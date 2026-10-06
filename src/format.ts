// Numbers and times for the whole page. Times are always India Standard Time,
// 12-hour, lowercase am/pm.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const IST_OFF = 5.5 * HOUR;
export const DASH = "—";

const IST = "Asia/Kolkata";
const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, ...o });
const F = {
  time: dtf({ hour: "numeric", minute: "2-digit", hour12: true }),
  timeSec: dtf({ hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }),
  day: dtf({ day: "numeric", month: "short" }),
  dayTime: dtf({ day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }),
  full: dtf({ day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }),
};
// ICU versions differ on "PM" / "pm" and on the space before it.
const ampm = (s: string) => s.replace(/\s?(AM|PM|am|pm)/, (m) => " " + m.trim().toLowerCase());

export const fTime = (t: number) => ampm(F.time.format(t));
export const fTimeSec = (t: number) => ampm(F.timeSec.format(t));
export const fDay = (t: number) => F.day.format(t);
export const fDayTime = (t: number) => ampm(F.dayTime.format(t));
export const fFull = (t: number) => ampm(F.full.format(t));

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// "0"; "<0.1"; one decimal below 10 ("2.4", "3"); whole numbers from 10 with
// en-IN grouping ("1,234").
export function num(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 0.1) return "<0.1";
  if (a < 10) {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  return Math.round(v).toLocaleString("en-IN");
}

export function bytes(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  if (v === 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  let x = v;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i += 1;
  }
  return `${i === 0 || x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export const pct = (v: number | null | undefined) => (isNum(v) ? `${Math.round(v)}%` : DASH);

// "now", "12m", "4h 12m", "4d 1h".
export function until(ms: number): string {
  if (!isNum(ms)) return DASH;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export type Series = (number | null)[];

export const sum = (a: readonly (number | null)[] | null | undefined) => (a ?? []).reduce<number>((s, v) => s + (isNum(v) ? v : 0), 0);

export function last<T>(a: readonly T[] | null | undefined): T | null {
  if (!a || a.length === 0) return null;
  return a[a.length - 1] ?? null;
}

export const istHour = (t: number) => ((((t + IST_OFF) % DAY) + DAY) % DAY) / HOUR;
export const istDayStart = (t: number) => Math.floor((t + IST_OFF) / DAY) * DAY - IST_OFF;
export const istWeekday = (t: number) => new Date(t + IST_OFF).getUTCDay();
