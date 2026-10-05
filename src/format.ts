import type { MetricValue } from "./types";

export const NOT_AVAILABLE = "not available";
export const IDLE = "idle";

const PERCENT_KEYS = new Set(["cpuPct", "memPct"]);
const RATE_KEYS = new Set(["reqPerMin", "errPerMin", "execPerMin", "readsPerMin", "writesPerMin", "deletesPerMin"]);
const BYTE_KEYS = new Set(["memBytes", "bytesStored", "bytesServed"]);
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatNumber(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) < 0.01) return v > 0 ? "<0.01" : ">-0.01";
  return String(Number(v.toFixed(2)));
}

export function formatBytes(v: number): string {
  if (v === 0) return "0";
  let value = v;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
  return `${text} ${BYTE_UNITS[unit]}`;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : NOT_AVAILABLE;
}

// Age of a value relative to the response time, or null for invalid times.
export function ageText(generatedAtIso: string | null | undefined, atIso: string | null | undefined): string | null {
  if (!generatedAtIso || !atIso) return null;
  const g = Date.parse(generatedAtIso);
  const a = Date.parse(atIso);
  if (!Number.isFinite(g) || !Number.isFinite(a)) return null;
  const m = Math.floor((g - a) / 60000);
  return m < 1 ? "just now" : `${m} min ago`;
}

// Display text for one metric. Missing values are always "not available", never 0.
export function formatValue(key: string, v: MetricValue | undefined): string {
  if (v === null || v === undefined) return NOT_AVAILABLE;
  if (typeof v === "string") return key === "lastRunAt" ? formatTime(v) : v;
  if (!Number.isFinite(v)) return NOT_AVAILABLE;
  if (v === 0) return "0";
  if (PERCENT_KEYS.has(key)) return `${formatNumber(v)} %`;
  if (RATE_KEYS.has(key)) return `${formatNumber(v)} /min`;
  if (BYTE_KEYS.has(key)) return formatBytes(v);
  return formatNumber(v);
}
