import { describe, expect, it, vi } from "vitest";
import type { TooltipItem } from "chart.js";
import { bucketFor, sourceStepFor, timeTicks, Y_AXIS_WIDTH } from "../src/chart-shape";
import { drawerConfig, type DrawerChartSpec } from "../src/drawer-chart";
import { groupFor } from "../src/drawer-groups";
import { fmt, istDateTime, istTick } from "../src/fmt";
import { panelConfig, type PanelContext } from "../src/panel-config";
import type { HistoryRange } from "../src/types";

// The real adapter's pure config (tests/setup.ts mocks the module elsewhere).
vi.unmock("../src/drawer-chart");

const HOUR = 3600000;
// 5 Oct 2026, 2:35:47 am IST.
const T = Date.UTC(2026, 9, 4, 21, 5, 47);

type Scale = {
  min?: number;
  max?: number;
  position?: string;
  ticks: { maxTicksLimit?: number; stepSize?: number; callback: (v: number, i: number, ticks: { value: number }[]) => string | null };
};

// What the drawer passes for a group, with every series at value(i).
function panelContext(opener: string, range: HistoryRange, value: (i: number) => number, extra: Partial<PanelContext> = {}): PanelContext {
  const group = groupFor(opener)!;
  const rangeMs = { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 168 * HOUR, "30d": 720 * HOUR, "6w": 1008 * HOUR }[range];
  const step = sourceStepFor(range);
  const from = T - rangeMs;
  const n = Math.floor(rangeMs / step);
  const raw = group.series.map(() => Array.from({ length: n }, (_, i) => ({ x: from + (i + 1) * step, y: value(i) })));
  return {
    from,
    to: T,
    bucketMs: bucketFor(range),
    sourceStepMs: step,
    raw,
    visible: [],
    band: null,
    formatTick: (ms) => istTick(ms, rangeMs),
    ...extra,
  };
}

function scalesOf(opener: string, panel: number, ctx: PanelContext) {
  const cfg = panelConfig(groupFor(opener)!.panels[panel], ctx);
  return (cfg.options as unknown as { scales: Record<string, Scale> }).scales;
}

describe("drawer panels", () => {
  it("label 1h x ticks with short 12-hour times and keep one y axis", () => {
    const scales = scalesOf("fs", 0, panelContext("fs", "1h", () => 51.64));
    expect(scales.x.ticks.callback(T, 0, [])).toBe("2:35 am");
    expect(scales.x.min).toBe(T - HOUR);
    expect(scales.x.max).toBe(T);
    expect(Object.keys(scales).sort()).toEqual(["x", "y"]);
  });

  it("every drawer byte axis spans at least 1 kB and never repeats a tick label", () => {
    const cases: [string, number][] = [
      ["host", 0],
      ["site:hosting:paraliyard", 0],
      ["sum:bytes", 0],
      ["st:bucket:mineral-proton-438104-g8-paraliyard", 0],
    ];
    for (const [opener, panel] of cases) {
      // All-zero data on every series of the group.
      const y = scalesOf(opener, panel, panelContext(opener, "24h", () => 0)).y;
      expect(y.max, opener).toBeGreaterThanOrEqual(1000);
      expect(y.min, opener).toBe(0);
      const ticks = Array.from({ length: Math.round(y.max! / y.ticks.stepSize!) + 1 }, (_, i) => ({ value: i * y.ticks.stepSize! }));
      expect(ticks.length, opener).toBeLessThanOrEqual(6);
      const labels = ticks.map((t, i) => y.ticks.callback(t.value, i, ticks)).filter((l): l is string => l !== null);
      expect(new Set(labels).size, opener).toBe(labels.length);
      expect(labels, opener).toEqual(["0", "200 B", "400 B", "600 B", "800 B", "1 kB"]);
    }
    // 1st gen memory is drawn as RAM %, on a 0..100 axis.
    const ram = scalesOf("fn:function1:pyCleanupOnAuthDelete", 1, panelContext("fn:function1:pyCleanupOnAuthDelete", "24h", () => 0)).y;
    expect([ram.min, ram.max]).toEqual([0, 100]);
    expect(ram.ticks.callback(40, 0, [{ value: 40 }])).toBe("40 %");
  });

  it("count axes never show decimals", () => {
    const y = scalesOf("fs", 0, panelContext("fs", "24h", (i) => (i === 3 ? 392 : 37.39))).y;
    expect(y.max).toBe(400);
    expect(y.ticks.stepSize).toBe(100);
    const ticks = [0, 100, 200, 300, 400].map((value) => ({ value }));
    const labels = ticks.map((t, i) => y.ticks.callback(t.value, i, ticks));
    expect(labels).toEqual(["0", "100", "200", "300", "400"]);
    expect(y.ticks.maxTicksLimit).toBe(6);
  });

  it("every panel of every drawer group has the shared y width and round time ticks", () => {
    const openers = ["fs", "fn:function2:pyMintOnCrewClaim", "fn:function1:pyCleanupOnAuthDelete", "st:bucket:mineral-proton-438104-g8-paraliyard", "host", "sum:requests", "sum:bytes"];
    for (const opener of openers) {
      const group = groupFor(opener)!;
      group.panels.forEach((panel, p) => {
        const ctx = panelContext(opener, "24h", () => 3, { timeLabels: p === group.panels.length - 1 });
        const scales = scalesOf(opener, p, ctx) as unknown as Record<string, Scale & { afterFit: (s: { width: number }) => void; afterBuildTicks: (s: unknown) => void }>;
        const fake = { width: 12 };
        scales.y.afterFit(fake);
        expect(fake.width, `${opener} ${panel.title}`).toBe(Y_AXIS_WIDTH);
        const x = { min: scales.x.min!, max: scales.x.max!, ticks: [] as { value: number }[] };
        scales.x.afterBuildTicks(x);
        expect(x.ticks.map((t) => t.value), `${opener} ${panel.title}`).toEqual(timeTicks(T - 24 * HOUR, T, 4 * HOUR));
        expect((scales.x.ticks as { display?: boolean }).display, `${opener} ${panel.title}`).toBe(p === group.panels.length - 1);
      });
    }
  });
});

describe("drawerConfig (scheduler runs)", () => {
  const runs: DrawerChartSpec = {
    kind: "bar",
    formatX: istDateTime,
    axes: { y: { title: "seconds", format: fmt.seconds } },
    formats: [fmt.seconds],
    labels: [istDateTime(T)],
    datasets: [{ label: "Run duration (s)", color: "#3E7B4F", data: [{ x: T, y: 12 }], barColors: ["#3E7B4F"] }],
  };
  const options = () =>
    drawerConfig(runs).options as unknown as {
      scales: Record<string, Scale>;
      plugins: { legend: { display: boolean }; tooltip: Record<string, unknown> & { callbacks: { title: (items: unknown[]) => string; label: (item: unknown) => string } } };
    };

  it("has no legend, one y axis and no curve", () => {
    const opts = options();
    expect(opts.plugins.legend.display).toBe(false);
    expect(Object.keys(opts.scales).sort()).toEqual(["x", "y"]);
    expect(opts.scales.y.position).toBeUndefined();
    expect(opts.scales.y.ticks.maxTicksLimit).toBeLessThanOrEqual(5);
    expect(drawerConfig(runs).data.datasets.map((d) => (d as { tension?: number }).tension)).toEqual([0]);
    expect(drawerConfig(runs).data.datasets[0].backgroundColor).toEqual(["#3E7B4F"]);
  });

  it("uses the shared tooltip style with run times and seconds", () => {
    const opts = options();
    expect(opts.plugins.tooltip).toMatchObject({ backgroundColor: "#1F2A1E", titleColor: "#F6F7F1", padding: 10, cornerRadius: 6 });
    const item = { parsed: { x: 0, y: 12 }, label: istDateTime(T), datasetIndex: 0, dataset: { label: "Run duration (s)" } } as unknown as TooltipItem<"bar">;
    expect(opts.plugins.tooltip.callbacks.title([item])).toBe("5 Oct 2026, 2:35:47 am");
    expect(opts.plugins.tooltip.callbacks.label(item)).toBe(" Run duration (s): 12s");
    const ticks = [0, 10, 20].map((value) => ({ value }));
    expect(ticks.map((t, i) => opts.scales.y.ticks.callback(t.value, i, ticks))).toEqual(["0s", "10s", "20s"]);
  });
});
