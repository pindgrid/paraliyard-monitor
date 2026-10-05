"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { KINDS } = require("../src/constants");
const { HISTORY_RANGES, HISTORY_METRICS, AGGREGATES } = require("../src/history");
const allowlist = require("../../src/history-allowlist.json");

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
