import allowlist from "./history-allowlist.json";
import { SERVICES } from "./services";
import type { HistoryRange, Kind, Route } from "./types";

// Same allowlist as functions/src/history.js (checked by a backend contract test).
export const HISTORY_RANGES: readonly HistoryRange[] = allowlist.ranges.map((r) => r.key as HistoryRange);
export const DEFAULT_RANGE: HistoryRange = "24h";

const METRICS_BY_KIND = allowlist.metricsByKind as Record<Kind, string[]>;

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === "string" && (HISTORY_RANGES as readonly string[]).includes(value);
}

function rangeInfo(range: HistoryRange) {
  const info = allowlist.ranges.find((r) => r.key === range);
  if (!info) throw new Error(`unknown range ${range}`);
  return info;
}

export function rangeSeconds(range: HistoryRange): number {
  return rangeInfo(range).seconds;
}

export function alignmentSeconds(range: HistoryRange): number {
  return rangeInfo(range).alignmentSeconds;
}

// True when the backend history allowlist accepts this (service id, metric).
export function isAllowedPair(serviceId: string, metric: string): boolean {
  const service = SERVICES.find((s) => s.id === serviceId);
  return service !== undefined && METRICS_BY_KIND[service.kind].includes(metric);
}

// Service ids and metric keys only use [A-Za-z0-9:-], so they go into the path as is.
export function historyPath(service: string, metric: string, range: HistoryRange = DEFAULT_RANGE): string {
  return `/history/${service}/${metric}?range=${range}`;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const HISTORY_PATTERN = /^\/history\/([^/]+)\/([^/]+)\/?$/;

// Anything that is not an allowlisted history route is the overview.
export function parseRoute(pathname: string, search: string): Route {
  const match = HISTORY_PATTERN.exec(pathname);
  if (!match) return { view: "overview" };
  const service = decode(match[1]);
  const metric = decode(match[2]);
  const range = new URLSearchParams(search).get("range") ?? DEFAULT_RANGE;
  if (service === null || metric === null || !isHistoryRange(range) || !isAllowedPair(service, metric)) {
    return { view: "overview" };
  }
  return { view: "history", service, metric, range };
}

// Metric shown by each kind's sparkline.
export const PRIMARY_METRIC: Record<Kind, string> = {
  function2: "reqPerMin",
  function1: "execPerMin",
  firestore: "readsPerMin",
  bucket: "reqPerMin",
  hosting: "bytesServed",
  scheduler: "runs",
};

// History metric opened by each table column, or null for none.
export const CELL_METRIC: Record<Kind, Record<string, string | null>> = {
  function2: { cpuPct: "cpuPct", memPct: "memPct", reqPerMin: "reqPerMin", errPerMin: "errPerMin", instances: "instances" },
  // 1st gen functions report no CPU; their RAM % comes from memory bytes.
  function1: { cpuPct: null, execPerMin: "execPerMin", memBytes: "memBytes", memPct: "memBytes" },
  firestore: { readsPerMin: "readsPerMin", writesPerMin: "writesPerMin", deletesPerMin: "deletesPerMin" },
  bucket: { reqPerMin: "reqPerMin", bytesStored: "bytesStored" },
  hosting: { bytesServed: "bytesServed" },
  scheduler: { lastRunAt: "runs", lastResult: "runs" },
};

// Counts: an empty answer is a flat 0 line. Everything else is a gauge.
export const COUNT_METRICS: ReadonlySet<string> = new Set([
  "reqPerMin",
  "errPerMin",
  "execPerMin",
  "readsPerMin",
  "writesPerMin",
  "deletesPerMin",
  "bytesServed",
  "runs",
]);

export const METRIC_LABELS: Record<string, string> = {
  cpuPct: "CPU % (p99)",
  memPct: "RAM % (p99)",
  reqPerMin: "Requests/min",
  errPerMin: "Errors/min",
  instances: "Instances",
  execPerMin: "Executions/min",
  memBytes: "Memory (p99)",
  readsPerMin: "Reads/min",
  writesPerMin: "Writes/min",
  deletesPerMin: "Deletes/min",
  bytesStored: "Bytes stored",
  bytesServed: "Bytes served",
  runs: "Runs",
};
