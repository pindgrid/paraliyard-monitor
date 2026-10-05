"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { METRIC_TYPES, SERVICES } = require("../src/constants");
const { CACHE_CONTROL, createHandler } = require("../src/handler");
const { HISTORY_METRICS, HISTORY_RANGES } = require("../src/history");
const { createFakeClient, defaultSeries, historySeries, metricTypeOf } = require("./fake-client");

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

test("non-GET /api/history gets 405 and no calls", async () => {
  const { get, fake } = setup();
  const res = await get(VALID, "/api/history", "POST");
  assert.equal(res.statusCode, 405);
  assert.equal(fake.calls.length, 0);
});
