import { describe, expect, it } from "vitest";
import { chartSvg, donut, scaleFor, spark, tickLabel, timeTicks, type ChartSpec } from "../src/charts";
import { HOUR, MIN, istDayStart } from "../src/format";

const T0 = Date.UTC(2026, 9, 6, 20, 0);
const buckets = Array.from({ length: 30 }, (_, i) => ({ start: T0 + i * MIN, end: T0 + (i + 1) * MIN }));
const spec = (over: Partial<ChartSpec>): ChartSpec => ({
  type: "bar",
  unit: "count",
  height: 200,
  from: T0,
  to: T0 + 30 * MIN,
  buckets,
  series: [{ label: "Reads", color: "var(--c-reads)", values: buckets.map((_, i) => (i === 10 ? 489 : 3)) }],
  ...over,
});

describe("axes", () => {
  it("rounds to 1, 2, 2.5 or 5 × 10^n, whole steps for small counts, 0-100 for %", () => {
    expect(scaleFor(489, "count")).toEqual({ max: 600, step: 200 });
    expect(scaleFor(878, "count")).toEqual({ max: 1000, step: 250 });
    expect(scaleFor(3, "count")).toEqual({ max: 3, step: 1 });
    expect(scaleFor(0.4, "count")).toEqual({ max: 0.4, step: 0.1 });
    expect(scaleFor(0, "count")).toEqual({ max: 4, step: 1 });
    expect(scaleFor(55, "pct")).toEqual({ max: 100, step: 25 });
  });

  it("puts byte axes on round steps of the display unit", () => {
    const sc = scaleFor(110e6, "bytes");
    expect(sc.max).toBe(150e6);
    expect(sc.step).toBe(50e6);
    expect([0, 50e6, 100e6, 150e6].map((v) => tickLabel(v, "bytes", sc))).toEqual(["0", "50 MB", "100 MB", "150 MB"]);
    expect(tickLabel(1500, "count", { max: 2000, step: 500 })).toBe("1,500");
    expect(tickLabel(50, "pct", { max: 100, step: 25 })).toBe("50%");
  });

  it("places time ticks on round IST times", () => {
    expect(timeTicks(T0 + 30 * 1000, T0 + 30 * MIN).every((t) => (t - T0) % (5 * MIN) === 0)).toBe(true);
    const day = timeTicks(T0 - 24 * HOUR, T0);
    expect(day.every((t) => (t - istDayStart(t)) % (4 * HOUR) === 0)).toBe(true);
  });
});

describe("chartSvg", () => {
  it("draws one bar per bucket with data, never smoothed, with round y labels", () => {
    const { svg, hasData } = chartSvg(spec({}), 800);
    expect(hasData).toBe(true);
    expect((svg.match(/class="c-bar"/g) ?? []).length).toBe(30);
    expect(svg).not.toMatch(/ d="[^"]*[CQS]/);
    for (const label of ["0", "200", "400", "600"]) expect(svg).toContain(`>${label}</text>`);
  });

  it("stacks series and adds light peak bars only when given", () => {
    const stacked = chartSvg(
      spec({
        stacked: true,
        series: [
          { label: "Writes", color: "var(--c-writes)", values: buckets.map(() => 2) },
          { label: "Deletes", color: "var(--c-deletes)", values: buckets.map(() => 1) },
        ],
      }),
      800,
    );
    expect((stacked.svg.match(/class="c-bar"/g) ?? []).length).toBe(60);
    expect(stacked.svg).not.toContain("c-peak");
    const peaks = chartSvg(spec({ series: [{ label: "Reads", color: "var(--c-reads)", values: buckets.map(() => 2), peaks: buckets.map(() => 9) }] }), 800);
    expect((peaks.svg.match(/class="c-peak"/g) ?? []).length).toBe(30);
  });

  it("draws steps as horizontal-then-vertical lines, with gaps for missing values", () => {
    const values = buckets.map((_, i) => (i < 5 ? null : 40e6 + i));
    const { svg } = chartSvg(spec({ type: "step", unit: "bytes", series: [{ label: "Stored", color: "var(--c-storage)", values, area: true }] }), 800);
    expect((svg.match(/class="c-line"/g) ?? []).length).toBe(1);
    expect(svg).toContain('class="c-area"');
  });

  it("says when there is nothing to show, and labels the no-data band", () => {
    const empty = chartSvg(spec({ series: [{ label: "Reads", color: "x", values: buckets.map(() => 0) }], emptyText: "No activity in this period" }), 800);
    expect(empty.hasData).toBe(false);
    expect(empty.svg).toContain("No activity in this period");
    const idle = chartSvg(spec({ type: "line", unit: "pct", series: [{ label: "CPU", color: "x", values: buckets.map(() => null) }], emptyText: "Idle in this period" }), 800);
    expect(idle.svg).toContain("Idle in this period");
    const band = chartSvg(spec({ band: { to: T0 + 20 * MIN, label: "No data before 18 Sept" } }), 800);
    expect(band.svg).toContain("No data before 18 Sept");
  });

  it("thins out axis labels on small charts so they never overlap", () => {
    const small = chartSvg(spec({ height: 60 }), 280);
    const yLabels = small.svg.match(/class="c-ytick"/g) ?? [];
    expect(yLabels.length).toBeLessThan(4);
    const xLabels = [...small.svg.matchAll(/class="c-xtick"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(xLabels.length).toBeGreaterThan(0);
    expect(xLabels.length).toBeLessThanOrEqual(Math.floor(small.pw / 58) + 1);
    const big = chartSvg(spec({}), 800);
    expect((big.svg.match(/class="c-xtick"/g) ?? []).length).toBeGreaterThan(xLabels.length);
  });

  it("uses theme variables for every colour", () => {
    const { svg } = chartSvg(spec({}), 800);
    expect(svg).toContain("fill:var(--c-reads)");
    expect(svg).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe("small charts", () => {
  it("spark shows idle minutes grey and error minutes red", () => {
    const s = spark([0, 2, 0], "var(--c-req)", { errors: [0, 0, 1] });
    expect(s).toContain("fill:var(--c-idle)");
    expect(s).toContain("fill:var(--c-req)");
    expect(s).toContain("fill:var(--c-err)");
    expect(spark([1, 2, 3], "var(--c-storage)", { type: "line" })).toContain("<path");
  });

  it("donut draws one arc per non-empty part", () => {
    const d = donut([{ value: 62, color: "a" }, { value: 47, color: "b" }, { value: 0, color: "c" }], 148);
    expect((d.match(/stroke-dasharray/g) ?? []).length).toBe(2);
  });
});
