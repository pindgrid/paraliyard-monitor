import { createChart, type ChartSpec, type TimePoint } from "./charts";
import { formatBytes, formatNumber } from "./format";
import type { HistorySource } from "./history-source";
import { createPoller } from "./poller";
import { COUNT_METRICS, HISTORY_RANGES, METRIC_LABELS, alignmentSeconds, rangeSeconds } from "./routes";
import { SERVICES } from "./services";
import { formatIst } from "./time";
import type { HistoryRange, HistoryResponse, Route, TrendPoint } from "./types";

export type HistoryRoute = Extract<Route, { view: "history" }>;

// Long ranges change slowly and are cached for up to 15 min by the backend.
export const LONG_RANGE_INTERVAL_MS = 300000;
export const IDLE_TEXT = "idle: the service reported no CPU/RAM samples in this range";
export const DAILY_TEXT = "measured about once a day";
export const NO_ACTIVITY_TEXT = "No activity in this range (flat 0).";
export const NO_SAMPLES_TEXT = "No samples in this range.";

export type HistoryState = "loading" | "ok" | "stale" | "empty" | "error";

export interface HistoryViewOptions {
  route: HistoryRoute;
  source: HistorySource;
  refreshSeconds: number;
  doc: Document;
  onClose(): void;
  onRange(range: HistoryRange): void;
  now?: () => number;
}

export interface HistoryView {
  close(): void;
}

// 1h and 6h follow the dashboard refresh; longer ranges refresh every 5 minutes.
export function historyIntervalMs(range: HistoryRange, refreshSeconds: number): number {
  return range === "1h" || range === "6h" ? refreshSeconds * 1000 : LONG_RANGE_INTERVAL_MS;
}

export interface Summary {
  min: number;
  avg: number;
  max: number;
}

export function summarize(points: readonly TrendPoint[]): Summary | null {
  const values = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return { min: Math.min(...values), avg: total / values.length, max: Math.max(...values) };
}

const BYTE_METRICS = new Set(["memBytes", "bytesStored", "bytesServed"]);
const GAUGE_PCT_METRICS = new Set(["cpuPct", "memPct"]);

function valueFormatter(metric: string): (v: number) => string {
  if (BYTE_METRICS.has(metric)) return formatBytes;
  if (GAUGE_PCT_METRICS.has(metric)) return (v) => `${formatNumber(v)} %`;
  return formatNumber;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, className?: string) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Renders the history view for one route into host and polls its source.
// Uses textContent only, never innerHTML. close() stops all polling.
export function openHistoryView(
  host: HTMLElement,
  { route, source, refreshSeconds, doc, onClose, onRange, now = Date.now }: HistoryViewOptions,
): HistoryView {
  const { service: serviceId, metric, range } = route;
  const service = SERVICES.find((s) => s.id === serviceId);
  const label = METRIC_LABELS[metric] ?? metric;
  const format = valueFormatter(metric);
  let closed = false;

  const section = el(doc, "section", undefined, "history-view");
  section.dataset.service = serviceId;
  section.dataset.metric = metric;
  section.dataset.range = range;

  const header = el(doc, "header", undefined, "history-header");
  header.appendChild(el(doc, "h2", `${service?.name ?? serviceId} · ${label}`));
  const ranges = el(doc, "div", undefined, "history-ranges");
  ranges.setAttribute("role", "group");
  ranges.setAttribute("aria-label", "Range");
  for (const r of HISTORY_RANGES) {
    const button = el(doc, "button", r);
    button.type = "button";
    button.dataset.range = r;
    button.setAttribute("aria-pressed", String(r === range));
    button.addEventListener("click", () => {
      if (r !== range) onRange(r);
    });
    ranges.appendChild(button);
  }
  const resetZoom = el(doc, "button", "Reset zoom");
  resetZoom.type = "button";
  resetZoom.dataset.action = "reset-zoom";
  const close = el(doc, "button", "Close");
  close.type = "button";
  close.dataset.action = "close";
  close.addEventListener("click", () => onClose());
  header.append(ranges, resetZoom, close);

  const status = el(doc, "p", "Loading history…", "history-status");
  status.dataset.historyState = "loading";
  status.setAttribute("role", "status");

  const figure = el(doc, "figure", undefined, "chart history-chart");
  const frame = el(doc, "div", undefined, "chart-canvas");
  const canvas = el(doc, "canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${label} history, times in IST`);
  frame.appendChild(canvas);
  figure.appendChild(frame);

  const note = el(doc, "p", "", "history-note");
  note.dataset.note = "";
  const summary = el(doc, "p", "", "history-summary");
  summary.dataset.summary = "";

  section.append(header, status, figure, note, summary);
  host.replaceChildren(section);
  host.hidden = false;

  const spec = (data: TimePoint[]): ChartSpec => ({
    kind: "line",
    timeAxis: true,
    zoom: true,
    datasets: [{ label, data }],
    formatValue: format,
  });
  const chart = createChart(canvas, spec([]));
  resetZoom.addEventListener("click", () => chart.resetZoom());

  function setState(state: HistoryState, text: string) {
    status.dataset.historyState = state;
    status.textContent = text;
  }

  function render(response: HistoryResponse) {
    const parsed = Date.parse(response.generatedAt);
    const nowMs = Number.isFinite(parsed) ? parsed : now();
    const startMs = nowMs - rangeSeconds(range) * 1000;
    const points: TimePoint[] = response.points
      .map((p) => ({ x: Date.parse(p.t), y: p.v }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x);
    const updated = `updated ${formatIst(nowMs)}`;

    if (points.length === 0) {
      if (COUNT_METRICS.has(metric)) {
        chart.update(spec([{ x: startMs, y: 0 }, { x: nowMs, y: 0 }]));
        note.textContent = NO_ACTIVITY_TEXT;
        summary.textContent = `min ${format(0)} · avg ${format(0)} · max ${format(0)} (${response.unit})`;
      } else {
        chart.update(spec([]));
        note.textContent = GAUGE_PCT_METRICS.has(metric)
          ? IDLE_TEXT
          : metric === "bytesStored"
            ? DAILY_TEXT
            : NO_SAMPLES_TEXT;
        summary.textContent = "";
      }
      setState(response.stale ? "stale" : "empty", response.stale ? `Showing stale data, ${updated}` : `No data, ${updated}`);
      return;
    }

    chart.update(spec(points));
    const first = points[0].x;
    note.textContent =
      first > startMs + alignmentSeconds(range) * 1000 ? `data from ${formatIst(first)}` : "";
    const stats = summarize(response.points);
    summary.textContent = stats
      ? `min ${format(stats.min)} · avg ${format(stats.avg)} · max ${format(stats.max)} (${response.unit})`
      : "";
    setState(response.stale ? "stale" : "ok", response.stale ? `Showing stale data, ${updated}` : `Updated ${formatIst(nowMs)}`);
  }

  const poller = createPoller({
    intervalMs: historyIntervalMs(range, refreshSeconds),
    doc,
    task: async () => {
      try {
        const response = await source.load(serviceId, metric, range);
        if (closed) return;
        render(response);
      } catch (err) {
        if (!closed) setState("error", "Could not load history, retrying.");
        throw err;
      }
    },
  });
  poller.start();

  return {
    close() {
      if (closed) return;
      closed = true;
      poller.stop();
      chart.destroy();
      host.replaceChildren();
      host.hidden = true;
    },
  };
}
