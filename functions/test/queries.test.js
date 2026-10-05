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
      else if (key === "scheduler.runs") assert.equal(span, 691200);
      else assert.equal(span, seconds);
    }
  }
});

test("cpu and memory use p99 with max across series, never ALIGN_MEAN", () => {
  const p99Types = new Set([METRIC_TYPES.RUN_CPU, METRIC_TYPES.RUN_MEMORY, METRIC_TYPES.GEN1_MEMORY]);
  for (const windowKey of ["1h", "6h"]) {
    const matching = buildRequests(windowKey, NOW).filter(({ request }) => p99Types.has(metricTypeOf(request.filter)));
    assert.equal(matching.length, 3);
    for (const { key, request } of matching) {
      assert.equal(request.aggregation.perSeriesAligner, "ALIGN_PERCENTILE_99", key);
      assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_MAX", key);
      assert.notEqual(request.aggregation.perSeriesAligner, "ALIGN_MEAN", key);
    }
  }
});

test("one scheduler query on the job functions' Cloud Run request_count", () => {
  const nowSeconds = NOW / 1000;
  for (const windowKey of ["1h", "6h"]) {
    const matching = buildRequests(windowKey, NOW).filter((r) => r.key === "scheduler.runs");
    assert.equal(matching.length, 1);
    const { request } = matching[0];
    for (const clause of [
      'metric.type = "run.googleapis.com/request_count"',
      'resource.type = "cloud_run_revision"',
      'resource.labels.service_name = one_of("pynightlyexport", "pyweeklyaccounts")',
      'resource.labels.location = "asia-south1"',
    ]) {
      assert.ok(request.filter.includes(clause), request.filter);
    }
    assert.equal(nowSeconds - request.interval.startTime.seconds, 691200);
    assert.equal(request.aggregation.alignmentPeriod.seconds, 300);
    assert.equal(request.aggregation.perSeriesAligner, "ALIGN_DELTA");
    assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_SUM");
    assert.ok(request.aggregation.groupByFields.includes("resource.labels.service_name"));
    assert.ok(request.aggregation.groupByFields.includes("metric.labels.response_code_class"));
  }
});

test("the function2 request_count filter is unchanged", () => {
  const { request } = buildRequests("1h", NOW).find((r) => r.key === "run.requests");
  assert.equal(
    request.filter,
    [
      'metric.type = "run.googleapis.com/request_count"',
      'resource.type = "cloud_run_revision"',
      "resource.labels.service_name = one_of(" +
        '"pynightlyexport", "pyreadstockistdocs", "pyyardstaffonwrite", "pymintoncrewclaim", ' +
        '"pydeleteaccountonrequest", "pystaffloginonrequest", "pyweeklyaccounts", ' +
        '"pypushonnotification", "pymintonrolerequest")',
      'resource.labels.location = "asia-south1"',
    ].join(" AND "),
  );
});
