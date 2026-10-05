"use strict";

const { WINDOWS, GEN1_MEMORY_BYTES, KINDS, RESOURCES, SERVICES } = require("./constants");
const { normalizeWindow } = require("./queries");

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

const MAX_KEYS = new Set(["cpuPct", "memPct"]);

// Time of the latest value for each MAX key.
const AT_KEYS = Object.freeze({ cpuAt: "cpuPct", memAt: "memPct" });

const IDLE = "idle";
// lastResult when the scheduler call succeeded but the job had no run in the lookback.
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

function function2Metrics(results, service, windowSeconds, nowMs) {
  const requests = seriesFor(results, "run.requests", service);
  let errPerMin = null;
  if (requests) {
    const errors = withLabel(requests, "response_code_class", ["4xx", "5xx"]);
    errPerMin = errors.length > 0 ? countPerMinute(errors, windowSeconds) : 0;
  }
  const cpu = gauge(seriesFor(results, "run.cpu", service), 100);
  const mem = gauge(seriesFor(results, "run.memory", service), 100);
  return {
    metrics: {
      cpuPct: cpu.value,
      memPct: mem.value,
      reqPerMin: countPerMinute(requests, windowSeconds),
      errPerMin,
      instances: latestCount(seriesFor(results, "run.instances", service)),
      cpuAt: cpu.at,
      memAt: mem.at,
    },
    points: trendOrFlat([requests], windowSeconds, nowMs),
  };
}

function function1Metrics(results, service, windowSeconds, nowMs) {
  const executions = seriesFor(results, "gen1.executions", service);
  const mem = gauge(seriesFor(results, "gen1.memory", service), 1);
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
  };
}

function firestoreMetrics(results, service, windowSeconds, nowMs) {
  const reads = seriesFor(results, "firestore.reads", service);
  const writes = seriesFor(results, "firestore.writes", service);
  return {
    metrics: {
      readsPerMin: countPerMinute(reads, windowSeconds),
      writesPerMin: countPerMinute(writes, windowSeconds),
      deletesPerMin: countPerMinute(seriesFor(results, "firestore.deletes", service), windowSeconds),
    },
    points: trendOrFlat([reads, writes], windowSeconds, nowMs),
  };
}

function bucketMetrics(results, service, windowSeconds, nowMs) {
  const requests = seriesFor(results, "bucket.requests", service);
  return {
    metrics: {
      reqPerMin: countPerMinute(requests, windowSeconds),
      bytesStored: latest(seriesFor(results, "bucket.bytes", service)),
    },
    points: trendOrFlat([requests], windowSeconds, nowMs),
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
  };
}

// Last run from the job function's request_count: null when the call failed,
// "none" when it succeeded without requests in the lookback. A run succeeded
// when every response class with requests at the newest time is 2xx.
function schedulerMetrics(results, service, windowSeconds, nowMs) {
  const runs = seriesFor(results, "scheduler.runs", service);
  let lastRunAt = null;
  let lastResult = null;
  if (runs) {
    const active = pointsOf(runs).filter((p) => p.v > 0);
    if (active.length === 0) {
      lastResult = NO_RUN;
    } else {
      const newest = Math.max(...active.map((p) => p.t));
      const atNewest = active.filter((p) => p.t === newest);
      lastRunAt = new Date(newest).toISOString();
      lastResult = atNewest.every((p) => p.labels.response_code_class === "2xx") ? "success" : "failed";
    }
  }
  return {
    metrics: { lastRunAt, lastResult },
    points: trendOf([runs], nowMs - windowSeconds * 1000),
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
    if (present.includes("failed")) return "failed";
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
  const services = SERVICES.map((service) => {
    const { metrics, points } = BUILDERS[service.kind](safeResults, service, windowSeconds, nowMs);
    return { id: service.id, kind: service.kind, name: service.name, metrics, trend: { points } };
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: windowName,
    stale: false,
    services,
    totals: buildTotals(services),
  };
}

module.exports = { METRIC_KEYS, buildPayload, buildTotals, totalFor };
