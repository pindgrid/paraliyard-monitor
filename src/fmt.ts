// Display formatting for the dashboard and drawer. Missing values are "—".
// Times are always shown in India Standard Time, 12-hour, without a suffix
// (the page says "Times in IST" once).

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
const DAY_MS = 86400000;

// One 12-hour formatter; the strings below are built from its parts so they
// read the same on every ICU version (lowercase am/pm, plain spaces).
const partsFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const dayFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });

interface IstParts {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  second: string;
  period: string;
}

function istParts(ms: number): IstParts {
  const p: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    day: p.day ?? "",
    month: p.month ?? "",
    year: p.year ?? "",
    hour: String(Number(p.hour)),
    minute: p.minute ?? "",
    second: p.second ?? "",
    period: (p.dayPeriod ?? "").toLowerCase(),
  };
}

// "11:07:01 pm", or "—" for an invalid time.
export function istTime(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const p = istParts(ms);
  return `${p.hour}:${p.minute}:${p.second} ${p.period}`;
}

// "10:36 pm", or "—" for an invalid time.
export function istShortTime(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const p = istParts(ms);
  return `${p.hour}:${p.minute} ${p.period}`;
}

// "5 Oct 2026, 2:35:47 am", or "—" for an invalid time.
export function istDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const p = istParts(ms);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second} ${p.period}`;
}

// "6 Oct, 2:30 am", or "—" for an invalid time.
export function istDayTime(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const p = istParts(ms);
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.period}`;
}

// Axis label for a chart covering rangeMs: "10:36 pm" up to a day,
// "5 Oct, 2 pm" up to a week, "5 Oct" beyond.
export function istTick(ms: number, rangeMs: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const p = istParts(ms);
  if (rangeMs <= DAY_MS) return `${p.hour}:${p.minute} ${p.period}`;
  if (rangeMs <= 7 * DAY_MS) return `${p.day} ${p.month}, ${p.hour} ${p.period}`;
  return `${p.day} ${p.month}`;
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
