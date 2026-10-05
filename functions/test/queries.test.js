"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { METRIC_TYPES, PROJECT_NAME } = require("../src/constants");
const { buildRequests, normalizeWindow } = require("../src/queries");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ALLOWED = new Set(Object.values(METRIC_TYPES));

function metricTypeOf(filter) {
  const match = /^metric\.type = "([^"]+)"/.exec(filter);
  return match && match[1];
}

test("13 requests per window, all against the project", () => {
  for (const windowKey of ["1h", "6h"]) {
    const requests = buildRequests(windowKey, NOW);
    assert.equal(requests.length, 13);
    for (const { request } of requests) {
      assert.equal(request.name, "projects/mineral-proton-438104-g8");
      assert.equal(request.name, PROJECT_NAME);
      assert.equal(request.view, "FULL");
      assert.equal(request.pageSize, 1000);
    }
  }
});

test("request keys are unique", () => {
  const keys = buildRequests("1h", NOW).map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every filter's metric.type is allowlisted", () => {
  for (const windowKey of ["1h", "6h"]) {
    for (const { request } of buildRequests(windowKey, NOW)) {
      const type = metricTypeOf(request.filter);
      assert.ok(ALLOWED.has(type), `not allowlisted: ${request.filter}`);
      assert.equal(request.filter.match(/metric\.type/g).length, 1);
    }
  }
});

test("normalizeWindow only accepts allowlisted keys", () => {
  assert.equal(normalizeWindow("6h"), "6h");
  assert.equal(normalizeWindow("1h"), "1h");
  assert.equal(normalizeWindow(undefined), "1h");
  assert.equal(normalizeWindow("7d"), "1h");
  assert.equal(normalizeWindow("__proto__"), "1h");
  assert.equal(normalizeWindow("constructor"), "1h");
  assert.equal(normalizeWindow(["1h"]), "1h");
  assert.equal(normalizeWindow(["6h"]), "1h");
  assert.equal(normalizeWindow("1h OR x"), "1h");
});

test("filters contain only constants", () => {
  for (const windowKey of ["1h", "6h", "1h OR x", "7d"]) {
    for (const { request } of buildRequests(windowKey, NOW)) {
      assert.ok(!request.filter.includes(windowKey), request.filter);
    }
  }
  const plain = buildRequests("1h", NOW).map((r) => r.request.filter);
  assert.deepEqual(buildRequests("1h OR x", NOW).map((r) => r.request.filter), plain);
  assert.deepEqual(buildRequests("6h", NOW).map((r) => r.request.filter), plain);
});

test("interval follows the window except for the fixed lookbacks", () => {
  const nowSeconds = NOW / 1000;
  for (const [windowKey, seconds] of [["1h", 3600], ["6h", 21600]]) {
    for (const { key, request } of buildRequests(windowKey, NOW)) {
      assert.equal(request.interval.endTime.seconds, nowSeconds);
      const span = nowSeconds - request.interval.startTime.seconds;
      if (key === "bucket.bytes") assert.equal(span, 48 * 3600);
      else if (key === "scheduler.attempts") assert.equal(span, 8 * 24 * 3600);
      else assert.equal(span, seconds);
    }
  }
});
