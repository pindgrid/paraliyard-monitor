// Chart.js for the history drawer (bundled, no zoom plugin). The drawer only
// uses this adapter, so tests replace it (tests/setup.ts mocks this module).
// Line groups draw one Chart per panel, stacked in .dchart with a shared x
// range, crosshair and tooltip; scheduler runs are one bar chart.
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import { firstDataAt, noDataBand, type NoDataBand, type XYPoint } from "./chart-shape";
import { crosshairSync, overlayPlugin } from "./chart-plugins";
import type { PanelSpec } from "./drawer-groups";
import { uniqueTicks, type Formatter } from "./fmt";
import { alpha, applyTheme, INK_3, RULE, tooltipStyle } from "./page-chart-config";
import { bucketTooltip, panelAxis, panelConfig, panelData, type PanelContext, type PanelDatasetMeta, type PanelWindow } from "./panel-config";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);
applyTheme(Chart.defaults);

export type { XYPoint } from "./chart-shape";

export interface DrawerChartDataset {
  label: string;
  color: string;
  // Line groups: the loaded points of one series; bar charts: one per bar.
  data: XYPoint[];
  hidden?: boolean;
  // Bar charts: one colour per bar.
  barColors?: string[];
}

export interface DrawerAxis {
  title: string;
  format: Formatter;
}

// Bucket sizes and the "No data before" band of a line group.
export interface DrawerPanelContext {
  bucketMs: number;
  sourceStepMs: number;
  band: NoDataBand | null;
}

export interface DrawerChartSpec {
  // line: the group's panels (one chart each); bar: scheduler run bars.
  kind: "line" | "bar";
  // Line groups: one per series (DrawerGroup.series order), raw points.
  datasets: DrawerChartDataset[];
  axes?: { y: DrawerAxis };
  panels?: PanelSpec[];
  panelContext?: DrawerPanelContext;
  // Line charts: the x range (epoch ms) and how to label times.
  from?: number;
  to?: number;
  formatX: (ms: number) => string;
  formatTick?: (ms: number) => string;
  // Bar charts: one label per bar.
  labels?: string[];
  formats: Formatter[];
  // A legend click hid or showed a series (index into datasets).
  onLegendToggle?: (index: number, visible: boolean) => void;
}

export interface DrawerChart {
  setVisible(index: number, visible: boolean): void;
  setData(index: number, data: XYPoint[], from?: number, to?: number): void;
  destroy(): void;
}

export type DrawerChartFactory = (canvas: HTMLCanvasElement, spec: DrawerChartSpec) => DrawerChart;

// The scheduler runs chart's Chart.js config (pure; tests call it directly):
// one bar per run, one y axis, no bucketing.
export function drawerConfig(spec: DrawerChartSpec): ChartConfiguration {
  const format = spec.axes?.y.format ?? spec.formats[0];
  return {
    type: "bar",
    data: {
      labels: spec.labels ?? [],
      datasets: spec.datasets.map((d) => ({
        label: d.label,
        data: d.data.map((p) => p.y),
        hidden: Boolean(d.hidden),
        borderColor: d.color,
        backgroundColor: d.barColors ?? alpha(d.color, 0.8),
        borderWidth: 0,
        tension: 0,
        borderRadius: 3,
        maxBarThickness: 26,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "category", grid: { display: false }, ticks: { color: INK_3, maxTicksLimit: 10, maxRotation: 0 } },
        // Tick labels never repeat.
        y: {
          beginAtZero: true,
          grid: { color: RULE },
          title: { display: false },
          ticks: { color: INK_3, maxTicksLimit: 5, precision: 0, callback: uniqueTicks(format) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            title: (items: TooltipItem<"bar">[]) => (items[0] ? String(items[0].label) : ""),
            label: (item: TooltipItem<"bar">) => {
              const y = item.parsed.y;
              const f = spec.formats[item.datasetIndex] ?? format;
              return ` ${item.dataset.label ?? ""}: ${typeof y === "number" ? f(y) : "not available"}`;
            },
          },
        },
      },
    },
  } as ChartConfiguration;
}

const NOOP: DrawerChart = { setVisible() {}, setData() {}, destroy() {} };

function createRunsChart(canvas: HTMLCanvasElement, spec: DrawerChartSpec): DrawerChart {
  const chart = new Chart(canvas, drawerConfig(spec));
  return {
    setVisible(index, visible) {
      chart.setDatasetVisibility(index, visible);
      chart.update("none");
    },
    setData(index, data) {
      const dataset = chart.data.datasets[index];
      if (!dataset) return;
      dataset.data = data.map((p) => p.y);
      chart.update("none");
    },
    destroy() {
      chart.destroy();
    },
  };
}

// One chart per panel: panel 0 on the given canvas, the others on new
// canvases; each sits in a .dpanel wrapper sized by its CSS classes
// (.dpanel--legend with more than one series, .dpanel--last at the bottom).
function createPanelCharts(canvas: HTMLCanvasElement, spec: DrawerChartSpec, panels: PanelSpec[], pc: DrawerPanelContext): DrawerChart {
  const doc = canvas.ownerDocument;
  const container = (canvas.closest(".dchart") as HTMLElement | null) ?? canvas.parentElement;
  if (!container) return NOOP;
  const anchor = canvas.nextSibling;
  const raw: XYPoint[][] = spec.datasets.map((d) => d.data);
  const visible: boolean[] = spec.datasets.map((d) => !d.hidden);
  const win: PanelWindow = { from: spec.from ?? 0, to: spec.to ?? 0, bucketMs: pc.bucketMs, sourceStepMs: pc.sourceStepMs };
  let band = pc.band;
  const formatTick = spec.formatTick ?? spec.formatX;

  const sync = crosshairSync({
    container,
    tooltipFor: (index) =>
      bucketTooltip(
        panels,
        panels.map((p) => panelData(p, raw, win)),
        index,
        win,
        visible,
      ),
  });

  // Only the bottom panel labels the times.
  function context(p: number): PanelContext {
    return { ...win, raw, visible, band, formatTick, onToggle: (i) => toggle(i, !visible[i]), timeLabels: p === panels.length - 1 };
  }

  const wrappers: HTMLElement[] = [];
  const created: HTMLCanvasElement[] = [];
  const charts: Chart[] = [];
  const height = container.style.height;
  container.classList.add("dpanels");
  panels.forEach((panel, i) => {
    const wrapper = doc.createElement("div");
    wrapper.classList.add("dpanel");
    if (panel.datasets.length > 1) wrapper.classList.add("dpanel--legend");
    if (i === panels.length - 1) wrapper.classList.add("dpanel--last");
    let target = canvas;
    if (i > 0) {
      target = doc.createElement("canvas");
      created.push(target);
    }
    target.setAttribute("role", "img");
    target.setAttribute("aria-label", panel.title);
    wrapper.append(target);
    container.insertBefore(wrapper, anchor);
    wrappers.push(wrapper);
    const config = panelConfig(panel, context(i));
    config.plugins = [sync.plugin as unknown as Plugin, overlayPlugin as unknown as Plugin];
    charts.push(new Chart(target, config));
  });

  // Re-bucket every panel from raw, then redraw without animation. The round
  // time ticks, bottom-only labels and shared y width are re-applied too.
  function refresh() {
    charts.forEach((chart, p) => {
      const next = panelConfig(panels[p], context(p));
      chart.data.datasets.forEach((dataset, k) => {
        const fresh = next.data.datasets[k];
        if (!fresh) return;
        dataset.data = fresh.data;
        dataset.hidden = fresh.hidden;
      });
      const scales = chart.options.scales as Record<string, Record<string, unknown>> | undefined;
      const nextScales = next.options?.scales as Record<string, Record<string, unknown>> | undefined;
      if (scales?.x && nextScales?.x) {
        Object.assign(scales.x, { min: nextScales.x.min, max: nextScales.x.max, afterBuildTicks: nextScales.x.afterBuildTicks });
        Object.assign(scales.x.ticks as object, { display: (nextScales.x.ticks as { display?: boolean }).display });
      }
      if (scales?.y && nextScales?.y) {
        scales.y.max = nextScales.y.max;
        scales.y.afterFit = nextScales.y.afterFit;
        Object.assign(scales.y.ticks as object, { stepSize: (nextScales.y.ticks as { stepSize: number }).stepSize });
      }
      const plugins = chart.options.plugins as Record<string, unknown> | undefined;
      const nextPlugins = next.options?.plugins as Record<string, unknown> | undefined;
      if (plugins && nextPlugins) {
        plugins.yardOverlay = nextPlugins.yardOverlay;
        plugins.yardCrosshair = nextPlugins.yardCrosshair;
      }
      chart.update("none");
    });
  }

  function toggle(index: number, shown: boolean) {
    if (index < 0 || index >= visible.length) return;
    visible[index] = shown;
    for (const chart of charts) {
      for (const dataset of chart.data.datasets) {
        if ((dataset as unknown as PanelDatasetMeta).seriesIndex === index) dataset.hidden = !shown;
      }
    }
    // Axes follow the visible series.
    charts.forEach((chart, p) => {
      const y = (chart.options.scales as Record<string, Record<string, unknown>> | undefined)?.y;
      if (!y) return;
      const axis = panelAxis(panels[p], panelData(panels[p], raw, win), visible, win);
      y.max = axis.max;
      Object.assign(y.ticks as object, { stepSize: axis.step });
      chart.update("none");
    });
    spec.onLegendToggle?.(index, shown);
  }

  return {
    setVisible(index, shown) {
      if (index < 0 || index >= visible.length) return;
      visible[index] = shown;
      refresh();
    },
    setData(index, data, from, to) {
      if (index < 0 || index >= raw.length) return;
      raw[index] = data;
      if (from !== undefined && to !== undefined) {
        win.from = from;
        win.to = to;
      }
      band = noDataBand(win.from, firstDataAt(raw), win.bucketMs);
      refresh();
    },
    destroy() {
      for (const chart of charts) chart.destroy();
      sync.destroy();
      // The given canvas goes back where it was; the rest is removed.
      container.insertBefore(canvas, wrappers[0] ?? anchor);
      canvas.removeAttribute("role");
      canvas.removeAttribute("aria-label");
      for (const wrapper of wrappers) wrapper.remove();
      for (const el of created) el.remove();
      container.classList.remove("dpanels");
      container.style.height = height;
    },
  };
}

export function createDrawerChart(canvas: HTMLCanvasElement, spec: DrawerChartSpec): DrawerChart {
  // Without a 2D context the chart is skipped; the stats table still works.
  if (!canvas.getContext("2d")) return NOOP;
  if (spec.kind === "line" && spec.panels && spec.panels.length > 0 && spec.panelContext) {
    return createPanelCharts(canvas, spec, spec.panels, spec.panelContext);
  }
  return createRunsChart(canvas, spec);
}
