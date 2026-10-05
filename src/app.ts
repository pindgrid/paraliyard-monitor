import { loadConfig } from "./config";
import { createLiveHistorySource, createMockHistorySource } from "./history-source";
import { openHistoryView, type HistoryRoute, type HistoryView } from "./history-view";
import { createOverview } from "./overview";
import { createPoller, type Poller } from "./poller";
import { renderDashboard } from "./render";
import { historyPath, parseRoute } from "./routes";
import { SERVICES } from "./services";
import { createLiveSource, createMockSource } from "./source";
import type { Config, MetricsResponse } from "./types";

// Open tabs in live mode re-read /config.json this often to honour the kill switch.
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
  // History entries this app pushed since the overview was last shown.
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

  // Built once: status and tables, the overview charts, the history view.
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

  // Shows whatever the current URL names; an invalid history URL becomes "/".
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

  // Back to the overview: undo our own pushes, otherwise replace the URL.
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

  // Table cells and sparklines link to the history view.
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
