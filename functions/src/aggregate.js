"use strict";

const {
  WINDOWS,
  GEN1_MEMORY_BYTES,
  KINDS,
  RESOURCES,
  SERVICES,
  JOB_SCHEDULES,
  SCHEDULER_ALIGNMENT_SECONDS,
  SCHEDULER_LOOKBACK_SECONDS,
} = require("./constants");
const { normalizeWindow } = require("./queries");
const { nextRunAt } = require("./schedule");
const { classifyRuns, latestClosedRun } = require("./runs");

// Metric keys per kind, in display order, then the *At keys. Unknown values
// (failed or missing call) are always null; a successful call with no data
// is "idle" for gauges, 0 for counts and "none" for the scheduler lastResult.
const METRIC_KEYS = Object.freeze({
  function2: Object.freeze(["cpuPct", "memPct", "reqPerMin", "errPerMin", "instances", "cpuAt", "memAt"]),
  function1: Object.freeze(["cpuPct", "execPerMin", "memBytes", "memPct", "memAt"]),
  firestore: Object.freeze(["readsPerMin", "writesPerMin", "deletesPerMin"]),
  bucket: Object.freeze(["reqPerMin", "bytesStored"]),
  hosting: Object.freeze(["bytesServed"]),
  scheduler: Object.freeze(["lastRunAt", "lastResult"]),
});

// Per-metric trend keys per kind, in payload order. Built only from the
// existing 13 results: null when the call failed; counts are a flat 0 line and
// gauges are [] when the call succeeded without points.
const TREND_KEYS = Object.freeze({
  function2: Object.freeze(["reqPerMin", "errPerMin", "cpuPct", "memPct", "instances"]),
  function1: Object.freeze(["execPerMin", "memBytes"]),
  firestore: Object.freeze(["readsPerMin", "writesPerMin", "deletesPerMin"]),
  bucket: Object.freeze(["reqPerMin", "bytesStored"]),
  hosting: Object.freeze(["bytesServed"]),
  scheduler: Object.freeze(["runs"]),
});

// Per-minute series for the last RECENT_SLOTS minutes, per kind. Built only
// from the existing 13 results: null when the call failed, 0 for a minute
// without points when it succeeded.
const RECENT_KEYS = Object.freeze({
  function2: Object.freeze(["reqPerMin", "errPerMin"]),
  function1: Object.freeze(["execPerMin"]),
  firestore: Object.freeze(["readsPerMin", "writesPerMin", "deletesPerMin"]),
  bucket: Object.freeze(["reqPerMin"]),
  hosting: Object.freeze(["bytesServed"]),
  scheduler: Object.freeze([]),
});

const RECENT_SLOTS = 30;
const RECENT_STEP_MS = 60000;

// Fields added to scheduler services after `recent`.
const SCHEDULE_KEYS = Object.freeze(["schedule", "cron", "timeZone", "nextRun"]);

const MAX_KEYS = new Set(["cpuPct", "memPct"]);

// Time of the latest value for each MAX key.
const AT_KEYS = Object.freeze({ cpuAt: "cpuPct", memAt: "memPct" });

const IDLE = "idle";
// lastResult when the scheduler call succeeded but the lookback holds no closed occurrence.
const NO_RUN = "none";

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeMs(ts) {
  if (!ts) return null;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  const seconds = toNumber(ts.seconds);
  if (seconds === null) return null;
  return seconds * 1000 + Math.floor((toNumber(ts.nanos) || 0) / 1e6);
}

function pointValue(point) {
  const value = point && point.value;
  if (!value) return null;
  if (value.doubleValue !== undefined && value.doubleValue !== null) return toNumber(value.doubleValue);
  if (value.int64Value !== undefined && value.int64Value !== null) return toNumber(value.int64Value);
  return null;
}

function pointsOf(seriesList) {
  const out = [];
  for (const series of seriesList) {
    for (const point of series.points || []) {
      const t = timeMs(point.interval && point.interval.endTime);
      const v = pointValue(point);
      if (t !== null && v !== null) out.push({ t, v, labels: (series.metric && series.metric.labels) || {} });
    }
  }
  return out;
}

// Series for one service: null when the call failed or is missing, otherwise
// the matching series (empty when the call succeeded with nothing for it).
function seriesFor(results, key, service) {
  const result = results[key];
  if (!result || !result.ok || !Array.isArray(result.series)) return null;
  const label = RESOURCES[service.kind].label;
  return result.series.filter(
    (s) => s && s.resource && s.resource.labels && s.resource.labels[label] === service.resourceLabel,
  );
}

// Newest point anywhere in the list, or null when there is none.
function newestPoint(seriesList) {
  if (!seriesList) return null;
  let best = null;
  for (const p of pointsOf(seriesList)) if (best === null || p.t > best.t) best = p;
  return best === null ? null : { t: best.t, v: best.v };
}

// Latest gauge value and its time: null when the call failed, "idle" when it
// succeeded without points.
function gauge(seriesList, factor) {
  if (!seriesList) return { value: null, at: null };
  const point = newestPoint(seriesList);
  if (!point) return { value: IDLE, at: null };
  return { value: point.v * factor, at: new Date(point.t).toISOString() };
}

// Sum per minute: null when the call failed, 0 when it succeeded without points.
function countPerMinute(seriesList, windowSeconds) {
  if (!seriesList) return null;
  return (sumOf(seriesList) || 0) / (windowSeconds / 60);
}

// Latest count: null when the call failed, 0 when it succeeded without points.
function latestCount(seriesList) {
  if (!seriesList) return null;
  const value = latest(seriesList);
  return value === null ? 0 : value;
}

// Trend points, or a flat zero line when every input call succeeded without points.
function trendOrFlat(seriesLists, windowSeconds, nowMs) {
  const points = trendOf(seriesLists);
  if (points.length > 0 || seriesLists.some((list) => !list)) return points;
  return [
    { t: new Date(nowMs - windowSeconds * 1000).toISOString(), v: 0 },
    { t: new Date(nowMs).toISOString(), v: 0 },
  ];
}

function latest(seriesList) {
  if (!seriesList) return null;
  const points = pointsOf(seriesList);
  if (points.length === 0) return null;
  let best = points[0];
  for (const p of points) if (p.t > best.t) best = p;
  return best.v;
}

function sumOf(seriesList) {
  if (!seriesList) return null;
  const points = pointsOf(seriesList);
  if (points.length === 0) return null;
  return points.reduce((acc, p) => acc + p.v, 0);
}

// Sums aligned points that share a timestamp and sorts them by time.
function trendOf(seriesLists, sinceMs) {
  const byTime = new Map();
  for (const seriesList of seriesLists) {
    if (!seriesList) continue;
    for (const p of pointsOf(seriesList)) {
      if (sinceMs !== undefined && p.t < sinceMs) continue;
      byTime.set(p.t, (byTime.get(p.t) || 0) + p.v);
    }
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t: new Date(t).toISOString(), v }));
}

function withLabel(seriesList, label, values) {
  if (!seriesList) return null;
  return seriesList.filter((s) => values.includes(s.metric && s.metric.labels && s.metric.labels[label]));
}

// Count trend: null when the call failed, a flat zero line when it succeeded without points.
function countTrend(seriesList, windowSeconds, nowMs, sinceMs) {
  if (!seriesList) return null;
  const points = trendOf([seriesList], sinceMs);
  return points.length > 0 ? points : trendOrFlat([[]], windowSeconds, nowMs);
}

// Gauge trend: null when the call failed, [] when it succeeded without points.
function gaugeTrend(seriesList, factor) {
  if (!seriesList) return null;
  return trendOf([seriesList]).map((p) => ({ t: p.t, v: p.v * factor }));
}

function recentAnchor(nowMs) {
  return Math.floor(nowMs / RECENT_STEP_MS) * RECENT_STEP_MS;
}

// RECENT_SLOTS per-minute sums. Slot i covers the minute ending at
// anchor - (RECENT_SLOTS - 1 - i) minutes; a point goes to the slot whose
// minute holds its end time. null when the call failed.
function recentSeries(seriesList, nowMs) {
  if (!seriesList) return null;
  const anchor = recentAnchor(nowMs);
  const slots = new Array(RECENT_SLOTS).fill(0);
  for (const p of pointsOf(seriesList)) {
    if (p.t > anchor) continue;
    const i = RECENT_SLOTS - 1 - Math.floor((anchor - p.t) / RECENT_STEP_MS);
    if (i >= 0) slots[i] += p.v;
  }
  return slots;
}

function function2Metrics(results, service, windowSeconds, nowMs) {
  const requests = seriesFor(results, "run.requests", service);
  let errPerMin = null;
  let errors = null;
  if (requests) {
    errors = withLabel(requests, "response_code_class", ["4xx", "5xx"]);
    errPerMin = errors.length > 0 ? countPerMinute(errors, windowSeconds) : 0;
  }
  const cpuSeries = seriesFor(results, "run.cpu", service);
  const memSeries = seriesFor(results, "run.memory", service);
  const instances = seriesFor(results, "run.instances", service);
  const cpu = gauge(cpuSeries, 100);
  const mem = gauge(memSeries, 100);
  return {
    metrics: {
      cpuPct: cpu.value,
      memPct: mem.value,
      reqPerMin: countPerMinute(requests, windowSeconds),
      errPerMin,
      instances: latestCount(instances),
      cpuAt: cpu.at,
      memAt: mem.at,
    },
    points: trendOrFlat([requests], windowSeconds, nowMs),
    trends: {
      reqPerMin: countTrend(requests, windowSeconds, nowMs),
      errPerMin: countTrend(errors, windowSeconds, nowMs),
      cpuPct: gaugeTrend(cpuSeries, 100),
      memPct: gaugeTrend(memSeries, 100),
      instances: gaugeTrend(instances, 1),
    },
    recent: {
      reqPerMin: recentSeries(requests, nowMs),
      errPerMin: recentSeries(errors, nowMs),
    },
  };
}

function function1Metrics(results, service, windowSeconds, nowMs) {
  const executions = seriesFor(results, "gen1.executions", service);
  const memSeries = seriesFor(results, "gen1.memory", service);
  const mem = gauge(memSeries, 1);
  return {
    metrics: {
      // 1st gen functions do not report CPU utilisation.
      cpuPct: null,
      execPerMin: countPerMinute(executions, windowSeconds),
      memBytes: mem.value,
      memPct: typeof mem.value === "number" ? (mem.value * 100) / GEN1_MEMORY_BYTES : mem.value,
      memAt: mem.at,
    },
    points: trendOrFlat([executions], windowSeconds, nowMs),
    trends: {
      execPerMin: countTrend(executions, windowSeconds, nowMs),
      memBytes: gaugeTrend(memSeries, 1),
    },
    recent: { execPerMin: recentSeries(executions, nowMs) },
  };
}

function firestoreMetrics(results, service, windowSeconds, nowMs) {
  const reads = seriesFor(results, "firestore.reads", service);
  const writes = seriesFor(results, "firestore.writes", service);
  const deletes = seriesFor(results, "firestore.deletes", service);
  return {
    metrics: {
      readsPerMin: countPerMinute(reads, windowSeconds),
      writesPerMin: countPerMinute(writes, windowSeconds),
      deletesPerMin: countPerMinute(deletes, windowSeconds),
    },
    points: trendOrFlat([reads, writes], windowSeconds, nowMs),
    trends: {
      readsPerMin: countTrend(reads, windowSeconds, nowMs),
      writesPerMin: countTrend(writes, windowSeconds, nowMs),
      deletesPerMin: countTrend(deletes, windowSeconds, nowMs),
    },
    recent: {
      readsPerMin: recentSeries(reads, nowMs),
      writesPerMin: recentSeries(writes, nowMs),
      deletesPerMin: recentSeries(deletes, nowMs),
    },
  };
}

function bucketMetrics(results, service, windowSeconds, nowMs) {
  const requests = seriesFor(results, "bucket.requests", service);
  const bytes = seriesFor(results, "bucket.bytes", service);
  return {
    metrics: {
      reqPerMin: countPerMinute(requests, windowSeconds),
      bytesStored: latest(bytes),
    },
    points: trendOrFlat([requests], windowSeconds, nowMs),
    trends: {
      reqPerMin: countTrend(requests, windowSeconds, nowMs),
      bytesStored: gaugeTrend(bytes, 1),
    },
    recent: { reqPerMin: recentSeries(requests, nowMs) },
  };
}

function hostingMetrics(results, service, windowSeconds, nowMs) {
  const sent = seriesFor(results, "hosting.sentBytes", service);
  return {
    metrics: {
      // Bytes served: null when the call failed, 0 when it succeeded without points.
      bytesServed: sent ? sumOf(sent) || 0 : null,
    },
    points: trendOrFlat([sent], windowSeconds, nowMs),
    trends: { bytesServed: countTrend(sent, windowSeconds, nowMs) },
    recent: { bytesServed: recentSeries(sent, nowMs) },
  };
}

// Last run from the job function's request_count: the latest scheduled
// occurrence whose run window has closed (see runs.js), so off-schedule calls
// never count. lastRunAt is its scheduled time and lastResult its result
// (success, failed or missed). null when the call failed, "none" when the
// lookback holds no closed occurrence.
function schedulerMetrics(results, service, windowSeconds, nowMs) {
  const runs = seriesFor(results, "scheduler.runs", service);
  let lastRunAt = null;
  let lastResult = null;
  const job = JOB_SCHEDULES[service.id];
  if (runs && job) {
    const fromMs = nowMs - SCHEDULER_LOOKBACK_SECONDS * 1000;
    const classified = classifyRuns(runs, job.cron, fromMs, nowMs, SCHEDULER_ALIGNMENT_SECONDS);
    const last = latestClosedRun(classified.runs, nowMs);
    if (last === null) {
      lastResult = NO_RUN;
    } else {
      lastRunAt = new Date(last.at).toISOString();
      lastResult = last.result;
    }
  }
  return {
    metrics: { lastRunAt, lastResult },
    points: trendOf([runs], nowMs - windowSeconds * 1000),
    trends: { runs: countTrend(runs, windowSeconds, nowMs, nowMs - windowSeconds * 1000) },
    recent: {},
  };
}

const BUILDERS = {
  function2: function2Metrics,
  function1: function1Metrics,
  firestore: firestoreMetrics,
  bucket: bucketMetrics,
  hosting: hostingMetrics,
  scheduler: schedulerMetrics,
};

function totalFor(key, values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return null;
  if (key === "lastRunAt") return present.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  if (key === "lastResult") {
    // Worst first: failed, missed, success, none.
    if (present.includes("failed")) return "failed";
    if (present.includes("missed")) return "missed";
    return present.includes("success") ? "success" : NO_RUN;
  }
  const numbers = present.filter((v) => typeof v === "number");
  if (numbers.length === 0) return present.includes(IDLE) ? IDLE : null;
  if (MAX_KEYS.has(key)) return Math.max(...numbers);
  return numbers.reduce((a, b) => a + b, 0);
}

// Time of the first service holding the numeric max of maxKey, else null.
function atOfMax(services, atKey, maxKey) {
  const max = totalFor(maxKey, services.map((s) => s.metrics[maxKey]));
  if (typeof max !== "number") return null;
  const holder = services.find((s) => s.metrics[maxKey] === max);
  return (holder && holder.metrics[atKey]) || null;
}

function buildTotals(services) {
  const totals = {};
  for (const kind of KINDS) {
    const ofKind = services.filter((s) => s.kind === kind);
    totals[kind] = {};
    for (const key of METRIC_KEYS[kind]) {
      totals[kind][key] = AT_KEYS[key]
        ? atOfMax(ofKind, key, AT_KEYS[key])
        : totalFor(key, ofKind.map((s) => s.metrics[key]));
    }
  }
  return totals;
}

function buildPayload({ results, windowKey, nowMs }) {
  const windowName = normalizeWindow(windowKey);
  const windowSeconds = WINDOWS[windowName];
  const safeResults = results || {};
  const recentFrom = new Date(recentAnchor(nowMs) - RECENT_SLOTS * RECENT_STEP_MS).toISOString();
  const services = SERVICES.map((service) => {
    const { metrics, points, trends, recent } = BUILDERS[service.kind](safeResults, service, windowSeconds, nowMs);
    const out = { id: service.id, kind: service.kind, name: service.name, metrics, trend: { points }, trends };
    // Slot i of every recent series covers [from + i min, from + (i + 1) min].
    out.recent = { from: recentFrom, stepSeconds: RECENT_STEP_MS / 1000, series: recent };
    const job = JOB_SCHEDULES[service.id];
    if (job) {
      out.schedule = job.schedule;
      out.cron = job.cron;
      out.timeZone = job.timeZone;
      out.nextRun = new Date(nextRunAt(job.cron, nowMs)).toISOString();
    }
    return out;
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: windowName,
    stale: false,
    services,
    totals: buildTotals(services),
  };
}

module.exports = {
  METRIC_KEYS,
  TREND_KEYS,
  RECENT_KEYS,
  RECENT_SLOTS,
  SCHEDULE_KEYS,
  buildPayload,
  buildTotals,
  pointsOf,
  totalFor,
  trendOf,
};
