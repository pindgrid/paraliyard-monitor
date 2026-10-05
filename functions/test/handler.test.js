"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { METRIC_TYPES } = require("../src/constants");
const { createHandler } = require("../src/handler");
const { createFakeClient, defaultSeries, metricTypeOf } = require("./fake-client");

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const CACHE_CONTROL = "public, max-age=30, s-maxage=60";
const silent = { warn() {}, error() {} };

function fakeReq({ method = "GET", path = "/api/metrics", query = {} } = {}) {
  return { method, path, query };
}

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

function setup(options = {}) {
  const clock = { t: START };
  const fake = createFakeClient(options);
  let clientCreations = 0;
  const handler = createHandler({
    getClient: () => {
      clientCreations += 1;
      return fake.client;
    },
    now: () => clock.t,
    log: silent,
  });
  async function get(reqOptions) {
    const res = fakeRes();
    await handler(fakeReq(reqOptions), res);
    return res;
  }
  return { clock, fake, handler, get, clientCreations: () => clientCreations };
}

test("non-GET methods get 405 with Allow and Cache-Control", async () => {
  const { get, fake } = setup();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await get({ method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET");
    assert.equal(res.headers["cache-control"], CACHE_CONTROL);
    assert.equal(typeof res.body.error, "string");
  }
  assert.equal(fake.calls.length, 0);
});

test("other paths get 404 with Cache-Control", async () => {
  const { get, fake } = setup();
  for (const path of ["/", "/api/metrics/x", "/api", "/api/metrics/"]) {
    const res = await get({ path });
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers["cache-control"], CACHE_CONTROL);
    assert.equal(typeof res.body.error, "string");
  }
  assert.equal(fake.calls.length, 0);
});

test("GET /api/metrics returns 200 JSON with Cache-Control", async () => {
  const { get } = setup();
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], CACHE_CONTROL);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.window, "1h");
  assert.equal(res.body.services.length, 17);
});

test("unknown query parameters and windows do not change the queries", async () => {
  const plain = setup();
  await plain.get();
  const odd = setup();
  const res = await odd.get({ query: { window: "7d", foo: "bar", project: "other" } });
  assert.equal(res.body.window, "1h");
  assert.deepEqual(odd.fake.calls.map((c) => c.request), plain.fake.calls.map((c) => c.request));
});

test("read-only: only listTimeSeries against the project with allowlisted types", async () => {
  const { get, fake } = setup();
  await get();
  await get({ query: { window: "6h" } });
  const allowed = new Set(Object.values(METRIC_TYPES));
  assert.deepEqual(fake.methods(), ["listTimeSeries"]);
  assert.equal(fake.calls.length, 26);
  for (const call of fake.calls) {
    assert.equal(call.request.name, "projects/mineral-proton-438104-g8");
    assert.ok(allowed.has(metricTypeOf(call.request.filter)));
    assert.ok(call.options.timeout <= 10000);
    assert.equal(call.options.retry, null);
  }
});

test("cache: GETs 10 s apart share one batch, 61 s later makes one more", async () => {
  const { get, fake, clock, clientCreations } = setup();
  await get();
  assert.equal(fake.calls.length, 13);
  clock.t = START + 10000;
  await get();
  assert.equal(fake.calls.length, 13);
  clock.t = START + 61000;
  await get();
  assert.equal(fake.calls.length, 26);
  clock.t = START + 70000;
  await get();
  assert.equal(fake.calls.length, 26);
  assert.equal(clientCreations(), 2);
});

test("cache: concurrent GETs share one in-flight refresh", async () => {
  const { get, fake } = setup({ delayMs: 5 });
  const responses = await Promise.all([get(), get(), get(), get(), get()]);
  assert.equal(fake.calls.length, 13);
  for (const res of responses) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, responses[0].body);
  }
});

test("windows are cached separately", async () => {
  const { get, fake } = setup();
  await get({ query: { window: "1h" } });
  await get({ query: { window: "6h" } });
  await get({ query: { window: "6h" } });
  assert.equal(fake.calls.length, 26);
});

test("failure after a good result serves stale data", async () => {
  let failing = false;
  const { get, fake, clock } = setup({
    respond: (request) => {
      if (failing) throw new Error("internal secret detail");
      return defaultSeries(request);
    },
  });
  const good = await get();
  assert.equal(good.body.stale, false);
  failing = true;
  clock.t = START + 61000;
  const stale = await get();
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.body.stale, true);
  assert.deepEqual({ ...stale.body, stale: false }, good.body);
  assert.equal(fake.calls.length, 26);
  assert.ok(!JSON.stringify(stale.body).includes("secret"));

  // Within the cooldown after the failure: no new calls, still stale.
  clock.t = START + 61000 + 30000;
  const again = await get();
  assert.equal(again.body.stale, true);
  assert.equal(fake.calls.length, 26);
});

test("failure with no prior result is 503 and the cooldown holds", async () => {
  const { get, fake, clock } = setup({
    respond: () => {
      throw new Error("internal secret detail");
    },
  });
  const res = await get();
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["cache-control"], CACHE_CONTROL);
  assert.deepEqual(res.body, { error: "metrics unavailable" });
  assert.equal(fake.calls.length, 13);
  for (const offset of [1000, 30000, 59999]) {
    clock.t = START + offset;
    const again = await get();
    assert.equal(again.statusCode, 503);
  }
  assert.equal(fake.calls.length, 13);
  clock.t = START + 60000;
  await get();
  assert.equal(fake.calls.length, 26);
});

test("a throwing getClient is treated as a failed refresh", async () => {
  const handler = createHandler({
    getClient: () => {
      throw new Error("no credentials");
    },
    now: () => START,
    log: silent,
  });
  const res = fakeRes();
  await handler(fakeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "metrics unavailable" });
});

function loggedSetup(respond) {
  const fake = createFakeClient({ respond });
  const warnings = [];
  const handler = createHandler({
    getClient: () => fake.client,
    now: () => START,
    log: { warn: (line) => warnings.push(line), error() {} },
  });
  async function get() {
    const res = fakeRes();
    await handler(fakeReq(), res);
    return res;
  }
  return { get, warnings };
}

test("a failed query logs one bounded line plus the summary and nulls its metrics", async () => {
  const message = `7 PERMISSION_DENIED: ${"y".repeat(300)}\nmore`;
  const { get, warnings } = loggedSetup((request) => {
    if (metricTypeOf(request.filter) === METRIC_TYPES.RUN_CPU) {
      throw Object.assign(new Error(message), {
        code: 7,
        metadata: { authorization: "Bearer fake-token-do-not-log" },
      });
    }
    return defaultSeries(request);
  });
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.equal(warnings.length, 2);
  const [line, summary] = warnings;
  assert.ok(line.includes("key=run.cpu"), line);
  assert.ok(line.includes("code=7"), line);
  assert.ok(line.endsWith(`message=${message.slice(0, 200)}`), line);
  assert.ok(!line.includes("fake-token"));
  assert.equal(summary, "liveMonitorApi: 1 metric call(s) failed");
  const fn = res.body.services.find((s) => s.id === "function2:pyMintOnCrewClaim").metrics;
  assert.equal(fn.cpuPct, null);
  assert.equal(fn.cpuAt, null);
});

test("a NOT_FOUND query is not logged and not counted as failed", async () => {
  const { get, warnings } = loggedSetup((request) => {
    if (metricTypeOf(request.filter) === METRIC_TYPES.RUN_CPU) {
      throw Object.assign(new Error('5 NOT_FOUND: Cannot find metric(s) that match type = "x"'), { code: 5 });
    }
    return defaultSeries(request);
  });
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(warnings, []);
});

test("getClient is only called when a refresh starts", async () => {
  const { get, clientCreations } = setup();
  await get({ method: "POST" });
  await get({ path: "/" });
  assert.equal(clientCreations(), 0);
  await get();
  assert.equal(clientCreations(), 1);
});
