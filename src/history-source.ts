import sample from "./mock/sample-metrics.json";
import { COUNT_METRICS, alignmentSeconds, isHistoryRange, rangeSeconds } from "./routes";
import type { HistoryRange, HistoryResponse, MetricsResponse, TrendPoint } from "./types";

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
};

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

// Same-origin GET /api/history. One request at a time is enforced by the
// poller; each request is aborted after timeoutMs.
export function createLiveHistorySource(fetchFn: typeof fetch, timeoutMs = HISTORY_TIMEOUT_MS): HistorySource {
  return {
    async load(service, metric, range) {
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

// Deterministic sample history: points on the range's alignment grid ending
// at floor(now / alignment) * alignment, each value seeded by
// (service, metric, range, t). Never fetches.
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
      const points: TrendPoint[] = [];
      if (!empty) {
        for (let k = count - 1; k >= 0; k -= 1) {
          const t = end - k * stepMs;
          if (t < oldest) continue;
          const v = mockValue(metric, seeded(`${service}|${metric}|${range}|${t}`));
          points.push({ t: new Date(t).toISOString(), v: COUNT_METRICS.has(metric) ? Math.max(0, v) : v });
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
