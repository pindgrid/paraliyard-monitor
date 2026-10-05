"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { METRIC_TYPES, RESOURCES, SERVICES } = require("../src/constants");
const {
  HISTORY_RANGES,
  HISTORY_METRICS,
  AGGREGATES,
  validateHistoryQuery,
  buildHistoryRequest,
  toHistoryPoints,
} = require("../src/history");
const { buildRequests } = require("../src/queries");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ALLOWED_TYPES = new Set(Object.values(METRIC_TYPES));

function byId(id) {
  return SERVICES.find((s) => s.id === id);
}

// Every allowlisted (service, metric) pair.
function allPairs() {
  const out = [];
  for (const service of SERVICES) {
    for (const metric of Object.keys(HISTORY_METRICS[service.kind])) out.push({ service, metric });
  }
  return out;
}

test("alignment per range, with at most 400 points each", () => {
  const expected = { "1h": 60, "6h": 60, "24h": 300, "7d": 3600, "30d": 10800, "6w": 14400 };
  assert.deepEqual(Object.keys(HISTORY_RANGES), Object.keys(expected));
  for (const [range, alignment] of Object.entries(expected)) {
    const { seconds, alignmentSeconds } = HISTORY_RANGES[range];
    assert.equal(alignmentSeconds, alignment, range);
    assert.ok(seconds / alignmentSeconds <= 400, range);
    const request = buildHistoryRequest(byId("firestore:yard"), "readsPerMin", range, NOW);
    assert.equal(request.aggregation.alignmentPeriod.seconds, alignment, range);
    assert.equal(request.interval.endTime.seconds, NOW / 1000, range);
    assert.equal(NOW / 1000 - request.interval.startTime.seconds, seconds, range);
  }
  assert.equal(HISTORY_RANGES["1h"].seconds, 3600);
  assert.equal(HISTORY_RANGES["6w"].seconds, 3628800);
});

test("TTLs: 60 s for 1h/6h, 300 s for 24h, 900 s for 7d/30d/6w", () => {
  const ttl = Object.fromEntries(Object.entries(HISTORY_RANGES).map(([k, v]) => [k, v.ttlMs]));
  assert.deepEqual(ttl, { "1h": 60000, "6h": 60000, "24h": 300000, "7d": 900000, "30d": 900000, "6w": 900000 });
});

test("CPU, RAM and gen1 memory use p99 with max, never ALIGN_MEAN", () => {
  const cases = [
    ["function2:pyMintOnCrewClaim", "cpuPct"],
    ["function2:pyMintOnCrewClaim", "memPct"],
    ["function1:pyCleanupOnAuthDelete", "memBytes"],
  ];
  for (const [id, metric] of cases) {
    for (const range of Object.keys(HISTORY_RANGES)) {
      const { aggregation } = buildHistoryRequest(byId(id), metric, range, NOW);
      assert.equal(aggregation.perSeriesAligner, "ALIGN_PERCENTILE_99", `${id} ${metric} ${range}`);
      assert.equal(aggregation.crossSeriesReducer, "REDUCE_MAX", `${id} ${metric} ${range}`);
      assert.notEqual(aggregation.perSeriesAligner, "ALIGN_MEAN");
    }
  }
});

test("every allowed pair: fixed type, only that service's label, the project name", () => {
  const pairs = allPairs();
  // Scheduler jobs: runs and durationSec.
  assert.equal(pairs.length, 9 * 5 + 2 + 3 + 2 * 2 + 2 + 2 * 2);
  for (const { service, metric } of pairs) {
    for (const range of Object.keys(HISTORY_RANGES)) {
      const request = buildHistoryRequest(service, metric, range, NOW);
      const where = `${service.id} ${metric} ${range}`;
      assert.equal(request.name, "projects/mineral-proton-438104-g8", where);
      assert.equal(request.view, "FULL");
      assert.equal(request.pageSize, 1000);
      const type = /^metric\.type = "([^"]+)"/.exec(request.filter)[1];
      assert.ok(ALLOWED_TYPES.has(type), where);
      assert.equal(request.filter.match(/metric\.type/g).length, 1, where);
      const { type: resourceType, label } = RESOURCES[service.kind];
      assert.ok(request.filter.includes(`resource.type = "${resourceType}"`), where);
      assert.ok(request.filter.includes(`resource.labels.${label} = "${service.resourceLabel}"`), where);
      assert.ok(!request.filter.includes("one_of(\"py"), where);
      for (const other of SERVICES.filter((s) => s.kind === service.kind && s.id !== service.id)) {
        assert.ok(!request.filter.includes(`"${other.resourceLabel}"`), `${where} mentions ${other.id}`);
      }
      // runs is also split by response class to report failed runs.
      const split = metric === "runs" ? ["metric.labels.response_code_class"] : [];
      assert.deepEqual(request.aggregation.groupByFields, [`resource.labels.${label}`, ...split], where);
    }
  }
});

test("errPerMin adds the fixed 4xx/5xx class clause and keeps a single series", () => {
  const request = buildHistoryRequest(byId("function2:pyMintOnCrewClaim"), "errPerMin", "24h", NOW);
  assert.equal(
    request.filter,
    [
      'metric.type = "run.googleapis.com/request_count"',
      'resource.type = "cloud_run_revision"',
      'resource.labels.service_name = "pymintoncrewclaim"',
      'resource.labels.location = "asia-south1"',
      'metric.labels.response_code_class = one_of("4xx", "5xx")',
    ].join(" AND "),
  );
  assert.deepEqual(request.aggregation.groupByFields, ["resource.labels.service_name"]);
  const req = buildHistoryRequest(byId("function2:pyMintOnCrewClaim"), "reqPerMin", "24h", NOW);
  assert.ok(!req.filter.includes("response_code_class"));
});

test("scheduler runs read the job function's Cloud Run request_count", () => {
  const request = buildHistoryRequest(byId("scheduler:pyNightlyExport"), "runs", "7d", NOW);
  assert.ok(request.filter.includes('resource.labels.service_name = "pynightlyexport"'));
  assert.ok(request.filter.includes('resource.labels.location = "asia-south1"'));
  assert.equal(request.aggregation.perSeriesAligner, "ALIGN_DELTA");
});

test("validateHistoryQuery accepts allowlisted queries", () => {
  const valid = validateHistoryQuery({ service: "firestore:yard", metric: "readsPerMin", range: "24h" });
  assert.equal(valid.service, byId("firestore:yard"));
  assert.equal(valid.metric, "readsPerMin");
  assert.equal(valid.range, "24h");
  assert.ok(validateHistoryQuery({ range: "6w", metric: "runs", service: "scheduler:pyWeeklyAccounts" }));
});

test("validateHistoryQuery rejects every invalid input", () => {
  const ok = { service: "firestore:yard", metric: "readsPerMin", range: "24h" };
  const invalid = [
    null,
    undefined,
    "service=firestore:yard",
    [],
    {},
    { ...ok, service: "firestore:other" },
    { ...ok, service: "__proto__" },
    { ...ok, service: "function2:pymintoncrewclaim" },
    { service: "function2:pyMintOnCrewClaim", metric: "runs", range: "24h" },
    { service: "function1:pyCleanupOnAuthDelete", metric: "cpuPct", range: "24h" },
    { service: "function1:pyCleanupOnAuthDelete", metric: "memPct", range: "24h" },
    { service: "hosting:paraliyard", metric: "reqPerMin", range: "24h" },
    { ...ok, metric: "constructor" },
    { ...ok, metric: "toString" },
    { ...ok, range: "2h" },
    { ...ok, range: "hasOwnProperty" },
    { ...ok, range: "24h OR x" },
    { service: ok.service, metric: ok.metric },
    { service: ok.service, range: ok.range },
    { metric: ok.metric, range: ok.range },
    { ...ok, project: "other-project" },
    { ...ok, filter: 'metric.type = "x"' },
    { ...ok, window: "1h" },
    { ...ok, range: ["24h"] },
    { ...ok, service: ["firestore:yard"] },
    { ...ok, metric: { x: 1 } },
    { ...ok, range: 24 },
  ];
  for (const query of invalid) assert.equal(validateHistoryQuery(query), null, JSON.stringify(query));
});

function series(values, stepMs, labels = {}) {
  return [
    {
      resource: { labels },
      metric: { labels: {} },
      points: values.map((v, i) => ({
        interval: { endTime: { seconds: String((NOW - i * stepMs) / 1000), nanos: 0 } },
        value: Number.isInteger(v) ? { int64Value: String(v) } : { doubleValue: v },
      })),
    },
  ];
}

test("toHistoryPoints scales per minute and x100 and sorts by time", () => {
  // 24h alignment is 300 s: a delta of 50 per bucket is 10 per minute.
  assert.deepEqual(toHistoryPoints(series([50, 25], 300000), "readsPerMin", "24h"), [
    { t: new Date(NOW - 300000).toISOString(), v: 5 },
    { t: new Date(NOW).toISOString(), v: 10 },
  ]);
  // 1h alignment is 60 s: deltas are already per minute.
  assert.deepEqual(toHistoryPoints(series([7], 60000), "reqPerMin", "1h"), [{ t: new Date(NOW).toISOString(), v: 7 }]);
  // 7d alignment is 3600 s.
  assert.deepEqual(toHistoryPoints(series([120], 3600000), "errPerMin", "7d").map((p) => p.v), [2]);
  assert.deepEqual(toHistoryPoints(series([0.25, 0.5], 60000), "cpuPct", "6h").map((p) => p.v), [50, 25]);
  assert.deepEqual(toHistoryPoints(series([0.4], 60000), "memPct", "1h").map((p) => p.v), [40]);
  assert.deepEqual(toHistoryPoints(series([3], 60000), "instances", "1h").map((p) => p.v), [3]);
  assert.deepEqual(toHistoryPoints(series([1024], 60000), "memBytes", "24h").map((p) => p.v), [1024]);
  assert.deepEqual(toHistoryPoints(series([4096], 3600000), "bytesStored", "7d").map((p) => p.v), [4096]);
  // Per-bucket totals stay as returned.
  assert.deepEqual(toHistoryPoints(series([2048], 300000), "bytesServed", "24h").map((p) => p.v), [2048]);
  assert.deepEqual(toHistoryPoints(series([2], 14400000), "runs", "6w").map((p) => p.v), [2]);
  assert.deepEqual(toHistoryPoints([], "runs", "6w"), []);
});

test("units", () => {
  assert.equal(HISTORY_METRICS.function2.cpuPct.unit, "%");
  assert.equal(HISTORY_METRICS.firestore.readsPerMin.unit, "per minute");
  assert.equal(HISTORY_METRICS.hosting.bytesServed.unit, "bytes per bucket");
  // One point per scheduled occurrence, no longer per bucket.
  assert.equal(HISTORY_METRICS.scheduler.runs.unit, "runs");
  assert.equal(HISTORY_METRICS.bucket.bytesStored.unit, "bytes");
  assert.ok(!("cpuPct" in HISTORY_METRICS.function1));
  assert.ok(!("memPct" in HISTORY_METRICS.function1));
  for (const [kind, metrics] of Object.entries(HISTORY_METRICS)) {
    if (kind !== "scheduler") assert.ok(!("runs" in metrics), kind);
  }
});

const AGGREGATE_SERVICES = {
  "total:function2": [
    "pynightlyexport",
    "pyreadstockistdocs",
    "pyyardstaffonwrite",
    "pymintoncrewclaim",
    "pydeleteaccountonrequest",
    "pystaffloginonrequest",
    "pyweeklyaccounts",
    "pypushonnotification",
    "pymintonrolerequest",
  ],
  "total:bucket": ["mineral-proton-438104-g8-paraliyard", "mineral-proton-438104-g8-yard-backups"],
  "total:hosting": ["paraliyard.web.app", "preparaliyard.web.app"],
};

test("aggregates: REDUCE_SUM, no groupBy, one_of over exactly the kind's services", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(AGGREGATES).map(([id, a]) => [id, [a.kind, ...a.metrics]])),
    {
      "total:function2": ["function2", "reqPerMin", "errPerMin", "instances"],
      "total:bucket": ["bucket", "bytesStored"],
      "total:hosting": ["hosting", "bytesServed"],
    },
  );
  for (const [id, { kind, metrics }] of Object.entries(AGGREGATES)) {
    for (const metric of metrics) {
      for (const range of Object.keys(HISTORY_RANGES)) {
        const query = validateHistoryQuery({ service: id, metric, range });
        assert.ok(query, `${id} ${metric} ${range}`);
        const request = buildHistoryRequest(query.service, metric, range, NOW);
        const where = `${id} ${metric} ${range}`;
        assert.equal(request.name, "projects/mineral-proton-438104-g8", where);
        assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_SUM", where);
        assert.deepEqual(request.aggregation.groupByFields, [], where);
        assert.equal(request.aggregation.alignmentPeriod.seconds, HISTORY_RANGES[range].alignmentSeconds, where);
        const type = /^metric\.type = "([^"]+)"/.exec(request.filter)[1];
        assert.ok(ALLOWED_TYPES.has(type), where);
        const { type: resourceType, label } = RESOURCES[kind];
        assert.ok(request.filter.includes(`resource.type = "${resourceType}"`), where);
        const labels = AGGREGATE_SERVICES[id].map((v) => `"${v}"`).join(", ");
        assert.ok(request.filter.includes(`resource.labels.${label} = one_of(${labels})`), where);
        assert.equal(request.filter.match(/one_of\(/g).length, metric === "errPerMin" ? 2 : 1, where);
      }
    }
  }
});

test("total:function2 errPerMin keeps the 4xx/5xx clause and the aligners of its metric", () => {
  const err = buildHistoryRequest(validateHistoryQuery({ service: "total:function2", metric: "errPerMin", range: "24h" }).service, "errPerMin", "24h", NOW);
  assert.ok(err.filter.endsWith(' AND metric.labels.response_code_class = one_of("4xx", "5xx")'), err.filter);
  assert.ok(err.filter.includes('resource.labels.location = "asia-south1"'));
  assert.equal(err.aggregation.perSeriesAligner, "ALIGN_DELTA");
  const req = buildHistoryRequest(validateHistoryQuery({ service: "total:function2", metric: "reqPerMin", range: "24h" }).service, "reqPerMin", "24h", NOW);
  assert.ok(!req.filter.includes("response_code_class"));
  const inst = buildHistoryRequest(validateHistoryQuery({ service: "total:function2", metric: "instances", range: "1h" }).service, "instances", "1h", NOW);
  assert.equal(inst.aggregation.perSeriesAligner, "ALIGN_MAX");
  assert.equal(metricTypeOf(inst.filter), METRIC_TYPES.RUN_INSTANCES);
  const bytes = buildHistoryRequest(validateHistoryQuery({ service: "total:bucket", metric: "bytesStored", range: "7d" }).service, "bytesStored", "7d", NOW);
  assert.equal(metricTypeOf(bytes.filter), METRIC_TYPES.BUCKET_BYTES);
  const served = buildHistoryRequest(validateHistoryQuery({ service: "total:hosting", metric: "bytesServed", range: "6h" }).service, "bytesServed", "6h", NOW);
  assert.equal(metricTypeOf(served.filter), METRIC_TYPES.HOSTING_SENT_BYTES);
});

function metricTypeOf(filter) {
  return /^metric\.type = "([^"]+)"/.exec(filter)[1];
}

test("aggregate queries outside the allowlist are rejected", () => {
  const invalid = [
    { service: "total:function2", metric: "cpuPct", range: "24h" },
    { service: "total:function2", metric: "memPct", range: "24h" },
    { service: "total:bucket", metric: "reqPerMin", range: "24h" },
    { service: "total:hosting", metric: "bytesStored", range: "24h" },
    { service: "total:firestore", metric: "readsPerMin", range: "24h" },
    { service: "total:function1", metric: "execPerMin", range: "24h" },
    { service: "total:scheduler", metric: "runs", range: "24h" },
    { service: "total:", metric: "reqPerMin", range: "24h" },
    { service: "total:function2", metric: "reqPerMin", range: "2d" },
    { service: "total:function2", metric: "reqPerMin", range: "24h", extra: "x" },
    { service: "total:function2", metric: "durationSec", range: "24h" },
    { service: "function2:pyMintOnCrewClaim", metric: "durationSec", range: "24h" },
    { service: "firestore:yard", metric: "durationSec", range: "24h" },
    { service: "function1:pyCleanupOnAuthDelete", metric: "durationSec", range: "24h" },
    { service: "hasOwnProperty", metric: "reqPerMin", range: "24h" },
  ];
  for (const query of invalid) assert.equal(validateHistoryQuery(query), null, JSON.stringify(query));
});

test("scheduler durationSec reads request_latencies p99 per job function", () => {
  for (const id of ["scheduler:pyNightlyExport", "scheduler:pyWeeklyAccounts"]) {
    const query = validateHistoryQuery({ service: id, metric: "durationSec", range: "30d" });
    assert.ok(query, id);
    const request = buildHistoryRequest(query.service, "durationSec", "30d", NOW);
    assert.equal(metricTypeOf(request.filter), "run.googleapis.com/request_latencies");
    assert.equal(METRIC_TYPES.RUN_LATENCIES, "run.googleapis.com/request_latencies");
    assert.ok(request.filter.includes(`resource.labels.service_name = "${byId(id).resourceLabel}"`));
    assert.ok(request.filter.includes('resource.type = "cloud_run_revision"'));
    assert.equal(request.aggregation.perSeriesAligner, "ALIGN_PERCENTILE_99");
    assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_MAX");
    assert.deepEqual(request.aggregation.groupByFields, ["resource.labels.service_name"]);
  }
  assert.equal(HISTORY_METRICS.scheduler.durationSec.unit, "seconds");
  // 1500 ms is 1.5 s.
  assert.deepEqual(toHistoryPoints(series([1500, 500], 3600000), "durationSec", "7d"), [
    { t: new Date(NOW - 3600000).toISOString(), v: 0.5 },
    { t: new Date(NOW).toISOString(), v: 1.5 },
  ]);
});

test("scheduler runs and durationSec use 300 s alignment at every range", () => {
  for (const id of ["scheduler:pyNightlyExport", "scheduler:pyWeeklyAccounts"]) {
    for (const metric of ["runs", "durationSec"]) {
      for (const range of ["7d", "30d", "6w", ...Object.keys(HISTORY_RANGES)]) {
        const request = buildHistoryRequest(byId(id), metric, range, NOW);
        assert.equal(request.aggregation.alignmentPeriod.seconds, 300, `${id} ${metric} ${range}`);
        // The interval still follows the range.
        assert.equal(NOW / 1000 - request.interval.startTime.seconds, HISTORY_RANGES[range].seconds);
        assert.equal(request.pageSize, 1000);
      }
    }
  }
  // Other kinds keep the range alignment.
  for (const range of Object.keys(HISTORY_RANGES)) {
    const request = buildHistoryRequest(byId("function2:pyNightlyExport"), "reqPerMin", range, NOW);
    assert.equal(request.aggregation.alignmentPeriod.seconds, HISTORY_RANGES[range].alignmentSeconds, range);
  }
});

test("/api/metrics never queries request_latencies and keeps 13 keys", () => {
  for (const windowKey of ["1h", "6h"]) {
    const requests = buildRequests(windowKey, NOW);
    assert.equal(requests.length, 13);
    for (const { request } of requests) assert.ok(!request.filter.includes("request_latencies"), request.filter);
  }
});

function classSeries(values, stepMs, cls) {
  const [s] = series(values, stepMs, { service_name: "pynightlyexport" });
  return { ...s, metric: { labels: { response_code_class: cls } } };
}

test("runs points carry failed (non-2xx) next to the unchanged total", () => {
  const step = 3600000;
  const list = [classSeries([1, 0, 1], step, "2xx"), classSeries([0, 0, 2], step, "5xx"), classSeries([1], step, "4xx")];
  const points = toHistoryPoints(list, "runs", "7d");
  assert.deepEqual(points, [
    { t: new Date(NOW - 2 * step).toISOString(), v: 3, failed: 2 },
    { t: new Date(NOW - step).toISOString(), v: 0, failed: 0 },
    { t: new Date(NOW).toISOString(), v: 2, failed: 1 },
  ]);
  // v equals the iteration-4 total: every class summed per bucket.
  const { trendOf } = require("../src/aggregate");
  assert.deepEqual(points.map((p) => ({ t: p.t, v: p.v })), trendOf([list]));
  // Only runs carries failed.
  for (const p of toHistoryPoints(series([3], 300000), "readsPerMin", "24h")) assert.deepEqual(Object.keys(p), ["t", "v"]);
});
