// Chart.js for the history drawer (bundled, no zoom plugin). The drawer only
// uses this adapter, so tests replace it (tests/setup.ts mocks this module).
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
  type ChartEvent,
  type LegendElement,
  type LegendItem,
  type TooltipItem,
} from "chart.js";
import type { Formatter } from "./fmt";
import { alpha, applyTheme, INK_2, INK_3, RULE, tooltipStyle } from "./page-chart-config";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);
applyTheme(Chart.defaults);

export interface XYPoint {
  x: number;
  y: number | null;
}

export interface DrawerChartDataset {
  label: string;
  color: string;
  axis: "y" | "y1";
  data: XYPoint[];
  hidden?: boolean;
  fill?: boolean;
  stepped?: boolean;
  // Bar charts: one colour per bar.
  barColors?: string[];
}

export interface DrawerAxis {
  title: string;
  format: Formatter;
  max?: number;
  level?: boolean;
}

export interface DrawerChartSpec {
  kind: "line" | "bar";
  datasets: DrawerChartDataset[];
  axes: { y: DrawerAxis; y1?: DrawerAxis };
  // Line charts: the x range (epoch ms) and how to label times (tooltip
  // titles; axis ticks use formatTick when given).
  from?: number;
  to?: number;
  formatX: (ms: number) => string;
  formatTick?: (ms: number) => string;
  // Bar charts: one label per bar.
  labels?: string[];
  formats: Formatter[];
  // A legend click hid or showed a line chart's dataset.
  onLegendToggle?: (index: number, visible: boolean) => void;
}

export interface DrawerChart {
  setVisible(index: number, visible: boolean): void;
  setData(index: number, data: XYPoint[], from?: number, to?: number): void;
  destroy(): void;
}

export type DrawerChartFactory = (canvas: HTMLCanvasElement, spec: DrawerChartSpec) => DrawerChart;

// Legend click: Chart.js's own toggle, then the new visibility is reported
// so the drawer can mute that row of the stats table.
function legendClick(spec: DrawerChartSpec) {
  return function (this: LegendElement<"line">, event: ChartEvent, item: LegendItem, legend: LegendElement<"line">) {
    Chart.defaults.plugins.legend.onClick.call(legend, event, item, legend);
    const index = item.datasetIndex;
    if (typeof index === "number") spec.onLegendToggle?.(index, legend.chart.isDatasetVisible(index));
  };
}

// The drawer chart's Chart.js config (pure; tests call it directly).
export function drawerConfig(spec: DrawerChartSpec): ChartConfiguration {
  const hasY1 = spec.datasets.some((d) => d.axis === "y1") && Boolean(spec.axes.y1);
  const line = spec.kind === "line";
  return {
    type: spec.kind,
    data: {
      labels: spec.labels ?? [],
      datasets: spec.datasets.map((d, i) => ({
        label: d.label,
        data: line ? d.data : d.data.map((p) => p.y),
        yAxisID: d.axis,
        hidden: Boolean(d.hidden),
        borderColor: d.color,
        backgroundColor: d.barColors ?? alpha(d.color, d.fill ? 0.14 : 0),
        fill: d.fill ? "origin" : false,
        stepped: Boolean(d.stepped),
        borderWidth: line ? (i ? 1.4 : 1.9) : 0,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: d.stepped ? 0 : 0.25,
        spanGaps: true,
        borderRadius: line ? 0 : 3,
        maxBarThickness: 26,
      })),
    },
    options: {
      parsing: line ? false : undefined,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: line
          ? { type: "linear", min: spec.from, max: spec.to, grid: { display: false }, ticks: { color: INK_3, maxTicksLimit: 7, maxRotation: 0, callback: (v) => (spec.formatTick ?? spec.formatX)(Number(v)) } }
          : { type: "category", grid: { display: false }, ticks: { color: INK_3, maxTicksLimit: 10, maxRotation: 0 } },
        y: {
          beginAtZero: !spec.axes.y.level,
          max: spec.axes.y.max,
          grid: { color: RULE },
          title: { display: true, text: spec.axes.y.title, color: INK_3 },
          ticks: { color: INK_3, maxTicksLimit: 6, callback: (v) => spec.axes.y.format(Number(v)) },
        },
        y1: {
          display: hasY1,
          position: "right",
          beginAtZero: true,
          max: spec.axes.y1?.max,
          grid: { display: false },
          title: { display: hasY1, text: spec.axes.y1?.title ?? "", color: INK_3 },
          ticks: { color: INK_3, maxTicksLimit: 6, callback: (v) => (spec.axes.y1?.format ?? spec.axes.y.format)(Number(v)) },
        },
      },
      plugins: {
        // Line charts: the Chart.js legend hides or shows a line. Run bars have none.
        legend: line
          ? {
              display: true,
              position: "bottom",
              labels: { usePointStyle: true, pointStyle: "line", boxWidth: 22, color: INK_2 },
              onClick: legendClick(spec),
            }
          : { display: false },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            title: (items: TooltipItem<"line" | "bar">[]) => {
              const item = items[0];
              if (!item) return "";
              return line ? spec.formatX(Number(item.parsed.x)) : String(item.label);
            },
            label: (item: TooltipItem<"line" | "bar">) => {
              const y = item.parsed.y;
              const format = spec.formats[item.datasetIndex] ?? spec.axes.y.format;
              return ` ${item.dataset.label ?? ""}: ${typeof y === "number" ? format(y) : "not available"}`;
            },
          },
        },
      },
    },
  } as ChartConfiguration;
}

export function createDrawerChart(canvas: HTMLCanvasElement, spec: DrawerChartSpec): DrawerChart {
  // Without a 2D context the chart is skipped; the stats table still works.
  if (!canvas.getContext("2d")) return { setVisible() {}, setData() {}, destroy() {} };
  const chart = new Chart(canvas, drawerConfig(spec));
  return {
    setVisible(index, visible) {
      chart.setDatasetVisibility(index, visible);
      chart.update("none");
    },
    setData(index, data, from, to) {
      const dataset = chart.data.datasets[index];
      if (!dataset) return;
      dataset.data = (spec.kind === "line" ? data : data.map((p) => p.y)) as typeof dataset.data;
      const x = chart.options.scales?.x;
      if (x && from !== undefined && to !== undefined) {
        x.min = from;
        x.max = to;
      }
      chart.update("none");
    },
    destroy() {
      chart.destroy();
    },
  };
}
