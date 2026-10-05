"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../src/handler");
const { createFakeClient } = require("./fake-client");
const fixture = require("../../src/mock/sample-metrics.json");

async function livePayload() {
  const fake = createFakeClient();
  const handler = createHandler({
    getClient: () => fake.client,
    now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
    log: { warn() {}, error() {} },
  });
  let body;
  const res = {
    set() {
      return res;
    },
    status() {
      return res;
    },
    json(value) {
      body = value;
      return res;
    },
  };
  await handler({ method: "GET", path: "/api/metrics", query: {} }, res);
  return body;
}

test("handler payload matches the frontend fixture shape", async () => {
  const payload = await livePayload();
  assert.deepEqual(Object.keys(payload), Object.keys(fixture));
  assert.deepEqual(payload.services.map((s) => s.id), fixture.services.map((s) => s.id));
  for (const [i, service] of payload.services.entries()) {
    const expected = fixture.services[i];
    assert.deepEqual(Object.keys(service), Object.keys(expected));
    assert.equal(service.kind, expected.kind);
    assert.equal(service.name, expected.name);
    assert.deepEqual(Object.keys(service.metrics), Object.keys(expected.metrics), service.id);
    assert.ok(Array.isArray(service.trend.points));
    for (const point of service.trend.points) assert.deepEqual(Object.keys(point), ["t", "v"]);
  }
  assert.deepEqual(Object.keys(payload.totals), Object.keys(fixture.totals));
  for (const kind of Object.keys(fixture.totals)) {
    assert.deepEqual(Object.keys(payload.totals[kind]), Object.keys(fixture.totals[kind]), kind);
  }
});
