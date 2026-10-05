"use strict";

// Frozen copy of functions/src/aggregate.js as of iteration 4 (before the
// `recent` and schedule fields). No tests live here: aggregate-recent.test.js
// deep-compares the current payload, minus the added fields, against it.

const { WINDOWS, GEN1_MEMORY_BYTES, KINDS, RESOURCES, SERVICES } = require("../../src/constants");
const { normalizeWindow } = require("../../src/queries");

const METRIC_KEYS = Object.freeze({
  function2: Object.freeze(["cpuPct", "memPct", "reqPerMin", "errPerMin", "instances", "cpuAt", "memAt"]),
  function1: Object.freeze(["cpuPct", "execPerMin", "memBytes", "memPct", "memAt"]),
  firestore: Object.freeze(["readsPerMin", "writesPerMin", "deletesPerMin"]),
  bucket: Object.freeze(["reqPerMin", "bytesStored"]),
  hosting: Object.freeze(["bytesServed"]),
  scheduler: Object.freeze(["lastRunAt", "lastResult"]),
});

const MAX_KEYS = new Set(["cpuPct", "memPct"]);
const AT_KEYS = Object.freeze({ cpuAt: "cpuPct", memAt: "memPct" });
const IDLE = "idle";
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

function seriesFor(results, key, service) {
  const result = results[key];
  if (!result || !result.ok || !Array.isArray(result.series)) return null;
  const label = RESOURCES[service.kind].label;
  return result.series.filter(
    (s) => s && s.resource && s.resource.labels && s.resource.labels[label] === service.resourceLabel,
  );
}

function newestPoint(seriesList) {
  if (!seriesList) return null;
  let best = null;
  for (const p of pointsOf(seriesList)) if (best === null || p.t > best.t) best = p;
  return best === null ? null : { t: best.t, v: best.v };
}

function gauge(seriesList, factor) {
  if (!seriesList) return { value: null, at: null };
  const point = newestPoint(seriesList);
  if (!point) return { value: IDLE, at: null };
  return { value: point.v * factor, at: new Date(point.t).toISOString() };
}

function countPerMinute(seriesList, windowSeconds) {
  if (!seriesList) return null;
  return (sumOf(seriesList) || 0) / (windowSeconds / 60);
}

function latestCount(seriesList) {
  if (!seriesList) return null;
  const value = latest(seriesList);
  return value === null ? 0 : value;
}

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

function countTrend(seriesList, windowSeconds, nowMs, sinceMs) {
  if (!seriesList) return null;
  const points = trendOf([seriesList], sinceMs);
  return points.length > 0 ? points : trendOrFlat([[]], windowSeconds, nowMs);
}

function gaugeTrend(seriesList, factor) {
  if (!seriesList) return null;
  return trendOf([seriesList]).map((p) => ({ t: p.t, v: p.v * factor }));
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
  };
}

function function1Metrics(results, service, windowSeconds, nowMs) {
  const executions = seriesFor(results, "gen1.executions", service);
  const memSeries = seriesFor(results, "gen1.memory", service);
  const mem = gauge(memSeries, 1);
  return {
    metrics: {
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
  };
}

function hostingMetrics(results, service, windowSeconds, nowMs) {
  const sent = seriesFor(results, "hosting.sentBytes", service);
  return {
    metrics: {
      bytesServed: sent ? sumOf(sent) || 0 : null,
    },
    points: trendOrFlat([sent], windowSeconds, nowMs),
    trends: { bytesServed: countTrend(sent, windowSeconds, nowMs) },
  };
}

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
    trends: { runs: countTrend(runs, windowSeconds, nowMs, nowMs - windowSeconds * 1000) },
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
    const { metrics, points, trends } = BUILDERS[service.kind](safeResults, service, windowSeconds, nowMs);
    return { id: service.id, kind: service.kind, name: service.name, metrics, trend: { points }, trends };
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: windowName,
    stale: false,
    services,
    totals: buildTotals(services),
  };
}

module.exports = { buildPayload };
