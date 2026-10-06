import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_RECHECK_MS, parseConfig, startApp, type AppHandle, type Config } from "../src/app";
import fixture from "./fixtures/api-metrics.json";

let root: HTMLElement;
let app: AppHandle | null = null;

function memory() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}
function stubFetch(routes: Record<string, () => unknown>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key]() };
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const MOCK: Config = { mode: "mock", refreshSeconds: 60 };
const click = (el: Element | null) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById("app")!;
  document.documentElement.dataset.theme = "light";
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
});

describe("config", () => {
  it("falls back to mock, snaps the refresh to 30 s, 60 s or 5 min", () => {
    expect(parseConfig(null)).toEqual({ mode: "mock", refreshSeconds: 60 });
    expect(parseConfig({ mode: "live", refreshSeconds: 300 })).toEqual({ mode: "live", refreshSeconds: 300 });
    expect(parseConfig({ mode: "off", refreshSeconds: 120 })).toEqual({ mode: "off", refreshSeconds: 60 });
    expect(parseConfig({ mode: "nope", refreshSeconds: 5 })).toEqual({ mode: "mock", refreshSeconds: 30 });
  });
});

describe("page (mock mode)", () => {
  beforeEach(async () => {
    const { fetchFn } = stubFetch({});
    app = await startApp({ root, fetchFn, config: MOCK, storage: memory() });
  });

  it("renders every section, in order, with no pause button", () => {
    const ids = [...root.querySelectorAll("#overview, #database, #functions, #storage, #hosting, #jobs")].map((el) => el.id);
    expect(ids).toEqual(["overview", "database", "functions", "storage", "hosting", "jobs"]);
    expect(root.querySelectorAll("[data-kpis] .kpi")).toHaveLength(6);
    expect(root.querySelectorAll("[data-fn-body] tr")).toHaveLength(10);
    expect(root.querySelectorAll("[data-job-list] .job")).toHaveLength(2);
    expect($('[data-chart="reads"] svg')).not.toBeNull();
    expect($('[data-chart="hosting"] svg')).not.toBeNull();
    expect(text($("[data-banner-title]"))).toMatch(/^(All systems healthy|Needs attention)$/);
    expect(text($("[data-note]"))).toContain("Demo data.");
    const labels = [...root.querySelectorAll("button")].map((b) => `${b.textContent} ${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.toLowerCase());
    expect(labels.some((l) => l.includes("pause"))).toBe(false);
  });

  it("switches between the white and the dark theme and remembers it", async () => {
    const store = memory();
    app?.stop();
    app = await startApp({ root, fetchFn: stubFetch({}).fetchFn, config: MOCK, storage: store });
    click($("[data-theme-btn]"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(store.map.get("pm-theme")).toBe("dark");
    click($("[data-theme-btn]"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("remembers the refresh choice", async () => {
    const store = memory();
    app?.stop();
    app = await startApp({ root, fetchFn: stubFetch({}).fetchFn, config: MOCK, storage: store });
    click($('[data-refresh-seg] [data-s="30"]'));
    expect($('[data-refresh-seg] [data-s="30"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(store.map.get("pm-refresh")).toBe("30");
  });

  it("filters, searches and sorts the functions table", () => {
    click($('[data-filter="idle"]'));
    const idle = [...root.querySelectorAll("[data-fn-body] tr .status")];
    expect(idle.every((s) => s.classList.contains("idle"))).toBe(true);
    click($('[data-filter="all"]'));
    const search = $<HTMLInputElement>("[data-fn-search]")!;
    search.value = "mint";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...root.querySelectorAll("[data-fn-body] tr")].map((r) => r.getAttribute("data-fn"))).toEqual(
      expect.arrayContaining(["function2:pyMintOnCrewClaim", "function2:pyMintOnRoleRequest"]),
    );
    expect(root.querySelectorAll("[data-fn-body] tr")).toHaveLength(2);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    click($('[data-sort="name"]'));
    const names = [...root.querySelectorAll("[data-fn-body] tr")].map((r) => r.getAttribute("data-fn")!.split(":")[1].toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it("opens the history drawer from a card and closes it with Escape", async () => {
    click($('[data-kpis] [data-open="fs"]'));
    await vi.waitFor(() => expect(root.querySelectorAll("[data-d-charts] svg").length).toBe(2));
    expect($("[data-drawer]")?.classList.contains("open")).toBe(true);
    expect(text($("[data-d-title]"))).toBe("Firestore · yard");
    expect(root.querySelectorAll("[data-d-range] button")).toHaveLength(6);
    expect(window.location.search).toContain("open=fs");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("[data-drawer]")?.classList.contains("open")).toBe(false);
    expect(window.location.search).toBe("");
  });

  it("shows scheduled-run history for a job", async () => {
    click($('[data-job="scheduler:pyNightlyExport"]'));
    await vi.waitFor(() => expect(root.querySelectorAll("[data-d-table] tbody tr").length).toBeGreaterThan(0));
    expect([...root.querySelectorAll("[data-d-range] button")].map((b) => b.textContent)).toEqual(["7d", "30d", "6w"]);
  });
});

describe("kill switch", () => {
  it("off: requests nothing and says monitoring is paused", async () => {
    const { fetchFn, calls } = stubFetch({});
    app = await startApp({ root, fetchFn, config: { mode: "off", refreshSeconds: 60 }, storage: memory() });
    expect(calls).toEqual([]);
    expect(text($("[data-banner-title]"))).toBe("Monitoring paused");
    expect($<HTMLElement>("[data-sections]")?.hidden).toBe(true);
    expect([...root.querySelectorAll<HTMLButtonElement>("[data-refresh-seg] button")].every((b) => b.disabled)).toBe(true);
  });

  it("an open live tab stops within 10 minutes of the switch going off", async () => {
    vi.useFakeTimers();
    let mode = "live";
    const { fetchFn, calls } = stubFetch({
      "/config.json": () => ({ mode, refreshSeconds: 60 }),
      "/api/metrics": () => fixture,
      "/api/history": () => ({ points: [] }),
    });
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 60 }, storage: memory() });
    mode = "off";
    await vi.advanceTimersByTimeAsync(CONFIG_RECHECK_MS);
    expect(text($("[data-banner-title]"))).toBe("Monitoring paused");
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(calls.filter((c) => c.startsWith("/api/")).length).toBe(calls.slice(0, before).filter((c) => c.startsWith("/api/")).length);
  });
});

describe("live mode", () => {
  it("shows the real services and asks only /api/metrics each refresh, plus the 30-day side data", async () => {
    vi.useFakeTimers();
    const { fetchFn, calls } = stubFetch({
      "/api/metrics": () => fixture,
      "/api/history": () => ({ points: [{ t: "2026-10-06T00:00:00.000Z", v: 100e6 }], otherCalls: { count: 10, failed: 10 } }),
    });
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 60 }, storage: memory() });
    expect(text($('[data-fn="function2:pyMintOnCrewClaim"]'))).toContain("pyMintOnCrewClaim");
    expect(text($("[data-live-text]"))).toBe("Live");
    expect($("[data-note]")?.hidden).toBe(true);
    const history = calls.filter((c) => c.startsWith("/api/history"));
    expect(history).toEqual([
      "/api/history?service=total%3Abucket&metric=bytesStored&range=30d",
      "/api/history?service=scheduler%3ApyNightlyExport&metric=runs&range=30d",
      "/api/history?service=scheduler%3ApyWeeklyAccounts&metric=runs&range=30d",
    ]);
    expect(text($('[data-job="scheduler:pyNightlyExport"] .job-note'))).toContain("10 off-schedule calls");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(calls.filter((c) => c === "/api/metrics")).toHaveLength(6);
  });

  it("says when the metrics service can't be reached", async () => {
    const { fetchFn } = stubFetch({});
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 60 }, storage: memory() });
    expect(text($("[data-live-text]"))).toBe("Offline");
    expect($("[data-note]")?.classList.contains("err")).toBe(true);
  });
});
