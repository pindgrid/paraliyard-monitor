// Shared data contract between liveMonitorApi and the dashboard.

export type Kind = "function2" | "function1" | "firestore" | "bucket" | "hosting" | "scheduler";

export type WindowKey = "1h" | "6h";

export interface ServiceInfo {
  id: string;
  kind: Kind;
  name: string;
}

// "idle": the call succeeded but the service reported no data in the window.
export type Idle = "idle";

export interface Function2Metrics {
  cpuPct: number | Idle | null;
  memPct: number | Idle | null;
  reqPerMin: number | null;
  errPerMin: number | null;
  instances: number | null;
  // ISO time of the latest CPU / RAM value.
  cpuAt: string | null;
  memAt: string | null;
}

export interface Function1Metrics {
  cpuPct: number | null;
  execPerMin: number | null;
  memBytes: number | Idle | null;
  memPct: number | Idle | null;
  memAt: string | null;
}

export interface FirestoreMetrics {
  readsPerMin: number | null;
  writesPerMin: number | null;
  deletesPerMin: number | null;
}

export interface BucketMetrics {
  reqPerMin: number | null;
  bytesStored: number | null;
}

export interface HostingMetrics {
  bytesServed: number | null;
}

// "none": the call succeeded but the job had no run in the 8-day lookback.
export type SchedulerResult = "success" | "failed" | "none";

export interface SchedulerMetrics {
  lastRunAt: string | null;
  lastResult: SchedulerResult | null;
}

export interface MetricsByKind {
  function2: Function2Metrics;
  function1: Function1Metrics;
  firestore: FirestoreMetrics;
  bucket: BucketMetrics;
  hosting: HostingMetrics;
  scheduler: SchedulerMetrics;
}

export type MetricValue = number | string | null;

export type MetricRecord = Record<string, MetricValue>;

export interface TrendPoint {
  t: string;
  v: number;
}

// Per-minute values for the last 30 minutes. Slot i covers
// [from + i * stepSeconds, from + (i + 1) * stepSeconds]; a series is null
// when its call failed and 0 for a minute without data.
export interface RecentSeries {
  from: string;
  stepSeconds: number;
  series: Record<string, (number | null)[] | null>;
}

export interface ServiceMetrics {
  id: string;
  kind: Kind;
  name: string;
  metrics: MetricRecord;
  trend: { points: TrendPoint[] };
  // Per-metric trends: null when the call failed, [] for a gauge without samples.
  trends: Record<string, TrendPoint[] | null>;
  recent?: RecentSeries;
  // Scheduler jobs only.
  schedule?: string;
  cron?: string;
  timeZone?: string;
  nextRun?: string;
}

export interface MetricsResponse {
  generatedAt: string;
  window: WindowKey;
  stale: boolean;
  services: ServiceMetrics[];
  totals: Partial<Record<Kind, MetricRecord>>;
}

export type HistoryRange = "1h" | "6h" | "24h" | "7d" | "30d" | "6w";

// Totals over every service of one kind (GET /api/history only).
export type AggregateId = "total:function2" | "total:bucket" | "total:hosting";

// A history point; scheduler runs also carry the non-2xx part as failed.
export interface HistoryPoint extends TrendPoint {
  failed?: number;
}

// GET /api/history response.
export interface HistoryResponse {
  service: string;
  metric: string;
  range: HistoryRange;
  unit: string;
  points: HistoryPoint[];
  generatedAt: string;
  stale?: boolean;
}

export type Route =
  | { view: "overview" }
  | { view: "history"; service: string; metric: string; range: HistoryRange };

export type Mode = "mock" | "live" | "off";

export interface Config {
  mode: Mode;
  refreshSeconds: number;
}
