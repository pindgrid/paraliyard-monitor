import { loadConfig } from "./config";
import { renderDashboard, type LiveState } from "./dashboard";
import { bindOpeners, createDrawer } from "./drawer";
import { groupFor } from "./drawer-groups";
import { drawerPath, isHistoryPath, parseDrawerRoute } from "./drawer-route";
import { createLiveHistorySource, createMockHistorySource } from "./history-source";
import { createPoller, type Poller } from "./poller";
import { isRefreshSeconds, loadRefresh, pollIntervalMs, saveRefresh, snapRefresh } from "./refresh";
import { SERVICES } from "./services";
import { createLiveSource, createMockSource } from "./source";
import type { Config, HistoryPoint, HistoryRange, MetricsResponse } from "./types";

// Open tabs in live mode re-read /config.json this often to honour the kill switch.
export const CONFIG_RECHECK_MS = 10 * 60 * 1000;
// Scheduler runs history (the day squares) is reloaded at most this often.
export const RUNS_RELOAD_MS = 10 * 60 * 1000;
export const RUNS_RANGE: HistoryRange = "30d";
// Same cap as the poller's backoff.
const MAX_RETRY_MS = 600000;

type RefreshStorage = Pick<Storage, "getItem" | "setItem">;

export interface AppOptions {
  root: HTMLElement;
  fetchFn?: typeof fetch;
  doc?: Document;
  config?: Config;
  // Where the refresh choice is kept (default: localStorage, if reachable).
  storage?: RefreshStorage | null;
}

export interface AppHandle {
  stop(): void;
}

function defaultStorage(win: Window): RefreshStorage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

export async function startApp({ root, fetchFn = fetch, doc = document, config, storage }: AppOptions): Promise<AppHandle> {
  const cfg = config ?? (await loadConfig(fetchFn));
  const win = doc.defaultView ?? window;
  const store = storage === undefined ? defaultStorage(win) : storage;
  let refreshSeconds = loadRefresh(store, snapRefresh(cfg.refreshSeconds));

  // Kill switch: zero requests, no drawer.
  const renderOff = () => {
    if (isHistoryPath(win.location.pathname)) win.history.replaceState(null, "", "/");
    renderDashboard(root, null, { state: "paused", mock: false, off: true, refreshSeconds, paused: true, nowMs: Date.now() });
  };
  if (cfg.mode === "off") {
    renderOff();
    return { stop() {} };
  }

  const mock = cfg.mode === "mock";
  const source = mock ? createMockSource() : createLiveSource(fetchFn);
  const historySource = mock ? createMockHistorySource() : createLiveHistorySource(fetchFn);

  let last: MetricsResponse | null = null;
  let state: LiveState = "loading";
  let paused = false;
  let stopped = false;
  let retrySeconds: number | undefined;
  let runs: Record<string, readonly HistoryPoint[] | null> = {};
  let lastRunsLoadAt: number | null = null;
  let lastFetchAt: number | null = null;
  let poller: Poller | null = null;
  let configPoller: Poller | null = null;
  // History entries this app pushed since the overview was last shown.
  let pushedDepth = 0;

  const render = () =>
    renderDashboard(root, last, {
      state,
      mock,
      stale: Boolean(last?.stale),
      retrySeconds,
      refreshSeconds,
      paused,
      nowMs: Date.now(),
      runs,
    });

  const drawer = createDrawer({
    doc,
    host: doc.body,
    source: historySource,
    onClose: closeDrawer,
    onRange: (range) => {
      const current = drawer.current();
      if (current) win.history.replaceState(null, "", drawerPath(current.group.target, range));
    },
  });

  // Day squares: both jobs' runs, at most once per RUNS_RELOAD_MS (failed or not).
  async function maybeLoadRuns() {
    const t = Date.now();
    if (lastRunsLoadAt !== null && t - lastRunsLoadAt < RUNS_RELOAD_MS) return;
    lastRunsLoadAt = t;
    const jobs = SERVICES.filter((s) => s.kind === "scheduler");
    const results = await Promise.all(
      jobs.map((j) =>
        historySource.load(j.id, "runs", RUNS_RANGE).then(
          (res) => res.points,
          () => null,
        ),
      ),
    );
    if (stopped) return;
    runs = Object.fromEntries(jobs.map((j, i) => [j.id, results[i] ?? runs[j.id] ?? null]));
    render();
  }

  async function tick() {
    lastFetchAt = Date.now();
    try {
      const data = await source.load();
      if (stopped) return;
      last = data;
      state = "live";
      retrySeconds = undefined;
      render();
      drawer.appendLive(data);
      void maybeLoadRuns();
    } catch (err) {
      if (!stopped) {
        state = "offline";
        // The poller doubles its delay after this failure.
        const current = poller ? poller.currentDelay() : pollIntervalMs(refreshSeconds);
        retrySeconds = Math.round(Math.min(current * 2, MAX_RETRY_MS) / 1000);
        render();
      }
      throw err;
    }
  }

  // (Re)starts polling at the chosen interval, never sooner than one interval
  // after the previous request.
  function startPolling() {
    poller?.stop();
    const intervalMs = pollIntervalMs(refreshSeconds);
    const elapsed = lastFetchAt === null ? Infinity : Date.now() - lastFetchAt;
    poller = createPoller({ intervalMs, doc, task: tick, runImmediately: elapsed >= intervalMs });
    poller.start();
  }

  function setPaused(next: boolean) {
    if (stopped || next === paused) return;
    paused = next;
    if (paused) {
      poller?.stop();
      state = "paused";
    } else {
      state = last ? "live" : "loading";
      startPolling();
    }
    render();
  }

  function setRefresh(seconds: number) {
    if (stopped || !isRefreshSeconds(seconds) || seconds === refreshSeconds) return;
    refreshSeconds = seconds;
    saveRefresh(store, seconds);
    if (!paused) startPolling();
    render();
  }

  function onChange(event: Event) {
    const select = (event.target as Element | null)?.closest?.('select[data-action="refresh"]') as HTMLSelectElement | null;
    if (select) setRefresh(Number(select.value));
  }

  function onClick(event: MouseEvent) {
    if ((event.target as Element | null)?.closest?.('button[data-action="pause"]')) setPaused(!paused);
  }

  // Shows whatever the URL names: a drawer over the page, or the page alone.
  // An invalid /history URL becomes "/".
  function route() {
    if (stopped) return;
    const current = parseDrawerRoute(win.location.pathname, win.location.search);
    if (current) {
      drawer.open(current.opener, { range: current.range, metric: current.metric });
      return;
    }
    if (isHistoryPath(win.location.pathname)) win.history.replaceState(null, "", "/");
    pushedDepth = 0;
    drawer.close();
  }

  function openFromPage(opener: string) {
    const group = groupFor(opener);
    if (stopped || !group || drawer.isOpen()) return;
    win.history.pushState(null, "", drawerPath(group.target, group.defaultRange));
    pushedDepth += 1;
    drawer.open(opener);
  }

  // Back to the page: undo our own pushes, otherwise replace the URL.
  function closeDrawer() {
    if (pushedDepth > 0) {
      const depth = pushedDepth;
      pushedDepth = 0;
      drawer.close();
      win.history.go(-depth);
    } else {
      win.history.replaceState(null, "", "/");
      drawer.close();
    }
  }

  function onPopState() {
    pushedDepth = Math.max(0, pushedDepth - 1);
    route();
  }

  const unbindOpeners = bindOpeners(root, (opener) => openFromPage(opener));
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  win.addEventListener("popstate", onPopState);

  function stop() {
    if (stopped) return;
    stopped = true;
    poller?.stop();
    configPoller?.stop();
    unbindOpeners();
    root.removeEventListener("change", onChange);
    root.removeEventListener("click", onClick);
    win.removeEventListener("popstate", onPopState);
    drawer.destroy();
  }

  render();
  startPolling();

  if (cfg.mode === "live") {
    configPoller = createPoller({
      intervalMs: CONFIG_RECHECK_MS,
      doc,
      runImmediately: false,
      task: async () => {
        const next = await loadConfig(fetchFn);
        if (next.mode === "off" && !stopped) {
          stop();
          renderOff();
        }
      },
    });
    configPoller.start();
  }

  route();
  return { stop };
}
