// The Chart.js config of one chart panel (drawer panels and the page's hero).
// Types only from chart.js, so this module is pure and tests call it directly.
// Points are bucketed here, in the browser, from what was already loaded.
import type { ChartConfiguration, ChartEvent, LegendElement, LegendItem } from "chart.js";
import {
  allZero,
  bucketize,
  bucketSpan,
  bytesTick,
  countTick,
  fitYAxis,
  GEN1_MEMORY_BYTES,
  niceAxis,
  pctTick,
  tickFor,
  timeTicks,
  timeTickStep,
  type Bucket,
  type NiceAxis,
  type NoDataBand,
  type XYPoint,
} from "./chart-shape";
import { COLORS, type PanelDataset, type PanelSpec } from "./drawer-groups";
import { uniqueTicks } from "./fmt";
import { alpha, INK_2, INK_3, RULE } from "./page-chart-config";
import { CHROME_TOP_PX } from "./panel-layout";

export interface PanelWindow {
  from: number;
  to: number;
  bucketMs: number;
  sourceStepMs: number;
}

export interface PanelContext extends PanelWindow {
  // Loaded points by series index (DrawerGroup.series order).
  raw: readonly (readonly XYPoint[])[];
  // Visibility by series index; missing means visible.
  visible: readonly boolean[];
  band: NoDataBand | null;
  formatTick: (ms: number) => string;
  // A legend click on a series; without it Chart.js toggles the dataset.
  onToggle?: (seriesIndex: number) => void;
  // False above the bottom panel of a stack: x labels hidden (ticks and
  // gridlines stay). Missing means shown.
  timeLabels?: boolean;
}

// One drawn series of a panel, bucketed.
export interface PanelSeries {
  seriesIndex: number;
  label: string;
  color: string;
  buckets: Bucket[];
}

// Extra fields on every dataset: the series it draws, and whether it is the
// light "busiest" twin of a bar.
export interface PanelDatasetMeta {
  seriesIndex: number;
  peak?: boolean;
}

export const PEAK_ALPHA = 0.3;
export const NO_ACTIVITY = "No activity in this period";

// A CSS variable of the palette (or a hex colour) as a hex colour.
export function colorOf(color: string): string {
  return COLORS[color] ?? color;
}

function derived(d: PanelDataset, raw: PanelContext["raw"]): readonly XYPoint[] {
  const points = raw[d.series] ?? [];
  if (d.derive === "memPct") {
    return points.map((p) => ({ x: p.x, y: typeof p.y === "number" ? (p.y * 100) / GEN1_MEMORY_BYTES : null }));
  }
  if (d.derive === "minus" && d.minus !== undefined) {
    const other = new Map((raw[d.minus] ?? []).map((p) => [p.x, p.y]));
    return points.map((p) => ({ x: p.x, y: typeof p.y === "number" ? Math.max(0, p.y - (other.get(p.x) ?? 0)) : null }));
  }
  return points;
}

// The panel's series, bucketed (also used for live updates).
export function panelData(panel: PanelSpec, raw: PanelContext["raw"], win: PanelWindow): PanelSeries[] {
  return panel.datasets.map((d) => ({
    seriesIndex: d.series,
    label: d.label,
    color: colorOf(d.color),
    buckets: bucketize(derived(d, raw), { from: win.from, to: win.to, bucketMs: win.bucketMs, sourceStepMs: win.sourceStepMs, mode: panel.kind }),
  }));
}

// Light peak bars only when a bucket holds more than one source point.
export function showsPeak(panel: PanelSpec, win: PanelWindow): boolean {
  return panel.kind === "bar" && win.bucketMs > win.sourceStepMs;
}

// The y axis for the visible series; stacked bars add up per bucket.
export function panelAxis(panel: PanelSpec, data: readonly PanelSeries[], visible: readonly boolean[], win: PanelWindow): NiceAxis {
  const shown = data.filter((s) => visible[s.seriesIndex] !== false);
  const peak = showsPeak(panel, win);
  const count = Math.max(0, ...shown.map((s) => s.buckets.length));
  let top = 0;
  for (let i = 0; i < count; i += 1) {
    const ys = shown.map((s) => s.buckets[i]?.y ?? 0);
    const peaks = shown.map((s) => (peak ? (s.buckets[i]?.peak ?? 0) : 0));
    if (panel.stacked) top = Math.max(top, ys.reduce((a, v) => a + v, 0), peaks.reduce((a, v) => a + v, 0));
    else top = Math.max(top, ...ys, ...peaks);
  }
  return niceAxis(top, panel.unit);
}

function datasetsFor(panel: PanelSpec, data: readonly PanelSeries[], ctx: PanelContext) {
  const half = ctx.bucketMs / 2;
  const peak = showsPeak(panel, ctx);
  return data.flatMap((s): object[] => {
    const hidden = ctx.visible[s.seriesIndex] === false;
    const common = { label: s.label, seriesIndex: s.seriesIndex, hidden, borderColor: s.color, tension: 0 };
    if (panel.kind === "bar") {
      const bar = { ...common, type: "bar" as const, borderWidth: 0, barPercentage: 1, categoryPercentage: 0.9 };
      const solid = { ...bar, data: s.buckets.map((b) => ({ x: b.start + half, y: b.y })), backgroundColor: s.color, stack: panel.stacked ? "avg" : undefined, order: 0 };
      if (!peak) return [solid];
      // The busiest source point, behind the solid bar in a stack of its own.
      const busiest = {
        ...bar,
        peak: true,
        data: s.buckets.map((b) => ({ x: b.start + half, y: b.peak })),
        backgroundColor: alpha(s.color, PEAK_ALPHA),
        grouped: false,
        stack: "peak",
        order: 1,
      };
      return [solid, busiest];
    }
    const line = { ...common, type: "line" as const, backgroundColor: s.color, borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 0, fill: false };
    if (panel.kind === "level") {
      const points = s.buckets.map((b) => ({ x: b.start, y: b.y }));
      // Hold the last level to the end of its bucket.
      const last = s.buckets[s.buckets.length - 1];
      if (last && last.y !== null) points.push({ x: Math.min(last.end, ctx.to), y: last.y });
      return [{ ...line, stepped: true, spanGaps: true, data: points }];
    }
    return [{ ...line, stepped: false, spanGaps: false, data: s.buckets.map((b) => ({ x: b.start + half, y: b.y })) }];
  });
}

function legendClick(onToggle: (seriesIndex: number) => void) {
  return (_event: ChartEvent, item: LegendItem, legend: LegendElement<"bar" | "line">) => {
    const dataset = legend.chart.data.datasets[item.datasetIndex ?? -1] as unknown as PanelDatasetMeta | undefined;
    if (dataset) onToggle(dataset.seriesIndex);
  };
}

// Chart.js afterBuildTicks hook of a time x scale: round IST ticks over the
// scale's live min/max, so a refreshed range needs no extra copying.
export function roundTimeTicks(scale: { min: number; max: number; ticks: { value: number }[] }): void {
  scale.ticks = timeTicks(scale.min, scale.max, timeTickStep(scale.max - scale.min)).map((value) => ({ value }));
}

export function panelConfig(panel: PanelSpec, ctx: PanelContext): ChartConfiguration {
  const data = panelData(panel, ctx.raw, ctx);
  const axis = panelAxis(panel, data, ctx.visible, ctx);
  const tick = tickFor(panel.unit);
  const stacked = panel.kind === "bar" && Boolean(panel.stacked);
  const values = data.flatMap((s) => s.buckets.map((b) => b.y));
  return {
    type: panel.kind === "bar" ? "bar" : "line",
    data: { datasets: datasetsFor(panel, data, ctx) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: CHROME_TOP_PX } },
      interaction: { mode: "index", intersect: false },
      scales: {
        // Round IST time ticks with vertical gridlines on every panel; only
        // the bottom panel of a stack labels them.
        x: {
          type: "linear",
          min: ctx.from,
          max: ctx.to,
          stacked,
          offset: false,
          grid: { display: true, color: RULE, drawTicks: false },
          afterBuildTicks: roundTimeTicks,
          ticks: {
            display: ctx.timeLabels !== false,
            autoSkip: false,
            color: INK_3,
            maxRotation: 0,
            callback: (v: number | string) => ctx.formatTick(Number(v)),
          },
        },
        // One y axis of the shared width, no title, a light horizontal grid.
        y: {
          type: "linear",
          min: 0,
          max: axis.max,
          stacked,
          afterFit: fitYAxis,
          grid: { color: RULE, drawTicks: false },
          border: { display: false },
          title: { display: false },
          ticks: { color: INK_3, padding: 6, stepSize: axis.step, maxTicksLimit: 6, includeBounds: false, callback: uniqueTicks((v) => tick(v ?? 0)) },
        },
      },
      plugins: {
        legend: {
          display: panel.datasets.length > 1,
          position: "bottom",
          labels: {
            usePointStyle: true,
            pointStyle: panel.kind === "bar" ? "rect" : "line",
            boxWidth: 22,
            color: INK_2,
            filter: (item: LegendItem, chartData: { datasets: unknown[] }) =>
              !(chartData.datasets[item.datasetIndex ?? -1] as PanelDatasetMeta | undefined)?.peak,
          },
          onClick: ctx.onToggle ? legendClick(ctx.onToggle) : undefined,
        },
        // One HTML tooltip for all panels (src/chart-plugins.ts).
        tooltip: { enabled: false },
        yardOverlay: { title: panel.title, band: ctx.band, empty: allZero(values) ? NO_ACTIVITY : null },
        yardCrosshair: { start: data[0]?.buckets[0]?.start ?? ctx.from, bucketMs: ctx.bucketMs, count: data[0]?.buckets.length ?? 0 },
      },
    },
  } as unknown as ChartConfiguration;
}

export interface BucketTooltip {
  title: string;
  lines: string[];
}

function valueText(unit: PanelSpec["unit"], v: number | null): string {
  if (v === null) return "no data";
  return unit === "bytes" ? bytesTick(v) : unit === "pct" ? pctTick(v) : countTick(v);
}

// The shared tooltip for one bucket: its IST time span, then each visible
// series of every panel; bars list the average and the busiest point.
export function bucketTooltip(
  panels: readonly PanelSpec[],
  data: readonly (readonly PanelSeries[])[],
  index: number,
  win: PanelWindow,
  visible: readonly boolean[] = [],
): BucketTooltip | null {
  const bucket = data.flatMap((series) => series.map((s) => s.buckets[index])).find((b) => b !== undefined);
  if (!bucket) return null;
  const lines: string[] = [];
  panels.forEach((panel, p) => {
    for (const s of data[p] ?? []) {
      const b = s.buckets[index];
      if (!b || visible[s.seriesIndex] === false) continue;
      const value = valueText(panel.unit, b.y);
      if (panel.kind !== "bar") lines.push(`${s.label}: ${value}`);
      else if (showsPeak(panel, win)) lines.push(`${s.label}: avg ${value} · peak ${valueText(panel.unit, b.peak)} /min`);
      else lines.push(`${s.label}: ${value} /min`);
    }
  });
  return { title: bucketSpan(bucket.start, bucket.end, win.to - win.from), lines };
}
