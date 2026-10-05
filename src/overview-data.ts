import type { ChartSeries, ChartSpec, TimePoint } from "./charts";
import { IDLE, NOT_AVAILABLE, NO_RUN, formatBytes, formatNumber, formatValue } from "./format";
import { METRIC_LABELS } from "./routes";
import { SERVICES } from "./services";
import type { Kind, MetricValue, MetricsResponse, ServiceMetrics, TrendPoint } from "./types";

export type OverviewChartId = "requests" | "cpuRam" | "firestore" | "bucketBytes" | "hostingBytes" | "scheduler";

// History view a chart element opens.
export interface Target {
  service: string;
  metric: string;
}

// One focusable entry per target, labelled with its value or note.
export interface LegendEntry {
  text: string;
  target: Target;
}

export interface OverviewChart {
  id: OverviewChartId;
  title: string;
  spec: ChartSpec;
  // targets[datasetIndex][index]: the element clicked on the chart.
  targets: (Target | null)[][];
  // Target of a legend click on a dataset.
  datasetTargets: (Target | null)[];
  entries: LegendEntry[];
}

const SUCCESS_COLOR = "#3ebd93";
const FAILED_COLOR = "#e12d39";
const UNKNOWN_COLOR = "#9aa5b1";

function servicesOf(kind: Kind) {
  return SERVICES.filter((s) => s.kind === kind);
}

function toTimePoints(points: TrendPoint[] | null | undefined): TimePoint[] {
  return (points ?? [])
    .map((p) => ({ x: Date.parse(p.t), y: p.v }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
}

// Bar value and note: numbers as is, never 0 for idle or unknown values.
function barValue(value: MetricValue | undefined): { value: number | null; note: string | null } {
  if (typeof value === "number" && Number.isFinite(value)) return { value, note: null };
  if (value === IDLE) return { value: null, note: IDLE };
  return { value: null, note: NOT_AVAILABLE };
}

function lineChart(
  id: OverviewChartId,
  title: string,
  lines: { label: string; points: TrendPoint[] | null | undefined; target: Target; text: string }[],
): OverviewChart {
  const datasets: ChartSeries[] = lines.map((line) => ({ label: line.label, data: toTimePoints(line.points) }));
  return {
    id,
    title,
    spec: { kind: "line", timeAxis: true, datasets },
    targets: datasets.map((d, i) => d.data.map(() => lines[i].target)),
    datasetTargets: lines.map((line) => line.target),
    entries: lines.map((line) => ({ text: line.text, target: line.target })),
  };
}

function entryText(name: string, label: string, key: string, value: MetricValue | undefined): string {
  return `${name} ${label}: ${formatValue(key, value)}`;
}

function requestsChart(byId: Map<string, ServiceMetrics>): OverviewChart {
  return lineChart(
    "requests",
    "Requests per minute (2nd gen functions)",
    servicesOf("function2").map((s) => {
      const data = byId.get(s.id);
      return {
        label: s.name,
        points: data?.trends?.reqPerMin,
        target: { service: s.id, metric: "reqPerMin" },
        text: entryText(s.name, METRIC_LABELS.reqPerMin, "reqPerMin", data?.metrics.reqPerMin),
      };
    }),
  );
}

function cpuRamChart(byId: Map<string, ServiceMetrics>): OverviewChart {
  const services = servicesOf("function2");
  const keys = ["cpuPct", "memPct"] as const;
  const datasets: ChartSeries[] = [];
  const targets: Target[][] = [];
  const entries: LegendEntry[] = [];
  for (const key of keys) {
    const bars = services.map((s) => barValue(byId.get(s.id)?.metrics[key]));
    datasets.push({ label: METRIC_LABELS[key], data: bars.map((b) => b.value), notes: bars.map((b) => b.note) });
    targets.push(services.map((s) => ({ service: s.id, metric: key })));
  }
  for (const s of services) {
    for (const key of keys) {
      const value = byId.get(s.id)?.metrics[key];
      entries.push({ text: entryText(s.name, METRIC_LABELS[key], key, value), target: { service: s.id, metric: key } });
    }
  }
  return {
    id: "cpuRam",
    title: "CPU and RAM % (p99, 2nd gen functions)",
    spec: { kind: "bar", labels: services.map((s) => s.name), datasets, formatValue: (v) => `${formatNumber(v)} %` },
    targets,
    datasetTargets: targets.map((row) => row[0] ?? null),
    entries,
  };
}

function firestoreChart(byId: Map<string, ServiceMetrics>): OverviewChart {
  const db = servicesOf("firestore")[0];
  const data = byId.get(db.id);
  return lineChart(
    "firestore",
    `Firestore operations per minute (${db.name})`,
    (["readsPerMin", "writesPerMin", "deletesPerMin"] as const).map((key) => ({
      label: METRIC_LABELS[key],
      points: data?.trends?.[key],
      target: { service: db.id, metric: key },
      text: entryText(db.name, METRIC_LABELS[key], key, data?.metrics[key]),
    })),
  );
}

function bytesBarChart(
  id: OverviewChartId,
  title: string,
  kind: Kind,
  key: string,
  byId: Map<string, ServiceMetrics>,
): OverviewChart {
  const services = servicesOf(kind);
  const bars = services.map((s) => barValue(byId.get(s.id)?.metrics[key]));
  const targets = [services.map((s) => ({ service: s.id, metric: key }))];
  return {
    id,
    title,
    spec: {
      kind: "bar",
      labels: services.map((s) => s.name),
      datasets: [{ label: METRIC_LABELS[key], data: bars.map((b) => b.value), notes: bars.map((b) => b.note) }],
      formatValue: formatBytes,
    },
    targets,
    datasetTargets: [targets[0][0] ?? null],
    entries: services.map((s) => ({
      text: entryText(s.name, METRIC_LABELS[key], key, byId.get(s.id)?.metrics[key]),
      target: { service: s.id, metric: key },
    })),
  };
}

const HOUR_MS = 3600000;

function schedulerChart(byId: Map<string, ServiceMetrics>, generatedAt: string | undefined): OverviewChart {
  const jobs = servicesOf("scheduler");
  const nowMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const bars = jobs.map((s) => {
    const metrics = byId.get(s.id)?.metrics;
    const result = metrics?.lastResult ?? null;
    const at = typeof metrics?.lastRunAt === "string" ? Date.parse(metrics.lastRunAt) : Number.NaN;
    const hours = Number.isFinite(at) && Number.isFinite(nowMs) ? Number(((nowMs - at) / HOUR_MS).toFixed(1)) : null;
    if (result === "none") return { value: null, note: NO_RUN, color: UNKNOWN_COLOR, text: NO_RUN };
    const color = result === "success" ? SUCCESS_COLOR : result === "failed" ? FAILED_COLOR : UNKNOWN_COLOR;
    const resultText = result === "success" || result === "failed" ? result : `result ${NOT_AVAILABLE}`;
    const ago = hours === null ? `last run ${NOT_AVAILABLE}` : `${formatNumber(hours)} h ago`;
    return { value: hours, note: hours === null ? NOT_AVAILABLE : null, color, text: `${resultText}, ${ago}` };
  });
  const targets = [jobs.map((s) => ({ service: s.id, metric: "runs" }))];
  return {
    id: "scheduler",
    title: "Scheduler jobs: hours since the last run",
    spec: {
      kind: "bar",
      labels: jobs.map((s) => s.name),
      datasets: [
        {
          label: "Hours since last run",
          data: bars.map((b) => b.value),
          notes: bars.map((b) => b.note),
          color: bars.map((b) => b.color),
        },
      ],
      formatValue: (v) => `${formatNumber(v)} h`,
    },
    targets,
    datasetTargets: [targets[0][0] ?? null],
    entries: jobs.map((s, i) => ({ text: `${s.name}: ${bars[i].text}`, target: { service: s.id, metric: "runs" } })),
  };
}

// The six overview charts, built only from one /api/metrics payload (or none yet).
export function buildOverviewSpecs(data: MetricsResponse | null): OverviewChart[] {
  const byId = new Map((data?.services ?? []).map((s) => [s.id, s]));
  return [
    requestsChart(byId),
    cpuRamChart(byId),
    firestoreChart(byId),
    bytesBarChart("bucketBytes", "Storage bucket bytes stored", "bucket", "bytesStored", byId),
    bytesBarChart("hostingBytes", "Hosting bytes served (window)", "hosting", "bytesServed", byId),
    schedulerChart(byId, data?.generatedAt),
  ];
}

// Target for a chart click (index) or a legend click (index null).
export function pickTarget(chart: OverviewChart, datasetIndex: number, index: number | null): Target | null {
  if (index === null) return chart.datasetTargets[datasetIndex] ?? null;
  return chart.targets[datasetIndex]?.[index] ?? null;
}
