"use strict";

const { WINDOWS, GEN1_MEMORY_BYTES, KINDS, RESOURCES, SERVICES } = require("./constants");
const { normalizeWindow } = require("./queries");

// Metric keys per kind, in display order. Unknown values are always null.
const METRIC_KEYS = Object.freeze({
  function2: Object.freeze(["cpuPct", "memPct", "reqPerMin", "errPerMin", "instances"]),
  function1: Object.freeze(["cpuPct", "execPerMin", "memBytes", "memPct"]),
  firestore: Object.freeze(["readsPerMin", "writesPerMin", "deletesPerMin"]),
  bucket: Object.freeze(["reqPerMin", "bytesStored"]),
  hosting: Object.freeze(["bytesServed", "reqPerMin"]),
  scheduler: Object.freeze(["lastRunAt", "lastResult"]),
});

const MAX_KEYS = new Set(["cpuPct", "memPct"]);

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

// Series for one service, or null when the call failed or returned nothing for it.
function seriesFor(results, key, service) {
  const result = results[key];
  if (!result || !result.ok || !Array.isArray(result.series)) return null;
  const label = RESOURCES[service.kind].label;
  const matching = result.series.filter(
    (s) => s && s.resource && s.resource.labels && s.resource.labels[label] === service.resourceLabel,
  );
  return matching.length > 0 ? matching : null;
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

function perMinute(seriesList, windowSeconds) {
  const total = sumOf(seriesList);
  return total === null ? null : total / (windowSeconds / 60);
}

function scale(value, factor) {
  return value === null ? null : value * factor;
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

// assumption: confirm in Metrics Explorer. HTTP 2xx (or the gRPC name "OK") means success.
function isSuccessCode(code) {
  return /^2\d\d$/.test(String(code)) || code === "OK";
}

function function2Metrics(results, service, windowSeconds) {
  const requests = seriesFor(results, "run.requests", service);
  let errPerMin = null;
  if (requests) {
    const errors = withLabel(requests, "response_code_class", ["4xx", "5xx"]);
    errPerMin = errors.length > 0 ? perMinute(errors, windowSeconds) : 0;
  }
  return {
    metrics: {
      cpuPct: scale(latest(seriesFor(results, "run.cpu", service)), 100),
      memPct: scale(latest(seriesFor(results, "run.memory", service)), 100),
      reqPerMin: perMinute(requests, windowSeconds),
      errPerMin,
      instances: latest(seriesFor(results, "run.instances", service)),
    },
    points: trendOf([requests]),
  };
}

function function1Metrics(results, service, windowSeconds) {
  const executions = seriesFor(results, "gen1.executions", service);
  const memBytes = latest(seriesFor(results, "gen1.memory", service));
  return {
    metrics: {
      // 1st gen functions do not report CPU utilisation.
      cpuPct: null,
      execPerMin: perMinute(executions, windowSeconds),
      memBytes,
      memPct: scale(memBytes, 100 / GEN1_MEMORY_BYTES),
    },
    points: trendOf([executions]),
  };
}

function firestoreMetrics(results, service, windowSeconds) {
  const reads = seriesFor(results, "firestore.reads", service);
  const writes = seriesFor(results, "firestore.writes", service);
  return {
    metrics: {
      readsPerMin: perMinute(reads, windowSeconds),
      writesPerMin: perMinute(writes, windowSeconds),
      deletesPerMin: perMinute(seriesFor(results, "firestore.deletes", service), windowSeconds),
    },
    points: trendOf([reads, writes]),
  };
}

function bucketMetrics(results, service, windowSeconds) {
  const requests = seriesFor(results, "bucket.requests", service);
  return {
    metrics: {
      reqPerMin: perMinute(requests, windowSeconds),
      bytesStored: latest(seriesFor(results, "bucket.bytes", service)),
    },
    points: trendOf([requests]),
  };
}

function hostingMetrics(results, service) {
  const sent = seriesFor(results, "hosting.sentBytes", service);
  return {
    metrics: {
      bytesServed: sumOf(sent),
      // No request-count series is queried for Hosting.
      reqPerMin: null,
    },
    points: trendOf([sent]),
  };
}

function schedulerMetrics(results, service, windowSeconds, nowMs) {
  const attempts = seriesFor(results, "scheduler.attempts", service);
  let lastRunAt = null;
  let lastResult = null;
  if (attempts) {
    const runs = pointsOf(attempts).filter((p) => p.v > 0);
    if (runs.length > 0) {
      const newest = Math.max(...runs.map((p) => p.t));
      const atNewest = runs.filter((p) => p.t === newest);
      lastRunAt = new Date(newest).toISOString();
      lastResult = atNewest.every((p) => isSuccessCode(p.labels.response_code)) ? "success" : "failed";
    }
  }
  return {
    metrics: { lastRunAt, lastResult },
    points: trendOf([attempts], nowMs - windowSeconds * 1000),
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
  if (key === "lastResult") return present.includes("failed") ? "failed" : "success";
  if (MAX_KEYS.has(key)) return Math.max(...present);
  return present.reduce((a, b) => a + b, 0);
}

function buildTotals(services) {
  const totals = {};
  for (const kind of KINDS) {
    const ofKind = services.filter((s) => s.kind === kind);
    totals[kind] = {};
    for (const key of METRIC_KEYS[kind]) {
      totals[kind][key] = totalFor(key, ofKind.map((s) => s.metrics[key]));
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
