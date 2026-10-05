import sample from "./mock/sample-metrics.json";
import type { MetricRecord, MetricsResponse } from "./types";

export interface MetricsSource {
  load(): Promise<MetricsResponse>;
}

export const METRICS_URL = "/api/metrics";
export const METRICS_TIMEOUT_MS = 15000;

function shift(iso: unknown, offsetMs: number): unknown {
  if (typeof iso !== "string") return iso;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + offsetMs).toISOString() : iso;
}

// Moves the CPU / RAM value times so their ages stay the same.
function shiftAtKeys(metrics: MetricRecord, offsetMs: number): void {
  for (const key of ["cpuAt", "memAt"]) {
    if (key in metrics) metrics[key] = shift(metrics[key], offsetMs) as string | null;
  }
}

// Bundled sample data, moved in time so the newest point is "now". Never fetches.
export function createMockSource(now: () => number = Date.now): MetricsSource {
  return {
    async load() {
      const data = JSON.parse(JSON.stringify(sample)) as MetricsResponse;
      const times = data.services.flatMap((s) => s.trend.points.map((p) => Date.parse(p.t)));
      const newest = times.length > 0 ? Math.max(...times) : Date.parse(data.generatedAt);
      const offset = now() - newest;
      data.generatedAt = shift(data.generatedAt, offset) as string;
      for (const s of data.services) {
        for (const p of s.trend.points) p.t = shift(p.t, offset) as string;
        for (const points of Object.values(s.trends ?? {})) {
          for (const p of points ?? []) p.t = shift(p.t, offset) as string;
        }
        if ("lastRunAt" in s.metrics) s.metrics.lastRunAt = shift(s.metrics.lastRunAt, offset) as string | null;
        shiftAtKeys(s.metrics, offset);
      }
      const schedulerTotals = data.totals.scheduler;
      if (schedulerTotals) schedulerTotals.lastRunAt = shift(schedulerTotals.lastRunAt, offset) as string | null;
      for (const totals of Object.values(data.totals)) if (totals) shiftAtKeys(totals, offset);
      return data;
    },
  };
}

function isMetricsResponse(body: unknown): body is MetricsResponse {
  if (body === null || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return Array.isArray(value.services) && value.totals !== null && typeof value.totals === "object";
}

// Same-origin API. One request at a time is enforced by the poller; each
// request is aborted after METRICS_TIMEOUT_MS.
export function createLiveSource(fetchFn: typeof fetch, timeoutMs = METRICS_TIMEOUT_MS): MetricsSource {
  return {
    async load() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(METRICS_URL, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`metrics request failed with status ${res.status}`);
        const body: unknown = await res.json();
        if (!isMetricsResponse(body)) throw new Error("metrics response has an unexpected shape");
        return body;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
