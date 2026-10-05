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
  return calls.filter((c) => c.url !== "/config.json");
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
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
    expect(root.querySelector('[data-status="paused"]')?.textContent).toBe("Live monitoring is paused");
    expect(root.querySelectorAll("tr")).toHaveLength(0);
  });
});

describe("mock mode", () => {
  it("renders 17 rows and never requests /api/metrics", async () => {
    const { fetchFn, calls } = stubFetch({ config: () => ({ mode: "mock", refreshSeconds: 60 }) });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
    expect(root.querySelector("[data-status]")?.textContent).toContain("sample data");
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(calls.map((c) => c.url)).toEqual(["/config.json"]);
  });

  it("falls back to mock when /config.json is missing", async () => {
    const { fetchFn, calls } = stubFetch({});
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
    expect(metricsCalls(calls)).toHaveLength(0);
  });
});

describe("live mode", () => {
  it("requests only /api/metrics, once per refreshSeconds", async () => {
    const { fetchFn, calls } = stubFetch({ metrics: () => fakeResponse(sample) });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    expect(metricsCalls(calls)).toHaveLength(1);
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
    expect(root.querySelector("[data-status]")?.getAttribute("data-status")).toBe("ok");

    await vi.advanceTimersByTimeAsync(5 * REFRESH);
    const metrics = metricsCalls(calls);
    expect(metrics).toHaveLength(6);
    for (const call of metrics) expect(call.url).toBe("/api/metrics");
    const gaps = metrics.slice(1).map((c, i) => c.at - metrics[i].at);
    expect(gaps).toEqual([REFRESH, REFRESH, REFRESH, REFRESH, REFRESH]);
    expect(calls.every((c) => c.url === "/api/metrics" || c.url === "/config.json")).toBe(true);
  });

  it("uses refreshSeconds from the config", async () => {
    const { fetchFn, calls } = stubFetch({ metrics: () => fakeResponse(sample) });
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 120 } });
    await vi.advanceTimersByTimeAsync(6 * REFRESH);
    expect(metricsCalls(calls)).toHaveLength(4);
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
    // Failing calls at 60, 180, 420, 900, 1500, 2100 s.
    await vi.advanceTimersByTimeAsync(2100 * SECOND);
    expect(root.querySelector("[data-status]")?.getAttribute("data-status")).toBe("error");
    // The last good data stays on screen while retrying.
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);

    failing = false;
    await vi.advanceTimersByTimeAsync(600 * SECOND); // recovers at 2700 s
    await vi.advanceTimersByTimeAsync(2 * REFRESH); // 2760 s, 2820 s

    const times = metricsCalls(calls).map((c) => c.at);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / SECOND);
    expect(gaps).toEqual([60, 120, 240, 480, 600, 600, 600, 60, 60]);
    expect(root.querySelector("[data-status]")?.getAttribute("data-status")).toBe("ok");
  });

  it("shows a stale banner for stale data", async () => {
    const { fetchFn } = stubFetch({ metrics: () => fakeResponse({ ...sample, stale: true }) });
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const banner = root.querySelector<HTMLElement>("[data-status]");
    expect(banner?.dataset.status).toBe("stale");
    expect(banner?.textContent).toMatch(/stale/);
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
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
