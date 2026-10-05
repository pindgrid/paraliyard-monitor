import allowlist from "./history-allowlist.json";
import sample from "./mock/sample-metrics.json";
import { COUNT_METRICS, alignmentSeconds, isAllowedPair, isHistoryRange, rangeSeconds } from "./routes";
import { DAY_MS, IST_OFFSET_MS, istDayStart, parseCron } from "./schedule";
import { JOB_SCHEDULES, SERVICES } from "./services";
import type { HistoryPoint, HistoryRange, HistoryResponse, MetricsResponse, TrendPoint } from "./types";

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
  runs: "runs per bucket",
  durationSec: "seconds",
};

const AGGREGATES = allowlist.aggregates as Record<string, string[]>;

// True for an allowlisted (service or aggregate id, metric) pair.
export function isAllowedHistoryTarget(service: string, metric: string): boolean {
  if (Object.prototype.hasOwnProperty.call(AGGREGATES, service)) return AGGREGATES[service].includes(metric);
  return isAllowedPair(service, metric);
}

function isPoint(value: unknown): value is TrendPoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.t === "string" && typeof p.v === "number";
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
    value.points.every(isPoint)
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
    case "runs":
      return h > 0.97 ? 1 : 0;
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

// Scheduled run times of a job in (fromMs, toMs].
function mockRunTimes(service: string, fromMs: number, toMs: number): number[] {
  const job = JOB_SCHEDULES[service];
  if (!job) return [];
  const { minute, hour, weekday } = parseCron(job.cron);
  const out: number[] = [];
  for (let day = istDayStart(fromMs); day <= toMs; day += DAY_MS) {
    if (weekday !== null && new Date(day + IST_OFFSET_MS).getUTCDay() !== weekday) continue;
    const t = day + (hour * 60 + minute) * 60000 + MOCK_RUN_DELAY_MS;
    if (t > fromMs && t <= toMs) out.push(t);
  }
  return out;
}

// Some mock runs fail: every 9th day for the nightly job, every 3rd week for the weekly one.
function mockRunFailed(service: string, t: number): boolean {
  const day = Math.floor((t + IST_OFFSET_MS) / DAY_MS);
  return service === "scheduler:pyWeeklyAccounts" ? Math.floor(day / 7) % 3 === 1 : day % 9 === 4;
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

// Deterministic sample history: points on the range's alignment grid ending
// at floor(now / alignment) * alignment, each value seeded by
// (service, metric, range, t); an aggregate sums its services. Scheduler runs
// follow the job's cron with some failed runs, and durationSec has a point
// for each bucket with a run. Never fetches.
export function createMockHistorySource(now: () => number = Date.now): HistorySource {
  return {
    async load(service, metric, range) {
      const nowMs = now();
      const stepMs = alignmentSeconds(range) * 1000;
      const end = Math.floor(nowMs / stepMs) * stepMs;
      const count = rangeSeconds(range) / alignmentSeconds(range);
      const oldest = nowMs - MOCK_RETENTION_SECONDS * 1000;
      const empty =
        ((metric === "cpuPct" || metric === "memPct") && IDLE_SERVICES.has(service)) ||
        (metric === "bytesStored" && (range === "1h" || range === "6h"));
      const members = membersOf(service);
      const points: HistoryPoint[] = [];
      if (!empty) {
        for (let k = count - 1; k >= 0; k -= 1) {
          const t = end - k * stepMs;
          if (t < oldest) continue;
          const iso = new Date(t).toISOString();
          if (metric === "runs" || metric === "durationSec") {
            const runs = mockRunTimes(service, t - stepMs, t);
            if (metric === "runs") {
              points.push({ t: iso, v: runs.length, failed: runs.filter((r) => mockRunFailed(service, r)).length });
            } else if (runs.length > 0) {
              points.push({ t: iso, v: mockDuration(service, runs[runs.length - 1]) });
            }
            continue;
          }
          let v = 0;
          for (const member of members) v += mockValue(metric, seeded(`${member}|${metric}|${range}|${t}`));
          v = Number(v.toFixed(2));
          points.push({ t: iso, v: COUNT_METRICS.has(metric) ? Math.max(0, v) : v });
        }
      }
      return {
        service,
        metric,
        range,
        unit: HISTORY_UNITS[metric] ?? "",
        points,
        generatedAt: new Date(nowMs).toISOString(),
      };
    },
  };
}
