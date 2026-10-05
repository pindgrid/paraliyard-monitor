"use strict";

const {
  PROJECT_NAME,
  REGION,
  WINDOWS,
  DEFAULT_WINDOW,
  ALIGNMENT_SECONDS,
  LONG_ALIGNMENT_SECONDS,
  BUCKET_BYTES_LOOKBACK_SECONDS,
  SCHEDULER_LOOKBACK_SECONDS,
  PAGE_SIZE,
  RESOURCES,
  METRIC_TYPES,
  SERVICES,
} = require("./constants");

const M = METRIC_TYPES;

// The fixed set of 13 queries. Each one covers every service of one kind.
// Aligners and reducers are assumptions: confirm in Metrics Explorer.
const QUERY_DEFS = Object.freeze([
  { key: "run.cpu", kind: "function2", metricType: M.RUN_CPU, aligner: "ALIGN_MEAN", reducer: "REDUCE_MAX" },
  { key: "run.memory", kind: "function2", metricType: M.RUN_MEMORY, aligner: "ALIGN_MEAN", reducer: "REDUCE_MAX" },
  {
    key: "run.requests",
    kind: "function2",
    metricType: M.RUN_REQUESTS,
    aligner: "ALIGN_DELTA",
    reducer: "REDUCE_SUM",
    metricLabels: ["response_code_class"],
  },
  { key: "run.instances", kind: "function2", metricType: M.RUN_INSTANCES, aligner: "ALIGN_MAX", reducer: "REDUCE_SUM" },
  { key: "gen1.executions", kind: "function1", metricType: M.GEN1_EXECUTIONS, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  { key: "gen1.memory", kind: "function1", metricType: M.GEN1_MEMORY, aligner: "ALIGN_MEAN", reducer: "REDUCE_MAX" },
  { key: "firestore.reads", kind: "firestore", metricType: M.FIRESTORE_READS, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  { key: "firestore.writes", kind: "firestore", metricType: M.FIRESTORE_WRITES, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  { key: "firestore.deletes", kind: "firestore", metricType: M.FIRESTORE_DELETES, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  { key: "bucket.requests", kind: "bucket", metricType: M.BUCKET_REQUESTS, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  {
    key: "bucket.bytes",
    kind: "bucket",
    metricType: M.BUCKET_BYTES,
    aligner: "ALIGN_MEAN",
    reducer: "REDUCE_SUM",
    lookbackSeconds: BUCKET_BYTES_LOOKBACK_SECONDS,
  },
  { key: "hosting.sentBytes", kind: "hosting", metricType: M.HOSTING_SENT_BYTES, aligner: "ALIGN_DELTA", reducer: "REDUCE_SUM" },
  {
    key: "scheduler.attempts",
    kind: "scheduler",
    metricType: M.SCHEDULER_ATTEMPTS,
    aligner: "ALIGN_DELTA",
    reducer: "REDUCE_SUM",
    metricLabels: ["response_code"],
    lookbackSeconds: SCHEDULER_LOOKBACK_SECONDS,
  },
]);

function normalizeWindow(value) {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(WINDOWS, value)) {
    return value;
  }
  return DEFAULT_WINDOW;
}

function quote(value) {
  return `"${value}"`;
}

function buildFilter(def) {
  const resource = RESOURCES[def.kind];
  const labelValues = SERVICES.filter((s) => s.kind === def.kind).map((s) => quote(s.resourceLabel));
  const clauses = [
    `metric.type = ${quote(def.metricType)}`,
    `resource.type = ${quote(resource.type)}`,
    `resource.labels.${resource.label} = one_of(${labelValues.join(", ")})`,
  ];
  if (def.kind === "function2") clauses.push(`resource.labels.location = ${quote(REGION)}`);
  return clauses.join(" AND ");
}

function timestamp(ms) {
  return { seconds: Math.floor(ms / 1000), nanos: 0 };
}

function buildRequests(windowKey, nowMs) {
  const windowSeconds = WINDOWS[normalizeWindow(windowKey)];
  return QUERY_DEFS.map((def) => {
    const resource = RESOURCES[def.kind];
    const lookbackSeconds = def.lookbackSeconds || windowSeconds;
    const alignmentSeconds = def.lookbackSeconds ? LONG_ALIGNMENT_SECONDS : ALIGNMENT_SECONDS;
    const groupByFields = [`resource.labels.${resource.label}`];
    for (const label of def.metricLabels || []) groupByFields.push(`metric.labels.${label}`);
    return {
      key: def.key,
      request: {
        name: PROJECT_NAME,
        filter: buildFilter(def),
        interval: {
          startTime: timestamp(nowMs - lookbackSeconds * 1000),
          endTime: timestamp(nowMs),
        },
        aggregation: {
          alignmentPeriod: { seconds: alignmentSeconds },
          perSeriesAligner: def.aligner,
          crossSeriesReducer: def.reducer,
          groupByFields,
        },
        view: "FULL",
        pageSize: PAGE_SIZE,
      },
    };
  });
}

module.exports = { QUERY_DEFS, normalizeWindow, buildFilter, buildRequests };
