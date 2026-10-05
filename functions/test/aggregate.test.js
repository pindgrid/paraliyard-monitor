"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVICES, GEN1_MEMORY_BYTES } = require("../src/constants");
const { buildPayload, METRIC_KEYS } = require("../src/aggregate");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60000;

// One aligned series; values[i] is the point i minutes before NOW (newest first).
function series(resourceLabels, values, metricLabels = {}, stepMs = MINUTE) {
  return {
    resource: { labels: resourceLabels },
    metric: { labels: metricLabels },
    points: values.map((v, i) => ({
      interval: { endTime: { seconds: String((NOW - i * stepMs) / 1000), nanos: 0 } },
      value: Number.isInteger(v) ? { int64Value: String(v) } : { doubleValue: v },
    })),
  };
}

function ok(...list) {
  return { ok: true, series: list };
}

function find(payload, id) {
  return payload.services.find((s) => s.id === id);
}

test("every service appears exactly once, even with no results", () => {
  const payload = buildPayload({ results: {}, windowKey: "1h", nowMs: NOW });
  assert.equal(payload.services.length, SERVICES.length);
  assert.deepEqual(payload.services.map((s) => s.id), SERVICES.map((s) => s.id));
  assert.equal(payload.window, "1h");
  assert.equal(payload.stale, false);
  assert.equal(payload.generatedAt, new Date(NOW).toISOString());
  for (const s of payload.services) {
    assert.deepEqual(Object.keys(s.metrics), [...METRIC_KEYS[s.kind]]);
    for (const value of Object.values(s.metrics)) assert.equal(value, null);
    assert.deepEqual(s.trend.points, []);
  }
});

test("unknown window falls back to 1h", () => {
  assert.equal(buildPayload({ results: {}, windowKey: "7d", nowMs: NOW }).window, "1h");
  assert.equal(buildPayload({ results: {}, windowKey: "6h", nowMs: NOW }).window, "6h");
});

test("missing or failed metric is null, a real 0 is 0", () => {
  const results = {
    "run.cpu": ok(series({ service_name: "pynightlyexport" }, [0])),
    "run.memory": { ok: false },
    "run.instances": ok(series({ service_name: "pynightlyexport" }, [0])),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  const fn = find(payload, "function2:pyNightlyExport").metrics;
  assert.equal(fn.cpuPct, 0);
  assert.equal(fn.instances, 0);
  assert.equal(fn.memPct, null);
  assert.equal(fn.reqPerMin, null);
  assert.equal(fn.errPerMin, null);
  // Another service with no series in a successful call is still null.
  assert.equal(find(payload, "function2:pyWeeklyAccounts").metrics.cpuPct, null);
});

test("function2 rates, utilisation and errors", () => {
  const sn = { service_name: "pymintoncrewclaim" };
  const results = {
    "run.cpu": ok(series(sn, [0.25, 0.9])),
    "run.memory": ok(series(sn, [0.5])),
    "run.requests": ok(
      series(sn, [60, 60], { response_code_class: "2xx" }),
      series(sn, [30], { response_code_class: "3xx" }),
      series(sn, [6], { response_code_class: "4xx" }),
      series(sn, [12], { response_code_class: "5xx" }),
    ),
    "run.instances": ok(series(sn, [3, 1])),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  const s = find(payload, "function2:pyMintOnCrewClaim");
  assert.equal(s.metrics.cpuPct, 25);
  assert.equal(s.metrics.memPct, 50);
  assert.equal(s.metrics.reqPerMin, (60 + 60 + 30 + 6 + 12) / 60);
  assert.equal(s.metrics.errPerMin, (6 + 12) / 60);
  assert.equal(s.metrics.instances, 3);
  assert.deepEqual(s.trend.points, [
    { t: new Date(NOW - MINUTE).toISOString(), v: 60 },
    { t: new Date(NOW).toISOString(), v: 60 + 30 + 6 + 12 },
  ]);
});

test("errors are 0 when requests exist without 4xx/5xx", () => {
  const sn = { service_name: "pyweeklyaccounts" };
  const results = { "run.requests": ok(series(sn, [10], { response_code_class: "2xx" })) };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyWeeklyAccounts");
  assert.equal(s.metrics.errPerMin, 0);
});

test("6h window divides rates by 360 minutes", () => {
  const results = { "firestore.reads": ok(series({ database_id: "yard" }, [360])) };
  const s = find(buildPayload({ results, windowKey: "6h", nowMs: NOW }), "firestore:yard");
  assert.equal(s.metrics.readsPerMin, 1);
});

test("function1 cpu is always null and memory is a share of 512 MB", () => {
  const fn = { function_name: "pyCleanupOnAuthDelete" };
  const results = {
    "gen1.executions": ok(series(fn, [2, 4])),
    "gen1.memory": ok(series(fn, [GEN1_MEMORY_BYTES / 4])),
  };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function1:pyCleanupOnAuthDelete");
  assert.equal(s.metrics.cpuPct, null);
  assert.equal(s.metrics.execPerMin, 6 / 60);
  assert.equal(s.metrics.memBytes, GEN1_MEMORY_BYTES / 4);
  assert.equal(s.metrics.memPct, 25);
});

test("firestore trend is reads plus writes", () => {
  const db = { database_id: "yard" };
  const results = {
    "firestore.reads": ok(series(db, [10, 20])),
    "firestore.writes": ok(series(db, [1, 2])),
    "firestore.deletes": ok(series(db, [0])),
  };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "firestore:yard");
  assert.equal(s.metrics.deletesPerMin, 0);
  assert.deepEqual(s.trend.points.map((p) => p.v), [22, 11]);
});

test("bucket bytes use the latest point and hosting sums bytes", () => {
  const results = {
    "bucket.bytes": ok(series({ bucket_name: "mineral-proton-438104-g8-paraliyard" }, [4000, 3000], {}, 3600000)),
    "hosting.sentBytes": ok(series({ domain_name: "paraliyard.web.app" }, [100, 200])),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  assert.equal(find(payload, "bucket:mineral-proton-438104-g8-paraliyard").metrics.bytesStored, 4000);
  assert.equal(find(payload, "bucket:mineral-proton-438104-g8-paraliyard").metrics.reqPerMin, null);
  const hosting = find(payload, "hosting:paraliyard").metrics;
  assert.equal(hosting.bytesServed, 300);
  assert.equal(hosting.reqPerMin, null);
});

test("scheduler last run and result", () => {
  const nightly = { job_id: "firebase-schedule-pyNightlyExport-asia-south1" };
  const weekly = { job_id: "firebase-schedule-pyWeeklyAccounts-asia-south1" };
  const HOUR = 3600000;
  const results = {
    "scheduler.attempts": ok(
      series(nightly, [0, 0, 1], { response_code: "200" }, HOUR),
      series(nightly, [0, 1], { response_code: "500" }, HOUR),
      series(weekly, [0, 0, 0, 1], { response_code: "200" }, HOUR),
    ),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  const n = find(payload, "scheduler:pyNightlyExport").metrics;
  assert.equal(n.lastRunAt, new Date(NOW - HOUR).toISOString());
  assert.equal(n.lastResult, "failed");
  const w = find(payload, "scheduler:pyWeeklyAccounts").metrics;
  assert.equal(w.lastRunAt, new Date(NOW - 3 * HOUR).toISOString());
  assert.equal(w.lastResult, "success");
  assert.equal(payload.totals.scheduler.lastRunAt, n.lastRunAt);
  assert.equal(payload.totals.scheduler.lastResult, "failed");
});

test("scheduler with no attempts has null run and result", () => {
  const results = { "scheduler.attempts": ok(series({ job_id: "firebase-schedule-pyNightlyExport-asia-south1" }, [0, 0])) };
  const n = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "scheduler:pyNightlyExport").metrics;
  assert.equal(n.lastRunAt, null);
  assert.equal(n.lastResult, null);
});

test("totals sum rates, take max of percentages and are null when all null", () => {
  const results = {
    "run.cpu": ok(series({ service_name: "pynightlyexport" }, [0.2]), series({ service_name: "pyweeklyaccounts" }, [0.7])),
    "run.requests": ok(
      series({ service_name: "pynightlyexport" }, [60], { response_code_class: "2xx" }),
      series({ service_name: "pyweeklyaccounts" }, [120], { response_code_class: "2xx" }),
    ),
    "run.instances": ok(series({ service_name: "pynightlyexport" }, [2]), series({ service_name: "pyweeklyaccounts" }, [1])),
    "bucket.bytes": ok(
      series({ bucket_name: "mineral-proton-438104-g8-paraliyard" }, [10]),
      series({ bucket_name: "mineral-proton-438104-g8-yard-backups" }, [5]),
    ),
  };
  const totals = buildPayload({ results, windowKey: "1h", nowMs: NOW }).totals;
  assert.equal(totals.function2.cpuPct, 70);
  assert.equal(totals.function2.reqPerMin, 3);
  assert.equal(totals.function2.errPerMin, 0);
  assert.equal(totals.function2.instances, 3);
  assert.equal(totals.function2.memPct, null);
  assert.equal(totals.bucket.bytesStored, 15);
  assert.equal(totals.bucket.reqPerMin, null);
  assert.deepEqual(totals.function1, { cpuPct: null, execPerMin: null, memBytes: null, memPct: null });
  assert.deepEqual(Object.keys(totals), ["function2", "function1", "firestore", "bucket", "hosting", "scheduler"]);
});
