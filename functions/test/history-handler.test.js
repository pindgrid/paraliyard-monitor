"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { METRIC_TYPES, SERVICES } = require("../src/constants");
const { CACHE_CONTROL, createHandler } = require("../src/handler");
const { HISTORY_METRICS, HISTORY_RANGES } = require("../src/history");
const { createFakeClient, defaultSeries, historySeries, metricTypeOf } = require("./fake-client");
const { NOW_MS: LIVE_NOW, ist, nightlySeries, weeklySeries } = require("./fixtures/scheduler-live-log");

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const silent = { warn() {}, error() {} };
const VALID = { service: "firestore:yard", metric: "readsPerMin", range: "24h" };

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: undefined,
    set(name, value) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

// /api/metrics requests get the default series, history requests one series.
function routed(request) {
  const series = defaultSeries(request);
  return series.length > 0 ? series : historySeries(request);
}

function setup({ respond = routed, delayMs = 0, log = silent } = {}) {
  const clock = { t: START };
  const fake = createFakeClient({ respond, delayMs });
  let clientCreations = 0;
  const handler = createHandler({
    getClient: () => {
      clientCreations += 1;
      return fake.client;
    },
    now: () => clock.t,
    log,
  });
  async function get(query, path = "/api/history", method = "GET") {
    const res = fakeRes();
    await handler({ method, path, query }, res);
    return res;
  }
  return { clock, fake, get, clientCreations: () => clientCreations };
}

// Every allowlisted (service, metric, range) query.
function allQueries() {
  const out = [];
  for (const service of SERVICES) {
    for (const metric of Object.keys(HISTORY_METRICS[service.kind])) {
      for (const range of Object.keys(HISTORY_RANGES)) out.push({ service: service.id, metric, range });
    }
  }
  return out;
}

test("invalid history requests get 400 no-store and make no calls", async () => {
  const { get, fake, clientCreations } = setup();
  const invalid = [
    { ...VALID, service: "firestore:other" },
    { ...VALID, service: "function2:unknown" },
    { service: "function2:pyMintOnCrewClaim", metric: "runs", range: "24h" },
    { service: "function1:pyCleanupOnAuthDelete", metric: "cpuPct", range: "24h" },
    { service: "function1:pyCleanupOnAuthDelete", metric: "memPct", range: "24h" },
    { ...VALID, range: "90d" },
    { service: VALID.service, metric: VALID.metric },
    { service: VALID.service, range: VALID.range },
    { metric: VALID.metric, range: VALID.range },
    {},
    undefined,
    { ...VALID, project: "another-project" },
    { ...VALID, filter: 'metric.type = "x"' },
    { ...VALID, range: ["24h", "7d"] },
    { ...VALID, service: ["firestore:yard"] },
  ];
  for (const query of invalid) {
    const res = await get(query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, { error: "bad request" });
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(clientCreations(), 0);
});

test("a valid miss makes exactly one listTimeSeries call for that service only", async () => {
  const { get, fake } = setup();
  const res = await get({ service: "function2:pyMintOnCrewClaim", metric: "cpuPct", range: "24h" });
  assert.equal(res.statusCode, 200);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.methods(), ["listTimeSeries"]);
  const [{ request, options }] = fake.calls;
  assert.equal(request.name, "projects/mineral-proton-438104-g8");
  assert.equal(metricTypeOf(request.filter), METRIC_TYPES.RUN_CPU);
  assert.ok(request.filter.includes('resource.labels.service_name = "pymintoncrewclaim"'));
  for (const other of SERVICES.filter((s) => s.kind === "function2" && s.id !== "function2:pyMintOnCrewClaim")) {
    assert.ok(!request.filter.includes(other.resourceLabel), other.id);
  }
  assert.equal(request.aggregation.perSeriesAligner, "ALIGN_PERCENTILE_99");
  assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_MAX");
  assert.equal(options.timeout, 10000);
  assert.equal(options.retry, null);
  assert.equal(options.autoPaginate, false);
});

test("GET firestore:yard readsPerMin 24h returns exactly the documented keys", async () => {
  const { get } = setup();
  const res = await get(VALID);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body), ["service", "metric", "range", "unit", "points", "generatedAt"]);
  assert.equal(res.body.service, "firestore:yard");
  assert.equal(res.body.metric, "readsPerMin");
  assert.equal(res.body.range, "24h");
  assert.equal(res.body.unit, "per minute");
  assert.equal(res.body.generatedAt, new Date(START).toISOString());
  assert.ok(res.body.points.length > 0 && res.body.points.length <= 400);
  for (const point of res.body.points) {
    assert.deepEqual(Object.keys(point), ["t", "v"]);
    assert.equal(typeof point.t, "string");
    assert.equal(typeof point.v, "number");
  }
  const times = res.body.points.map((p) => Date.parse(p.t));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  // Fake deltas 1..3 per 300 s bucket are 0.2..0.6 per minute.
  assert.ok(res.body.points.every((p) => p.v > 0 && p.v <= 0.6 + 1e-9));
});

test("fake-clock TTLs are 60/300/900 s and Cache-Control s-maxage equals the TTL", async () => {
  const cases = [
    ["1h", 60],
    ["6h", 60],
    ["24h", 300],
    ["7d", 900],
    ["30d", 900],
    ["6w", 900],
  ];
  for (const [range, ttl] of cases) {
    const { get, fake, clock } = setup();
    const query = { ...VALID, range };
    const first = await get(query);
    assert.equal(first.headers["cache-control"], `public, max-age=${ttl / 2}, s-maxage=${ttl}`, range);
    assert.equal(fake.calls.length, 1, range);
    clock.t = START + ttl * 1000 - 1;
    const cached = await get(query);
    assert.equal(fake.calls.length, 1, range);
    assert.deepEqual(cached.body, first.body, range);
    clock.t = START + ttl * 1000;
    await get(query);
    assert.equal(fake.calls.length, 2, range);
  }
});

test("N concurrent identical requests share one Monitoring call", async () => {
  const { get, fake } = setup({ delayMs: 5 });
  const responses = await Promise.all(Array.from({ length: 8 }, () => get(VALID)));
  assert.equal(fake.calls.length, 1);
  for (const res of responses) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, responses[0].body);
  }
});

test("more than 60 distinct misses at once: 60 calls, then 429 with Retry-After", async () => {
  const { get, fake } = setup();
  const queries = allQueries().slice(0, 75);
  const responses = [];
  for (const query of queries) responses.push(await get(query));
  assert.equal(fake.calls.length, 60);
  assert.ok(responses.slice(0, 60).every((r) => r.statusCode === 200));
  for (const res of responses.slice(60)) {
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "60");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(typeof res.body.error, "string");
  }
});

test("over the limit an expired entry is served stale and others get 429", async () => {
  const { get, fake, clock } = setup();
  const expiring = { ...VALID, range: "1h" };
  const rest = allQueries().filter((q) => JSON.stringify(q) !== JSON.stringify(expiring));
  assert.ok(rest.length > 61);
  const first = await get(expiring);
  assert.equal(first.statusCode, 200);
  assert.equal(fake.calls.length, 1);

  // 59 distinct misses 30 s later, one more at 60 s when the first slot frees.
  clock.t = START + 30000;
  for (const query of rest.slice(0, 59)) assert.equal((await get(query)).statusCode, 200);
  clock.t = START + 60000;
  assert.equal((await get(rest[59])).statusCode, 200);
  assert.equal(fake.calls.length, 61);

  // Within one minute (30 s .. 60 s) 60 calls happened: the limiter is full.
  const stale = await get(expiring);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body.stale, true);
  assert.deepEqual({ ...stale.body, stale: undefined }, { ...first.body, stale: undefined });
  const limited = await get(rest[60]);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "30");
  assert.equal(fake.calls.length, 61);

  // Once slots free up, misses are served again.
  clock.t = START + 90000;
  assert.equal((await get(rest[60])).statusCode, 200);
  assert.equal(fake.calls.length, 62);
});

test("NOT_FOUND returns 200 with empty points and logs one info line per key", async () => {
  const lines = { info: [], warn: [] };
  const { get, clock, fake } = setup({
    respond: () => {
      throw Object.assign(new Error('5 NOT_FOUND: Cannot find metric(s) that match type = "x"'), { code: 5 });
    },
    log: { info: (l) => lines.info.push(l), warn: (l) => lines.warn.push(l), error() {} },
  });
  const res = await get(VALID);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.points, []);
  assert.equal("stale" in res.body, false);
  clock.t = START + 300000;
  await get(VALID);
  assert.equal(fake.calls.length, 2);
  assert.equal(lines.info.length, 1);
  assert.ok(lines.info[0].includes("history/firestore:yard/readsPerMin/24h"), lines.info[0]);
  assert.deepEqual(lines.warn, []);
});

test("an empty result returns 200 with empty points", async () => {
  const { get } = setup({ respond: () => [] });
  const res = await get({ service: "function2:pyWeeklyAccounts", metric: "cpuPct", range: "1h" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.points, []);
  assert.equal(res.body.unit, "%");
});

test("another error with no cached answer is 502 no-store, logged with key and code, and remembered", async () => {
  const warnings = [];
  const { get, fake, clock } = setup({
    respond: () => {
      throw Object.assign(new Error("7 PERMISSION_DENIED: secret detail"), {
        code: 7,
        metadata: { authorization: "Bearer fake-token-do-not-log" },
      });
    },
    log: { warn: (l) => warnings.push(l), error() {} },
  });
  const res = await get(VALID);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.body, { error: "history unavailable" });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("key=history/firestore:yard/readsPerMin/24h"), warnings[0]);
  assert.ok(warnings[0].includes("code=7"), warnings[0]);
  assert.ok(!warnings[0].includes("fake-token"));
  // The failure holds until the TTL ends: no retry loop.
  clock.t = START + 299999;
  assert.equal((await get(VALID)).statusCode, 502);
  assert.equal(fake.calls.length, 1);
  clock.t = START + 300000;
  await get(VALID);
  assert.equal(fake.calls.length, 2);
});

test("another error after a good answer serves the cached answer marked stale", async () => {
  let failing = false;
  const warnings = [];
  const { get, clock } = setup({
    respond: (request) => {
      if (failing) throw Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
      return historySeries(request);
    },
    log: { warn: (l) => warnings.push(l), error() {} },
  });
  const good = await get(VALID);
  failing = true;
  clock.t = START + 300000;
  const stale = await get(VALID);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body.stale, true);
  assert.deepEqual(Object.keys(stale.body), ["service", "metric", "range", "unit", "points", "generatedAt", "stale"]);
  assert.deepEqual(stale.body.points, good.body.points);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("code=14"));
});

test("a throwing getClient is a failed history call", async () => {
  const handler = createHandler({
    getClient: () => {
      throw new Error("no credentials");
    },
    now: () => START,
    log: silent,
  });
  const res = fakeRes();
  await handler({ method: "GET", path: "/api/history", query: VALID }, res);
  assert.equal(res.statusCode, 502);
});

test("/api/metrics is unchanged: 13 calls and the same Cache-Control", async () => {
  const { get, fake } = setup();
  await get(VALID);
  assert.equal(fake.calls.length, 1);
  const metrics = await get({}, "/api/metrics");
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.headers["cache-control"], CACHE_CONTROL);
  assert.equal(CACHE_CONTROL, "public, max-age=30, s-maxage=60");
  assert.equal(fake.calls.length, 14);
  for (const s of metrics.body.services) assert.ok(s.trends && typeof s.trends === "object", s.id);
});

const AGGREGATE_QUERIES = [
  { service: "total:function2", metric: "reqPerMin", unit: "per minute" },
  { service: "total:function2", metric: "errPerMin", unit: "per minute" },
  { service: "total:function2", metric: "instances", unit: "instances" },
  { service: "total:bucket", metric: "bytesStored", unit: "bytes" },
  { service: "total:hosting", metric: "bytesServed", unit: "bytes per bucket" },
];

test("each aggregate makes exactly one summed listTimeSeries call", async () => {
  for (const { service, metric, unit } of AGGREGATE_QUERIES) {
    const { get, fake } = setup();
    const res = await get({ service, metric, range: "24h" });
    assert.equal(res.statusCode, 200, `${service} ${metric}`);
    assert.deepEqual(Object.keys(res.body), ["service", "metric", "range", "unit", "points", "generatedAt"]);
    assert.equal(res.body.service, service);
    assert.equal(res.body.unit, unit);
    assert.equal(fake.calls.length, 1, `${service} ${metric}`);
    assert.deepEqual(fake.methods(), ["listTimeSeries"]);
    const { request, options } = fake.calls[0];
    assert.equal(request.aggregation.crossSeriesReducer, "REDUCE_SUM");
    assert.deepEqual(request.aggregation.groupByFields, []);
    assert.ok(/one_of\(/.test(request.filter), request.filter);
    assert.equal(options.retry, null);
    assert.equal(options.autoPaginate, false);
  }
});

test("unknown aggregates, other metrics and extra keys get 400 with zero calls", async () => {
  const { get, fake, clientCreations } = setup();
  for (const query of [
    { service: "total:function2", metric: "cpuPct", range: "24h" },
    { service: "total:function2", metric: "memPct", range: "24h" },
    { service: "total:firestore", metric: "readsPerMin", range: "24h" },
    { service: "total:everything", metric: "reqPerMin", range: "24h" },
    { service: "total:bucket", metric: "reqPerMin", range: "24h" },
    { service: "total:function2", metric: "reqPerMin", range: "24h", extra: "1" },
    { service: "total:function2", metric: "reqPerMin", range: "90d" },
    { service: "function2:pyMintOnCrewClaim", metric: "durationSec", range: "24h" },
    { service: "hosting:paraliyard", metric: "durationSec", range: "24h" },
    { service: "total:function2", metric: "durationSec", range: "24h" },
  ]) {
    const res = await get(query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(res.body, { error: "bad request" });
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(clientCreations(), 0);
});

test("aggregate keys use the same TTL cache and single flight", async () => {
  const { get, fake, clock } = setup({ delayMs: 5 });
  const query = { service: "total:function2", metric: "reqPerMin", range: "1h" };
  const responses = await Promise.all(Array.from({ length: 6 }, () => get(query)));
  assert.equal(fake.calls.length, 1);
  for (const res of responses) assert.deepEqual(res.body, responses[0].body);
  clock.t = START + 59999;
  await get(query);
  assert.equal(fake.calls.length, 1);
  clock.t = START + 60000;
  await get(query);
  assert.equal(fake.calls.length, 2);
  // The aggregate and a single service are cached separately.
  await get({ service: "function2:pyMintOnCrewClaim", metric: "reqPerMin", range: "1h" });
  assert.equal(fake.calls.length, 3);
});

test("the 60/min limit covers aggregate and durationSec keys", async () => {
  const { get, fake } = setup();
  const misses = allQueries().filter((q) => q.metric !== "durationSec").slice(0, 60);
  for (const query of misses) assert.equal((await get(query)).statusCode, 200);
  assert.equal(fake.calls.length, 60);
  for (const query of [
    { service: "total:function2", metric: "reqPerMin", range: "24h" },
    { service: "total:hosting", metric: "bytesServed", range: "7d" },
    { service: "scheduler:pyNightlyExport", metric: "durationSec", range: "30d" },
  ]) {
    const res = await get(query);
    assert.equal(res.statusCode, 429, JSON.stringify(query));
    assert.equal(res.headers["retry-after"], "60");
  }
  assert.equal(fake.calls.length, 60);
});

test("durationSec answers in seconds and runs points are scheduled occurrences", async () => {
  const respond = (request) => {
    const end = Number(request.interval.endTime.seconds) * 1000;
    const pt = (t, v) => ({ interval: { endTime: { seconds: String(t / 1000), nanos: 0 } }, value: { int64Value: String(v) } });
    const resource = { labels: { service_name: "pynightlyexport" } };
    if (metricTypeOf(request.filter) === METRIC_TYPES.RUN_LATENCIES) {
      return [{ resource, metric: { labels: {} }, points: [{ interval: { endTime: { seconds: String(end / 1000), nanos: 0 } }, value: { doubleValue: 1500 } }] }];
    }
    return [
      { resource, metric: { labels: { response_code_class: "2xx" } }, points: [pt(end, 1), pt(end - 86400000, 1)] },
      { resource, metric: { labels: { response_code_class: "5xx" } }, points: [pt(end - 86400000, 1)] },
    ];
  };
  const { get, fake } = setup({ respond });
  const duration = await get({ service: "scheduler:pyNightlyExport", metric: "durationSec", range: "7d" });
  assert.equal(duration.statusCode, 200);
  assert.equal(duration.body.unit, "seconds");
  assert.deepEqual(duration.body.points, [{ t: new Date(START).toISOString(), v: 1.5 }]);
  const runs = await get({ service: "scheduler:pyNightlyExport", metric: "runs", range: "7d" });
  // START is 17:30 IST: the buckets lie outside every 02:30 IST run window,
  // so the 7 daily occurrences are missed and the requests are other calls.
  assert.equal(runs.body.unit, "runs");
  assert.equal(runs.body.points.length, 7);
  for (const point of runs.body.points) {
    assert.equal(new Date(point.t).getUTCHours(), 21);
    assert.deepEqual({ ...point, t: undefined }, { t: undefined, v: 0, result: "missed", requests: 0, failed: 0 });
  }
  assert.deepEqual(runs.body.otherCalls, { count: 3, failed: 1 });
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].request.aggregation.groupByFields, [
    "resource.labels.service_name",
    "metric.labels.response_code_class",
  ]);
});

// The live-log series of the job whose service label is in the filter.
function liveLog(request) {
  if (request.filter.includes('"pynightlyexport"')) return nightlySeries();
  if (request.filter.includes('"pyweeklyaccounts"')) return weeklySeries();
  return [];
}

function liveSetup(options = {}) {
  const ctx = setup({ respond: liveLog, ...options });
  ctx.clock.t = LIVE_NOW;
  return ctx;
}

test("live log, nightly 30d: one point per 02:30 IST occurrence and the 18:20 calls as otherCalls", async () => {
  const { get, fake } = liveSetup();
  const res = await get({ service: "scheduler:pyNightlyExport", metric: "runs", range: "30d" });
  assert.equal(res.statusCode, 200);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].request.aggregation.alignmentPeriod.seconds, 300);
  const { points, otherCalls } = res.body;
  assert.equal(points.length, 30);
  for (const p of points) {
    assert.equal(new Date(p.t).getUTCHours(), 21, p.t);
    assert.equal(new Date(p.t).getUTCMinutes(), 0, p.t);
  }
  const at = (ms) => points.find((p) => p.t === new Date(ms).toISOString());
  assert.deepEqual(at(ist(9, 19, 2, 30)), { t: new Date(ist(9, 19, 2, 30)).toISOString(), v: 0, result: "missed", requests: 0, failed: 0 });
  assert.deepEqual(at(ist(10, 5, 2, 30)), { t: new Date(ist(10, 5, 2, 30)).toISOString(), v: 1, result: "success", requests: 1, failed: 0 });
  // No point sits at the 18:20 calls.
  assert.ok(points.every((p) => !p.t.startsWith("2026-09-19T12:")));
  assert.deepEqual(otherCalls, { count: 4, failed: 4 });
});

test("live log, weekly 30d: only Sunday 03:00 IST occurrences, Thursday calls only in otherCalls", async () => {
  const { get } = liveSetup();
  const res = await get({ service: "scheduler:pyWeeklyAccounts", metric: "runs", range: "30d" });
  assert.equal(res.statusCode, 200);
  const { points, otherCalls } = res.body;
  assert.deepEqual(
    points.map((p) => p.t),
    [ist(9, 6, 3, 0), ist(9, 13, 3, 0), ist(9, 20, 3, 0), ist(9, 27, 3, 0), ist(10, 4, 3, 0)].map((ms) => new Date(ms).toISOString()),
  );
  for (const p of points) assert.equal(new Date(Date.parse(p.t) + 330 * 60000).getUTCDay(), 0, p.t);
  assert.deepEqual(points[points.length - 1], { t: new Date(ist(10, 4, 3, 0)).toISOString(), v: 1, result: "success", requests: 1, failed: 0 });
  assert.ok(points.slice(0, -1).every((p) => p.result === "missed"));
  assert.deepEqual(otherCalls, { count: 3, failed: 3 });
});

test("runs: an open window is upcoming and a closed empty one is missed", async () => {
  const { get, clock } = liveSetup();
  clock.t = ist(10, 6, 2, 45);
  const res = await get({ service: "scheduler:pyNightlyExport", metric: "runs", range: "7d" });
  const { points } = res.body;
  assert.deepEqual(points[points.length - 1], { t: new Date(ist(10, 6, 2, 30)).toISOString(), v: 0, result: "upcoming", requests: 0, failed: 0 });
  assert.equal(points[points.length - 2].result, "success");
  assert.equal(points[points.length - 3].result, "missed");
});

test("scheduler history uses 300 s alignment at 7d, 30d and 6w with one call per miss", async () => {
  for (const id of ["scheduler:pyNightlyExport", "scheduler:pyWeeklyAccounts"]) {
    for (const metric of ["runs", "durationSec"]) {
      for (const range of ["7d", "30d", "6w"]) {
        const { get, fake } = liveSetup();
        const res = await get({ service: id, metric, range });
        assert.equal(res.statusCode, 200, `${id} ${metric} ${range}`);
        assert.equal(fake.calls.length, 1, `${id} ${metric} ${range}`);
        assert.equal(fake.calls[0].request.aggregation.alignmentPeriod.seconds, 300, `${id} ${metric} ${range}`);
        assert.equal(fake.calls[0].options.autoPaginate, false);
        await get({ service: id, metric, range });
        assert.equal(fake.calls.length, 1, `${id} ${metric} ${range} cached`);
      }
    }
  }
});

test("a nextPageToken logs one warn line with the key and makes no second call", async () => {
  const warnings = [];
  const calls = [];
  const client = {
    listTimeSeries(request, options) {
      calls.push({ request, options });
      return Promise.resolve([nightlySeries(), null, { nextPageToken: "next-page" }]);
    },
  };
  const handler = createHandler({ getClient: () => client, now: () => LIVE_NOW, log: { warn: (l) => warnings.push(l), error() {} } });
  const res = fakeRes();
  await handler({ method: "GET", path: "/api/history", query: { service: "scheduler:pyNightlyExport", metric: "runs", range: "6w" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.pageToken, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("key=history/scheduler:pyNightlyExport/runs/6w"), warnings[0]);
  assert.ok(!warnings[0].includes("next-page"), warnings[0]);
  assert.equal(res.body.points.find((p) => p.result === "success").t, new Date(ist(10, 5, 2, 30)).toISOString());
});

test("runs NOT_FOUND or empty still lists the occurrences with zero otherCalls", async () => {
  const notFound = () => {
    throw Object.assign(new Error("5 NOT_FOUND"), { code: 5 });
  };
  for (const respond of [notFound, () => []]) {
    const { get } = liveSetup({ respond });
    const res = await get({ service: "scheduler:pyWeeklyAccounts", metric: "runs", range: "30d" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.points.length, 5);
    assert.ok(res.body.points.every((p) => p.result === "missed" && p.requests === 0));
    assert.deepEqual(res.body.otherCalls, { count: 0, failed: 0 });
  }
});

test("non-GET /api/history gets 405 and no calls", async () => {
  const { get, fake } = setup();
  const res = await get(VALID, "/api/history", "POST");
  assert.equal(res.statusCode, 405);
  assert.equal(fake.calls.length, 0);
});
