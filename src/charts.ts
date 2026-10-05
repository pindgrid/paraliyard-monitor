// The only module that imports Chart.js. Everything else uses this adapter,
// so tests can replace it with vi.mock("../src/charts").
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
  type ChartDataset as ChartJsDataset,
  type TooltipItem,
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";
import { formatIst } from "./time";

Chart.register(
  LineController,
  BarController,
  LineElement,
  BarElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
  zoomPlugin,
);

export type ChartKind = "line" | "bar";

// A point on a time axis: x is epoch ms.
export interface TimePoint {
  x: number;
  y: number | null;
}

export interface ChartSeries {
  label: string;
  // Time points for a time axis, otherwise one value per label.
  data: TimePoint[] | (number | null)[];
  // Text shown instead of the value at an index, e.g. "idle" or "not available".
  notes?: (string | null)[];
  color?: string | string[];
}

export interface ChartSpec {
  kind: ChartKind;
  // Category labels (bar charts without a time axis).
  labels?: string[];
  datasets: ChartSeries[];
  // x holds epoch ms; ticks and tooltips are formatted in IST.
  timeAxis?: boolean;
  yLabel?: string;
  formatValue?: (v: number) => string;
  // Drag to zoom along x.
  zoom?: boolean;
}

export interface ChartHandle {
  update(spec: ChartSpec): void;
  resetZoom(): void;
  destroy(): void;
}

export interface ChartOptions {
  // Called for a click on a bar/point (index) or a legend entry (index null).
  onPick?: (datasetIndex: number, index: number | null) => void;
}

export const PALETTE = ["#2680c2", "#e12d39", "#3ebd93", "#f0b429", "#8662c7", "#d9822b", "#486581", "#e668a7", "#27ab83"];

type AnyDataset = ChartJsDataset<"line" | "bar", (number | null | TimePoint)[]>;

function toDataset(series: ChartSeries, i: number, kind: ChartKind): AnyDataset {
  const color = series.color ?? PALETTE[i % PALETTE.length];
  return {
    label: series.label,
    data: series.data as (number | null | TimePoint)[],
    backgroundColor: color,
    borderColor: color,
    borderWidth: kind === "line" ? 1.5 : 0,
    pointRadius: kind === "line" ? 0 : undefined,
    spanGaps: false,
  } as AnyDataset;
}

function buildConfig(spec: ChartSpec, holder: { spec: ChartSpec }, onPick: ChartOptions["onPick"]): ChartConfiguration {
  const valueText = (v: number) => (spec.formatValue ? spec.formatValue(v) : String(Number(v.toFixed(2))));
  return {
    type: spec.kind,
    data: {
      labels: spec.labels ?? [],
      datasets: spec.datasets.map((s, i) => toDataset(s, i, spec.kind)),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: spec.timeAxis ? { xAxisKey: "x", yAxisKey: "y" } : undefined,
      scales: {
        x: spec.timeAxis
          ? { type: "linear", ticks: { maxTicksLimit: 6, callback: (v) => formatIst(Number(v)) } }
          : { type: "category" },
        y: { type: "linear", beginAtZero: true, title: { display: Boolean(spec.yLabel), text: spec.yLabel ?? "" } },
      },
      onClick: (_event, elements) => {
        if (onPick && elements.length > 0) onPick(elements[0].datasetIndex, elements[0].index);
      },
      plugins: {
        legend: {
          onClick: (_event, item) => {
            if (onPick) onPick(item.datasetIndex ?? 0, null);
          },
        },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<"line" | "bar">[]) => {
              const item = items[0];
              if (!item) return "";
              return holder.spec.timeAxis ? formatIst(Number(item.parsed.x)) : String(item.label);
            },
            label: (item: TooltipItem<"line" | "bar">) => {
              const note = holder.spec.datasets[item.datasetIndex]?.notes?.[item.dataIndex];
              const y = item.parsed.y;
              const value = note ?? (typeof y === "number" ? valueText(y) : "not available");
              return `${item.dataset.label ?? ""}: ${value}`;
            },
          },
        },
        zoom: spec.zoom
          ? { zoom: { drag: { enabled: true }, mode: "x" }, pan: { enabled: false } }
          : { zoom: { drag: { enabled: false }, wheel: { enabled: false }, pinch: { enabled: false } } },
      },
    },
  } as ChartConfiguration;
}

// Creates one chart on the canvas. update() mutates the data in place and
// redraws, so the chart object is never recreated.
export function createChart(canvas: HTMLCanvasElement, spec: ChartSpec, { onPick }: ChartOptions = {}): ChartHandle {
  // Without a 2D context (very old browser) the chart is skipped; tables still work.
  if (!canvas.getContext("2d")) return { update() {}, resetZoom() {}, destroy() {} };
  const holder = { spec };
  const chart = new Chart(canvas, buildConfig(spec, holder, onPick));
  return {
    update(next: ChartSpec) {
      holder.spec = next;
      chart.data.labels = next.labels ?? [];
      const datasets = chart.data.datasets as AnyDataset[];
      next.datasets.forEach((series, i) => {
        const fresh = toDataset(series, i, next.kind);
        if (datasets[i]) {
          datasets[i].label = fresh.label;
          datasets[i].data = fresh.data;
          datasets[i].backgroundColor = fresh.backgroundColor;
          datasets[i].borderColor = fresh.borderColor;
        } else {
          datasets.push(fresh);
        }
      });
      datasets.length = next.datasets.length;
      chart.update();
    },
    resetZoom() {
      chart.resetZoom();
    },
    destroy() {
      chart.destroy();
    },
  };
}
