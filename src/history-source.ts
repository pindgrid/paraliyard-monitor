import allowlist from "./history-allowlist.json";
import sample from "./mock/sample-metrics.json";
import { COUNT_METRICS, alignmentSeconds, isAllowedPair, isHistoryRange, rangeSeconds } from "./routes";
import { DAY_MS, IST_OFFSET_MS, RUN_WINDOW_MS, istDayStart, occurrencesBetween } from "./schedule";
import { JOB_SCHEDULES, SERVICES } from "./services";
import type { HistoryPoint, HistoryRange, HistoryResponse, MetricsResponse, OtherCalls, RunResult, TrendPoint } from "./types";

export interface HistorySource {
  load(service: string, metric: string, range: HistoryRange): Promise<HistoryResponse>;
}

export const HISTORY_URL = "/api/history";
export const HISTORY_TIMEOUT_MS = 15000;

// Same units as functions/src/history.js.
export const HISTORY_UNITS: Record<string, string> = {
  cpuPct: "%",
  memPct: "%",
  reqPerMin: "per minute",
  errPerMin: "per minute",
  instances: "instances",
  execPerMin: "per minute",
  memBytes: "bytes",
  readsPerMin: "per minute",
  writesPerMin: "per minute",
  deletesPerMin: "per minute",
  bytesStored: "bytes",
  bytesServed: "bytes per bucket",
  runs: "runs",
  durationSec: "seconds",
};

const AGGREGATES = allowlist.aggregates as Record<string, string[]>;

// True for an allowlisted (service or aggregate id, metric) pair.
export function isAllowedHistoryTarget(service: string, metric: string): boolean {
  if (Object.prototype.hasOwnProperty.call(AGGREGATES, service)) return AGGREGATES[service].includes(metric);
  return isAllowedPair(service, metric);
}

const RUN_RESULTS: readonly string[] = ["success", "failed", "missed", "upcoming"] satisfies RunResult[];

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

// { t, v } plus, for scheduler runs, optional result, requests and failed.
function isPoint(value: unknown): value is TrendPoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.t === "string" &&
    typeof p.v === "number" &&
    (p.result === undefined || (typeof p.result === "string" && RUN_RESULTS.includes(p.result))) &&
    isOptionalNumber(p.requests) &&
    isOptionalNumber(p.failed)
  );
}

function isOtherCalls(value: unknown): value is OtherCalls {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.count === "number" && typeof o.failed === "number";
}

function isHistoryResponse(body: unknown): body is HistoryResponse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.service === "string" &&
    typeof value.metric === "string" &&
    isHistoryRange(value.range) &&
    typeof value.unit === "string" &&
    typeof value.generatedAt === "string" &&
    Array.isArray(value.points) &&
    value.points.every(isPoint) &&
    (value.otherCalls === undefined || isOtherCalls(value.otherCalls))
  );
}

// Same-origin GET /api/history with allowlisted values only (anything else is
// rejected without a request); each request is aborted after timeoutMs.
export function createLiveHistorySource(fetchFn: typeof fetch, timeoutMs = HISTORY_TIMEOUT_MS): HistorySource {
  return {
    async load(service, metric, range) {
      if (!isHistoryRange(range) || !isAllowedHistoryTarget(service, metric)) {
        throw new Error("history query is not allowlisted");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const query = new URLSearchParams({ service, metric, range });
        const res = await fetchFn(`${HISTORY_URL}?${query.toString()}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`history request failed with status ${res.status}`);
        const body: unknown = await res.json();
        if (!isHistoryResponse(body)) throw new Error("history response has an unexpected shape");
        return body;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// 2nd gen services that are idle in the sample payload report no CPU/RAM history.
const IDLE_SERVICES: ReadonlySet<string> = new Set(
  (sample as unknown as MetricsResponse).services.filter((s) => s.metrics.cpuPct === "idle").map((s) => s.id),
);

// The mock keeps 24 days of history, so 30d and 6w start later than the range.
export const MOCK_RETENTION_SECONDS = 24 * 86400;

// FNV-1a hash of the inputs, as a number in [0, 1).
function seeded(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

const MB = 1024 * 1024;

function mockValue(metric: string, h: number): number {
  switch (metric) {
    case "cpuPct":
      return Number((2 + h * 40).toFixed(1));
    case "memPct":
      return Number((15 + h * 35).toFixed(1));
    case "instances":
      return Math.floor(h * 3);
    case "memBytes":
      return Math.round((0.1 + h * 0.2) * 512 * MB);
    case "bytesStored":
      return Math.round(41 * MB + h * MB);
    case "bytesServed":
      return Math.round(h * 250000);
    case "readsPerMin":
      return Number((100 + h * 80).toFixed(2));
    case "writesPerMin":
      return Number((10 + h * 15).toFixed(2));
    default:
      return Number((h * 4).toFixed(2));
  }
}

// Seconds after the scheduled minute at which a mock run is recorded.
const MOCK_RUN_DELAY_MS = 47000;

// The backend reads scheduler history in 5-minute buckets at every range.
const SCHEDULER_STEP_MS = 300000;

function istDayNumber(t: number): number {
  return Math.floor((t + IST_OFFSET_MS) / DAY_MS);
}

// Some mock runs fail: every 9th day for the nightly job, every 3rd week for the weekly one.
function mockRunFailed(service: string, t: number): boolean {
  const day = istDayNumber(t);
  return service === "scheduler:pyWeeklyAccounts" ? Math.floor(day / 7) % 3 === 1 : day % 9 === 4;
}

// Some mock runs never happen: every 11th day for the nightly job, every 4th week for the weekly one.
function mockRunMissed(service: string, t: number): boolean {
  const day = istDayNumber(t);
  return service === "scheduler:pyWeeklyAccounts" ? Math.floor(day / 7) % 4 === 3 : day % 11 === 7;
}

interface MockRun {
  at: number;
  result: RunResult;
}

// One mock run per scheduled occurrence in [fromMs, nowMs].
function mockRuns(service: string, fromMs: number, nowMs: number): MockRun[] {
  const job = JOB_SCHEDULES[service];
  if (!job) return [];
  return occurrencesBetween(job.cron, fromMs, nowMs).map((at) => {
    let result: RunResult;
    if (nowMs < at + RUN_WINDOW_MS) result = "upcoming";
    else if (mockRunMissed(service, at)) result = "missed";
    else result = mockRunFailed(service, at) ? "failed" : "success";
    return { at, result };
  });
}

// Mock manual calls outside every run window, at 18:20 IST on some days:
// for the nightly job 4 failing calls every 6th day and 2 good calls every
// 7th day, for the weekly job 3 failing calls every 10th day.
function mockOtherCalls(service: string, fromMs: number, nowMs: number): OtherCalls {
  const out = { count: 0, failed: 0 };
  if (!JOB_SCHEDULES[service]) return out;
  for (let day = istDayStart(fromMs); day <= nowMs; day += DAY_MS) {
    const t = day + (18 * 60 + 20) * 60000;
    if (t < fromMs || t > nowMs) continue;
    const n = istDayNumber(t);
    if (service === "scheduler:pyWeeklyAccounts") {
      if (n % 10 === 3) {
        out.count += 3;
        out.failed += 3;
      }
    } else {
      if (n % 6 === 1) {
        out.count += 4;
        out.failed += 4;
      }
      if (n % 7 === 2) out.count += 2;
    }
  }
  return out;
}

function mockDuration(service: string, t: number): number {
  const h = seeded(`${service}|duration|${t}`);
  return Math.round(service === "scheduler:pyNightlyExport" ? 38 + h * 55 : 14 + h * 26);
}

// Members of an aggregate id, or [service] for a single service.
function membersOf(service: string): string[] {
  if (!Object.prototype.hasOwnProperty.call(AGGREGATES, service)) return [service];
  const kind = service.slice("total:".length);
  return SERVICES.filter((s) => s.kind === kind).map((s) => s.id);
}

// Scheduler history like /api/history: runs has one point per scheduled
// occurrence plus otherCalls; durationSec has one 5-minute bucket inside each
// run window that had a request.
function mockSchedulerHistory(service: string, metric: string, fromMs: number, nowMs: number): Pick<HistoryResponse, "points" | "otherCalls"> {
  const runs = mockRuns(service, fromMs, nowMs);
  if (metric === "runs") {
    const points = runs.map((r): HistoryPoint => {
      const requests = r.result === "success" || r.result === "failed" ? 1 : 0;
      const failed = r.result === "failed" ? 1 : 0;
      return { t: new Date(r.at).toISOString(), v: requests, result: r.result, requests, failed };
    });
    return { points, otherCalls: mockOtherCalls(service, fromMs, nowMs) };
  }
  const points = runs
    .filter((r) => r.result === "success" || r.result === "failed")
    .map((r) => {
      const end = Math.ceil((r.at + MOCK_RUN_DELAY_MS) / SCHEDULER_STEP_MS) * SCHEDULER_STEP_MS;
      return { t: new Date(end).toISOString(), v: mockDuration(service, r.at) };
    })
    .filter((p) => Date.parse(p.t) <= nowMs);
  return { points };
}

// Deterministic sample history: points on the range's alignment grid ending
// at floor(now / alignment) * alignment, each value seeded by
// (service, metric, range, t); an aggregate sums its services. Scheduler runs
// follow the job's cron with some failed and some missed runs, and
// durationSec has a point for each run that happened. Never fetches.
export function createMockHistorySource(now: () => number = Date.now): HistorySource {
  return {
    async load(service, metric, range) {
      const nowMs = now();
      const stepMs = alignmentSeconds(range) * 1000;
      const end = Math.floor(nowMs / stepMs) * stepMs;
      const count = rangeSeconds(range) / alignmentSeconds(range);
      const oldest = nowMs - MOCK_RETENTION_SECONDS * 1000;
      const base = {
        service,
        metric,
        range,
        unit: HISTORY_UNITS[metric] ?? "",
        points: [] as HistoryPoint[],
        generatedAt: new Date(nowMs).toISOString(),
      };
      if (metric === "runs" || metric === "durationSec") {
        const fromMs = Math.max(nowMs - rangeSeconds(range) * 1000, oldest);
        const { points, otherCalls } = mockSchedulerHistory(service, metric, fromMs, nowMs);
        return otherCalls ? { ...base, points, otherCalls } : { ...base, points };
      }
      const empty =
        ((metric === "cpuPct" || metric === "memPct") && IDLE_SERVICES.has(service)) ||
        (metric === "bytesStored" && (range === "1h" || range === "6h"));
      const members = membersOf(service);
      const points = base.points;
      if (!empty) {
        for (let k = count - 1; k >= 0; k -= 1) {
          const t = end - k * stepMs;
          if (t < oldest) continue;
          let v = 0;
          for (const member of members) v += mockValue(metric, seeded(`${member}|${metric}|${range}|${t}`));
          v = Number(v.toFixed(2));
          points.push({ t: new Date(t).toISOString(), v: COUNT_METRICS.has(metric) ? Math.max(0, v) : v });
        }
      }
      return base;
    },
  };
}
