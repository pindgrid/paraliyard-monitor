"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { collect, AllCallsFailedError } = require("../src/collect");
const { buildRequests } = require("../src/queries");
const { createFakeClient } = require("./fake-client");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

test("at most 4 calls in flight and one call per request", async () => {
  const fake = createFakeClient({ delayMs: 5 });
  const requests = buildRequests("1h", NOW);
  const results = await collect(fake.client, requests);
  assert.ok(fake.peakConcurrency() <= 4, `peak ${fake.peakConcurrency()}`);
  assert.ok(fake.peakConcurrency() >= 1);
  assert.equal(fake.calls.length, 13);
  assert.deepEqual(Object.keys(results).sort(), requests.map((r) => r.key).sort());
  for (const result of Object.values(results)) assert.equal(result.ok, true);
});

test("every call has a bounded timeout, no retry and no auto-pagination", async () => {
  const fake = createFakeClient();
  await collect(fake.client, buildRequests("6h", NOW));
  for (const call of fake.calls) {
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000);
    assert.equal(call.options.retry, null);
    assert.equal(call.options.autoPaginate, false);
    assert.equal(call.request.pageSize, 1000);
    assert.equal(call.request.key, undefined);
  }
});

test("partial failure keeps the other results", async () => {
  const fake = createFakeClient({
    respond: (request, index) => {
      if (index % 2 === 0) throw new Error("boom");
      return [];
    },
  });
  const results = await collect(fake.client, buildRequests("1h", NOW));
  const values = Object.values(results);
  assert.equal(values.length, 13);
  assert.equal(values.filter((r) => r.ok).length, 6);
  assert.equal(values.filter((r) => !r.ok).length, 7);
  for (const r of values.filter((v) => !v.ok)) assert.deepEqual(r, { ok: false });
});

test("throws only when every call fails", async () => {
  const fake = createFakeClient({
    respond: () => {
      throw new Error("down");
    },
  });
  await assert.rejects(collect(fake.client, buildRequests("1h", NOW)), AllCallsFailedError);
  assert.equal(fake.calls.length, 13);
});

test("only listTimeSeries is called", async () => {
  const fake = createFakeClient();
  await collect(fake.client, buildRequests("1h", NOW));
  assert.deepEqual(fake.methods(), ["listTimeSeries"]);
});

function recordingLog() {
  const lines = [];
  return { lines, log: { warn: (line) => lines.push(line) } };
}

const NOT_FOUND_MESSAGE = '5 NOT_FOUND: Cannot find metric(s) that match type = "run.googleapis.com/container/cpu/utilizations"';

test("NOT_FOUND is a successful call with no series and is not logged", async () => {
  const requests = buildRequests("1h", NOW);
  const target = requests[0].key;
  const fake = createFakeClient({
    respond: (request, index) => {
      if (index === 0) throw Object.assign(new Error(NOT_FOUND_MESSAGE), { code: 5 });
      return [];
    },
  });
  const { lines, log } = recordingLog();
  const results = await collect(fake.client, requests, { log });
  assert.deepEqual(results[target], { ok: true, series: [] });
  assert.deepEqual(lines, []);
});

test("a NOT_FOUND message without a code is treated the same way", async () => {
  const requests = buildRequests("1h", NOW);
  const fake = createFakeClient({
    respond: (request, index) => {
      if (index === 0) throw new Error(NOT_FOUND_MESSAGE);
      return [];
    },
  });
  const { lines, log } = recordingLog();
  const results = await collect(fake.client, requests, { log });
  assert.deepEqual(results[requests[0].key], { ok: true, series: [] });
  assert.deepEqual(lines, []);
});

test("all calls NOT_FOUND does not reject", async () => {
  const fake = createFakeClient({
    respond: () => {
      throw Object.assign(new Error(NOT_FOUND_MESSAGE), { code: 5 });
    },
  });
  const results = await collect(fake.client, buildRequests("1h", NOW));
  assert.equal(Object.keys(results).length, 13);
  for (const r of Object.values(results)) assert.deepEqual(r, { ok: true, series: [] });
});

test("an empty series list is a successful call", async () => {
  const fake = createFakeClient({ respond: () => [] });
  const results = await collect(fake.client, buildRequests("1h", NOW));
  for (const r of Object.values(results)) assert.deepEqual(r, { ok: true, series: [] });
});

test("a real failure logs one bounded line without metadata, details or stack", async () => {
  const requests = buildRequests("1h", NOW);
  const target = requests[0].key;
  const message = `7 PERMISSION_DENIED: first line\r\nsecond line ${"x".repeat(300)}`;
  const err = Object.assign(new Error(message), {
    code: 7,
    metadata: { authorization: "Bearer fake-token-do-not-log" },
    details: "details fake-token-do-not-log",
  });
  const fake = createFakeClient({
    respond: (request, index) => {
      if (index === 0) throw err;
      return [];
    },
  });
  const { lines, log } = recordingLog();
  const results = await collect(fake.client, requests, { log });
  assert.deepEqual(results[target], { ok: false });
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.includes(`key=${target}`), line);
  assert.ok(line.includes("code=7"), line);
  const expectedMessage = message.replace(/[\r\n]+/g, " ").slice(0, 200);
  assert.ok(line.endsWith(`message=${expectedMessage}`), line);
  assert.ok(!line.includes("\n") && !line.includes("\r"));
  assert.ok(!line.includes("fake-token"));
  assert.ok(!line.includes(err.stack.split("\n")[1].trim()));
});

test("an error without a code logs code=unknown", async () => {
  const requests = buildRequests("1h", NOW);
  const fake = createFakeClient({
    respond: (request, index) => {
      if (index === 0) throw new Error("boom");
      return [];
    },
  });
  const { lines, log } = recordingLog();
  await collect(fake.client, requests, { log });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("code=unknown"), lines[0]);
});
