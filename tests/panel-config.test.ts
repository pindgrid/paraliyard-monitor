import { describe, expect, it } from "vitest";
import { GEN1_MEMORY_BYTES, type XYPoint } from "../src/chart-shape";
import { groupFor, type PanelSpec } from "../src/drawer-groups";
import { istTick } from "../src/fmt";
import { bucketTooltip, NO_ACTIVITY, panelConfig, panelData, type PanelContext } from "../src/panel-config";

const MIN = 60000;
const HOUR = 60 * MIN;
// 5 Oct 2026, 2:00 pm IST.
const T = Date.UTC(2026, 9, 5, 8, 30);

interface Dataset {
  type: string;
  label: string;
  seriesIndex: number;
  peak?: boolean;
  stepped?: boolean;
  spanGaps?: boolean;
  tension?: number;
  hidden?: boolean;
  grouped?: boolean;
  order?: number;
  backgroundColor: string;
  data: XYPoint[];
}
interface Options {
  scales: Record<string, { min?: number; max?: number; stacked?: boolean; ticks: { stepSize?: number; callback: (v: number, i: number, t: { value: number }[]) => string | null } }>;
  plugins: {
    legend: { display: boolean; labels: { filter: (item: { datasetIndex: number }, data: { datasets: unknown[] }) => boolean }; onClick?: (...args: unknown[]) => void };
    tooltip: { enabled: boolean };
    yardOverlay: { title: string; band: unknown; empty: string | null };
  };
}

// Every series of a group with a point per 5 minutes over the last 24 hours.
function context(series: number, value: (i: number, s: number) => number | null = () => 1, extra: Partial<PanelContext> = {}): PanelContext {
  const from = T - 24 * HOUR;
  const raw = Array.from({ length: series }, (_, s) => Array.from({ length: 288 }, (_, i) => ({ x: from + (i + 1) * 5 * MIN, y: value(i, s) })));
  return { from, to: T, bucketMs: 15 * MIN, sourceStepMs: 5 * MIN, raw, visible: [], band: null, formatTick: (ms) => istTick(ms, 24 * HOUR), ...extra };
}

function build(panel: PanelSpec, ctx: PanelContext) {
  const cfg = panelConfig(panel, ctx);
  return { type: cfg.type as string, datasets: cfg.data.datasets as unknown as Dataset[], options: cfg.options as unknown as Options };
}

const OPENERS = [
  "fs",
  "fn:function2:pyMintOnCrewClaim",
  "fn:function1:pyCleanupOnAuthDelete",
  "st:bucket:mineral-proton-438104-g8-paraliyard",
  "host",
  "sum:requests",
  "sum:bytes",
];

describe("chart type per metric", () => {
  it("bars for counts and bytes served, stepped lines for levels, 0-100 lines for percentages", () => {
    const seen = new Map<string, string>();
    for (const opener of OPENERS) {
      const group = groupFor(opener)!;
      for (const panel of group.panels) {
        const { type, datasets, options } = build(panel, context(group.series.length));
        for (const d of datasets) {
          const metric = group.series[d.seriesIndex].metric;
          const key = `${opener.startsWith("st:") ? "bucket " : ""}${metric}`;
          if (d.type === "bar") {
            expect(type, key).toBe("bar");
            seen.set(key, "bar");
          } else if (d.stepped) {
            seen.set(key, "stepped");
          } else {
            expect(d.spanGaps, key).toBe(false);
            expect(options.scales.y.min, key).toBe(0);
            expect(options.scales.y.max, key).toBe(100);
            seen.set(key, "pct");
          }
        }
      }
    }
    for (const metric of ["reqPerMin", "errPerMin", "execPerMin", "readsPerMin", "writesPerMin", "deletesPerMin", "bucket reqPerMin", "bytesServed"]) {
      expect(seen.get(metric), metric).toBe("bar");
    }
    for (const metric of ["bytesStored", "instances"]) expect(seen.get(metric), metric).toBe("stepped");
    // 1st gen RAM is drawn as a percentage from memory bytes.
    for (const metric of ["cpuPct", "memPct", "memBytes"]) expect(seen.get(metric), metric).toBe("pct");
  });

  it("1st gen RAM is memBytes as a percentage of the deployed memory", () => {
    const group = groupFor("fn:function1:pyCleanupOnAuthDelete")!;
    const ctx = context(2, (_i, s) => (s === 1 ? GEN1_MEMORY_BYTES / 4 : 0));
    const ram = panelData(group.panels[1], ctx.raw, ctx)[0];
    expect(ram.buckets.every((b) => b.y === 25)).toBe(true);
  });

  it("successful requests are requests minus errors, never below 0", () => {
    const group = groupFor("fn:function2:pyMintOnCrewClaim")!;
    const ctx = context(5, (i, s) => (s === 0 ? 3 : s === 1 ? (i % 3 === 0 ? 5 : 1) : 0));
    const [ok, errors] = panelData(group.panels[0], ctx.raw, ctx);
    // Per 15 min: (0 + 2 + 2) / 3 successful, (5 + 1 + 1) / 3 errors.
    expect(ok.buckets[1].y).toBeCloseTo(4 / 3);
    expect(errors.buckets[1].y).toBeCloseTo(7 / 3);
  });

  it("bars have a light peak twin behind them in the same colour; every dataset has tension 0", () => {
    const group = groupFor("fs")!;
    const { datasets } = build(group.panels[0], context(3));
    expect(datasets.map((d) => [d.label, Boolean(d.peak)])).toEqual([
      ["Reads", false],
      ["Reads", true],
    ]);
    expect(datasets[1]).toMatchObject({ grouped: false, order: 1, backgroundColor: "rgba(176,122,18,0.3)" });
    expect(datasets[0]).toMatchObject({ order: 0, backgroundColor: "#B07A12" });
    expect(datasets.every((d) => d.tension === 0)).toBe(true);
    // 1-minute buckets of 1-minute points: no peak twin.
    const hour = context(3, () => 1, { from: T - HOUR, bucketMs: MIN, sourceStepMs: MIN });
    expect(build(group.panels[0], hour).datasets.map((d) => Boolean(d.peak))).toEqual([false]);
  });

  it("a stacked panel stacks the solid bars and the peaks apart and its axis fits the sums", () => {
    const panel = groupFor("fs")!.panels[1];
    const { datasets, options } = build(panel, context(3, (_i, s) => (s === 1 ? 40 : s === 2 ? 30 : 0)));
    expect(options.scales.x.stacked).toBe(true);
    expect(options.scales.y.stacked).toBe(true);
    expect(datasets.map((d) => (d as unknown as { stack: string }).stack)).toEqual(["avg", "peak", "avg", "peak"]);
    // 40 + 30 per minute, stacked.
    expect(options.scales.y.max).toBe(80);
  });
});

describe("axes, legend and states", () => {
  it("has one y axis with round steps and no title", () => {
    const { options } = build(groupFor("fs")!.panels[0], context(3, (i) => (i === 10 ? 292 : 12)));
    expect(Object.keys(options.scales).sort()).toEqual(["x", "y"]);
    expect(options.scales.y.max).toBe(300);
    expect(options.scales.y.ticks.stepSize).toBe(100);
    const ticks = [0, 100, 200, 300].map((value) => ({ value }));
    expect(ticks.map((t, i) => options.scales.y.ticks.callback(t.value, i, ticks))).toEqual(["0", "100", "200", "300"]);
    expect(options.scales.x.min).toBe(T - 24 * HOUR);
    expect(options.scales.x.max).toBe(T);
    expect(options.scales.x.ticks.callback(T, 0, [])).toBe("2:00 pm");
  });

  it("shows the legend only with more than one series, without the peak twins", () => {
    for (const opener of OPENERS) {
      const group = groupFor(opener)!;
      for (const panel of group.panels) {
        const { datasets, options } = build(panel, context(group.series.length));
        expect(options.plugins.legend.display, `${opener} ${panel.title}`).toBe(panel.datasets.length > 1);
        const kept = datasets.filter((_d, i) => options.plugins.legend.labels.filter({ datasetIndex: i }, { datasets }));
        expect(kept.every((d) => !d.peak)).toBe(true);
        expect(kept).toHaveLength(panel.datasets.length);
      }
    }
  });

  it("a legend click reports the series index", () => {
    const toggles: number[] = [];
    const group = groupFor("fn:function2:pyMintOnCrewClaim")!;
    const { datasets, options } = build(group.panels[2], context(5, () => 1, { onToggle: (i) => toggles.push(i) }));
    const legend = { chart: { data: { datasets } } };
    options.plugins.legend.onClick!({}, { datasetIndex: 1 }, legend);
    expect(toggles).toEqual([4]);
  });

  it("hidden series start hidden and the internal tooltip is off", () => {
    const group = groupFor("fn:function2:pyMintOnCrewClaim")!;
    const { datasets, options } = build(group.panels[2], context(5, () => 1, { visible: [true, true, true, false, true] }));
    expect(datasets.map((d) => Boolean(d.hidden))).toEqual([true, false]);
    expect(options.plugins.tooltip.enabled).toBe(false);
  });

  it("carries the 'No data before' band and a 'No activity' state that keeps the axis", () => {
    const band = { from: T - 24 * HOUR, to: T - 2 * HOUR, label: "No data before 5 Oct" };
    const zero = build(groupFor("fs")!.panels[0], context(3, () => 0, { band }));
    expect(zero.options.plugins.yardOverlay).toEqual({ title: "Reads per minute", band, empty: NO_ACTIVITY });
    expect(zero.options.scales.y.max).toBe(1);
    const bytes = build(groupFor("host")!.panels[0], context(3, () => 0));
    expect(bytes.options.plugins.yardOverlay.empty).toBe(NO_ACTIVITY);
    expect(bytes.options.scales.y.max).toBe(1000);
    const busy = build(groupFor("fs")!.panels[0], context(3));
    expect(busy.options.plugins.yardOverlay.empty).toBeNull();
    expect(busy.options.plugins.yardOverlay.band).toBeNull();
  });
});

describe("bucketTooltip", () => {
  it("titles the bucket's IST span and lists average and peak with units for bars", () => {
    const group = groupFor("fs")!;
    // 10:15 am IST bucket of a range ending at 2:00 pm.
    const ctx = context(3, (i, s) => (s === 0 ? (i % 3 === 2 ? 40 : 1) : s === 1 ? 2 : 0));
    const data = group.panels.map((p) => panelData(p, ctx.raw, ctx));
    const start = Date.UTC(2026, 9, 5, 4, 45);
    const index = data[0][0].buckets.findIndex((b) => b.start === start);
    const tip = bucketTooltip(group.panels, data, index, ctx)!;
    expect(tip.title).toBe("10:15-10:30 am");
    expect(tip.lines).toEqual(["Reads: avg 14 · peak 40 /min", "Writes: avg 2 · peak 2 /min", "Deletes: avg 0 · peak 0 /min"]);
    // Hidden series are left out; levels and percentages show one value.
    const fn = groupFor("fn:function2:pyMintOnCrewClaim")!;
    const fctx = context(5, (_i, s) => (s === 3 ? 40 : 2));
    const fdata = fn.panels.map((p) => panelData(p, fctx.raw, fctx));
    expect(bucketTooltip(fn.panels, fdata, index, fctx, [true, false, true, true, true])!.lines).toEqual([
      "Successful: avg 0 · peak 0 /min",
      "Instances: 2",
      "CPU: 40 %",
      "RAM: 2 %",
    ]);
    expect(bucketTooltip(fn.panels, fdata, 9999, fctx)).toBeNull();
  });
});
