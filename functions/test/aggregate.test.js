"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVICES, GEN1_MEMORY_BYTES } = require("../src/constants");
const { buildPayload, METRIC_KEYS, TREND_KEYS, totalFor } = require("../src/aggregate");

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
  // Another service with no series in a successful call is idle.
  assert.equal(find(payload, "function2:pyWeeklyAccounts").metrics.cpuPct, "idle");
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
  assert.equal("reqPerMin" in hosting, false);
});

test("successful hosting query with no series gives 0 bytes served", () => {
  const payload = buildPayload({ results: { "hosting.sentBytes": ok() }, windowKey: "1h", nowMs: NOW });
  assert.equal(find(payload, "hosting:paraliyard").metrics.bytesServed, 0);
  assert.equal(find(payload, "hosting:preparaliyard").metrics.bytesServed, 0);
  assert.equal(payload.totals.hosting.bytesServed, 0);
});

test("failed hosting query keeps bytes served null", () => {
  const payload = buildPayload({ results: { "hosting.sentBytes": { ok: false } }, windowKey: "1h", nowMs: NOW });
  assert.equal(find(payload, "hosting:paraliyard").metrics.bytesServed, null);
  assert.equal(find(payload, "hosting:preparaliyard").metrics.bytesServed, null);
  assert.equal(payload.totals.hosting.bytesServed, null);
});

const NIGHTLY = { service_name: "pynightlyexport" };
const WEEKLY = { service_name: "pyweeklyaccounts" };
const FIVE_MINUTES = 300000;

test("scheduler last run and result from request_count classes", () => {
  const results = {
    "scheduler.runs": ok(
      series(NIGHTLY, [0, 0, 1], { response_code_class: "2xx" }, FIVE_MINUTES),
      series(NIGHTLY, [0, 0, 1], { response_code_class: "5xx" }, FIVE_MINUTES),
      series(WEEKLY, [0, 0, 0, 2], { response_code_class: "2xx" }, FIVE_MINUTES),
      series(WEEKLY, [0, 0, 0, 0], { response_code_class: "4xx" }, FIVE_MINUTES),
    ),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  const n = find(payload, "scheduler:pyNightlyExport").metrics;
  assert.equal(n.lastRunAt, new Date(NOW - 2 * FIVE_MINUTES).toISOString());
  assert.equal(n.lastResult, "failed");
  const w = find(payload, "scheduler:pyWeeklyAccounts").metrics;
  assert.equal(w.lastRunAt, new Date(NOW - 3 * FIVE_MINUTES).toISOString());
  assert.equal(w.lastResult, "success");
  assert.equal(payload.totals.scheduler.lastRunAt, n.lastRunAt);
  assert.equal(payload.totals.scheduler.lastResult, "failed");
});

test("scheduler with no requests in a successful query is a distinct no-run value", () => {
  const results = { "scheduler.runs": ok(series(NIGHTLY, [0, 0], { response_code_class: "2xx" }, FIVE_MINUTES)) };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  // Only zero values.
  const n = find(payload, "scheduler:pyNightlyExport").metrics;
  assert.equal(n.lastRunAt, null);
  assert.equal(n.lastResult, "none");
  // No series at all.
  const w = find(payload, "scheduler:pyWeeklyAccounts").metrics;
  assert.equal(w.lastRunAt, null);
  assert.equal(w.lastResult, "none");
  assert.equal(payload.totals.scheduler.lastRunAt, null);
  assert.equal(payload.totals.scheduler.lastResult, "none");
});

test("failed scheduler query keeps run and result null", () => {
  const payload = buildPayload({ results: { "scheduler.runs": { ok: false } }, windowKey: "1h", nowMs: NOW });
  for (const id of ["scheduler:pyNightlyExport", "scheduler:pyWeeklyAccounts"]) {
    assert.deepEqual(find(payload, id).metrics, { lastRunAt: null, lastResult: null }, id);
  }
  assert.deepEqual(payload.totals.scheduler, { lastRunAt: null, lastResult: null });
});

test("scheduler totals: failed over success over none", () => {
  const results = { "scheduler.runs": ok(series(WEEKLY, [0, 1], { response_code_class: "2xx" }, FIVE_MINUTES)) };
  const totals = buildPayload({ results, windowKey: "1h", nowMs: NOW }).totals.scheduler;
  assert.equal(totals.lastResult, "success");
  assert.equal(totals.lastRunAt, new Date(NOW - FIVE_MINUTES).toISOString());
  assert.equal(totalFor("lastResult", ["none", "none"]), "none");
  assert.equal(totalFor("lastResult", ["none", "success"]), "success");
  assert.equal(totalFor("lastResult", ["success", "none", "failed"]), "failed");
  assert.equal(totalFor("lastResult", [null, null]), null);
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
  assert.deepEqual(totals.function1, { cpuPct: null, execPerMin: null, memBytes: null, memPct: null, memAt: null });
  assert.deepEqual(Object.keys(totals), ["function2", "function1", "firestore", "bucket", "hosting", "scheduler"]);
});

const ALL_KEYS = [
  "run.cpu",
  "run.memory",
  "run.requests",
  "run.instances",
  "gen1.executions",
  "gen1.memory",
  "firestore.reads",
  "firestore.writes",
  "firestore.deletes",
  "bucket.requests",
  "bucket.bytes",
  "hosting.sentBytes",
  "scheduler.runs",
];

function allEmpty() {
  return Object.fromEntries(ALL_KEYS.map((key) => [key, ok()]));
}

test("every query with an empty series list gives idle gauges and zero counts", () => {
  assert.equal(ALL_KEYS.length, 13);
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  for (const s of payload.services.filter((v) => v.kind === "function2")) {
    assert.equal(s.metrics.reqPerMin, 0, s.id);
    assert.equal(s.metrics.errPerMin, 0, s.id);
    assert.equal(s.metrics.instances, 0, s.id);
    assert.equal(s.metrics.cpuPct, "idle", s.id);
    assert.equal(s.metrics.memPct, "idle", s.id);
    assert.equal(s.metrics.cpuAt, null, s.id);
    assert.equal(s.metrics.memAt, null, s.id);
  }
  const fn1 = find(payload, "function1:pyCleanupOnAuthDelete").metrics;
  assert.equal(fn1.execPerMin, 0);
  assert.equal(fn1.memBytes, "idle");
  assert.equal(fn1.memPct, "idle");
  assert.equal(fn1.cpuPct, null);
  assert.equal(fn1.memAt, null);
  const fs = find(payload, "firestore:yard").metrics;
  assert.equal(fs.readsPerMin, 0);
  assert.equal(fs.writesPerMin, 0);
  assert.equal(fs.deletesPerMin, 0);
  for (const s of payload.services.filter((v) => v.kind === "bucket")) assert.equal(s.metrics.reqPerMin, 0, s.id);
  assert.equal(find(payload, "hosting:paraliyard").metrics.bytesServed, 0);
  assert.equal(find(payload, "hosting:preparaliyard").metrics.bytesServed, 0);
  assert.equal(payload.totals.hosting.bytesServed, 0);
});

test("failed calls keep every affected metric null", () => {
  const failed = Object.fromEntries(ALL_KEYS.map((key) => [key, { ok: false }]));
  for (const results of [{}, failed]) {
    const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
    for (const s of payload.services) {
      for (const [key, value] of Object.entries(s.metrics)) assert.equal(value, null, `${s.id} ${key}`);
      assert.deepEqual(s.trend.points, [], s.id);
    }
  }
});

test("cpu uses the newest point with its time", () => {
  const at = NOW - 23 * MINUTE;
  const results = {
    "run.cpu": ok({
      resource: { labels: { service_name: "pymintoncrewclaim" } },
      metric: { labels: {} },
      points: [{ interval: { endTime: { seconds: String(at / 1000), nanos: 0 } }, value: { doubleValue: 0.12 } }],
    }),
  };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyMintOnCrewClaim").metrics;
  assert.equal(s.cpuPct, 12);
  assert.equal(s.cpuAt, new Date(at).toISOString());
  assert.equal(s.memAt, null);
});

test("function2 totals take the max with its time, idle when all idle, null when failed", () => {
  const results = {
    "run.cpu": ok(
      series({ service_name: "pynightlyexport" }, [0.2]),
      series({ service_name: "pyweeklyaccounts" }, [null, 0.7]),
    ),
    "run.memory": ok(),
  };
  const totals = buildPayload({ results, windowKey: "1h", nowMs: NOW }).totals.function2;
  assert.equal(totals.cpuPct, 70);
  assert.equal(totals.cpuAt, new Date(NOW - MINUTE).toISOString());
  assert.equal(totals.memPct, "idle");
  assert.equal(totals.memAt, null);

  const failed = buildPayload({ results: { "run.cpu": { ok: false } }, windowKey: "1h", nowMs: NOW }).totals.function2;
  assert.equal(failed.cpuPct, null);
  assert.equal(failed.cpuAt, null);
});

test("idle trend is a flat line, failed trend is empty", () => {
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  const flat = [
    { t: new Date(NOW - 3600000).toISOString(), v: 0 },
    { t: new Date(NOW).toISOString(), v: 0 },
  ];
  for (const id of [
    "function2:pyWeeklyAccounts",
    "function1:pyCleanupOnAuthDelete",
    "firestore:yard",
    "bucket:mineral-proton-438104-g8-paraliyard",
  ]) {
    assert.deepEqual(find(payload, id).trend.points, flat, id);
  }
  const failed = buildPayload({ results: { "run.requests": { ok: false } }, windowKey: "1h", nowMs: NOW });
  assert.deepEqual(find(failed, "function2:pyWeeklyAccounts").trend.points, []);
});

test("trends follow trend in the service object and use the kind's trend keys", () => {
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  for (const s of payload.services) {
    const added = s.kind === "scheduler" ? ["recent", "schedule", "cron", "timeZone", "nextRun"] : ["recent"];
    assert.deepEqual(Object.keys(s), ["id", "kind", "name", "metrics", "trend", "trends", ...added], s.id);
    assert.deepEqual(Object.keys(s.trends), [...TREND_KEYS[s.kind]], s.id);
  }
  assert.deepEqual(TREND_KEYS.firestore, ["readsPerMin", "writesPerMin", "deletesPerMin"]);
  assert.deepEqual(TREND_KEYS.function2, ["reqPerMin", "errPerMin", "cpuPct", "memPct", "instances"]);
});

test("firestore reads, writes and deletes trends are separate", () => {
  const db = { database_id: "yard" };
  const results = {
    "firestore.reads": ok(series(db, [10, 20])),
    "firestore.writes": ok(series(db, [1, 2])),
    "firestore.deletes": ok(series(db, [3])),
  };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "firestore:yard");
  assert.deepEqual(s.trends.readsPerMin.map((p) => p.v), [20, 10]);
  assert.deepEqual(s.trends.writesPerMin.map((p) => p.v), [2, 1]);
  assert.deepEqual(s.trends.deletesPerMin, [{ t: new Date(NOW).toISOString(), v: 3 }]);
  // The existing combined trend is unchanged.
  assert.deepEqual(s.trend.points.map((p) => p.v), [22, 11]);
});

test("function2 trends: summed requests, errors, scaled CPU/RAM and instances", () => {
  const sn = { service_name: "pymintoncrewclaim" };
  const results = {
    "run.cpu": ok(series(sn, [0.25, 0.5])),
    "run.memory": ok(series(sn, [0.4])),
    "run.requests": ok(
      series(sn, [60, 50], { response_code_class: "2xx" }),
      series(sn, [6], { response_code_class: "4xx" }),
      series(sn, [0, 12], { response_code_class: "5xx" }),
    ),
    "run.instances": ok(series(sn, [3, 1])),
  };
  const t = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyMintOnCrewClaim").trends;
  const at = (i) => new Date(NOW - i * MINUTE).toISOString();
  assert.deepEqual(t.reqPerMin, [{ t: at(1), v: 62 }, { t: at(0), v: 66 }]);
  assert.deepEqual(t.errPerMin, [{ t: at(1), v: 12 }, { t: at(0), v: 6 }]);
  assert.deepEqual(t.cpuPct, [{ t: at(1), v: 50 }, { t: at(0), v: 25 }]);
  assert.deepEqual(t.memPct, [{ t: at(0), v: 40 }]);
  assert.deepEqual(t.instances, [{ t: at(1), v: 1 }, { t: at(0), v: 3 }]);
});

test("function1, bucket, hosting and scheduler trends", () => {
  const results = {
    "gen1.executions": ok(series({ function_name: "pyCleanupOnAuthDelete" }, [2])),
    "gen1.memory": ok(series({ function_name: "pyCleanupOnAuthDelete" }, [1024])),
    "bucket.requests": ok(series({ bucket_name: "mineral-proton-438104-g8-paraliyard" }, [5])),
    "bucket.bytes": ok(series({ bucket_name: "mineral-proton-438104-g8-paraliyard" }, [4000, 3000], {}, 3600000)),
    "hosting.sentBytes": ok(series({ domain_name: "paraliyard.web.app" }, [100, 200])),
    "scheduler.runs": ok(
      series(NIGHTLY, [1, 0], { response_code_class: "2xx" }, FIVE_MINUTES),
      // A run 2 h ago is outside the 1h window and not part of the runs trend.
      series(NIGHTLY, [0, 1], { response_code_class: "5xx" }, 2 * 3600000),
    ),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  const now = new Date(NOW).toISOString();
  assert.deepEqual(find(payload, "function1:pyCleanupOnAuthDelete").trends, {
    execPerMin: [{ t: now, v: 2 }],
    memBytes: [{ t: now, v: 1024 }],
  });
  const bucket = find(payload, "bucket:mineral-proton-438104-g8-paraliyard").trends;
  assert.deepEqual(bucket.reqPerMin, [{ t: now, v: 5 }]);
  assert.deepEqual(bucket.bytesStored, [{ t: new Date(NOW - 3600000).toISOString(), v: 3000 }, { t: now, v: 4000 }]);
  assert.deepEqual(find(payload, "hosting:paraliyard").trends.bytesServed.map((p) => p.v), [200, 100]);
  assert.deepEqual(find(payload, "scheduler:pyNightlyExport").trends.runs, [
    { t: new Date(NOW - FIVE_MINUTES).toISOString(), v: 0 },
    { t: now, v: 1 },
  ]);
});

test("failed calls give null trends", () => {
  const failed = Object.fromEntries(ALL_KEYS.map((key) => [key, { ok: false }]));
  for (const results of [{}, failed]) {
    const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
    for (const s of payload.services) {
      for (const [key, value] of Object.entries(s.trends)) assert.equal(value, null, `${s.id} ${key}`);
    }
  }
});

test("empty successful calls give flat 0 count trends and [] gauge trends", () => {
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  const flat = [
    { t: new Date(NOW - 3600000).toISOString(), v: 0 },
    { t: new Date(NOW).toISOString(), v: 0 },
  ];
  const COUNT = new Set(["reqPerMin", "errPerMin", "execPerMin", "readsPerMin", "writesPerMin", "deletesPerMin", "bytesServed", "runs"]);
  for (const s of payload.services) {
    for (const [key, value] of Object.entries(s.trends)) {
      assert.deepEqual(value, COUNT.has(key) ? flat : [], `${s.id} ${key}`);
    }
  }
  const fn2 = find(payload, "function2:pyWeeklyAccounts").trends;
  assert.deepEqual(fn2.cpuPct, []);
  assert.deepEqual(fn2.memPct, []);
});

test("one refresh with trends still makes exactly 13 listTimeSeries calls", async () => {
  const { createHandler } = require("../src/handler");
  const { createFakeClient } = require("./fake-client");
  const fake = createFakeClient();
  const handler = createHandler({ getClient: () => fake.client, now: () => NOW, log: { warn() {}, error() {} } });
  let body;
  const res = { set: () => res, status: () => res, json: (value) => ((body = value), res) };
  await handler({ method: "GET", path: "/api/metrics", query: {} }, res);
  assert.equal(fake.calls.length, 13);
  assert.deepEqual(fake.methods(), ["listTimeSeries"]);
  for (const s of body.services) assert.deepEqual(Object.keys(s.trends), [...TREND_KEYS[s.kind]], s.id);
});

test("errors trend is a flat 0 line when requests succeeded without 4xx/5xx", () => {
  const sn = { service_name: "pyweeklyaccounts" };
  const results = { "run.requests": ok(series(sn, [10], { response_code_class: "2xx" })) };
  const t = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyWeeklyAccounts").trends;
  assert.deepEqual(t.reqPerMin, [{ t: new Date(NOW).toISOString(), v: 10 }]);
  assert.deepEqual(t.errPerMin.map((p) => p.v), [0, 0]);
  assert.equal(t.cpuPct, null);
});
