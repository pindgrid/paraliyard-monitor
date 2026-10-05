import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { startApp, type AppHandle } from "../src/app";
import type { Config } from "../src/types";

const SECOND = 1000;
const NOW = Date.UTC(2026, 9, 5, 8, 30, 0);

interface Call {
  url: string;
  at: number;
}

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function historyBody(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  return {
    service: params.get("service"),
    metric: params.get("metric"),
    range: params.get("range"),
    unit: "per minute",
    points: [{ t: new Date(Date.now()).toISOString(), v: 1 }],
    generatedAt: new Date(Date.now()).toISOString(),
  };
}

// Stubbed fetch for /config.json, /api/metrics and /api/history. No network.
function stubFetch(config: unknown = { mode: "live", refreshSeconds: 60 }) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    if (url === "/config.json") return fakeResponse(config);
    if (url === "/api/metrics") return fakeResponse(sample);
    if (url.startsWith("/api/history?")) return fakeResponse(historyBody(url));
    return fakeResponse({ error: "not found" }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function historyCalls(calls: Call[]) {
  return calls.filter((c) => c.url.startsWith("/api/history"));
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function go(path: string) {
  window.history.replaceState(null, "", path);
}

function historyView(): HTMLElement | null {
  const host = root.querySelector<HTMLElement>(".history");
  return host && !host.hidden ? host.querySelector<HTMLElement>(".history-view") : null;
}

function overviewVisible(): boolean {
  const tables = root.querySelector<HTMLElement>(".tables");
  const charts = root.querySelector<HTMLElement>(".charts");
  return Boolean(tables && charts && !tables.hidden && !charts.hidden && historyView() === null);
}

const live: Config = { mode: "live", refreshSeconds: 60 };
const mockCfg: Config = { mode: "mock", refreshSeconds: 60 };

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setVisibility("visible");
  go("/");
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
  setVisibility("visible");
  go("/");
});

describe("router", () => {
  it("opening a history route renders the view and hides the overview", async () => {
    go("/history/firestore:yard/readsPerMin?range=7d");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const view = historyView();
    expect(view?.dataset.service).toBe("firestore:yard");
    expect(view?.dataset.metric).toBe("readsPerMin");
    expect(view?.dataset.range).toBe("7d");
    expect(overviewVisible()).toBe(false);
    expect(historyCalls(calls).map((c) => c.url)).toEqual(["/api/history?service=firestore%3Ayard&metric=readsPerMin&range=7d"]);
    expect(view?.querySelector("[data-history-state]")?.getAttribute("data-history-state")).toBe("ok");
  });

  it("a missing range opens 24h", async () => {
    go("/history/firestore:yard/writesPerMin");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    expect(historyView()?.dataset.range).toBe("24h");
  });

  it("popstate back to / returns to the overview and stops the history poller", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLAnchorElement>('tr[data-service-id="firestore:yard"] a[data-history]')?.click();
    expect(window.location.pathname).toBe("/history/firestore:yard/readsPerMin");
    expect(historyView()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls(calls)).toHaveLength(1);

    go("/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(overviewVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60 * SECOND);
    expect(historyCalls(calls)).toHaveLength(1);
  });

  it("Escape returns to the overview", async () => {
    go("/history/firestore:yard/readsPerMin?range=1h");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    expect(historyView()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overviewVisible()).toBe(true);
    // Entered directly, so the URL is replaced.
    expect(window.location.pathname).toBe("/");
  });

  it("Escape after an in-app navigation goes back in history", async () => {
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    await vi.advanceTimersByTimeAsync(0);
    const back = vi.spyOn(window.history, "go").mockImplementation(() => {});
    root.querySelector<HTMLButtonElement>('figure[data-chart="firestore"] button')?.click();
    expect(historyView()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overviewVisible()).toBe(true);
    expect(back).toHaveBeenCalledWith(-1);
    back.mockRestore();
  });

  it("the close button returns to the overview", async () => {
    go("/history/function2:pyMintOnCrewClaim/cpuPct?range=6h");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    root.querySelector<HTMLButtonElement>('.history-view button[data-action="close"]')?.click();
    expect(overviewVisible()).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("invalid service, metric or range routes show the overview at /", async () => {
    for (const path of [
      "/history/firestore:nope/readsPerMin",
      "/history/function2:pyMintOnCrewClaim/runs",
      "/history/function1:pyCleanupOnAuthDelete/cpuPct",
      "/history/firestore:yard/readsPerMin?range=2d",
    ]) {
      go(path);
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: live });
      await vi.advanceTimersByTimeAsync(0);
      expect(overviewVisible(), path).toBe(true);
      expect(window.location.pathname + window.location.search, path).toBe("/");
      expect(historyCalls(calls), path).toHaveLength(0);
      app.stop();
      app = null;
    }
  });

  it("a range button updates ?range= and loads that range", async () => {
    go("/history/firestore:yard/readsPerMin?range=24h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLButtonElement>('.history-view button[data-range="7d"]')?.click();
    expect(window.location.search).toBe("?range=7d");
    expect(window.location.pathname).toBe("/history/firestore:yard/readsPerMin");
    expect(historyView()?.dataset.range).toBe("7d");
    expect(root.querySelector('button[data-range="7d"]')?.getAttribute("aria-pressed")).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls(calls).map((c) => new URL(c.url, "http://x").searchParams.get("range"))).toEqual(["24h", "7d"]);
    // The old range's poller is stopped: only 7d polls, every 300 s.
    await vi.advanceTimersByTimeAsync(300 * SECOND);
    expect(historyCalls(calls).map((c) => new URL(c.url, "http://x").searchParams.get("range"))).toEqual(["24h", "7d", "7d"]);
  });
});

describe("history refresh cadence", () => {
  it("1h and 6h refresh every refreshSeconds", async () => {
    for (const range of ["1h", "6h"]) {
      go(`/history/firestore:yard/readsPerMin?range=${range}`);
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 90 } });
      await vi.advanceTimersByTimeAsync(270 * SECOND);
      const times = historyCalls(calls).map((c) => c.at);
      expect(times.slice(1).map((t, i) => (t - times[i]) / SECOND), range).toEqual([90, 90, 90]);
      app.stop();
      app = null;
    }
  });

  it("7d, 30d and 6w refresh every 300 s", async () => {
    for (const range of ["7d", "30d", "6w"]) {
      go(`/history/function2:pyMintOnCrewClaim/reqPerMin?range=${range}`);
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: live });
      await vi.advanceTimersByTimeAsync(900 * SECOND);
      const times = historyCalls(calls).map((c) => c.at);
      expect(times.slice(1).map((t, i) => (t - times[i]) / SECOND), range).toEqual([300, 300, 300]);
      app.stop();
      app = null;
    }
  });

  it("makes no history fetch while the tab is hidden", async () => {
    go("/history/firestore:yard/readsPerMin?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(before);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(historyCalls(calls)).toHaveLength(2);
  });

  it("off mode makes zero fetch calls, also on a /history URL", async () => {
    go("/history/firestore:yard/readsPerMin?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: { mode: "off", refreshSeconds: 60 } });
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(0);
    expect(root.textContent).toBe("Live monitoring is paused");
  });

  it("the kill switch stops the history poller too", async () => {
    go("/history/firestore:yard/readsPerMin?range=1h");
    let mode = "live";
    const { fetchFn, calls } = stubFetch();
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/config.json") {
        calls.push({ url: "/config.json", at: Date.now() });
        return fakeResponse({ mode, refreshSeconds: 60 });
      }
      return fetchFn(input, init);
    }) as typeof fetch;
    app = await startApp({ root, fetchFn: wrapped, config: live });
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    mode = "off";
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    expect(root.textContent).toBe("Live monitoring is paused");
    const total = calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(total);
  });

  it("mock mode makes zero fetch calls for history", async () => {
    go("/history/firestore:yard/readsPerMin?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: mockCfg });
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(calls).toHaveLength(0);
    expect(historyView()?.querySelector("[data-history-state]")?.getAttribute("data-history-state")).toBe("ok");
  });
});
