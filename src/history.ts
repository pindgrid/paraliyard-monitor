// The history drawer: ranges, what each opener shows, and time bucketing of
// the points GET /api/history returns.
import type { Unit } from "./charts";
import { HOUR, MIN, isNum } from "./format";
import allowlist from "./history-allowlist.json";
import { shortBucket, type JobInfo, type Model, type Point } from "./model";

export type Range = "1h" | "6h" | "24h" | "7d" | "30d" | "6w";
export const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d", "6w"];
export const RUN_RANGES: Range[] = ["7d", "30d", "6w"];
// From src/history-allowlist.json, which a backend test keeps equal to
// functions/src/history.js: each range's length and the step of the points
// the API returns for it.
const rangeInfo = (key: Range) => {
  const r = allowlist.ranges.find((x) => x.key === key);
  if (!r) throw new Error(`history-allowlist.json has no range ${key}`);
  return r;
};
export const RANGE_MS = Object.fromEntries(RANGES.map((k) => [k, rangeInfo(k).seconds * 1000])) as Record<Range, number>;
export const SOURCE_STEP = Object.fromEntries(RANGES.map((k) => [k, rangeInfo(k).alignmentSeconds * 1000])) as Record<Range, number>;
// Width of one drawn bucket: 60-120 per chart.
export const BUCKET: Record<Range, number> = { "1h": MIN, "6h": 5 * MIN, "24h": 15 * MIN, "7d": 2 * HOUR, "30d": 6 * HOUR, "6w": 12 * HOUR };
export const STEP_WORD: Record<Range, string> = { "1h": "1 min", "6h": "5 min", "24h": "15 min", "7d": "2 h", "30d": "6 h", "6w": "12 h" };
export const SRC_WORD: Record<Range, string> = { "1h": "minute", "6h": "minute", "24h": "5 min", "7d": "hour", "30d": "3 h", "6w": "4 h" };
export const isRange = (v: unknown): v is Range => typeof v === "string" && (RANGES as string[]).includes(v);

export interface PanelSeriesSpec {
  id: string;
  metric: string;
  label: string;
  color: string;
  // Drawn as max(0, value - series[minus]) at the same time (successful = requests - errors).
  minus?: number;
  // Multiplies every value (1st gen memory bytes to % of 512 MB).
  scale?: number;
  area?: boolean;
}
export interface PanelSpec {
  title: string;
  type: "bar" | "line" | "step";
  unit: Unit;
  height: number;
  stacked?: boolean;
  empty?: string;
  series: PanelSeriesSpec[];
}
export interface DrawerGroup {
  title: string;
  sub: string;
  panels: PanelSpec[];
  // Scheduler jobs show their runs instead of panels.
  runs?: JobInfo;
  defaultRange: Range;
}

const C = (v: string) => `var(${v})`;
export const SITE_COLORS = [C("--c-site"), C("--c-site-2"), C("--c-storage"), C("--c-writes")];
export const BUCKET_COLORS = [C("--c-reads"), C("--c-storage"), C("--c-writes"), C("--c-site-2")];
const GEN1_MEMORY = 512 * 1048576;

// What a click on `open` shows: "fs", "fn:<id>", "st:<id>", "site:<id>",
// "job:<id>", "sum:functions", "sum:storage" or "sum:hosting".
export function groupFor(open: string, m: Model): DrawerGroup | null {
  const i = open.indexOf(":");
  const kind = i < 0 ? open : open.slice(0, i);
  const id = i < 0 ? "" : open.slice(i + 1);
  if (open === "fs") {
    return {
      title: `Firestore · ${m.firestore.name}`,
      sub: "Document reads, writes and deletes per minute",
      defaultRange: "24h",
      panels: [
        { title: "Reads per minute", type: "bar", unit: "count", height: 210, series: [{ id: m.firestore.id, metric: "readsPerMin", label: "Reads", color: C("--c-reads") }] },
        {
          title: "Writes and deletes per minute",
          type: "bar",
          unit: "count",
          height: 150,
          stacked: true,
          series: [
            { id: m.firestore.id, metric: "writesPerMin", label: "Writes", color: C("--c-writes") },
            { id: m.firestore.id, metric: "deletesPerMin", label: "Deletes", color: C("--c-deletes") },
          ],
        },
      ],
    };
  }
  if (kind === "fn") {
    const f = m.functions.find((x) => x.id === id);
    if (!f) return null;
    if (f.gen === 1) {
      return {
        title: f.name,
        sub: "1st gen Cloud Function · executions and memory",
        defaultRange: "24h",
        panels: [
          { title: "Executions per minute", type: "bar", unit: "count", height: 190, series: [{ id: f.id, metric: "execPerMin", label: "Executions", color: C("--c-req") }] },
          { title: "Memory, % of 512 MB", type: "line", unit: "pct", height: 150, empty: "Idle in this period", series: [{ id: f.id, metric: "memBytes", label: "Memory", color: C("--c-ram"), scale: 100 / GEN1_MEMORY }] },
        ],
      };
    }
    return {
      title: f.name,
      sub: "2nd gen Cloud Function · requests, errors, CPU and RAM (p99) and instances",
      defaultRange: "24h",
      panels: [
        {
          title: "Requests per minute (errors in red)",
          type: "bar",
          unit: "count",
          height: 190,
          stacked: true,
          series: [
            { id: f.id, metric: "reqPerMin", label: "Successful", color: C("--c-req"), minus: 1 },
            { id: f.id, metric: "errPerMin", label: "Errors", color: C("--c-err") },
          ],
        },
        {
          title: "CPU and RAM, p99",
          type: "line",
          unit: "pct",
          height: 150,
          empty: "Idle in this period",
          series: [
            { id: f.id, metric: "cpuPct", label: "CPU", color: C("--c-cpu") },
            { id: f.id, metric: "memPct", label: "RAM", color: C("--c-ram") },
          ],
        },
        { title: "Instances", type: "step", unit: "count", height: 120, empty: "No instances in this period", series: [{ id: f.id, metric: "instances", label: "Instances", color: C("--c-inst") }] },
      ],
    };
  }
  if (open === "sum:functions") {
    return {
      title: "All functions",
      sub: "Requests and errors per minute, summed over every 2nd gen function",
      defaultRange: "24h",
      panels: [
        {
          title: "Requests per minute (errors in red)",
          type: "bar",
          unit: "count",
          height: 210,
          stacked: true,
          series: [
            { id: "total:function2", metric: "reqPerMin", label: "Successful", color: C("--c-req"), minus: 1 },
            { id: "total:function2", metric: "errPerMin", label: "Errors", color: C("--c-err") },
          ],
        },
        { title: "Instances", type: "step", unit: "count", height: 120, empty: "No instances in this period", series: [{ id: "total:function2", metric: "instances", label: "Instances", color: C("--c-inst") }] },
      ],
    };
  }
  if (kind === "st") {
    const b = m.buckets.find((x) => x.id === id);
    if (!b) return null;
    return {
      title: shortBucket(b.name),
      sub: `Storage bucket ${b.name}`,
      defaultRange: "30d",
      panels: [
        { title: "Storage used", type: "step", unit: "bytes", height: 180, series: [{ id: b.id, metric: "bytesStored", label: "Stored", color: C("--c-storage"), area: true }] },
        { title: "Requests per minute", type: "bar", unit: "count", height: 130, series: [{ id: b.id, metric: "reqPerMin", label: "Requests", color: C("--c-reads") }] },
      ],
    };
  }
  if (open === "sum:storage") {
    return {
      title: "Storage, all buckets",
      sub: "Total bytes stored",
      defaultRange: "30d",
      panels: [{ title: "Storage used", type: "step", unit: "bytes", height: 220, series: [{ id: "total:bucket", metric: "bytesStored", label: "All buckets", color: C("--c-storage"), area: true }] }],
    };
  }
  if (kind === "site") {
    const s = m.sites.find((x) => x.id === id);
    if (!s) return null;
    return {
      title: `${s.name}.web.app`,
      sub: "Firebase Hosting · data served per minute",
      defaultRange: "24h",
      panels: [{ title: "Data served per minute", type: "bar", unit: "bytes", height: 210, series: [{ id: s.id, metric: "bytesServed", label: "Served", color: C("--c-site-2") }] }],
    };
  }
  if (open === "sum:hosting") {
    return {
      title: "Firebase Hosting",
      sub: "Data served per minute, all sites",
      defaultRange: "24h",
      panels: [
        {
          title: "Data served per minute",
          type: "bar",
          unit: "bytes",
          height: 220,
          stacked: true,
          series: m.sites.map((s, k) => ({ id: s.id, metric: "bytesServed", label: s.name, color: SITE_COLORS[k % SITE_COLORS.length] })),
        },
      ],
    };
  }
  if (kind === "job") {
    const j = m.jobs.find((x) => x.id === id);
    if (!j) return null;
    return { title: j.name, sub: `Cloud Scheduler job · ${j.schedule} IST`, defaultRange: "30d", panels: [], runs: j };
  }
  return null;
}

export interface Bucket {
  start: number;
  end: number;
  // bar: average per source slot; step: last value carried forward; max: highest value.
  y: number | null;
  // bar: highest source point (0 when the bucket had none).
  pk: number | null;
}
export type BucketMode = "bar" | "step" | "max";

// Buckets of bucketMs ending at `to`. Counts are sparse (a missing slot means
// 0), so bars average over every slot; nothing is drawn before the first point.
export function bucketize(points: readonly Point[], from: number, to: number, bucketMs: number, srcMs: number, mode: BucketMode): Bucket[] {
  const n = Math.ceil((to - from) / bucketMs);
  const start = to - n * bucketMs;
  const slots = Math.max(1, bucketMs / srcMs);
  const acc = Array.from({ length: n }, () => ({ sum: 0, peak: null as number | null, last: null as number | null }));
  let firstT: number | null = null;
  for (const p of points) {
    if (!isNum(p.v)) continue;
    if (firstT === null || p.t < firstT) firstT = p.t;
    const i = Math.floor((p.t - start) / bucketMs);
    if (i < 0 || i >= n) continue;
    const a = acc[i];
    a.sum += p.v;
    a.peak = a.peak === null ? p.v : Math.max(a.peak, p.v);
    a.last = p.v;
  }
  let carry: number | null = null;
  return acc.map((a, i) => {
    const b = { start: start + i * bucketMs, end: start + (i + 1) * bucketMs };
    const started = firstT !== null && b.end > firstT;
    if (mode === "bar") return { ...b, y: started ? a.sum / slots : null, pk: started ? (a.peak ?? 0) : null };
    if (mode === "step") {
      if (a.last !== null) carry = a.last;
      return { ...b, y: carry, pk: null };
    }
    return { ...b, y: a.peak, pk: null };
  });
}
