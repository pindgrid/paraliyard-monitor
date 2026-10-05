// Display formatting for the dashboard and drawer. Missing values are "—".
// Times are always shown in India Standard Time.

export const DASH = "—";

export type Formatter = (v: number | null | undefined) => string;

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export const fmt = {
  rate: ((v) => (isNum(v) ? v.toFixed(2) : DASH)) as Formatter,
  int: ((v) => (isNum(v) ? (Math.round(v * 10) / 10).toLocaleString("en-IN") : DASH)) as Formatter,
  pct: ((v) => (isNum(v) ? `${Math.round(v)}%` : DASH)) as Formatter,
  seconds: ((v) => (isNum(v) ? `${Math.round(v)}s` : DASH)) as Formatter,
  bytes: ((v) => {
    if (!isNum(v)) return DASH;
    if (v === 0) return "0";
    if (v < 1e3) return `${Math.round(v)} B`;
    if (v < 1e6) return `${(v / 1e3).toFixed(1)} kB`;
    if (v < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
    return `${(v / 1e9).toFixed(2)} GB`;
  }) as Formatter,
};

const IST = "Asia/Kolkata";

const timeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dayFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });

// "14:05:07 IST", or "—" for an invalid time.
export function istTime(ms: number): string {
  return Number.isFinite(ms) ? `${timeFormatter.format(new Date(ms))} IST` : DASH;
}

// "5 Oct, 02:30 IST", or "—" for an invalid time.
export function istDateTime(ms: number): string {
  return Number.isFinite(ms) ? `${dateTimeFormatter.format(new Date(ms))} IST` : DASH;
}

// "5 Oct" in IST.
export function istDay(ms: number): string {
  return Number.isFinite(ms) ? dayFormatter.format(new Date(ms)) : DASH;
}

// "9h 40m", "2d 3h", "12m" or "now".
export function untilText(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

// Bucket name without the project prefix.
export function shortBucket(name: string, projectId: string): string {
  return name.startsWith(`${projectId}-`) ? name.slice(projectId.length + 1) : name;
}
