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
