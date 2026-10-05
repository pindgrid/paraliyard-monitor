"use strict";

const { PROJECT_NAME, PAGE_SIZE, RESOURCES, SERVICES } = require("./constants");
const { QUERY_DEFS, buildServiceFilter } = require("./queries");
const { trendOf } = require("./aggregate");

// Allowed history ranges. range / alignment stays at or under 400 points so a
// single page (PAGE_SIZE, no auto-pagination) always holds the whole series.
const HISTORY_RANGES = Object.freeze({
  "1h": Object.freeze({ seconds: 3600, alignmentSeconds: 60, ttlMs: 60000 }),
  "6h": Object.freeze({ seconds: 21600, alignmentSeconds: 60, ttlMs: 60000 }),
  "24h": Object.freeze({ seconds: 86400, alignmentSeconds: 300, ttlMs: 300000 }),
  "7d": Object.freeze({ seconds: 604800, alignmentSeconds: 3600, ttlMs: 900000 }),
  "30d": Object.freeze({ seconds: 2592000, alignmentSeconds: 10800, ttlMs: 900000 }),
  "6w": Object.freeze({ seconds: 3628800, alignmentSeconds: 14400, ttlMs: 900000 }),
});

// errPerMin: one series of 4xx + 5xx per bucket (grouped by the resource label only).
const ERROR_CLASSES_CLAUSE = 'metric.labels.response_code_class = one_of("4xx", "5xx")';

function spec(queryKey, factor, perMinute, unit, metricFilter) {
  const out = { queryKey, factor, perMinute, unit };
  if (metricFilter) out.metricFilter = metricFilter;
  return Object.freeze(out);
}

const PER_MINUTE = "per minute";

// Allowed history metrics per kind. queryKey names the QUERY_DEFS entry whose
// metric type, aligner and reducer are reused. Mirrored by src/history-allowlist.json.
const HISTORY_METRICS = Object.freeze({
  function2: Object.freeze({
    cpuPct: spec("run.cpu", 100, false, "%"),
    memPct: spec("run.memory", 100, false, "%"),
    reqPerMin: spec("run.requests", 1, true, PER_MINUTE),
    errPerMin: spec("run.requests", 1, true, PER_MINUTE, ERROR_CLASSES_CLAUSE),
    instances: spec("run.instances", 1, false, "instances"),
  }),
  // 1st gen functions report no CPU utilisation and their RAM % is derived.
  function1: Object.freeze({
    execPerMin: spec("gen1.executions", 1, true, PER_MINUTE),
    memBytes: spec("gen1.memory", 1, false, "bytes"),
  }),
  firestore: Object.freeze({
    readsPerMin: spec("firestore.reads", 1, true, PER_MINUTE),
    writesPerMin: spec("firestore.writes", 1, true, PER_MINUTE),
    deletesPerMin: spec("firestore.deletes", 1, true, PER_MINUTE),
  }),
  bucket: Object.freeze({
    reqPerMin: spec("bucket.requests", 1, true, PER_MINUTE),
    bytesStored: spec("bucket.bytes", 1, false, "bytes"),
  }),
  hosting: Object.freeze({
    bytesServed: spec("hosting.sentBytes", 1, false, "bytes per bucket"),
  }),
  scheduler: Object.freeze({
    runs: spec("scheduler.runs", 1, false, "runs per bucket"),
  }),
});

const QUERY_KEYS = Object.freeze(["metric", "range", "service"]);

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// { service, metric, range } for an allowlisted query, otherwise null. The
// query must have exactly the three keys, each a plain string.
function validateHistoryQuery(query) {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return null;
  const keys = Object.keys(query).sort();
  if (keys.length !== QUERY_KEYS.length || keys.some((key, i) => key !== QUERY_KEYS[i])) return null;
  const { service: serviceId, metric, range } = query;
  if (typeof serviceId !== "string" || typeof metric !== "string" || typeof range !== "string") return null;
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return null;
  if (!has(HISTORY_METRICS[service.kind], metric)) return null;
  if (!has(HISTORY_RANGES, range)) return null;
  return { service, metric, range };
}

function timestamp(ms) {
  return { seconds: Math.floor(ms / 1000), nanos: 0 };
}

// listTimeSeries request for one validated (service, metric, range). Every
// field comes from constants; only the times depend on nowMs.
function buildHistoryRequest(service, metric, range, nowMs) {
  const metricSpec = HISTORY_METRICS[service.kind][metric];
  const { seconds, alignmentSeconds } = HISTORY_RANGES[range];
  const def = QUERY_DEFS.find((d) => d.key === metricSpec.queryKey);
  const extra = metricSpec.metricFilter ? [metricSpec.metricFilter] : [];
  return {
    name: PROJECT_NAME,
    filter: buildServiceFilter(def, service, extra),
    interval: {
      startTime: timestamp(nowMs - seconds * 1000),
      endTime: timestamp(nowMs),
    },
    aggregation: {
      alignmentPeriod: { seconds: alignmentSeconds },
      perSeriesAligner: def.aligner,
      crossSeriesReducer: def.reducer,
      groupByFields: [`resource.labels.${RESOURCES[service.kind].label}`],
    },
    view: "FULL",
    pageSize: PAGE_SIZE,
  };
}

// Scaling for a metric key; the same key scales the same way in every kind.
function metricSpecOf(metric) {
  for (const metrics of Object.values(HISTORY_METRICS)) if (has(metrics, metric)) return metrics[metric];
  return null;
}

// [{ t (ISO), v }] sorted by time: deltas per minute for *PerMin keys,
// utilisations x100, everything else as returned.
function toHistoryPoints(series, metric, range) {
  const metricSpec = metricSpecOf(metric);
  if (!metricSpec || !has(HISTORY_RANGES, range) || !Array.isArray(series)) return [];
  const divisor = metricSpec.perMinute ? HISTORY_RANGES[range].alignmentSeconds / 60 : 1;
  return trendOf([series]).map((p) => ({ t: p.t, v: (p.v * metricSpec.factor) / divisor }));
}

module.exports = {
  HISTORY_RANGES,
  HISTORY_METRICS,
  validateHistoryQuery,
  buildHistoryRequest,
  toHistoryPoints,
};
