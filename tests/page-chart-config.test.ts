import { beforeEach, describe, expect, it } from "vitest";
import type { TooltipItem } from "chart.js";
import {
  applyTheme,
  bytesTick,
  FONT_FAMILY,
  heroConfig,
  heroData,
  heroTick,
  heroTooltipTitle,
  hostBytesTick,
  hostConfig,
  hostLabel,
  INK,
  INK_3,
  rateLabel,
  RULE,
  SURFACE,
  tooltipStyle,
} from "../src/page-chart-config";
import { createMockSource } from "../src/source";
import type { MetricsResponse, ServiceMetrics } from "../src/types";

// 5 Oct 2026, 10:36:00 pm IST.
const T = Date.UTC(2026, 9, 5, 17, 6, 0);

let data: MetricsResponse;
const fs = () => data.services.find((s) => s.kind === "firestore") as ServiceMetrics;
const sites = () => data.services.filter((s) => s.kind === "hosting");

// Minimal tooltip items: only the fields the callbacks read.
const lineItem = (label: string, x: number, y: number) =>
  ({ parsed: { x, y }, dataset: { label } }) as unknown as TooltipItem<"line">;
const barItem = (label: string, y: number) => ({ parsed: { x: 0, y }, dataset: { label } }) as unknown as TooltipItem<"bar">;

beforeEach(async () => {
  data = await createMockSource(() => T).load();
});

describe("theme", () => {
  it("applyTheme sets the font, size, ink-3 colour and rule border", () => {
    const defaults = { font: {} as { family?: string; size?: number }, color: "", borderColor: "" };
    applyTheme(defaults);
    expect(defaults.font.family).toBe(FONT_FAMILY);
    expect(FONT_FAMILY).toBe('"Archivo Variable", Archivo, "Helvetica Neue", Arial, sans-serif');
    expect(defaults.font.size).toBe(12);
    expect(defaults.color).toBe(INK_3);
    expect(defaults.borderColor).toBe(RULE);
    expect(INK).toBe("#1F2A1E");
    expect(RULE).toBe("#D0D6C4");
  });

  it("tooltipStyle: ink background, surface text, padding 10, radius 6, boxPadding 4, point style", () => {
    expect(tooltipStyle()).toEqual({
      backgroundColor: "#1F2A1E",
      titleColor: SURFACE,
      bodyColor: SURFACE,
      padding: 10,
      cornerRadius: 6,
      boxPadding: 4,
      usePointStyle: true,
    });
  });
});

type HeroDataset = { label: string; type: string; tension?: number; stack?: string; data: { x: number; y: number | null }[] };
type HeroScale = { min?: number; max?: number; position?: string; stacked?: boolean; ticks: { stepSize?: number; maxTicksLimit?: number; callback: (v: number, i?: number, t?: { value: number }[]) => string | null } };
const heroPanels = (f: ServiceMetrics | undefined) =>
  heroConfig(f, T).panels.map((p) => ({
    weight: p.weight,
    type: p.config.type as string,
    datasets: p.config.data.datasets as unknown as HeroDataset[],
    options: p.config.options as unknown as {
      interaction: unknown;
      scales: Record<string, HeroScale>;
      plugins: { legend: { display: boolean; position: string }; tooltip: { enabled: boolean }; yardOverlay: { title: string } };
    },
  }));

describe("hero config", () => {
  it("is two stacked bar panels: reads at about 70 % of the height, then writes and deletes", () => {
    const [reads, writes] = heroPanels(fs());
    expect(heroConfig(fs(), T).panels).toHaveLength(2);
    expect([reads.weight, writes.weight]).toEqual([0.7, 0.3]);
    expect([reads.type, writes.type]).toEqual(["bar", "bar"]);
    expect(reads.datasets.map((d) => d.label)).toEqual(["Reads"]);
    expect(writes.datasets.map((d) => d.label)).toEqual(["Writes", "Deletes"]);
    expect(reads.options.plugins.yardOverlay.title).toBe("Reads per minute");
    expect(writes.options.plugins.yardOverlay.title).toBe("Writes and deletes per minute");
    // Writes and deletes stack.
    expect(writes.datasets.map((d) => d.stack)).toEqual(["avg", "avg"]);
    expect(writes.options.scales.y.stacked).toBe(true);
  });

  it("has 30 one-minute buckets, one y axis and tension 0 on each panel", () => {
    const readsSeries = fs().recent!.series.readsPerMin!;
    for (const panel of heroPanels(fs())) {
      expect(Object.keys(panel.options.scales).sort()).toEqual(["x", "y"]);
      expect(panel.options.scales.y.position).toBeUndefined();
      for (const d of panel.datasets) {
        expect(d.data).toHaveLength(30);
        expect(d.tension).toBe(0);
      }
      expect(panel.options.scales.x.min).toBe(T - 30 * 60000);
      expect(panel.options.scales.x.max).toBe(T);
      expect(panel.options.scales.x.ticks.callback(T)).toBe("10:36 pm");
      expect(panel.options.scales.y.ticks.maxTicksLimit).toBe(5);
    }
    const reads = heroPanels(fs())[0].datasets[0].data;
    // Bucket centres; the last bucket is the minute ending at generatedAt.
    expect(reads[29]).toEqual({ x: T - 30000, y: readsSeries[29] });
    expect(heroData(fs(), T).map((panel) => panel.map((s) => s.buckets.length))).toEqual([[30], [30, 30]]);
  });

  it("shows a legend only on the writes and deletes panel and uses the shared tooltip", () => {
    const [reads, writes] = heroPanels(fs());
    expect(reads.options.plugins.legend.display).toBe(false);
    expect(writes.options.plugins.legend).toMatchObject({ display: true, position: "bottom" });
    expect(reads.options.interaction).toEqual({ mode: "index", intersect: false });
    expect(reads.options.plugins.tooltip.enabled).toBe(false);
    // The older tooltip callbacks still format the same way.
    expect(heroTick(T)).toBe("10:36 pm");
    expect(heroTooltipTitle([lineItem("Reads/min", T + 7000, 1)])).toBe("10:36:07 pm");
    expect(heroTooltipTitle([])).toBe("");
    expect(rateLabel(lineItem("Reads/min", T, 51.64))).toBe(" Reads/min: 51.64");
  });

  it("has empty buckets when Firestore is missing", () => {
    const panels = heroPanels(undefined);
    expect(panels.flatMap((p) => p.datasets.map((d) => d.data.every((pt) => pt.y === null)))).toEqual([true, true, true]);
    expect(panels[0].datasets[0].data).toHaveLength(30);
  });
});

describe("hosting config", () => {
  it("is a stacked bar chart with one dataset per site and 30 labels", () => {
    const cfg = hostConfig(sites(), T);
    expect(cfg.type).toBe("bar");
    expect(cfg.data.datasets.map((d) => d.label)).toEqual(["paraliyard", "preparaliyard"]);
    expect(cfg.data.labels).toHaveLength(30);
    expect(cfg.data.labels![29]).toBe("10:36 pm");
    expect(cfg.data.labels![0]).toBe("10:07 pm");
    expect(cfg.data.datasets[0].data).toEqual(sites()[0].recent!.series.bytesServed);
    const scales = cfg.options!.scales! as Record<string, Record<string, unknown>>;
    expect(scales.x.stacked).toBe(true);
    expect(scales.y.stacked).toBe(true);
    expect(scales.x.ticks).toMatchObject({ maxTicksLimit: 6 });
    // The y ticks show byte units without needless decimals or repeated labels.
    const yTicks = scales.y.ticks as { callback: (v: number, i: number, ticks: { value: number }[]) => string | null; maxTicksLimit: number };
    expect(yTicks.callback).toBe(hostBytesTick);
    expect(yTicks.callback(1000, 0, [{ value: 1000 }])).toBe("1 kB");
    expect(yTicks.callback(1500, 0, [{ value: 1500 }])).toBe("1.5 kB");
    expect(yTicks.maxTicksLimit).toBe(5);
    expect(bytesTick(1000)).toBe("1.0 kB");
    // One y axis, no curve, round steps over the stacked sum.
    expect(Object.keys(scales).sort()).toEqual(["x", "y"]);
    expect(cfg.data.datasets.every((d) => (d as { tension?: number }).tension === 0)).toBe(true);
    const top = Math.max(...Array.from({ length: 30 }, (_, i) => cfg.data.datasets.reduce((a, d) => a + (d.data[i] ?? 0), 0)));
    expect(scales.y.max as number).toBeGreaterThanOrEqual(top);
    expect((scales.y.max as number) / (yTicks as unknown as { stepSize: number }).stepSize).toBeLessThanOrEqual(4);
  });

  it("all-zero data still gets a 0..1 kB y axis with no duplicate tick labels", () => {
    const zero = sites().map((s) => ({
      ...s,
      recent: { ...s.recent!, series: { bytesServed: new Array(30).fill(0) } },
    }));
    const cfg = hostConfig(zero, T);
    expect(cfg.data.datasets.every((d) => d.data.every((v) => v === 0))).toBe(true);
    const y = (cfg.options!.scales! as Record<string, Record<string, unknown>>).y;
    expect(y.suggestedMax as number).toBeGreaterThanOrEqual(1000);
    expect(y.beginAtZero).toBe(true);
    const callback = (y.ticks as { callback: (v: number, i: number, ticks: { value: number }[]) => string | null }).callback;
    // The ticks Chart.js would generate for a 0..1 kB axis and for a 0..1 B axis.
    for (const [max, step] of [
      [1000, 200],
      [1, 0.2],
    ]) {
      const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => ({ value: Number((i * step).toFixed(6)) }));
      const labels = ticks.map((t, i) => callback(t.value, i, ticks)).filter((l): l is string => l !== null);
      expect(new Set(labels).size, `0..${max}`).toBe(labels.length);
    }
  });

  it("shows a legend for more than one site and labels tooltips in bytes per minute", () => {
    const options = hostConfig(sites(), T).options!;
    expect(options.plugins!.legend).toMatchObject({ display: true, position: "bottom" });
    expect(hostConfig(sites().slice(0, 1), T).options!.plugins!.legend).toMatchObject({ display: false });
    expect(options.plugins!.tooltip!.backgroundColor).toBe("#1F2A1E");
    expect(options.plugins!.tooltip!.callbacks!.label).toBe(hostLabel);
    expect(hostLabel(barItem("paraliyard", 2000))).toBe(" paraliyard: 2.0 kB/min");
  });
});
