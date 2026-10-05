"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { KINDS } = require("../src/constants");
const { HISTORY_RANGES, HISTORY_METRICS } = require("../src/history");
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
