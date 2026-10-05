// Frozen copy of src/app.ts as of iteration 4: the overview charts, tables and
// full-page history view composed together. The iteration-5 app no longer
// mounts these modules, but they stay in src/ until a clean-up PR removes them;
// tests/overview.test.ts keeps testing them through this composition.
import { loadConfig } from "../../src/config";
import { createLiveHistorySource, createMockHistorySource } from "../../src/history-source";
import { openHistoryView, type HistoryRoute, type HistoryView } from "../../src/history-view";
import { createOverview } from "../../src/overview";
import { createPoller, type Poller } from "../../src/poller";
import { renderDashboard } from "../../src/render";
import { historyPath, parseRoute } from "../../src/routes";
import { SERVICES } from "../../src/services";
import { createLiveSource, createMockSource } from "../../src/source";
import type { Config, MetricsResponse } from "../../src/types";

export const CONFIG_RECHECK_MS = 10 * 60 * 1000;

export interface AppOptions {
  root: HTMLElement;
  fetchFn?: typeof fetch;
  doc?: Document;
  config?: Config;
}

export interface AppHandle {
  stop(): void;
}

export async function startApp({ root, fetchFn = fetch, doc = document, config }: AppOptions): Promise<AppHandle> {
  const cfg = config ?? (await loadConfig(fetchFn));
  const renderPaused = () => renderDashboard(root, SERVICES, null, { state: "paused" });

  if (cfg.mode === "off") {
    renderPaused();
    return { stop() {} };
  }

  const mock = cfg.mode === "mock";
  const source = mock ? createMockSource() : createLiveSource(fetchFn);
  const pollers: Poller[] = [];
  let stopped = false;
  let last: MetricsResponse | null = null;

  const win = doc.defaultView ?? window;
  const historySource = mock ? createMockHistorySource() : createLiveHistorySource(fetchFn);
  let view: HistoryView | null = null;
  let pushedDepth = 0;

  const closeView = () => {
    view?.close();
    view = null;
  };

  const stop = () => {
    stopped = true;
    for (const poller of pollers) poller.stop();
    closeView();
    win.removeEventListener("popstate", onPopState);
    doc.removeEventListener("keydown", onKeydown);
  };

  const tablesHost = doc.createElement("div");
  tablesHost.className = "tables";
  const chartsHost = doc.createElement("section");
  chartsHost.className = "charts";
  chartsHost.setAttribute("aria-label", "Overview charts");
  const historyHost = doc.createElement("div");
  historyHost.className = "history";
  historyHost.hidden = true;
  root.replaceChildren(tablesHost, chartsHost, historyHost);

  function showOverview() {
    closeView();
    tablesHost.hidden = false;
    chartsHost.hidden = false;
    historyHost.hidden = true;
  }

  function showHistory(route: HistoryRoute) {
    closeView();
    tablesHost.hidden = true;
    chartsHost.hidden = true;
    view = openHistoryView(historyHost, {
      route,
      source: historySource,
      refreshSeconds: cfg.refreshSeconds,
      doc,
      onClose: closeHistory,
      onRange: (range) => navigate(historyPath(route.service, route.metric, range)),
    });
  }

  function route() {
    if (stopped) return;
    const current = parseRoute(win.location.pathname, win.location.search);
    if (current.view === "history") {
      showHistory(current);
      return;
    }
    if (win.location.pathname.startsWith("/history")) win.history.replaceState(null, "", "/");
    pushedDepth = 0;
    showOverview();
  }

  function navigate(path: string) {
    if (stopped) return;
    win.history.pushState(null, "", path);
    pushedDepth += 1;
    route();
  }

  function closeHistory() {
    if (pushedDepth > 0) {
      const depth = pushedDepth;
      pushedDepth = 0;
      showOverview();
      win.history.go(-depth);
    } else {
      win.history.replaceState(null, "", "/");
      route();
    }
  }

  function onPopState() {
    pushedDepth = Math.max(0, pushedDepth - 1);
    route();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && view) closeHistory();
  }

  win.addEventListener("popstate", onPopState);
  doc.addEventListener("keydown", onKeydown);

  const overview = createOverview(chartsHost, doc, { open: (service, metric) => navigate(historyPath(service, metric)) });

  root.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const link = (event.target as Element | null)?.closest?.("a[data-history]");
    const href = link?.getAttribute("href");
    if (!link || !href || !root.contains(link)) return;
    event.preventDefault();
    navigate(href);
  });

  const updateCharts = (data: MetricsResponse) => {
    try {
      overview.update(data);
    } catch {
      // A chart problem must never hide the tables or change the status.
    }
  };

  renderDashboard(tablesHost, SERVICES, null, { state: "loading", mock });

  pollers.push(
    createPoller({
      intervalMs: cfg.refreshSeconds * 1000,
      doc,
      task: async () => {
        try {
          const data = await source.load();
          if (stopped) return;
          last = data;
          renderDashboard(tablesHost, SERVICES, data, {
            state: data.stale ? "stale" : "ok",
            updatedAt: data.generatedAt,
            mock,
          });
          updateCharts(data);
        } catch (err) {
          if (!stopped) {
            renderDashboard(tablesHost, SERVICES, last, { state: "error", updatedAt: last?.generatedAt ?? null, mock });
          }
          throw err;
        }
      },
    }),
  );

  if (cfg.mode === "live") {
    pollers.push(
      createPoller({
        intervalMs: CONFIG_RECHECK_MS,
        doc,
        runImmediately: false,
        task: async () => {
          const next = await loadConfig(fetchFn);
          if (next.mode === "off" && !stopped) {
            stop();
            renderPaused();
          }
        },
      }),
    );
  }

  for (const poller of pollers) poller.start();
  route();
  return { stop };
}
