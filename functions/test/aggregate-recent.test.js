"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVICES } = require("../src/constants");
const { buildPayload, RECENT_KEYS, RECENT_SLOTS, SCHEDULE_KEYS } = require("../src/aggregate");
const { buildRequests } = require("../src/queries");
const { collect } = require("../src/collect");
const { createFakeClient } = require("./fake-client");
const iteration4 = require("./fixtures/aggregate-iteration4");

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60000;

// One series; values[i] ends i minutes before endMs (newest first).
function series(resourceLabels, values, metricLabels = {}, endMs = NOW) {
  return {
    resource: { labels: resourceLabels },
    metric: { labels: metricLabels },
    points: values.map((v, i) => ({
      interval: { endTime: { seconds: String((endMs - i * MINUTE) / 1000), nanos: 0 } },
      value: Number.isInteger(v) ? { int64Value: String(v) } : { doubleValue: v },
    })),
  };
}

function ok(...list) {
  return { ok: true, series: list };
}

function find(payload, id) {
  return payload.services.find((s) => s.id === id);
}

const ALL_KEYS = buildRequests("1h", NOW).map((r) => r.key);

function allEmpty() {
  return Object.fromEntries(ALL_KEYS.map((key) => [key, ok()]));
}

function allFailed() {
  return Object.fromEntries(ALL_KEYS.map((key) => [key, { ok: false }]));
}

// The payload with the scheduler lastRunAt / lastResult blanked: iteration 8
// replaced the newest-bucket rule with scheduled occurrences (tested in
// aggregate.test.js), every other field must stay the same.
function withoutRunRule(payload) {
  const blank = { lastRunAt: "(run rule)", lastResult: "(run rule)" };
  return {
    ...payload,
    services: payload.services.map((s) => (s.kind === "scheduler" ? { ...s, metrics: blank } : s)),
    totals: { ...payload.totals, scheduler: blank },
  };
}

// The payload without the iteration-5 additions.
function withoutAdded(payload) {
  return {
    ...payload,
    services: payload.services.map((s) => {
      const copy = { ...s };
      delete copy.recent;
      for (const key of SCHEDULE_KEYS) delete copy[key];
      return copy;
    }),
  };
}

test("buildRequests still issues exactly the 13 existing queries", () => {
  assert.deepEqual(ALL_KEYS, [
    "run.cpu",
    "run.memory",
    "run.requests",
    "run.instances",
    "gen1.executions",
    "gen1.memory",
    "firestore.reads",
    "firestore.writes",
    "firestore.deletes",
    "bucket.requests",
    "bucket.bytes",
    "hosting.sentBytes",
    "scheduler.runs",
  ]);
  for (const windowKey of ["1h", "6h"]) assert.equal(buildRequests(windowKey, NOW).length, 13);
});

test("every service has 30 per-minute values for its kind's recent keys", () => {
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  assert.equal(RECENT_SLOTS, 30);
  for (const s of payload.services) {
    assert.deepEqual(Object.keys(s.recent), ["from", "stepSeconds", "series"], s.id);
    assert.equal(s.recent.stepSeconds, 60, s.id);
    assert.equal(s.recent.from, new Date(NOW - 30 * MINUTE).toISOString(), s.id);
    assert.deepEqual(Object.keys(s.recent.series), [...RECENT_KEYS[s.kind]], s.id);
    for (const [key, values] of Object.entries(s.recent.series)) {
      assert.equal(values.length, 30, `${s.id} ${key}`);
      // An empty successful result is 0 for every minute.
      assert.ok(values.every((v) => v === 0), `${s.id} ${key}`);
    }
  }
  assert.deepEqual(RECENT_KEYS.function2, ["reqPerMin", "errPerMin"]);
  assert.deepEqual(RECENT_KEYS.firestore, ["readsPerMin", "writesPerMin", "deletesPerMin"]);
});

test("a failed query makes the whole recent series null", () => {
  for (const results of [{}, allFailed()]) {
    const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
    for (const s of payload.services) {
      for (const [key, values] of Object.entries(s.recent.series)) assert.equal(values, null, `${s.id} ${key}`);
    }
  }
  const payload = buildPayload({ results: { ...allEmpty(), "firestore.writes": { ok: false } }, windowKey: "1h", nowMs: NOW });
  const fs = find(payload, "firestore:yard").recent.series;
  assert.equal(fs.writesPerMin, null);
  assert.equal(fs.readsPerMin.length, 30);
});

test("points go to the minute that holds their end time", () => {
  const db = { database_id: "yard" };
  // Newest first: NOW, NOW-1m, ... NOW-30m (outside the 30 slots).
  const values = Array.from({ length: 31 }, (_, i) => i + 1);
  const results = { ...allEmpty(), "firestore.reads": ok(series(db, values)) };
  const reads = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "firestore:yard").recent.series.readsPerMin;
  assert.equal(reads[29], 1);
  assert.equal(reads[28], 2);
  assert.equal(reads[0], 30);
  assert.ok(!reads.includes(31));

  // 20 s past the minute: a point ending after the anchor is not placed and
  // the point ending at the anchor fills the last slot.
  const later = NOW + 20000;
  const shifted = { ...allEmpty(), "firestore.reads": ok(series(db, [7], {}, later), series(db, [5])) };
  const r2 = find(buildPayload({ results: shifted, windowKey: "1h", nowMs: later }), "firestore:yard").recent;
  assert.equal(r2.series.readsPerMin[29], 5);
  assert.equal(r2.series.readsPerMin.reduce((a, b) => a + b, 0), 5);
  assert.equal(r2.from, new Date(NOW - 30 * MINUTE).toISOString());
});

test("function2 requests sum every class and errors sum 4xx + 5xx", () => {
  const sn = { service_name: "pymintoncrewclaim" };
  const results = {
    ...allEmpty(),
    "run.requests": ok(
      series(sn, [10, 20], { response_code_class: "2xx" }),
      series(sn, [1], { response_code_class: "3xx" }),
      series(sn, [2, 0], { response_code_class: "4xx" }),
      series(sn, [0, 3], { response_code_class: "5xx" }),
    ),
  };
  const s = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyMintOnCrewClaim").recent.series;
  assert.equal(s.reqPerMin[29], 10 + 1 + 2 + 0);
  assert.equal(s.reqPerMin[28], 20 + 0 + 3);
  assert.equal(s.errPerMin[29], 2);
  assert.equal(s.errPerMin[28], 3);
  assert.equal(s.errPerMin[0], 0);
  // An idle function in the same successful call is all zeros.
  const idle = find(buildPayload({ results, windowKey: "1h", nowMs: NOW }), "function2:pyWeeklyAccounts").recent.series;
  assert.ok(idle.reqPerMin.every((v) => v === 0));
});

test("function1, bucket and hosting recent series", () => {
  const results = {
    ...allEmpty(),
    "gen1.executions": ok(series({ function_name: "pyCleanupOnAuthDelete" }, [0, 4])),
    "bucket.requests": ok(series({ bucket_name: "mineral-proton-438104-g8-paraliyard" }, [6])),
    "hosting.sentBytes": ok(series({ domain_name: "paraliyard.web.app" }, [2048, 1024])),
  };
  const payload = buildPayload({ results, windowKey: "1h", nowMs: NOW });
  assert.equal(find(payload, "function1:pyCleanupOnAuthDelete").recent.series.execPerMin[28], 4);
  assert.equal(find(payload, "bucket:mineral-proton-438104-g8-paraliyard").recent.series.reqPerMin[29], 6);
  assert.deepEqual(find(payload, "hosting:paraliyard").recent.series.bytesServed.slice(28), [1024, 2048]);
  assert.deepEqual(find(payload, "scheduler:pyNightlyExport").recent.series, {});
});

test("scheduler services carry schedule, cron, timeZone and the next run", () => {
  const payload = buildPayload({ results: allEmpty(), windowKey: "1h", nowMs: NOW });
  // NOW is Thursday 2026-01-01 17:30 IST.
  const nightly = find(payload, "scheduler:pyNightlyExport");
  assert.equal(nightly.schedule, "Every day, 2:30 am");
  assert.equal(nightly.cron, "30 2 * * *");
  assert.equal(nightly.timeZone, "Asia/Kolkata");
  assert.equal(nightly.nextRun, "2026-01-01T21:00:00.000Z");
  const weekly = find(payload, "scheduler:pyWeeklyAccounts");
  assert.equal(weekly.schedule, "Sundays, 3:00 am");
  assert.equal(weekly.cron, "0 3 * * 0");
  assert.equal(weekly.timeZone, "Asia/Kolkata");
  assert.equal(weekly.nextRun, "2026-01-03T21:30:00.000Z");
  for (const s of payload.services.filter((v) => v.kind !== "scheduler")) {
    for (const key of SCHEDULE_KEYS) assert.ok(!(key in s), `${s.id} ${key}`);
  }
  // The schedule fields do not depend on the query result.
  const failed = find(buildPayload({ results: allFailed(), windowKey: "1h", nowMs: NOW }), "scheduler:pyNightlyExport");
  assert.equal(failed.nextRun, nightly.nextRun);
});

test("every pre-existing payload field is unchanged (deep-equal with iteration 4)", async () => {
  const fake = createFakeClient();
  const fakeResults = await collect(fake.client, buildRequests("1h", NOW));
  const sn = { service_name: "pymintoncrewclaim" };
  const mixed = {
    "run.cpu": ok(series(sn, [0.25, 0.9])),
    "run.memory": { ok: false },
    "run.requests": ok(series(sn, [60, 60], { response_code_class: "2xx" }), series(sn, [6], { response_code_class: "4xx" })),
    "run.instances": ok(series(sn, [3, 1])),
    "firestore.reads": ok(series({ database_id: "yard" }, [10, 20])),
    "hosting.sentBytes": ok(),
    "scheduler.runs": ok(series({ service_name: "pynightlyexport" }, [0, 1], { response_code_class: "2xx" })),
  };
  const cases = [fakeResults, allEmpty(), allFailed(), {}, mixed];
  for (const [i, results] of cases.entries()) {
    for (const windowKey of ["1h", "6h"]) {
      const current = buildPayload({ results, windowKey, nowMs: NOW });
      const before = iteration4.buildPayload({ results, windowKey, nowMs: NOW });
      assert.deepEqual(withoutRunRule(withoutAdded(current)), withoutRunRule(before), `case ${i} ${windowKey}`);
    }
  }
  assert.equal(fake.calls.length, 13);
  assert.equal(SERVICES.length, 17);
});
