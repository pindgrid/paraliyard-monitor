"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { KINDS } = require("../src/constants");
const { HISTORY_RANGES, HISTORY_METRICS, AGGREGATES } = require("../src/history");
const { createHandler } = require("../src/handler");
const allowlist = require("../../src/history-allowlist.json");
const { createFakeClient } = require("./fake-client");
const { NOW_MS, nightlySeries } = require("./fixtures/scheduler-live-log");

test("runs history keeps the documented keys and adds otherCalls and per-run fields", async () => {
  const fake = createFakeClient({ respond: () => nightlySeries() });
  const handler = createHandler({ getClient: () => fake.client, now: () => NOW_MS, log: { warn() {}, error() {} } });
  const res = { headers: {}, set: (n, v) => ((res.headers[n] = v), res), status: (c) => ((res.statusCode = c), res), json: (b) => ((res.body = b), res) };
  await handler({ method: "GET", path: "/api/history", query: { service: "scheduler:pyNightlyExport", metric: "runs", range: "30d" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body), ["service", "metric", "range", "unit", "points", "generatedAt", "otherCalls"]);
  assert.equal(res.body.unit, "runs");
  assert.deepEqual(Object.keys(res.body.otherCalls), ["count", "failed"]);
  assert.ok(res.body.points.length > 0);
  for (const p of res.body.points) {
    assert.deepEqual(Object.keys(p), ["t", "v", "result", "requests", "failed"]);
    assert.equal(new Date(p.t).toISOString(), p.t);
    assert.equal(typeof p.v, "number");
    assert.ok(["success", "failed", "missed", "upcoming"].includes(p.result), p.result);
    assert.equal(typeof p.requests, "number");
    assert.equal(typeof p.failed, "number");
  }
});

test("backend history ranges equal the frontend allowlist", () => {
  assert.deepEqual(
    allowlist.ranges,
    Object.entries(HISTORY_RANGES).map(([key, r]) => ({ key, seconds: r.seconds, alignmentSeconds: r.alignmentSeconds })),
  );
});

test("backend history metrics per kind equal the frontend allowlist", () => {
  assert.deepEqual(Object.keys(allowlist.metricsByKind), [...KINDS]);
  assert.deepEqual(Object.keys(HISTORY_METRICS), [...KINDS]);
  for (const kind of KINDS) {
    assert.deepEqual(allowlist.metricsByKind[kind], Object.keys(HISTORY_METRICS[kind]), kind);
  }
});

test("backend history aggregates equal the frontend allowlist", () => {
  assert.deepEqual(Object.keys(allowlist), ["ranges", "metricsByKind", "aggregates"]);
  assert.deepEqual(
    allowlist.aggregates,
    Object.fromEntries(Object.entries(AGGREGATES).map(([id, a]) => [id, [...a.metrics]])),
  );
  assert.deepEqual(Object.keys(AGGREGATES), ["total:function2", "total:bucket", "total:hosting"]);
  for (const [id, aggregate] of Object.entries(AGGREGATES)) {
    for (const metric of aggregate.metrics) {
      assert.ok(allowlist.metricsByKind[aggregate.kind].includes(metric), `${id} ${metric}`);
    }
  }
});
