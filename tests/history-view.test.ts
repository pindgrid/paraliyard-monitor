import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartSpec, TimePoint } from "../src/charts";
import type { HistorySource } from "../src/history-source";
import {
  DAILY_TEXT,
  IDLE_TEXT,
  LONG_RANGE_INTERVAL_MS,
  NO_ACTIVITY_TEXT,
  historyIntervalMs,
  openHistoryView,
  summarize,
  type HistoryRoute,
  type HistoryView,
} from "../src/history-view";
import type { HistoryRange, HistoryResponse } from "../src/types";

const mocks = vi.hoisted(() => ({
  charts: [] as { spec: ChartSpec; update: ReturnType<typeof vi.fn>; resetZoom: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[],
}));

vi.mock("../src/charts", () => ({
  PALETTE: [],
  createChart: vi.fn((_canvas: HTMLCanvasElement, spec: ChartSpec) => {
    const chart = { spec, update: vi.fn(), resetZoom: vi.fn(), destroy: vi.fn() };
    mocks.charts.push(chart);
    return chart;
  }),
}));

const NOW = Date.UTC(2026, 9, 5, 8, 30, 0);
const SECOND = 1000;

function response(route: HistoryRoute, points: { t: string; v: number }[], extra: Partial<HistoryResponse> = {}): HistoryResponse {
  return {
    service: route.service,
    metric: route.metric,
    range: route.range,
    unit: "per minute",
    points,
    generatedAt: new Date(NOW).toISOString(),
    ...extra,
  };
}

function route(service: string, metric: string, range: HistoryRange = "24h"): HistoryRoute {
  return { view: "history", service, metric, range };
}

let host: HTMLElement;
let view: HistoryView | null = null;

function state(): string | undefined {
  return host.querySelector<HTMLElement>("[data-history-state]")?.dataset.historyState;
}

function note(): string {
  return host.querySelector("[data-note]")?.textContent ?? "";
}

function lastSpec(): ChartSpec {
  const chart = mocks.charts[mocks.charts.length - 1];
  return chart.update.mock.calls.at(-1)?.[0] as ChartSpec;
}

function open(r: HistoryRoute, source: HistorySource, extra: { onClose?: () => void; onRange?: (r: HistoryRange) => void } = {}) {
  view = openHistoryView(host, {
    route: r,
    source,
    refreshSeconds: 60,
    doc: document,
    onClose: extra.onClose ?? (() => {}),
    onRange: extra.onRange ?? (() => {}),
  });
  return view;
}

beforeEach(() => {
  mocks.charts.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  view?.close();
  view = null;
  vi.useRealTimers();
});

describe("history view", () => {
  it("renders the header, range buttons, close and reset-zoom controls", () => {
    open(route("firestore:yard", "readsPerMin", "7d"), { load: () => new Promise(() => {}) });
    expect(host.querySelector("h2")?.textContent).toBe("yard · Reads/min");
    const ranges = [...host.querySelectorAll<HTMLButtonElement>("button[data-range]")];
    expect(ranges.map((b) => b.dataset.range)).toEqual(["1h", "6h", "24h", "7d", "30d", "6w"]);
    expect(ranges.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "true", "false", "false"]);
    expect(host.querySelector('button[data-action="close"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('button[data-action="reset-zoom"]')?.click();
    expect(mocks.charts[0].resetZoom).toHaveBeenCalledTimes(1);
    expect(mocks.charts[0].spec.zoom).toBe(true);
    expect(mocks.charts[0].spec.timeAxis).toBe(true);
  });

  it("shows loading until the first answer, then the points and a summary", async () => {
    let resolve: (value: HistoryResponse) => void = () => {};
    const r = route("firestore:yard", "readsPerMin");
    open(r, { load: () => new Promise((res) => (resolve = res)) });
    expect(state()).toBe("loading");
    resolve(
      response(r, [
        { t: new Date(NOW - 86400000 + 300000).toISOString(), v: 2 },
        { t: new Date(NOW - 300000).toISOString(), v: 4 },
        { t: new Date(NOW).toISOString(), v: 6 },
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe("ok");
    expect((lastSpec().datasets[0].data as TimePoint[]).map((p) => p.y)).toEqual([2, 4, 6]);
    expect(host.querySelector("[data-summary]")?.textContent).toBe("min 2 · avg 4 · max 6 (per minute)");
    expect(note()).toBe("");
    expect(mocks.charts).toHaveLength(1);
  });

  it("empty counts show a flat 0 line", async () => {
    const r = route("function2:pyWeeklyAccounts", "reqPerMin");
    open(r, { load: async () => response(r, []) });
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe("empty");
    expect(lastSpec().datasets[0].data).toEqual([
      { x: NOW - 86400000, y: 0 },
      { x: NOW, y: 0 },
    ]);
    expect(note()).toBe(NO_ACTIVITY_TEXT);
  });

  it("empty CPU/RAM shows the idle explanation, never a 0 line", async () => {
    for (const metric of ["cpuPct", "memPct"]) {
      const r = route("function2:pyWeeklyAccounts", metric);
      open(r, { load: async () => response(r, [], { unit: "%" }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(state()).toBe("empty");
      expect(lastSpec().datasets[0].data).toEqual([]);
      expect(note()).toBe(IDLE_TEXT);
      view?.close();
    }
  });

  it("empty bytesStored explains the daily measurement", async () => {
    const r = route("bucket:mineral-proton-438104-g8-paraliyard", "bytesStored", "1h");
    open(r, { load: async () => response(r, [], { unit: "bytes" }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(note()).toBe(DAILY_TEXT);
  });

  it("shows data from <IST time> when the first point is later than the range start", async () => {
    const r = route("firestore:yard", "readsPerMin", "30d");
    const first = NOW - 10 * 86400000;
    open(r, { load: async () => response(r, [{ t: new Date(first).toISOString(), v: 1 }]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(note()).toMatch(/^data from .+ IST$/);
    // 25 Sep 08:30 UTC is 14:00 IST.
    expect(note()).toContain("25");
    expect(note()).toContain("14:00");
  });

  it("shows the error state and retries with backoff", async () => {
    const load = vi.fn(async () => {
      throw new Error("history request failed with status 502");
    });
    open(route("firestore:yard", "readsPerMin", "1h"), { load });
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe("error");
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119 * SECOND);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("marks a stale answer", async () => {
    const r = route("firestore:yard", "readsPerMin");
    open(r, { load: async () => response(r, [{ t: new Date(NOW).toISOString(), v: 1 }], { stale: true }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe("stale");
  });

  it("refreshes 1h/6h every refreshSeconds and 7d/30d/6w every 300 s", async () => {
    const cases: [HistoryRange, number][] = [
      ["1h", 60],
      ["6h", 60],
      ["24h", 300],
      ["7d", 300],
      ["30d", 300],
      ["6w", 300],
    ];
    for (const [range, seconds] of cases) {
      const r = route("firestore:yard", "readsPerMin", range);
      const load = vi.fn(async () => response(r, []));
      open(r, { load });
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(seconds * SECOND - 1);
      expect(load, range).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(load, range).toHaveBeenCalledTimes(2);
      view?.close();
    }
    expect(historyIntervalMs("1h", 90)).toBe(90000);
    expect(historyIntervalMs("6w", 30)).toBe(LONG_RANGE_INTERVAL_MS);
  });

  it("close() stops polling and empties the host", async () => {
    const r = route("firestore:yard", "readsPerMin", "1h");
    const load = vi.fn(async () => response(r, []));
    const v = open(r, { load });
    await vi.advanceTimersByTimeAsync(0);
    v.close();
    expect(host.children).toHaveLength(0);
    expect(host.hidden).toBe(true);
    expect(mocks.charts[0].destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * SECOND);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("calls onClose and onRange from the controls", () => {
    const onClose = vi.fn();
    const onRange = vi.fn();
    open(route("firestore:yard", "readsPerMin"), { load: () => new Promise(() => {}) }, { onClose, onRange });
    host.querySelector<HTMLButtonElement>('button[data-range="7d"]')?.click();
    host.querySelector<HTMLButtonElement>('button[data-range="24h"]')?.click();
    host.querySelector<HTMLButtonElement>('button[data-action="close"]')?.click();
    expect(onRange.mock.calls).toEqual([["7d"]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("summarize gives min, avg and max or null", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([{ t: "a", v: 1 }, { t: "b", v: 3 }])).toEqual({ min: 1, avg: 2, max: 3 });
  });
});
