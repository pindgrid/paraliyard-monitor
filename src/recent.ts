import type { ServiceMetrics } from "./types";

// One per-minute series of `recent`: null when unknown (failed call or no data).
export type Series = readonly (number | null)[] | null;

export function recentSeries(service: ServiceMetrics | undefined, key: string): Series {
  const values = service?.recent?.series?.[key];
  return Array.isArray(values) ? values : null;
}

// The "now" value: the newest minute.
export function latestValue(series: Series): number | null {
  if (!series || series.length === 0) return null;
  const v = series[series.length - 1];
  return typeof v === "number" ? v : null;
}

// Sum over the 30 minutes, ignoring unknown minutes.
export function sumOf(series: Series): number | null {
  if (!series) return null;
  return series.reduce<number>((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
}

// Largest minute, or null when unknown.
export function peakOf(series: Series): number | null {
  if (!series) return null;
  const values = series.filter((v): v is number => typeof v === "number");
  return values.length > 0 ? Math.max(...values) : null;
}

// Minute-by-minute sum; null only when every input is null.
export function addSeries(list: readonly Series[]): Series {
  const present = list.filter((s): s is readonly (number | null)[] => Array.isArray(s));
  if (present.length === 0) return null;
  const length = Math.max(...present.map((s) => s.length));
  return Array.from({ length }, (_, i) => present.reduce<number>((acc, s) => acc + (typeof s[i] === "number" ? (s[i] as number) : 0), 0));
}

const positive = (v: number | null | undefined) => typeof v === "number" && v > 0;

// A function is running now when its newest minute had requests (executions
// for 1st gen) or it has instances.
export function isRunningNow(service: ServiceMetrics): boolean {
  if (service.kind === "function1") return positive(latestValue(recentSeries(service, "execPerMin")));
  if (service.kind !== "function2") return false;
  const instances = service.metrics.instances;
  return positive(latestValue(recentSeries(service, "reqPerMin"))) || (typeof instances === "number" && instances > 0);
}

// Requests per minute of a function: requests for 2nd gen, executions for 1st gen.
export function requestSeries(service: ServiceMetrics): Series {
  return recentSeries(service, service.kind === "function1" ? "execPerMin" : "reqPerMin");
}

export type CellState = "idle" | "on" | "err" | "none";

export interface ActivityCell {
  state: CellState;
  // Straw opacity for "on" cells, scaled by the requests in that minute.
  alpha: number;
}

export const ACTIVITY_SLOTS = 30;

export function cellAlpha(requests: number): number {
  return Math.min(1, 0.3 + requests / 5);
}

// One cell per minute: ember for a minute with errors, straw scaled by
// requests, idle for 0 and "none" when unknown.
export function activityCells(requests: Series, errors: Series): ActivityCell[] {
  return Array.from({ length: ACTIVITY_SLOTS }, (_, i) => {
    const req = requests ? requests[i] : null;
    const err = errors ? errors[i] : null;
    if (positive(err)) return { state: "err", alpha: 1 };
    if (typeof req !== "number") return { state: "none", alpha: 0 };
    if (req > 0) return { state: "on", alpha: cellAlpha(req) };
    return { state: "idle", alpha: 0 };
  });
}
