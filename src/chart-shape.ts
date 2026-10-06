// Pure shaping for every chart: time buckets over points that are already
// loaded, round y axes, tick labels and the texts around the charts. No I/O;
// bucketing never changes what is fetched.
import { BYTE_AXIS_MIN, istDay, istShortTime } from "./fmt";
import { alignmentSeconds } from "./routes";
import { DAY_MS, IST_OFFSET_MS } from "./schedule";
import type { HistoryRange } from "./types";

export interface XYPoint {
  x: number;
  y: number | null;
}

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;

// The page's hero and Hosting overview: 30 one-minute buckets.
export const LIVE_BUCKET_MS = MINUTE_MS;
export const LIVE_BUCKETS = 30;

// pyCleanupOnAuthDelete is deployed with 512 MB (copied from
// functions/src/constants.js; a test checks the two still match).
export const GEN1_MEMORY_BYTES = 512 * 1024 * 1024;

const BUCKET_MS: Record<HistoryRange, number> = {
  "1h": MINUTE_MS,
  "6h": 5 * MINUTE_MS,
  "24h": 15 * MINUTE_MS,
  "7d": 2 * HOUR_MS,
  "30d": 6 * HOUR_MS,
  "6w": 12 * HOUR_MS,
};

// Width of one drawn bucket for a drawer range.
export function bucketFor(range: HistoryRange): number {
  return BUCKET_MS[range];
}

// Step of the loaded points (the range's alignment in src/history-allowlist.json
// and functions/src/history.js).
export function sourceStepFor(range: HistoryRange): number {
  return alignmentSeconds(range) * 1000;
}

export type BucketMode = "bar" | "level" | "pct";

export interface Bucket {
  // Bucket start (x of the bucket); start and end are kept for tooltips.
  x: number;
  start: number;
  end: number;
  // bar: average per source slot; level: last value; pct: highest value.
  y: number | null;
  // bar: highest point in the bucket (0 without points); null otherwise.
  peak: number | null;
}

export interface BucketOptions {
  from: number;
  to: number;
  bucketMs: number;
  sourceStepMs: number;
  mode: BucketMode;
}

// Buckets line up with IST clock boundaries (e.g. 00:00, 06:00, 12:00 IST).
function alignDown(ms: number, size: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / size) * size - IST_OFFSET_MS;
}

// Starts of the buckets covering [from, to).
export function bucketStarts(from: number, to: number, bucketMs: number): number[] {
  const starts: number[] = [];
  for (let s = alignDown(from, bucketMs); s < to; s += bucketMs) starts.push(s);
  return starts;
}

// Groups points into buckets. A point at t covers the source slot
// (t - step, t]. Bars divide the sum by the source slots the bucket covers
// inside [from, to], so missing count points count as 0 and a partial first
// or last bucket divides by the slots it really has; levels and percentages
// without points are null, and so is every bucket of a series with no points.
export function bucketize(points: readonly XYPoint[], { from, to, bucketMs, sourceStepMs, mode }: BucketOptions): Bucket[] {
  const starts = bucketStarts(from, to, bucketMs);
  if (starts.length === 0) return [];
  const first = starts[0];
  const last = starts.length - 1;
  const indexOf = (ms: number) => Math.min(last, Math.max(0, Math.floor((ms - first) / bucketMs)));
  const step = sourceStepMs;
  const firstSlot = Math.floor(from / step) * step;

  // Source slots in the range, by bucket.
  const slotCounts = new Array<number>(starts.length).fill(0);
  for (let s = firstSlot; s + step <= to; s += step) slotCounts[indexOf(Math.max(s, from))] += 1;

  // One value per slot (a later point for the same slot wins).
  const slots = new Map<number, number>();
  for (const p of points) {
    if (typeof p.y !== "number" || !Number.isFinite(p.y) || !Number.isFinite(p.x) || p.x <= from || p.x > to) continue;
    slots.set(Math.max(firstSlot, Math.floor((p.x - step) / step) * step), p.y);
  }
  const values: number[][] = starts.map(() => []);
  for (const slot of [...slots.keys()].sort((a, b) => a - b)) values[indexOf(Math.max(slot, from))].push(slots.get(slot)!);
  // A series without any point (not loaded) is unknown, not zero.
  const known = slots.size > 0;

  return starts.map((start, i) => {
    const vs = values[i];
    const bucket = { x: start, start, end: start + bucketMs };
    if (mode === "level") return { ...bucket, y: vs.length ? vs[vs.length - 1] : null, peak: null };
    if (mode === "pct") return { ...bucket, y: vs.length ? Math.max(...vs) : null, peak: null };
    const count = Math.max(slotCounts[i], vs.length);
    if (count === 0 || !known) return { ...bucket, y: null, peak: null };
    return { ...bucket, y: vs.reduce((a, v) => a + v, 0) / count, peak: vs.length ? Math.max(...vs) : 0 };
  });
}

export type AxisUnit = "count" | "bytes" | "pct";

export interface NiceAxis {
  min: number;
  max: number;
  step: number;
}

const clean = (v: number) => Number(v.toPrecision(12));

// A 0-based y axis with round 1-2-5 x 10^n steps and at most maxCount ticks.
// The axis max is always the first round tick at or above the data
// (0-12 → 0,5,10,15; 0-292 → ...,300; 43.4 MB → 0..50 MB by 10 MB).
// Counts and bytes never get fractional steps; all-zero data still spans 0..1
// (0..1 kB for bytes); percentages are always 0..100.
export function niceAxis(dataMax: number, unit: AxisUnit, maxCount = 6): NiceAxis {
  if (unit === "pct") return { min: 0, max: 100, step: 25 };
  const floor = unit === "bytes" ? BYTE_AXIS_MIN : 1;
  const top = Math.max(Number.isFinite(dataMax) ? dataMax : 0, floor);
  const intervals = Math.max(1, maxCount - 1);
  let magnitude = 10 ** Math.floor(Math.log10(top / intervals));
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = clean(m * magnitude);
      if (step < 1) continue;
      const count = Math.ceil(clean(top / step));
      if (count > intervals) continue;
      return { min: 0, max: clean(count * step), step };
    }
    magnitude *= 10;
  }
}

// Every chart's y axis is this wide (px), so stacked panels line up. Labels
// stay within 9 characters ("10,00,000"): 9 x 6.6 px + 6 px padding fits.
export const Y_AXIS_WIDTH = 68;

// Chart.js afterFit hook of a y scale: the shared width.
export function fitYAxis(scale: { width: number }): void {
  scale.width = Y_AXIS_WIDTH;
}

// Round time-tick spacing for a window: 5-7 ticks per window.
export function timeTickStep(rangeMs: number): number {
  if (rangeMs <= 30 * MINUTE_MS) return 5 * MINUTE_MS;
  if (rangeMs <= HOUR_MS) return 10 * MINUTE_MS;
  if (rangeMs <= 6 * HOUR_MS) return HOUR_MS;
  if (rangeMs <= DAY_MS) return 4 * HOUR_MS;
  if (rangeMs <= 7 * DAY_MS) return DAY_MS;
  if (rangeMs <= 30 * DAY_MS) return 5 * DAY_MS;
  return 7 * DAY_MS;
}

// Ticks on IST step boundaries over [from, to).
export function timeTicks(from: number, to: number, stepMs: number): number[] {
  const ticks: number[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(stepMs > 0)) return ticks;
  for (let t = Math.ceil((from + IST_OFFSET_MS) / stepMs) * stepMs - IST_OFFSET_MS; t < to; t += stepMs) ticks.push(t);
  return ticks;
}

// The ticks of a nice axis.
export function axisTicks(axis: NiceAxis): number[] {
  const ticks: number[] = [];
  for (let v = axis.min; v <= axis.max + axis.step / 1e6; v += axis.step) ticks.push(clean(v));
  return ticks;
}

const trim = (v: number, digits: number) => Number(v.toFixed(digits));

// "500", "1,250", "0.5": never needless decimals.
export function countTick(value: number | string): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";
  return trim(v, 2).toLocaleString("en-IN");
}

// Decimal byte units without a trailing ".0": "0", "250 B", "1.5 kB", "12 MB".
export function bytesTick(value: number | string): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  if (Math.abs(v) < 1e3) return `${trim(v, 0)} B`;
  if (Math.abs(v) < 1e6) return `${trim(v / 1e3, 2)} kB`;
  if (Math.abs(v) < 1e9) return `${trim(v / 1e6, 2)} MB`;
  return `${trim(v / 1e9, 2)} GB`;
}

// "40 %".
export function pctTick(value: number | string): string {
  const v = Number(value);
  return Number.isFinite(v) ? `${Math.round(v)} %` : "";
}

export function tickFor(unit: AxisUnit): (value: number | string) => string {
  return unit === "bytes" ? bytesTick : unit === "pct" ? pctTick : countTick;
}

// "10:15-10:30 am" or "11:45 am-12:00 pm" in IST; ranges over a day start
// with the day ("5 Oct, 10:00 pm-12:00 am").
export function bucketSpan(start: number, end: number, rangeMs: number): string {
  const [a, ap] = istShortTime(start).split(" ");
  const [b, bp] = istShortTime(end).split(" ");
  const span = ap === bp ? `${a}-${b} ${bp}` : `${a} ${ap}-${b} ${bp}`;
  return rangeMs > DAY_MS ? `${istDay(start)}, ${span}` : span;
}

// Earliest point with a value across the series, or null.
export function firstDataAt(series: readonly (readonly XYPoint[])[]): number | null {
  let first: number | null = null;
  for (const points of series) {
    for (const p of points) {
      if (typeof p.y === "number" && Number.isFinite(p.x) && (first === null || p.x < first)) first = p.x;
    }
  }
  return first;
}

export interface NoDataBand {
  from: number;
  to: number;
  label: string;
}

// A "No data before <day>" band from the range start to the first point, when
// the first point is more than one bucket after the start.
export function noDataBand(from: number, first: number | null, bucketMs: number): NoDataBand | null {
  if (first === null || first - from <= bucketMs) return null;
  return { from, to: first, label: `No data before ${istDay(first)}` };
}

// True when the values have at least one number and every number is 0.
export function allZero(values: readonly (number | null)[]): boolean {
  const numbers = values.filter((v): v is number => typeof v === "number");
  return numbers.length > 0 && numbers.every((v) => v === 0);
}

// "minute", "5 min", "hour", "2 h".
function spanText(ms: number): string {
  if (ms === MINUTE_MS) return "minute";
  if (ms === HOUR_MS) return "hour";
  return ms < HOUR_MS ? `${ms / MINUTE_MS} min` : `${ms / HOUR_MS} h`;
}

// The explanation under the drawer chart for a range and its panel kinds.
export function bucketNote(range: HistoryRange, kinds: readonly BucketMode[]): string {
  const bucket = bucketFor(range);
  const step = sourceStepFor(range);
  const per = spanText(bucket);
  const parts: string[] = [];
  if (kinds.includes("bar")) {
    parts.push(bucket > step ? `Solid bar: average per ${per}. Light bar: busiest ${spanText(step)}.` : `Each bar is one ${per}.`);
  }
  const level = kinds.includes("level");
  const pct = kinds.includes("pct");
  if (level && pct) parts.push(`Step lines show the last value and percent lines the highest value in each ${per}.`);
  else if (level) parts.push(`Lines show the last value in each ${per}.`);
  else if (pct) parts.push(`Lines show the highest value in each ${per}.`);
  return parts.join(" ");
}
