import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { startApp, type AppHandle } from "../src/app";
import type { ChartOptions, ChartSpec } from "../src/charts";
import { createOverview } from "../src/overview";
import { CELL_METRIC, PRIMARY_METRIC, isAllowedPair, parseRoute } from "../src/routes";
import type { Kind, MetricsResponse } from "../src/types";

interface Created {
  canvas: HTMLCanvasElement;
  spec: ChartSpec;
  onPick?: ChartOptions["onPick"];
  handle: { update: ReturnType<typeof vi.fn>; resetZoom: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
}

const mocks = vi.hoisted(() => ({ created: [] as Created[] }));

vi.mock("../src/charts", () => ({
  PALETTE: [],
  createChart: vi.fn((canvas: HTMLCanvasElement, spec: ChartSpec, options: ChartOptions = {}) => {
    const handle = { update: vi.fn(), resetZoom: vi.fn(), destroy: vi.fn() };
    mocks.created.push({ canvas, spec, onPick: options.onPick, handle });
    return handle;
  }),
}));

const SECOND = 1000;

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function stubFetch(config: unknown) {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/config.json") return fakeResponse(config);
    return fakeResponse({ error: "not found" }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, urls };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function currentRoute() {
  return parseRoute(window.location.pathname, window.location.search);
}

// The URL after an action is /history/<id>/<metric>?range=24h with an allowed pair.
function expectHistoryUrl(expected?: { service: string; metric: string }) {
  const route = currentRoute();
  expect(route.view, window.location.href).toBe("history");
  if (route.view !== "history") return;
  expect(window.location.pathname).toBe(`/history/${route.service}/${route.metric}`);
  expect(window.location.search).toBe("?range=24h");
  expect(route.range).toBe("24h");
  expect(isAllowedPair(route.service, route.metric)).toBe(true);
  if (expected) expect({ service: route.service, metric: route.metric }).toEqual(expected);
}

function resetUrl() {
  window.history.replaceState(null, "", "/");
}

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  mocks.created.length = 0;
  vi.useFakeTimers();
  setVisibility("visible");
  resetUrl();
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
  resetUrl();
});

describe("createOverview", () => {
  it("creates six figures with a canvas and a legend of buttons, once", () => {
    const host = document.createElement("section");
    const open = vi.fn();
    const overview = createOverview(host, document, { open });
    const figures = [...host.querySelectorAll<HTMLElement>("figure[data-chart]")];
    expect(figures.map((f) => f.dataset.chart)).toEqual(["requests", "cpuRam", "firestore", "bucketBytes", "hostingBytes", "scheduler"]);
    for (const figure of figures) {
      expect(figure.querySelector("figcaption")?.textContent).toBeTruthy();
      expect(figure.querySelector("canvas")).not.toBeNull();
      expect(figure.querySelectorAll("ul.chart-legend button").length).toBeGreaterThan(0);
    }
    expect(mocks.created).toHaveLength(6);
    expect(mocks.created.map((c) => c.spec.kind)).toEqual(["line", "bar", "line", "bar", "bar", "bar"]);

    overview.update(structuredClone(sample) as unknown as MetricsResponse);
    expect(mocks.created).toHaveLength(6);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(1);
    const cpu = host.querySelector('figure[data-chart="cpuRam"]');
    const idle = [...(cpu?.querySelectorAll("button") ?? [])].find((b) => b.dataset.service === "function2:pyWeeklyAccounts");
    expect(idle?.textContent).toContain("idle");
    const bucket = host.querySelector('figure[data-chart="bucketBytes"] button');
    expect(bucket?.textContent).toContain("41 MB");
  });

  it("keeps focus on a legend button across updates", () => {
    const host = document.createElement("section");
    document.body.appendChild(host);
    const overview = createOverview(host, document, { open: vi.fn() });
    overview.update(structuredClone(sample) as unknown as MetricsResponse);
    const button = host.querySelector<HTMLButtonElement>("figure button");
    button?.focus();
    overview.update(structuredClone(sample) as unknown as MetricsResponse);
    expect(document.activeElement).toBe(button);
  });
});

describe("overview in the app", () => {
  it("updates charts in place every refreshSeconds, never under 30 s", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 10 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.created).toHaveLength(6);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29 * SECOND);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90 * SECOND);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(5);
    expect(mocks.created).toHaveLength(6);
  });

  it("follows refreshSeconds from the config", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 120 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(6 * 60 * SECOND);
    for (const c of mocks.created) expect(c.handle.update).toHaveBeenCalledTimes(4);
    expect(mocks.created).toHaveLength(6);
  });

  it("keeps the charts and tables in separate hosts", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 60 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    const figures = root.querySelectorAll("figure[data-chart]");
    expect(figures).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    // The same figure nodes survive table re-renders.
    expect([...root.querySelectorAll("figure[data-chart]")]).toEqual([...figures]);
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
  });

  it("a click on every element of every chart kind opens an allowed history route", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 60 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    const kinds = new Set<string>();
    // Opening a history view creates its own chart; only the six overview charts are checked.
    const overviewCharts = mocks.created.filter((c) => c.canvas.closest("figure[data-chart]"));
    expect(overviewCharts).toHaveLength(6);
    for (const created of overviewCharts) {
      const spec = created.handle.update.mock.calls.at(-1)?.[0] as ChartSpec;
      spec.datasets.forEach((dataset, d) => {
        dataset.data.forEach((_v, i) => {
          resetUrl();
          created.onPick?.(d, i);
          expectHistoryUrl();
        });
        // Legend click on the dataset.
        resetUrl();
        created.onPick?.(d, null);
        expectHistoryUrl();
      });
      kinds.add(created.canvas.closest<HTMLElement>("figure")?.dataset.chart ?? "");
    }
    expect([...kinds]).toEqual(["requests", "cpuRam", "firestore", "bucketBytes", "hostingBytes", "scheduler"]);

    const cpu = overviewCharts[1];
    const idleIndex = (cpu.handle.update.mock.calls.at(-1)?.[0] as ChartSpec).labels?.indexOf("pyWeeklyAccounts") ?? -1;
    resetUrl();
    cpu.onPick?.(1, idleIndex);
    expectHistoryUrl({ service: "function2:pyWeeklyAccounts", metric: "memPct" });
    resetUrl();
    overviewCharts[5].onPick?.(0, 1);
    expectHistoryUrl({ service: "scheduler:pyWeeklyAccounts", metric: "runs" });
  });

  it("click or Enter on every legend entry opens its history route", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 60 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("figure ul.chart-legend button")];
    expect(buttons.length).toBeGreaterThan(20);
    for (const button of buttons) {
      const expected = { service: button.dataset.service ?? "", metric: button.dataset.metric ?? "" };
      resetUrl();
      button.click();
      expectHistoryUrl(expected);
      resetUrl();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expectHistoryUrl(expected);
    }
  });

  it("click on every table cell link and sparkline opens its history route", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 60 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    let cells = 0;
    let sparklines = 0;
    for (const row of root.querySelectorAll<HTMLElement>("tr[data-service-id]")) {
      const serviceId = row.dataset.serviceId ?? "";
      const kind = serviceId.split(":")[0] as Kind;
      for (const td of row.querySelectorAll<HTMLElement>("td[data-key]")) {
        const metric = CELL_METRIC[kind][td.dataset.key ?? ""];
        const link = td.querySelector<HTMLAnchorElement>("a[data-history]");
        if (!metric) {
          expect(link, `${serviceId} ${td.dataset.key}`).toBeNull();
          continue;
        }
        expect(link, `${serviceId} ${td.dataset.key}`).not.toBeNull();
        expect(link?.textContent).toBe(td.textContent);
        resetUrl();
        link?.click();
        expectHistoryUrl({ service: serviceId, metric });
        cells += 1;
      }
      const spark = row.querySelector<HTMLAnchorElement>("td.trend a[data-history]");
      expect(spark?.querySelector("svg"), serviceId).not.toBeNull();
      resetUrl();
      spark?.querySelector("svg")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expectHistoryUrl({ service: serviceId, metric: PRIMARY_METRIC[kind] });
      sparklines += 1;
    }
    expect(sparklines).toBe(17);
    expect(cells).toBe(9 * 5 + 3 + 3 + 2 * 2 + 2 + 2 * 2);
  });

  it("ctrl-click on a table link is left to the browser", async () => {
    const { fetchFn } = stubFetch({ mode: "mock", refreshSeconds: 60 });
    app = await startApp({ root, fetchFn });
    await vi.advanceTimersByTimeAsync(0);
    const link = root.querySelector<HTMLAnchorElement>("a[data-history]");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    // Keep jsdom from navigating.
    link?.addEventListener("click", (e) => e.preventDefault(), { once: true });
    link?.dispatchEvent(event);
    expect(window.location.pathname).toBe("/");
  });
});
