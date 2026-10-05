"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../src/handler");
const { createFakeClient } = require("./fake-client");
const fixture = require("../../src/mock/sample-metrics.json");
const { SCHEDULE_KEYS } = require("../src/aggregate");

// Fields added after the fixture's keys in iteration 5. The mock source adds
// the same fields to the fixture at load time (src/source.ts).
function addedKeys(kind) {
  return kind === "scheduler" ? ["recent", ...SCHEDULE_KEYS] : ["recent"];
}

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
    assert.deepEqual(Object.keys(service), [...Object.keys(expected), ...addedKeys(expected.kind)]);
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

test("handler trends match the frontend fixture's trend keys and point shape", async () => {
  const payload = await livePayload();
  for (const [i, service] of payload.services.entries()) {
    const expected = fixture.services[i];
    assert.deepEqual(Object.keys(service.trends), Object.keys(expected.trends), service.id);
    for (const trends of [service.trends, expected.trends]) {
      for (const [key, points] of Object.entries(trends)) {
        if (points === null) continue;
        assert.ok(Array.isArray(points), `${service.id} ${key}`);
        for (const point of points) {
          assert.deepEqual(Object.keys(point), ["t", "v"], `${service.id} ${key}`);
          assert.equal(typeof point.t, "string");
          assert.equal(typeof point.v, "number");
        }
      }
    }
  }
});
