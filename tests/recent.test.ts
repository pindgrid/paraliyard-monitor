import { describe, expect, it } from "vitest";
import {
  activityCells,
  addSeries,
  cellAlpha,
  isRunningNow,
  latestValue,
  peakOf,
  recentSeries,
  requestSeries,
  sumOf,
} from "../src/recent";
import type { Kind, MetricRecord, ServiceMetrics } from "../src/types";

const zeros = () => new Array<number>(30).fill(0);

function svc(kind: Kind, series: Record<string, (number | null)[] | null>, metrics: MetricRecord = {}): ServiceMetrics {
  return {
    id: `${kind}:x`,
    kind,
    name: "x",
    metrics,
    trend: { points: [] },
    trends: {},
    recent: { from: "2026-10-05T08:00:00.000Z", stepSeconds: 60, series },
  };
}

describe("recent values", () => {
  it("now is the newest minute; sums and peaks cover the 30 minutes", () => {
    const reads = zeros();
    reads[3] = 9;
    reads[29] = 4;
    const s = svc("firestore", { readsPerMin: reads, writesPerMin: null });
    expect(latestValue(recentSeries(s, "readsPerMin"))).toBe(4);
    expect(sumOf(recentSeries(s, "readsPerMin"))).toBe(13);
    expect(peakOf(recentSeries(s, "readsPerMin"))).toBe(9);
    // A failed series stays unknown.
    expect(latestValue(recentSeries(s, "writesPerMin"))).toBeNull();
    expect(sumOf(recentSeries(s, "writesPerMin"))).toBeNull();
    expect(peakOf(recentSeries(s, "writesPerMin"))).toBeNull();
    expect(recentSeries(s, "nope")).toBeNull();
    expect(recentSeries(undefined, "readsPerMin")).toBeNull();
  });

  it("addSeries sums minute by minute and is null only when all are null", () => {
    expect(addSeries([[1, 2, null], [3, null, 1], null])).toEqual([4, 2, 1]);
    expect(addSeries([null, null])).toBeNull();
    expect(addSeries([])).toBeNull();
  });
});

describe("isRunningNow", () => {
  it("2nd gen: latest requests > 0 or instances > 0", () => {
    const idle = svc("function2", { reqPerMin: zeros(), errPerMin: zeros() }, { instances: 0 });
    expect(isRunningNow(idle)).toBe(false);
    const req = zeros();
    req[29] = 2;
    expect(isRunningNow(svc("function2", { reqPerMin: req, errPerMin: zeros() }, { instances: 0 }))).toBe(true);
    expect(isRunningNow(svc("function2", { reqPerMin: zeros(), errPerMin: zeros() }, { instances: 1 }))).toBe(true);
    // Requests earlier in the window are not "now".
    const earlier = zeros();
    earlier[10] = 5;
    expect(isRunningNow(svc("function2", { reqPerMin: earlier, errPerMin: zeros() }, { instances: 0 }))).toBe(false);
  });

  it("1st gen: latest executions > 0", () => {
    const exec = zeros();
    expect(isRunningNow(svc("function1", { execPerMin: exec }))).toBe(false);
    exec[29] = 1;
    expect(isRunningNow(svc("function1", { execPerMin: exec }))).toBe(true);
    expect(requestSeries(svc("function1", { execPerMin: exec }))).toBe(exec);
    expect(isRunningNow(svc("firestore", { readsPerMin: exec }))).toBe(false);
  });
});

describe("activityCells", () => {
  it("straw opacity scales with requests, ember marks errors, idle for 0", () => {
    const req = zeros();
    const err = zeros();
    req[0] = 1;
    req[1] = 5;
    req[2] = 20;
    req[3] = 2;
    err[3] = 1;
    const cells = activityCells(req, err);
    expect(cells).toHaveLength(30);
    expect(cells[0]).toEqual({ state: "on", alpha: cellAlpha(1) });
    expect(cells[0].alpha).toBeCloseTo(0.5);
    expect(cells[1].alpha).toBe(1);
    expect(cells[2].alpha).toBe(1);
    expect(cells[3]).toEqual({ state: "err", alpha: 1 });
    expect(cells[4]).toEqual({ state: "idle", alpha: 0 });
    expect(cells[0].alpha).toBeLessThan(cells[1].alpha);
  });

  it("unknown series give unknown cells, errors still show", () => {
    expect(activityCells(null, null).every((c) => c.state === "none")).toBe(true);
    const err = zeros();
    err[5] = 2;
    const cells = activityCells(null, err);
    expect(cells[5].state).toBe("err");
    expect(cells[6].state).toBe("none");
  });
});
