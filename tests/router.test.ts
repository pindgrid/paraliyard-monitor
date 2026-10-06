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

function params(url: string) {
  return new URL(url, "http://x").searchParams;
}

// History requests made by the drawer (the page's own 30-day loads excluded:
// the day squares' runs and the storage card's growth chart).
function drawerCalls(calls: Call[]) {
  return calls.filter((c) => {
    if (!c.url.startsWith("/api/history")) return false;
    const p = params(c.url);
    if (p.get("range") !== "30d") return true;
    return !(p.get("metric") === "runs" || (p.get("service") === "total:bucket" && p.get("metric") === "bytesStored"));
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function go(path: string) {
  window.history.replaceState(null, "", path);
}

const aside = () => document.querySelector<HTMLElement>("aside.drawer");
const drawerOpen = () => aside()?.classList.contains("open") === true;
const drawerTitle = () => document.getElementById("dTitle")?.textContent;
const pageVisible = () => root.querySelectorAll('[data-section="functions"] tbody tr').length === 10;
const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

const live: Config = { mode: "live", refreshSeconds: 60 };
const mockCfg: Config = { mode: "mock", refreshSeconds: 60 };

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setVisibility("visible");
  window.localStorage.clear();
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
  it("a /history/<id>?range= deep link opens the drawer over the page", async () => {
    go("/history/firestore:yard?range=7d");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    expect(drawerOpen()).toBe(true);
    expect(drawerTitle()).toBe("Firestore: yard");
    expect(pageVisible()).toBe(true);
    expect(drawerCalls(calls).map((c) => c.url)).toEqual([
      "/api/history?service=firestore%3Ayard&metric=readsPerMin&range=7d",
      "/api/history?service=firestore%3Ayard&metric=writesPerMin&range=7d",
      "/api/history?service=firestore%3Ayard&metric=deletesPerMin&range=7d",
    ]);
    expect(aside()?.querySelector('[data-range="7d"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("the older /history/<id>/<metric>?range=24h form opens the drawer with that metric visible", async () => {
    go("/history/function2:pyMintOnCrewClaim/cpuPct?range=24h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    expect(drawerOpen()).toBe(true);
    expect(drawerTitle()).toBe("pyMintOnCrewClaim");
    // The Chart.js legend draws on the canvas; visible series have unmuted stats rows.
    // Function series all start visible (each has a panel), the linked metric included.
    const rows = [...(aside()?.querySelectorAll<HTMLElement>(".dstats tbody tr") ?? [])];
    expect(rows.map((tr) => [tr.querySelector("td")?.textContent, !tr.classList.contains("muted")])).toEqual([
      ["Requests/min", true],
      ["Errors/min", true],
      ["Instances", true],
      ["CPU % (p99)", true],
      ["RAM % (p99)", true],
    ]);
    expect(drawerCalls(calls).every((c) => params(c.url).get("range") === "24h")).toBe(true);
    expect(pageVisible()).toBe(true);
  });

  it("a missing range opens 24h, or 30d for a job", async () => {
    go("/history/firestore:yard");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    expect(aside()?.querySelector('[aria-pressed="true"][data-range]')?.getAttribute("data-range")).toBe("24h");
    app.stop();
    go("/history/scheduler:pyNightlyExport");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    expect(aside()?.querySelector('[aria-pressed="true"][data-range]')?.getAttribute("data-range")).toBe("30d");
  });

  it("an opener pushes /history/<id>; popstate back to / closes the drawer and nothing polls history", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLElement>('tr[data-open="fn:function2:pyMintOnCrewClaim"]')!.click();
    expect(window.location.pathname).toBe("/history/function2:pyMintOnCrewClaim");
    expect(window.location.search).toBe("?range=24h");
    expect(drawerOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawerCalls(calls)).toHaveLength(5);

    go("/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(drawerOpen()).toBe(false);
    expect(pageVisible()).toBe(true);
    await vi.advanceTimersByTimeAsync(30 * 60 * SECOND);
    expect(drawerCalls(calls)).toHaveLength(5);
  });

  it("Escape on a deep link returns to / by replacing the URL", async () => {
    go("/history/firestore:yard?range=1h");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    expect(drawerOpen()).toBe(true);
    key(document, "Escape");
    expect(drawerOpen()).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  it("Escape after an in-app open goes back in history", async () => {
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    await vi.advanceTimersByTimeAsync(0);
    const back = vi.spyOn(window.history, "go").mockImplementation(() => {});
    root.querySelector<HTMLElement>('.hero-chart[data-open="fs"]')!.click();
    expect(drawerOpen()).toBe(true);
    key(document, "Escape");
    expect(drawerOpen()).toBe(false);
    expect(back).toHaveBeenCalledWith(-1);
    back.mockRestore();
  });

  it("the Close button returns to /", async () => {
    go("/history/function2:pyMintOnCrewClaim/cpuPct?range=6h");
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: mockCfg });
    aside()!.querySelector<HTMLElement>('[data-d="close"]')!.click();
    expect(drawerOpen()).toBe(false);
    expect(pageVisible()).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("invalid service, metric or range routes show the page at / with no drawer", async () => {
    for (const path of [
      "/history/firestore:nope",
      "/history/firestore:nope/readsPerMin",
      "/history/function2:pyMintOnCrewClaim/runs",
      "/history/function1:pyCleanupOnAuthDelete/cpuPct",
      "/history/firestore:yard/readsPerMin?range=2d",
      "/history/scheduler:pyNightlyExport?range=1h",
      "/history/total:firestore",
    ]) {
      go(path);
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: live });
      await vi.advanceTimersByTimeAsync(0);
      expect(drawerOpen(), path).toBe(false);
      expect(pageVisible(), path).toBe(true);
      expect(window.location.pathname + window.location.search, path).toBe("/");
      expect(drawerCalls(calls), path).toHaveLength(0);
      app.stop();
      app = null;
    }
  });

  it("a range button updates ?range= and loads that range", async () => {
    go("/history/firestore:yard/readsPerMin?range=24h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    aside()!.querySelector<HTMLElement>('button[data-range="7d"]')!.click();
    expect(window.location.search).toBe("?range=7d");
    expect(window.location.pathname).toBe("/history/firestore:yard");
    expect(aside()?.querySelector('button[data-range="7d"]')?.getAttribute("aria-pressed")).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    expect(drawerCalls(calls).map((c) => params(c.url).get("range"))).toEqual(["24h", "24h", "24h", "7d", "7d", "7d"]);
    // No history polling: only live points from the metrics refresh.
    await vi.advanceTimersByTimeAsync(900 * SECOND);
    expect(drawerCalls(calls)).toHaveLength(6);
  });
});

describe("drawer requests", () => {
  it("never polls history while open, at any range", async () => {
    for (const range of ["1h", "6h", "7d", "30d", "6w"]) {
      go(`/history/function2:pyMintOnCrewClaim/reqPerMin?range=${range}`);
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: live });
      await vi.advanceTimersByTimeAsync(900 * SECOND);
      expect(drawerCalls(calls), range).toHaveLength(5);
      app.stop();
      app = null;
    }
  });

  it("makes no history fetch while the tab is hidden", async () => {
    go("/history/firestore:yard?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(before);
  });

  it("off mode makes zero fetch calls, also on a /history URL", async () => {
    go("/history/firestore:yard?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: { mode: "off", refreshSeconds: 60 } });
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(0);
    expect(drawerOpen()).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(root.textContent).toContain("Live monitoring is paused");
  });

  it("the kill switch closes the drawer and stops every request", async () => {
    go("/history/firestore:yard?range=1h");
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
    expect(drawerOpen()).toBe(true);
    mode = "off";
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    expect(root.textContent).toContain("Live monitoring is paused");
    expect(aside()).toBeNull();
    expect(window.location.pathname).toBe("/");
    const total = calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * SECOND);
    expect(calls).toHaveLength(total);
  });

  it("mock mode makes zero fetch calls for history", async () => {
    go("/history/firestore:yard?range=1h");
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: mockCfg });
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(calls).toHaveLength(0);
    expect(drawerOpen()).toBe(true);
    expect(aside()?.querySelectorAll(".dstats tbody tr")).toHaveLength(3);
  });
});
