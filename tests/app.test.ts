import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { startApp, type AppHandle } from "../src/app";
import type { Config } from "../src/types";

const SECOND = 1000;
const REFRESH = 60 * SECOND;

interface Call {
  url: string;
  at: number;
  init?: RequestInit;
}

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// Stubbed fetch that records every URL. Nothing here reaches the network.
function stubFetch(routes: { config?: () => unknown; metrics?: () => Response }) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), init });
    if (url === "/config.json" && routes.config) return fakeResponse(routes.config());
    if (url === "/api/metrics" && routes.metrics) return routes.metrics();
    return fakeResponse({ error: "not found" }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function metricsCalls(calls: Call[]) {
  return calls.filter((c) => c.url === "/api/metrics");
}

// The day squares' runs history: the only other request the page makes.
const RUNS_URLS = [
  "/api/history?service=scheduler%3ApyNightlyExport&metric=runs&range=30d",
  "/api/history?service=scheduler%3ApyWeeklyAccounts&metric=runs&range=30d",
];

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const liveState = () => root.querySelector<HTMLElement>("[data-live]")?.dataset.state;
const functionRows = () => root.querySelectorAll('[data-section="functions"] tbody tr[data-service-id]');

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
  setVisibility("visible");
});

const live: Config = { mode: "live", refreshSeconds: 60 };

describe("off mode (kill switch)", () => {
  it("shows paused and fetches only /config.json once", async () => {
    const { fetchFn, calls } = stubFetch({ config: () => ({ mode: "off", refreshSeconds: 60 }) });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(root.textContent).toContain("Live monitoring is paused");
    expect(calls.map((c) => c.url)).toEqual(["/config.json"]);
  });

  it("makes zero fetch calls with an injected config", async () => {
    const { fetchFn, calls } = stubFetch({});
    app = await startApp({ root, fetchFn, config: { mode: "off", refreshSeconds: 60 } });
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(calls).toHaveLength(0);
    expect(liveState()).toBe("paused");
    expect(root.querySelector("[data-live-text]")?.textContent).toBe("Paused");
    expect(root.querySelector("[data-note]")?.textContent).toContain("Live monitoring is paused");
    expect(root.querySelectorAll("tr")).toHaveLength(0);
  });
});

describe("mock mode", () => {
  it("renders every service and never requests /api/metrics", async () => {
    const { fetchFn, calls } = stubFetch({ config: () => ({ mode: "mock", refreshSeconds: 60 }) });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    // 10 functions, Firestore in the hero, 2 buckets, 2 sites and 2 jobs: all 17 services.
    expect(functionRows()).toHaveLength(10);
    expect(root.querySelectorAll('[data-open="fs"]').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('[data-open^="st:"]')).toHaveLength(2);
    expect(root.querySelectorAll('[data-open^="site:"]')).toHaveLength(2);
    expect(root.querySelectorAll('[data-open^="job:"].job')).toHaveLength(2);
    expect(root.querySelector("[data-note]")?.textContent).toContain("sample data");
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(calls.map((c) => c.url)).toEqual(["/config.json"]);
  });

  it("falls back to mock when /config.json is missing", async () => {
    const { fetchFn, calls } = stubFetch({});
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(functionRows()).toHaveLength(10);
    expect(metricsCalls(calls)).toHaveLength(0);
    expect(calls.map((c) => c.url)).toEqual(["/config.json"]);
  });
});

describe("live mode", () => {
  it("requests only /api/metrics, once per refreshSeconds, plus the runs history", async () => {
    const { fetchFn, calls } = stubFetch({ metrics: () => fakeResponse(sample) });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    expect(metricsCalls(calls)).toHaveLength(1);
    expect(functionRows()).toHaveLength(10);
    expect(liveState()).toBe("live");

    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    const metrics = metricsCalls(calls);
    expect(metrics).toHaveLength(6);
    const gaps = metrics.slice(1).map((c, i) => c.at - metrics[i].at);
    expect(gaps).toEqual([REFRESH, REFRESH, REFRESH, REFRESH, REFRESH]);
    // Everything else is the two runs requests after the first load (at most every 10 minutes).
    const others = calls.filter((c) => c.url !== "/api/metrics");
    expect(others.map((c) => c.url)).toEqual(RUNS_URLS);
  });

  it("uses the configured refreshSeconds, snapped to 30s, 60s or 5m", async () => {
    const { fetchFn, calls } = stubFetch({ metrics: () => fakeResponse(sample) });
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 300 } });
    await vi.advanceTimersByTimeAsync(6 * REFRESH);
    expect(metricsCalls(calls)).toHaveLength(2);
    expect(root.querySelector<HTMLSelectElement>('select[data-action="refresh"]')?.value).toBe("300");
    app.stop();

    const second = stubFetch({ metrics: () => fakeResponse(sample) });
    app = await startApp({ root, fetchFn: second.fetchFn, config: { mode: "live", refreshSeconds: 120 } });
    await vi.advanceTimersByTimeAsync(6 * REFRESH);
    // 120 s is nearest to 60 s.
    expect(metricsCalls(second.calls)).toHaveLength(7);
  });

  it("requests nothing while the tab is hidden", async () => {
    const { fetchFn, calls } = stubFetch({
      config: () => ({ mode: "live", refreshSeconds: 60 }),
      metrics: () => fakeResponse(sample),
    });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30 * REFRESH);
    expect(calls).toHaveLength(before);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(metricsCalls(calls)).toHaveLength(2);
  });

  it("backs off after errors up to the cap and recovers after a success", async () => {
    let failing = false;
    const { fetchFn, calls } = stubFetch({
      config: () => ({ mode: "live", refreshSeconds: 60 }),
      metrics: () => (failing ? fakeResponse({ error: "metrics unavailable" }, 503) : fakeResponse(sample)),
    });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);

    failing = true;
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    // Offline with the next retry interval.
    expect(liveState()).toBe("offline");
    expect(root.querySelector("[data-live-text]")?.textContent).toBe("Offline");
    expect(root.querySelector(".note.err")?.textContent).toContain("Retrying in 120 seconds");

    // Failing calls at 60, 180, 420, 900, 1500, 2100 s.
    await vi.advanceTimersByTimeAsync(2040 * SECOND);
    expect(liveState()).toBe("offline");
    expect(root.querySelector(".note.err")?.textContent).toContain("Retrying in 600 seconds");
    // The last good data stays on screen while retrying.
    expect(functionRows()).toHaveLength(10);

    failing = false;
    await vi.advanceTimersByTimeAsync(600 * SECOND); // recovers at 2700 s
    await vi.advanceTimersByTimeAsync(2 * REFRESH); // 2760 s, 2820 s

    const times = metricsCalls(calls).map((c) => c.at);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / SECOND);
    expect(gaps).toEqual([60, 120, 240, 480, 600, 600, 600, 60, 60]);
    expect(liveState()).toBe("live");
    expect(root.querySelector<HTMLElement>(".note.err")?.hidden).toBe(true);
  });

  it("shows a stale note for stale data", async () => {
    const { fetchFn } = stubFetch({ metrics: () => fakeResponse({ ...sample, stale: true }) });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const note = root.querySelector<HTMLElement>("[data-note]");
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toMatch(/last good data/);
    expect(functionRows()).toHaveLength(10);
  });

  it("re-reads /config.json every 10 minutes and stops when it becomes off", async () => {
    let mode = "live";
    const { fetchFn, calls } = stubFetch({
      config: () => ({ mode, refreshSeconds: 60 }),
      metrics: () => fakeResponse(sample),
    });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(10 * REFRESH);
    const configCalls = calls.filter((c) => c.url === "/config.json");
    expect(configCalls).toHaveLength(1);
    expect(configCalls[0].init).toEqual({ cache: "no-store" });

    mode = "off";
    await vi.advanceTimersByTimeAsync(10 * REFRESH);
    expect(root.textContent).toContain("Live monitoring is paused");
    expect(liveState()).toBe("paused");
    const total = calls.length;
    const metricsSoFar = metricsCalls(calls).length;

    await vi.advanceTimersByTimeAsync(60 * REFRESH);
    expect(calls).toHaveLength(total);
    expect(metricsCalls(calls)).toHaveLength(metricsSoFar);
    expect(root.textContent).toContain("Live monitoring is paused");
  });

  it("stop() ends all polling", async () => {
    const { fetchFn, calls } = stubFetch({
      config: () => ({ mode: "live", refreshSeconds: 60 }),
      metrics: () => fakeResponse(sample),
    });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    app.stop();
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(30 * REFRESH);
    expect(calls).toHaveLength(count);
  });
});
