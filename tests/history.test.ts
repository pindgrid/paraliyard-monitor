import { describe, expect, it } from "vitest";
import { demoModel } from "../src/demo";
import { HOUR, MIN } from "../src/format";
import { BUCKET, RANGE_MS, RANGES, RUN_RANGES, SOURCE_STEP, bucketize, groupFor, isRange } from "../src/history";

const NOW = Date.UTC(2026, 9, 7, 6, 0);
const m = demoModel(NOW);

describe("ranges", () => {
  it("come from the allowlist the backend test checks against functions/src/history.js", () => {
    expect(RANGE_MS["24h"]).toBe(86400 * 1000);
    expect(RANGE_MS["6w"]).toBe(42 * 86400 * 1000);
    expect(SOURCE_STEP).toEqual({ "1h": 60e3, "6h": 60e3, "24h": 300e3, "7d": 3600e3, "30d": 10800e3, "6w": 14400e3 });
  });

  it("keeps every chart at 60-120 buckets", () => {
    for (const r of RANGES) {
      const n = RANGE_MS[r] / BUCKET[r];
      expect(n, r).toBeGreaterThanOrEqual(60);
      expect(n, r).toBeLessThanOrEqual(120);
      expect(BUCKET[r] % SOURCE_STEP[r], r).toBe(0);
    }
    expect(RUN_RANGES).toEqual(["7d", "30d", "6w"]);
    expect(isRange("24h")).toBe(true);
    expect(isRange("999d")).toBe(false);
  });
});

describe("bucketize", () => {
  const from = NOW - HOUR;

  it("bar: average per source slot (missing slots are 0) and the busiest point", () => {
    const pts = [
      { t: from + 10 * MIN, v: 6 },
      { t: from + 12 * MIN, v: 9 },
    ];
    const b = bucketize(pts, from, NOW, 15 * MIN, 5 * MIN, "bar");
    expect(b).toHaveLength(4);
    expect(b[0].y).toBe(5);
    expect(b[0].pk).toBe(9);
    expect(b[1].y).toBe(0);
    expect(b[1].pk).toBe(0);
  });

  it("bar: nothing before the first point", () => {
    const b = bucketize([{ t: from + 40 * MIN, v: 3 }], from, NOW, 15 * MIN, 5 * MIN, "bar");
    expect(b[0].y).toBeNull();
    expect(b[2].y).toBe(1);
  });

  it("step carries the last level forward; max keeps gaps", () => {
    const pts = [
      { t: from + 5 * MIN, v: 100 },
      { t: from + 35 * MIN, v: 120 },
    ];
    expect(bucketize(pts, from, NOW, 15 * MIN, 5 * MIN, "step").map((b) => b.y)).toEqual([100, 100, 120, 120]);
    expect(bucketize(pts, from, NOW, 15 * MIN, 5 * MIN, "max").map((b) => b.y)).toEqual([100, null, 120, null]);
  });
});

describe("groupFor", () => {
  it("opens every kind of element with one metric per panel and no dual axes", () => {
    const openers = [
      "fs",
      "sum:functions",
      "sum:storage",
      "sum:hosting",
      ...m.functions.map((f) => `fn:${f.id}`),
      ...m.buckets.map((b) => `st:${b.id}`),
      ...m.sites.map((s) => `site:${s.id}`),
    ];
    for (const open of openers) {
      const g = groupFor(open, m);
      expect(g, open).not.toBeNull();
      expect(g!.panels.length, open).toBeGreaterThan(0);
      for (const p of g!.panels) {
        expect(["bar", "line", "step"]).toContain(p.type);
        const colors = p.series.map((s) => s.color);
        expect(new Set(colors).size, `${open} ${p.title}`).toBe(colors.length);
      }
    }
  });

  it("shows CPU and RAM as % lines and errors stacked on requests", () => {
    const g = groupFor("fn:function2:pyMintOnCrewClaim", m)!;
    expect(g.panels.map((p) => p.type)).toEqual(["bar", "line", "step"]);
    expect(g.panels[0].stacked).toBe(true);
    expect(g.panels[0].series[0].minus).toBe(1);
    expect(g.panels[1].unit).toBe("pct");
  });

  it("opens scheduled-run history for jobs, and nothing for unknown ids", () => {
    const g = groupFor("job:scheduler:pyNightlyExport", m)!;
    expect(g.runs?.name).toBe("pyNightlyExport");
    expect(g.defaultRange).toBe("30d");
    expect(groupFor("fn:nope", m)).toBeNull();
    expect(groupFor("whatever", m)).toBeNull();
  });
});
