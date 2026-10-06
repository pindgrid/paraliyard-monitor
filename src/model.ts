// The page's data model, the adapter from GET /api/metrics, the schedules of
// the two Cloud Scheduler jobs, and the derived health.
import { DAY, HOUR, MIN, fDay, isNum, istDayStart, istWeekday, last, sum, type Series } from "./format";

export const PROJECT_ID = "mineral-proton-438104-g8";
export const shortBucket = (name: string) => (name.startsWith(`${PROJECT_ID}-`) ? name.slice(PROJECT_ID.length + 1) : name);

// A utilisation: a percentage, "idle" (nothing ran), "na" (not reported) or unknown.
export type Gauge = number | "idle" | "na" | null;

export interface FnInfo {
  id: string;
  name: string;
  gen: 1 | 2;
  req: Series | null;
  err: Series | null;
  cpu: Gauge;
  ram: Gauge;
  instances: number | null;
}
export interface BucketInfo {
  id: string;
  name: string;
  bytes: number | null;
  req: Series | null;
}
export interface SiteInfo {
  id: string;
  name: string;
  served: Series | null;
}
export interface JobInfo {
  id: string;
  name: string;
  schedule: string;
  lastRunAt: number | null;
  lastResult: string | null;
  nextRun: number | null;
}
export interface Model {
  generatedAt: number;
  // Start of each of the last 30 minutes.
  minutes: number[];
  stale?: boolean;
  firestore: { id: string; name: string; reads: Series | null; writes: Series | null; deletes: Series | null };
  functions: FnInfo[];
  buckets: BucketInfo[];
  sites: SiteInfo[];
  jobs: JobInfo[];
}
// One history point; scheduler runs also carry their result.
export interface Point {
  t: number;
  v: number;
  result?: string;
  requests?: number;
  failed?: number;
}
export interface OtherCalls {
  count: number;
  failed: number;
}

export interface JobConf {
  name: string;
  text: string;
  h: number;
  m: number;
  // Day of week (0 = Sunday) or null for every day.
  dow: number | null;
  every: number;
  fn: string;
}
export const JOBS: Record<string, JobConf> = {
  "scheduler:pyNightlyExport": { name: "pyNightlyExport", text: "Every day, 2:30 am", h: 2, m: 30, dow: null, every: DAY, fn: "function2:pyNightlyExport" },
  "scheduler:pyWeeklyAccounts": { name: "pyWeeklyAccounts", text: "Sundays, 3:00 am", h: 3, m: 0, dow: 0, every: 7 * DAY, fn: "function2:pyWeeklyAccounts" },
};

// The next scheduled time after t (dir 1), or the latest at or before t (dir -1), in IST.
export function occurrence(job: JobConf, t: number, dir: 1 | -1): number | null {
  const day = istDayStart(t);
  for (let k = 0; k < 16; k += 1) {
    const occ = day + dir * k * DAY + job.h * HOUR + job.m * MIN;
    if (job.dow !== null && istWeekday(occ) !== job.dow) continue;
    if (dir > 0 && occ > t) return occ;
    if (dir < 0 && occ <= t) return occ;
  }
  return null;
}

// ---------- GET /api/metrics ----------

interface ApiService {
  id: string;
  kind: string;
  name: string;
  metrics: Record<string, unknown>;
  recent?: { from?: string; stepSeconds?: number; series?: Record<string, Series | null> };
  schedule?: string;
  nextRun?: string;
}
export interface ApiMetrics {
  generatedAt: string;
  stale?: boolean;
  services: ApiService[];
}

const seriesOf = (s: ApiService | undefined, key: string): Series | null => {
  const v = s?.recent?.series?.[key];
  return Array.isArray(v) ? v : null;
};
const gauge = (v: unknown): Gauge => (isNum(v) ? v : v === "idle" ? "idle" : null);

export function fromApi(d: ApiMetrics, now: number = Date.now()): Model {
  const svcs = Array.isArray(d.services) ? d.services : [];
  const withRecent = svcs.find((s) => s.recent?.from);
  const parsedFrom = withRecent?.recent?.from ? Date.parse(withRecent.recent.from) : NaN;
  const from = Number.isFinite(parsedFrom) ? parsedFrom : Math.floor(now / MIN) * MIN - 29 * MIN;
  const step = withRecent?.recent?.stepSeconds ? withRecent.recent.stepSeconds * 1000 : MIN;
  const fs = svcs.find((s) => s.kind === "firestore");
  const generated = Date.parse(d.generatedAt);
  return {
    generatedAt: Number.isFinite(generated) ? generated : now,
    minutes: Array.from({ length: 30 }, (_, i) => from + i * step),
    stale: Boolean(d.stale),
    firestore: {
      id: fs?.id ?? "firestore:yard",
      name: fs?.name ?? "yard",
      reads: seriesOf(fs, "readsPerMin"),
      writes: seriesOf(fs, "writesPerMin"),
      deletes: seriesOf(fs, "deletesPerMin"),
    },
    functions: svcs
      .filter((s) => s.kind === "function2" || s.kind === "function1")
      .map((s): FnInfo =>
        s.kind === "function1"
          ? { id: s.id, name: s.name, gen: 1, req: seriesOf(s, "execPerMin"), err: null, cpu: "na", ram: gauge(s.metrics.memPct), instances: null }
          : {
              id: s.id,
              name: s.name,
              gen: 2,
              req: seriesOf(s, "reqPerMin"),
              err: seriesOf(s, "errPerMin"),
              cpu: gauge(s.metrics.cpuPct),
              ram: gauge(s.metrics.memPct),
              instances: isNum(s.metrics.instances) ? s.metrics.instances : null,
            },
      ),
    buckets: svcs
      .filter((s) => s.kind === "bucket")
      .map((s) => ({ id: s.id, name: s.name, bytes: isNum(s.metrics.bytesStored) ? s.metrics.bytesStored : null, req: seriesOf(s, "reqPerMin") })),
    sites: svcs.filter((s) => s.kind === "hosting").map((s) => ({ id: s.id, name: s.name, served: seriesOf(s, "bytesServed") })),
    jobs: svcs
      .filter((s) => s.kind === "scheduler")
      .map((s): JobInfo => {
        const conf = JOBS[s.id];
        const lastRun = typeof s.metrics.lastRunAt === "string" ? Date.parse(s.metrics.lastRunAt) : NaN;
        const apiNext = s.nextRun ? Date.parse(s.nextRun) : NaN;
        const next = Number.isFinite(apiNext) ? apiNext : conf ? occurrence(conf, now, 1) : null;
        return {
          id: s.id,
          name: s.name,
          schedule: conf ? conf.text : (s.schedule ?? ""),
          lastRunAt: Number.isFinite(lastRun) ? lastRun : null,
          lastResult: typeof s.metrics.lastResult === "string" ? s.metrics.lastResult : null,
          nextRun: next,
        };
      }),
  };
}

// ---------- derived ----------

export type FnStatus = "error" | "active" | "idle";
export const fnStatus = (f: FnInfo): FnStatus =>
  sum(f.err) > 0 ? "error" : (last(f.req) ?? 0) > 0 || (f.instances ?? 0) > 0 ? "active" : "idle";

export interface Health {
  ok: boolean;
  reasons: { text: string; open: string }[];
  errs: number;
}
// Healthy unless a function erred in the last 30 minutes or a job's last
// scheduled run failed or was missed.
export function health(m: Model): Health {
  const reasons: Health["reasons"] = [];
  const errs = Math.round(m.functions.reduce((s, f) => s + sum(f.err), 0));
  if (errs > 0) reasons.push({ text: `${errs} function error${errs === 1 ? "" : "s"} in the last 30 min`, open: "sum:functions" });
  for (const j of m.jobs) {
    if (j.lastResult === "failed" || j.lastResult === "missed") reasons.push({ text: `${j.name} ${j.lastResult}`, open: `job:${j.id}` });
  }
  return { ok: reasons.length === 0, reasons, errs };
}

// Per-minute sum of several series (unknown minutes count as 0).
export function addSeries(list: readonly (Series | null)[]): Series | null {
  const present = list.filter((s): s is Series => Array.isArray(s));
  if (present.length === 0) return null;
  const n = Math.max(...present.map((s) => s.length));
  return Array.from({ length: n }, (_, i) => present.reduce((acc, s) => acc + (isNum(s[i]) ? (s[i] as number) : 0), 0));
}

export interface SeriesStats {
  now: number | null;
  avg: number | null;
  peak: number | null;
  total: number | null;
}
export function seriesStats(a: Series | null): SeriesStats {
  const v = (a ?? []).filter(isNum);
  if (v.length === 0) return { now: null, avg: null, peak: null, total: null };
  return { now: last(a), avg: sum(v) / v.length, peak: Math.max(...v), total: sum(v) };
}

// Bytes per day over the last 7 days of a total-stored history.
export function storageGrowth(points: readonly Point[] | null | undefined): number | null {
  if (!points || points.length < 2) return null;
  const end = points[points.length - 1];
  const target = end.t - 7 * DAY;
  let start = points[0];
  for (const p of points) if (p.t <= target) start = p;
  const days = (end.t - start.t) / DAY;
  return days >= 1 ? (end.v - start.v) / days : null;
}

export interface DaySquare {
  // ok, fail, off (not scheduled), wait (not yet due) or "" (no run recorded).
  cls: "ok" | "fail" | "off" | "wait" | "";
  label: string;
  letter: string;
}
// The last 14 IST days of a job, from its scheduled-run history.
export function daySquares(jobId: string, runs: readonly Point[] | null | undefined, now: number): DaySquare[] {
  const conf = JOBS[jobId];
  const today = istDayStart(now);
  const firstRun = (runs ?? []).find((r) => r.result === "success" || r.result === "failed" || r.result === "missed");
  const cells: DaySquare[] = [];
  for (let k = 13; k >= 0; k -= 1) {
    const ds = today - k * DAY;
    const de = ds + DAY;
    const noon = ds + 12 * HOUR;
    const dayText = fDay(noon);
    const letter = "SMTWTFS"[istWeekday(noon)];
    const scheduled = conf ? conf.dow === null || istWeekday(noon) === conf.dow : true;
    const inDay = (runs ?? []).filter((r) => r.t >= ds && r.t < de && (r.result === "success" || r.result === "failed" || r.result === "missed"));
    if (!scheduled) cells.push({ cls: "off", label: `${dayText}: not scheduled`, letter });
    else if (inDay.some((r) => r.result !== "success")) cells.push({ cls: "fail", label: `${dayText}: ${inDay.map((r) => r.result).join(", ")}`, letter });
    else if (inDay.length > 0) cells.push({ cls: "ok", label: `${dayText}: succeeded`, letter });
    else if (conf && ds + conf.h * HOUR + conf.m * MIN > now) cells.push({ cls: "wait", label: `${dayText}: not yet due`, letter });
    else cells.push({ cls: "", label: `${dayText}: ${firstRun && firstRun.t >= de ? "before the first recorded run" : "no run recorded"}`, letter });
  }
  return cells;
}
