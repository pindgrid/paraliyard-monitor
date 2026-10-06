import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GEN1_MEMORY_BYTES,
  LIVE_BUCKETS,
  LIVE_BUCKET_MS,
  allZero,
  axisTicks,
  bucketFor,
  bucketNote,
  bucketSpan,
  bucketStarts,
  bucketize,
  bytesTick,
  countTick,
  firstDataAt,
  niceAxis,
  noDataBand,
  pctTick,
  sourceStepFor,
  type XYPoint,
} from "../src/chart-shape";
import { istDay } from "../src/fmt";
import type { HistoryRange } from "../src/types";

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 5 Oct 2026, 2:00 pm IST.
const T = Date.UTC(2026, 9, 5, 8, 30);

describe("bucket sizes", () => {
  it("maps each range to its bucket and source step", () => {
    const expected: [HistoryRange, number, number][] = [
      ["1h", MIN, MIN],
      ["6h", 5 * MIN, MIN],
      ["24h", 15 * MIN, 5 * MIN],
      ["7d", 2 * HOUR, HOUR],
      ["30d", 6 * HOUR, 3 * HOUR],
      ["6w", 12 * HOUR, 4 * HOUR],
    ];
    for (const [range, bucket, step] of expected) {
      expect(bucketFor(range), range).toBe(bucket);
      expect(sourceStepFor(range), range).toBe(step);
    }
  });

  it("hero and Hosting overview: exactly 30 one-minute buckets", () => {
    expect(LIVE_BUCKET_MS).toBe(MIN);
    const from = T - 30 * MIN;
    const points: XYPoint[] = Array.from({ length: 30 }, (_, i) => ({ x: from + (i + 1) * MIN, y: i }));
    const buckets = bucketize(points, { from, to: T, bucketMs: LIVE_BUCKET_MS, sourceStepMs: MIN, mode: "bar" });
    expect(buckets).toHaveLength(LIVE_BUCKETS);
    expect(buckets.map((b) => b.y)).toEqual(points.map((p) => p.y));
    expect(buckets[0].x).toBe(from);
    expect(buckets[29].end).toBe(T);
  });

  it("covers each drawer range with whole buckets", () => {
    for (const range of ["1h", "6h", "24h", "7d", "30d", "6w"] as HistoryRange[]) {
      const seconds = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "6w": 3628800 }[range];
      const starts = bucketStarts(T - seconds * 1000, T, bucketFor(range));
      expect(starts[0], range).toBeLessThanOrEqual(T - seconds * 1000);
      expect(starts[starts.length - 1] + bucketFor(range), range).toBeGreaterThanOrEqual(T);
      expect(starts.length, range).toBeLessThanOrEqual(Math.ceil((seconds * 1000) / bucketFor(range)) + 1);
    }
  });
});

describe("bucketize", () => {
  // 24h shape: 15-minute buckets of 5-minute points.
  const opts = { from: T, to: T + 30 * MIN, bucketMs: 15 * MIN, sourceStepMs: 5 * MIN };
  const points: XYPoint[] = [
    { x: T + 5 * MIN, y: 3 },
    { x: T + 10 * MIN, y: 6 },
    { x: T + 15 * MIN, y: 9 },
    // Second bucket: one point, two missing.
    { x: T + 20 * MIN, y: 4 },
  ];

  it("bar mode: average over the source slots and the busiest point; missing count points count as 0", () => {
    const buckets = bucketize(points, { ...opts, mode: "bar" });
    expect(buckets.map((b) => [b.start, b.end])).toEqual([
      [T, T + 15 * MIN],
      [T + 15 * MIN, T + 30 * MIN],
    ]);
    expect(buckets[0].y).toBe(6);
    expect(buckets[0].peak).toBe(9);
    expect(buckets[1].y).toBeCloseTo(4 / 3);
    expect(buckets[1].peak).toBe(4);
  });

  it("level mode: the last value; pct mode: the highest; missing buckets are null", () => {
    const level = bucketize(points, { ...opts, to: T + 45 * MIN, mode: "level" });
    expect(level.map((b) => b.y)).toEqual([9, 4, null]);
    const pct = bucketize(points, { ...opts, to: T + 45 * MIN, mode: "pct" });
    expect(pct.map((b) => b.y)).toEqual([9, 4, null]);
    expect(pct.every((b) => b.peak === null)).toBe(true);
    // A bar bucket with slots but no points is 0, not null.
    const bars = bucketize(points, { ...opts, to: T + 45 * MIN, mode: "bar" });
    expect(bars[2].y).toBe(0);
    expect(bars[2].peak).toBe(0);
    // A series with no points at all (not loaded) is unknown, not zero.
    expect(bucketize([], { ...opts, mode: "bar" }).map((b) => b.y)).toEqual([null, null]);
  });

  it("divides a partial first and last bucket by the slots they cover", () => {
    const from = T + 5 * MIN;
    const to = T + 25 * MIN;
    const pts: XYPoint[] = [
      // At the range start: outside the range.
      { x: T + 5 * MIN, y: 100 },
      { x: T + 10 * MIN, y: 2 },
      { x: T + 15 * MIN, y: 4 },
      { x: T + 20 * MIN, y: 6 },
      { x: T + 25 * MIN, y: 8 },
    ];
    const buckets = bucketize(pts, { from, to, bucketMs: 15 * MIN, sourceStepMs: 5 * MIN, mode: "bar" });
    expect(buckets.map((b) => b.start)).toEqual([T, T + 15 * MIN]);
    expect(buckets.map((b) => b.y)).toEqual([3, 7]);
    expect(buckets.map((b) => b.peak)).toEqual([4, 8]);
  });

  it("a live point lands in the last bucket without adding buckets", () => {
    const from = T - HOUR;
    const pts: XYPoint[] = Array.from({ length: 60 }, (_, i) => ({ x: from + (i + 1) * MIN, y: 1 }));
    const before = bucketize(pts, { from, to: T, bucketMs: MIN, sourceStepMs: MIN, mode: "bar" });
    const after = bucketize([...pts.slice(0, -1), { x: T, y: 5 }], { from, to: T, bucketMs: MIN, sourceStepMs: MIN, mode: "bar" });
    expect(after).toHaveLength(before.length);
    expect(after[after.length - 1].y).toBe(5);
  });
});

describe("niceAxis and ticks", () => {
  it("0-292 gives 0, 100, 200, 300 and 0-12 gives steps of 5", () => {
    expect(axisTicks(niceAxis(292, "count"))).toEqual([0, 100, 200, 300]);
    const twelve = niceAxis(12, "count");
    expect(twelve.step).toBe(5);
    expect(axisTicks(twelve)).toEqual([0, 5, 10, 15]);
  });

  it("never has more than 5 ticks, reaches the data and uses round steps", () => {
    for (const unit of ["count", "bytes"] as const) {
      for (const max of [0, 0.4, 1, 3, 7, 12, 37.39, 99, 101, 292, 499.6, 1234, 98765, 4.3e7, 2.1e9]) {
        const axis = niceAxis(max, unit);
        const ticks = axisTicks(axis);
        expect(ticks.length, `${unit} ${max}`).toBeLessThanOrEqual(5);
        expect(axis.max, `${unit} ${max}`).toBeGreaterThanOrEqual(max);
        expect(Number.isInteger(axis.step), `${unit} ${max}`).toBe(true);
        const mantissa = axis.step / 10 ** Math.floor(Math.log10(axis.step));
        expect([1, 2, 2.5, 5], `${unit} ${max}`).toContain(Number(mantissa.toFixed(6)));
      }
    }
    expect(axisTicks(niceAxis(37, "pct"))).toEqual([0, 25, 50, 75, 100]);
  });

  it("all-zero data keeps an axis: 0..1 for counts, 0..1 kB for bytes", () => {
    expect(niceAxis(0, "count").max).toBe(1);
    expect(niceAxis(0, "bytes").max).toBe(1000);
  });

  it("formats counts without needless decimals, bytes with units and percentages with a space", () => {
    expect(countTick(500)).toBe("500");
    expect(countTick(1250)).toBe("1,250");
    expect(countTick(0.5)).toBe("0.5");
    expect(bytesTick(12e6)).toBe("12 MB");
    expect(bytesTick(1500)).toBe("1.5 kB");
    expect(bytesTick(1000)).toBe("1 kB");
    expect(bytesTick(250)).toBe("250 B");
    expect(bytesTick(0)).toBe("0");
    expect(pctTick(40)).toBe("40 %");
    for (const unit of ["count", "bytes"] as const) {
      const labels = axisTicks(niceAxis(0, unit)).map(unit === "bytes" ? bytesTick : countTick);
      expect(new Set(labels).size, unit).toBe(labels.length);
      expect(labels.some((l) => l.includes(".00")), unit).toBe(false);
    }
  });
});

describe("texts", () => {
  it("bucketSpan reads like 10:15-10:30 am in IST", () => {
    // 10:15 am IST.
    const start = Date.UTC(2026, 9, 5, 4, 45);
    expect(bucketSpan(start, start + 15 * MIN, DAY)).toBe("10:15-10:30 am");
    expect(bucketSpan(start + 90 * MIN, start + 105 * MIN, DAY)).toBe("11:45 am-12:00 pm");
    expect(bucketSpan(start, start + 2 * HOUR, 7 * DAY)).toBe("5 Oct, 10:15 am-12:15 pm");
  });

  it("a group whose first point is after the range start gets a 'No data before' band", () => {
    const from = T - 30 * DAY;
    const first = T - 24 * DAY;
    const series: XYPoint[][] = [[], [{ x: first + DAY, y: 1 }, { x: first, y: 0 }], [{ x: first + HOUR, y: null }]];
    expect(firstDataAt(series)).toBe(first);
    expect(noDataBand(from, first, 6 * HOUR)).toEqual({ from, to: first, label: `No data before ${istDay(first)}` });
    // Within one bucket of the start: no band.
    expect(noDataBand(from, from + 6 * HOUR, 6 * HOUR)).toBeNull();
    expect(noDataBand(from, null, 6 * HOUR)).toBeNull();
  });

  it("allZero is true only for numbers that are all 0", () => {
    expect(allZero([0, null, 0])).toBe(true);
    expect(allZero([0, 1])).toBe(false);
    expect(allZero([null, null])).toBe(false);
  });

  it("explains each range's buckets", () => {
    expect(bucketNote("1h", ["bar"])).toBe("Each bar is one minute.");
    expect(bucketNote("6h", ["bar"])).toBe("Solid bar: average per 5 min. Light bar: busiest minute.");
    expect(bucketNote("24h", ["bar"])).toBe("Solid bar: average per 15 min. Light bar: busiest 5 min.");
    expect(bucketNote("7d", ["bar"])).toBe("Solid bar: average per 2 h. Light bar: busiest hour.");
    expect(bucketNote("30d", ["bar"])).toBe("Solid bar: average per 6 h. Light bar: busiest 3 h.");
    expect(bucketNote("6w", ["bar"])).toBe("Solid bar: average per 12 h. Light bar: busiest 4 h.");
    expect(bucketNote("24h", ["level", "bar"])).toBe("Solid bar: average per 15 min. Light bar: busiest 5 min. Lines show the last value in each 15 min.");
    expect(bucketNote("30d", ["pct"])).toBe("Lines show the highest value in each 6 h.");
  });
});

describe("GEN1_MEMORY_BYTES", () => {
  it("matches functions/src/constants.js", () => {
    const text = readFileSync("functions/src/constants.js", "utf8");
    expect(text).toMatch(/const GEN1_MEMORY_BYTES = 512 \* 1024 \* 1024;/);
    expect(GEN1_MEMORY_BYTES).toBe(512 * 1024 * 1024);
  });
});
