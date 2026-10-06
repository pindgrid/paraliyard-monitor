// Deterministic sample data shaped like the real yard (mock mode). The same
// generator feeds the live overview and every history range.
import { DAY, HOUR, MIN, istHour } from "./format";
import { RANGE_MS, SOURCE_STEP, type Range } from "./history";
import { JOBS, occurrence, type Model, type OtherCalls, type Point } from "./model";

export const DEMO_START = Date.UTC(2026, 8, 16, 6, 0);
const FIRST_NIGHTLY = Date.UTC(2026, 8, 17, 21, 0);

interface DemoFn {
  id: string;
  gen: 1 | 2;
  job?: string;
  lvl?: number;
}
const FUNCS: DemoFn[] = [
  { id: "function2:pyNightlyExport", gen: 2, job: "scheduler:pyNightlyExport" },
  { id: "function2:pyReadStockistDocs", gen: 2, lvl: 0.3 },
  { id: "function2:pyYardStaffOnWrite", gen: 2, lvl: 0.18 },
  { id: "function2:pyMintOnCrewClaim", gen: 2, lvl: 0.1 },
  { id: "function2:pyDeleteAccountOnRequest", gen: 2, lvl: 0.02 },
  { id: "function2:pyStaffLoginOnRequest", gen: 2, lvl: 0.12 },
  { id: "function2:pyWeeklyAccounts", gen: 2, job: "scheduler:pyWeeklyAccounts" },
  { id: "function2:pyPushOnNotification", gen: 2, lvl: 0.15 },
  { id: "function2:pyMintOnRoleRequest", gen: 2, lvl: 0.05 },
  { id: "function1:pyCleanupOnAuthDelete", gen: 1, lvl: 0.004 },
];
const BUCKETS = ["mineral-proton-438104-g8-paraliyard", "mineral-proton-438104-g8-yard-backups"];
const SITES = ["paraliyard", "preparaliyard"];

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rnd(seed: number, n: number): number {
  let x = (seed ^ Math.imul(n | 0, 2654435761)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
// Busy in the IST day, nearly quiet at night.
const dayFactor = (t: number) => {
  const h = istHour(t);
  return h < 7 || h > 22.5 ? 0.06 : 0.25 + 0.75 * Math.sin((Math.PI * (h - 7)) / 15.5);
};
const nightlyRuns = (t: number) => (t < FIRST_NIGHTLY ? 0 : Math.floor((t - FIRST_NIGHTLY) / DAY) + 1);
const jobMinute = (jobId: string, t: number) => {
  const occ = occurrence(JOBS[jobId], t, -1);
  return occ !== null && t - occ < MIN;
};

// One value per minute for (service, metric); null before data exists.
export function demoValue(id: string, metric: string, t: number): number | null {
  if (t < DEMO_START) return null;
  const n = Math.floor(t / MIN);
  const seed = hash(id + metric);
  const R = (k: number) => rnd(seed + k * 7919, n);
  const df = dayFactor(t);
  if (id === "firestore:yard") {
    if (metric === "readsPerMin") return Math.round(6 + 70 * df * (0.75 + 0.5 * R(1)) + (R(2) < 0.025 * (0.3 + df) ? 150 + R(3) * 650 : 0));
    if (metric === "writesPerMin") return Math.round(10 * (0.1 + 2.2 * df * R(4) + (R(5) < 0.03 ? 4 + R(6) * 11 : 0))) / 10;
    if (metric === "deletesPerMin") return R(7) < 0.004 ? 1 : 0;
    return null;
  }
  const fn = FUNCS.find((f) => f.id === id);
  if (fn) {
    const active = fn.job ? jobMinute(fn.job, t) : R(1) < (fn.lvl ?? 0) * df;
    const req = active ? (fn.job ? 1 : 1 + Math.floor(R(2) * 4)) : 0;
    if (metric === "reqPerMin" || metric === "execPerMin") return req;
    if (metric === "errPerMin") return active && R(3) < 0.012 ? 1 : 0;
    if (metric === "cpuPct") return active ? Math.round(3 + R(4) * 28) : null;
    if (metric === "memPct") return active ? Math.round(22 + R(5) * 24) : null;
    if (metric === "memBytes") return active ? (120 + R(5) * 90) * 1048576 : null;
    if (metric === "instances") {
      for (let k = 0; k < 15; k += 1) if ((demoValue(id, "reqPerMin", t - k * MIN) ?? 0) > 0) return req > 3 ? 2 : 1;
      return 0;
    }
    return null;
  }
  if (id.startsWith("bucket:")) {
    const backups = id.endsWith("yard-backups");
    if (metric === "bytesStored") return backups ? nightlyRuns(t) * 2.47e6 : 57.35e6 + ((t - DEMO_START) / DAY) * 0.27e6;
    if (metric === "reqPerMin") return backups ? (jobMinute("scheduler:pyNightlyExport", t) ? 12 : 0) : R(1) < 0.05 * df ? 1 + Math.floor(R(2) * 3) : 0;
    return null;
  }
  if (id.startsWith("hosting:") && metric === "bytesServed") {
    if (id === "hosting:paraliyard") return R(1) < 0.4 * df ? 30e3 + R(2) * 2.2e6 : 0;
    return R(1) < 0.01 ? R(2) * 400e3 : 0;
  }
  if (id === "total:function2") return FUNCS.filter((f) => f.gen === 2).reduce((s, f) => s + (demoValue(f.id, metric, t) ?? 0), 0);
  if (id === "total:bucket") return BUCKETS.reduce((s, b) => s + (demoValue(`bucket:${b}`, metric, t) ?? 0), 0);
  if (id === "total:hosting") return SITES.reduce((s, h) => s + (demoValue(`hosting:${h}`, metric, t) ?? 0), 0);
  return null;
}

export const minutesEnding = (t: number) => {
  const end = Math.floor(t / MIN) * MIN;
  return Array.from({ length: 30 }, (_, i) => end - (29 - i) * MIN);
};

export function demoModel(now: number): Model {
  const minutes = minutesEnding(now);
  const series = (id: string, m: string) => minutes.map((t) => demoValue(id, m, t));
  const latest = (id: string, m: string) => demoValue(id, m, minutes[29]);
  return {
    generatedAt: now,
    minutes,
    firestore: {
      id: "firestore:yard",
      name: "yard",
      reads: series("firestore:yard", "readsPerMin"),
      writes: series("firestore:yard", "writesPerMin"),
      deletes: series("firestore:yard", "deletesPerMin"),
    },
    functions: FUNCS.map((f) => {
      const name = f.id.split(":")[1];
      if (f.gen === 1) {
        const mem = latest(f.id, "memBytes");
        return { id: f.id, name, gen: 1, req: series(f.id, "execPerMin"), err: null, cpu: "na", ram: mem ? (mem / (512 * 1048576)) * 100 : "idle", instances: null };
      }
      const req = series(f.id, "reqPerMin");
      const active = (req[29] ?? 0) > 0;
      return {
        id: f.id,
        name,
        gen: 2,
        req,
        err: series(f.id, "errPerMin"),
        cpu: active ? latest(f.id, "cpuPct") : "idle",
        ram: active ? latest(f.id, "memPct") : "idle",
        instances: latest(f.id, "instances"),
      };
    }),
    buckets: BUCKETS.map((b) => ({ id: `bucket:${b}`, name: b, bytes: latest(`bucket:${b}`, "bytesStored"), req: series(`bucket:${b}`, "reqPerMin") })),
    sites: SITES.map((s) => ({ id: `hosting:${s}`, name: s, served: series(`hosting:${s}`, "bytesServed") })),
    jobs: Object.keys(JOBS).map((id) => {
      const job = JOBS[id];
      const lastRun = occurrence(job, now, -1);
      return { id, name: job.name, schedule: job.text, lastRunAt: lastRun, lastResult: lastRun ? "success" : null, nextRun: occurrence(job, now, 1) };
    }),
  };
}

// The history GET /api/history would return: sparse counts (zero slots
// left out), levels at every step, the highest utilisation per step.
export function demoHistory(id: string, metric: string, range: Range, now: number): { points: Point[]; otherCalls?: OtherCalls } {
  const from = now - RANGE_MS[range];
  if (metric === "runs") return demoRuns(id, from, now);
  const step = SOURCE_STEP[range];
  const level = metric === "bytesStored" || metric === "instances";
  const pctLike = metric === "cpuPct" || metric === "memPct" || metric === "memBytes";
  const points: Point[] = [];
  for (let t = Math.ceil(from / step) * step; t <= now; t += step) {
    if (level) {
      const v = demoValue(id, metric, t);
      if (v !== null) points.push({ t, v });
      continue;
    }
    const k = Math.max(1, Math.min(6, Math.round(step / MIN)));
    let acc = 0;
    let mx: number | null = null;
    let seen = false;
    for (let j = 0; j < k; j += 1) {
      const v = demoValue(id, metric, t - Math.floor((j * step) / k));
      if (v === null) continue;
      seen = true;
      acc += v;
      mx = mx === null ? v : Math.max(mx, v);
    }
    if (!seen) continue;
    if (pctLike) {
      if (mx !== null) points.push({ t, v: mx });
    } else if (acc > 0) points.push({ t, v: acc / k });
  }
  return { points };
}

function demoRuns(id: string, from: number, now: number): { points: Point[]; otherCalls: OtherCalls } {
  const job = JOBS[id];
  const points: Point[] = [];
  if (!job) return { points, otherCalls: { count: 0, failed: 0 } };
  for (let occ = occurrence(job, from, 1); occ !== null && occ <= now; occ = occurrence(job, occ, 1)) {
    if (occ < FIRST_NIGHTLY - HOUR) continue;
    points.push({ t: occ, v: 1, result: "success", requests: 1, failed: 0 });
  }
  return { points, otherCalls: { count: 0, failed: 0 } };
}
