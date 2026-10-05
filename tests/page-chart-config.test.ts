import { beforeEach, describe, expect, it } from "vitest";
import type { TooltipItem } from "chart.js";
import {
  applyTheme,
  bytesTick,
  FONT_FAMILY,
  heroConfig,
  heroTick,
  heroTooltipTitle,
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

describe("hero config", () => {
  it("is a line chart with reads on y (filled) and writes, deletes on y1", () => {
    const cfg = heroConfig(fs(), T);
    expect(cfg.type).toBe("line");
    const ds = cfg.data.datasets;
    expect(ds.map((d) => d.label)).toEqual(["Reads/min", "Writes/min", "Deletes/min"]);
    expect(ds.map((d) => d.yAxisID)).toEqual(["y", "y1", "y1"]);
    expect(ds.map((d) => d.fill)).toEqual(["origin", false, false]);
    expect(ds[0].data).toHaveLength(30);
    const reads = fs().recent!.series.readsPerMin!;
    expect(ds[0].data[29]).toEqual({ x: T, y: reads[29] });
    expect(ds[0].data.every((p) => p.x > T - 30 * 60000 && p.x <= T)).toBe(true);
  });

  it("has the reads/min and writes, deletes axes and a 30-minute linear x axis", () => {
    const scales = heroConfig(fs(), T).options!.scales! as Record<string, Record<string, unknown>>;
    const { x, y, y1 } = scales;
    expect(y.title).toMatchObject({ display: true, text: "reads/min" });
    expect(y.grid).toMatchObject({ color: "#D0D6C4" });
    expect(y1.position).toBe("right");
    expect(y1.title).toMatchObject({ display: true, text: "writes, deletes" });
    expect(y1.suggestedMax).toBe(4);
    expect(y1.grid).toMatchObject({ display: false });
    expect(x.type).toBe("linear");
    expect(x.min).toBe(T - 30 * 60000);
    expect(x.max).toBe(T);
    const ticks = x.ticks as { stepSize: number; callback: (v: number) => string };
    expect(ticks.stepSize).toBe(300000);
    expect(ticks.callback).toBe(heroTick);
    expect(ticks.callback(T)).toBe("10:36 pm");
  });

  it("has a bottom point-style legend, index interaction and the ink tooltip", () => {
    const options = heroConfig(fs(), T).options!;
    expect(options.plugins!.legend).toMatchObject({ position: "bottom", labels: { usePointStyle: true, pointStyle: "line", boxWidth: 22 } });
    expect(options.interaction).toEqual({ mode: "index", intersect: false });
    const tooltip = options.plugins!.tooltip!;
    expect(tooltip.backgroundColor).toBe("#1F2A1E");
    expect(tooltip.callbacks!.title).toBe(heroTooltipTitle);
    expect(tooltip.callbacks!.label).toBe(rateLabel);
    expect(heroTooltipTitle([lineItem("Reads/min", T + 7000, 1)])).toBe("10:36:07 pm");
    expect(heroTooltipTitle([])).toBe("");
    expect(rateLabel(lineItem("Reads/min", T, 51.64))).toBe(" Reads/min: 51.64");
  });

  it("has empty datasets when Firestore is missing", () => {
    expect(heroConfig(undefined, T).data.datasets.map((d) => d.data)).toEqual([[], [], []]);
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
    const yTicks = scales.y.ticks as { callback: (v: number) => string };
    expect(yTicks.callback).toBe(bytesTick);
    expect(bytesTick(1000)).toBe("1.0 kB");
  });

  it("hides the legend and labels tooltips in bytes per minute", () => {
    const options = hostConfig(sites(), T).options!;
    expect(options.plugins!.legend).toMatchObject({ display: false });
    expect(options.plugins!.tooltip!.backgroundColor).toBe("#1F2A1E");
    expect(options.plugins!.tooltip!.callbacks!.label).toBe(hostLabel);
    expect(hostLabel(barItem("paraliyard", 2000))).toBe(" paraliyard: 2.0 kB/min");
  });
});
