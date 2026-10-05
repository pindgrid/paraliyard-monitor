"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { JOB_SCHEDULES } = require("../src/constants");
const { classifyRuns, markBeforeFirstRun, latestClosedRun } = require("../src/runs");
const { NOW_MS, ist, point, classSeries, nightlySeries, weeklySeries } = require("./fixtures/scheduler-live-log");

const DAILY = JOB_SCHEDULES["scheduler:pyNightlyExport"].cron;
const WEEKLY = JOB_SCHEDULES["scheduler:pyWeeklyAccounts"].cron;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;

test("nightly over 30 days: one run per 02:30 IST occurrence, off-schedule calls apart", () => {
  const classified = classifyRuns(nightlySeries(), DAILY, NOW_MS - 30 * DAY_MS, NOW_MS);
  // Raw classifyRuns (as /api/metrics uses it): empty closed windows are missed.
  assert.ok(classified.runs.filter((r) => r.requests === 0).every((r) => r.result === "missed"));
  const runs = markBeforeFirstRun(classified.runs, NOW_MS);
  const { otherCalls } = classified;
  assert.equal(runs.length, 30);
  for (const r of runs) {
    const d = new Date(r.at);
    assert.equal(d.getUTCHours(), 21);
    assert.equal(d.getUTCMinutes(), 0);
  }
  const sep19 = runs.find((r) => r.at === ist(9, 19, 2, 30));
  assert.deepEqual(sep19, { at: ist(9, 19, 2, 30), requests: 0, failed: 0, result: "before-first-run" });
  const oct5 = runs.find((r) => r.at === ist(10, 5, 2, 30));
  assert.deepEqual(oct5, { at: ist(10, 5, 2, 30), requests: 1, failed: 0, result: "success" });
  assert.deepEqual(otherCalls, { count: 4, failed: 4 });
  // Every occurrence before 5 Oct comes before the first observed run.
  assert.ok(runs.filter((r) => r.at < oct5.at).every((r) => r.result === "before-first-run"));
  assert.equal(runs[runs.length - 1], oct5);
});

test("weekly: only Sunday 03:00 IST occurrences, Thursday calls only in otherCalls", () => {
  const classified = classifyRuns(weeklySeries(), WEEKLY, NOW_MS - 30 * DAY_MS, NOW_MS);
  assert.ok(classified.runs.slice(0, -1).every((r) => r.result === "missed"));
  const runs = markBeforeFirstRun(classified.runs, NOW_MS);
  const { otherCalls } = classified;
  assert.deepEqual(
    runs.map((r) => r.at),
    [ist(9, 6, 3, 0), ist(9, 13, 3, 0), ist(9, 20, 3, 0), ist(9, 27, 3, 0), ist(10, 4, 3, 0)],
  );
  for (const r of runs) assert.equal(new Date(r.at + 330 * MINUTE_MS).getUTCDay(), 0);
  assert.deepEqual(runs[runs.length - 1], { at: ist(10, 4, 3, 0), requests: 1, failed: 0, result: "success" });
  assert.ok(runs.slice(0, -1).every((r) => r.result === "before-first-run" && r.requests === 0 && r.failed === 0));
  assert.deepEqual(otherCalls, { count: 3, failed: 3 });
});

test("markBeforeFirstRun: a gap after the first run stays missed", () => {
  const first = ist(10, 3, 2, 30);
  const series = [
    classSeries("pynightlyexport", "2xx", [point(first + 5 * MINUTE_MS, 1), point(first + 2 * DAY_MS + 5 * MINUTE_MS, 1)]),
  ];
  const nowMs = first + 2 * DAY_MS + 60 * MINUTE_MS;
  const runs = markBeforeFirstRun(classifyRuns(series, DAILY, first - MINUTE_MS, nowMs).runs, nowMs);
  assert.deepEqual(
    runs.map((r) => r.result),
    ["success", "missed", "success"],
  );
});

test("markBeforeFirstRun: no request at all gives before-first-run and upcoming, never missed", () => {
  const first = ist(10, 3, 2, 30);
  const nowMs = first + 3 * DAY_MS + 10 * MINUTE_MS;
  const runs = markBeforeFirstRun(classifyRuns([], DAILY, first - MINUTE_MS, nowMs).runs, nowMs);
  assert.deepEqual(
    runs.map((r) => r.result),
    ["before-first-run", "before-first-run", "before-first-run", "upcoming"],
  );
  assert.ok(!runs.some((r) => r.result === "missed"));
});

test("markBeforeFirstRun: a failed first run counts as the first run", () => {
  const first = ist(10, 3, 2, 30);
  const failedAt = first + 2 * DAY_MS;
  const series = [classSeries("pynightlyexport", "5xx", [point(failedAt + 5 * MINUTE_MS, 2)])];
  const nowMs = failedAt + DAY_MS + 60 * MINUTE_MS;
  const runs = markBeforeFirstRun(classifyRuns(series, DAILY, first - MINUTE_MS, nowMs).runs, nowMs);
  assert.deepEqual(
    runs.map((r) => r.result),
    ["before-first-run", "before-first-run", "failed", "missed"],
  );
  assert.deepEqual(runs[2], { at: failedAt, requests: 2, failed: 2, result: "failed" });
});

test("raw classifyRuns: a closed window without requests is missed, an open one is upcoming", () => {
  const at = ist(10, 6, 2, 30);
  const open = classifyRuns([], DAILY, at - MINUTE_MS, at + 29 * MINUTE_MS);
  assert.deepEqual(open.runs, [{ at, requests: 0, failed: 0, result: "upcoming" }]);
  assert.deepEqual(open.otherCalls, { count: 0, failed: 0 });
  const closed = classifyRuns([], DAILY, at - MINUTE_MS, at + 30 * MINUTE_MS);
  assert.deepEqual(closed.runs, [{ at, requests: 0, failed: 0, result: "missed" }]);
  assert.equal(latestClosedRun(open.runs, at + 29 * MINUTE_MS), null);
  assert.equal(latestClosedRun(closed.runs, at + 30 * MINUTE_MS), closed.runs[0]);
});

test("a non-2xx request inside the window makes the run failed", () => {
  const at = ist(10, 5, 2, 30);
  const series = [
    classSeries("pynightlyexport", "2xx", [point(at + 5 * MINUTE_MS, 2)]),
    classSeries("pynightlyexport", "4xx", [point(at + 10 * MINUTE_MS, 1)]),
  ];
  const { runs } = classifyRuns(series, DAILY, at, at + DAY_MS - 1);
  assert.deepEqual(runs, [{ at, requests: 3, failed: 1, result: "failed" }]);
});

test("the alignment phase does not matter: overlapping buckets belong to the run", () => {
  const at = ist(10, 5, 2, 30);
  for (const offsetMin of [0, 1, 2, 3, 4]) {
    // The first bucket ending after s, and the last one starting before s + 30 min.
    const first = at + (offsetMin === 0 ? 5 : offsetMin) * MINUTE_MS;
    const last = at + (30 + (offsetMin === 0 ? 0 : offsetMin) - 1) * MINUTE_MS + MINUTE_MS;
    const before = first - 5 * MINUTE_MS;
    const after = last + 5 * MINUTE_MS;
    const series = [classSeries("pynightlyexport", "2xx", [point(before, 7), point(first, 1), point(last, 2), point(after, 9)])];
    const { runs, otherCalls } = classifyRuns(series, DAILY, at, at + DAY_MS - 1);
    assert.deepEqual(runs[0], { at, requests: 3, failed: 0, result: "success" }, String(offsetMin));
    assert.deepEqual(otherCalls, { count: 16, failed: 0 }, String(offsetMin));
  }
});

test("a bucket matching two windows goes to the earliest", () => {
  // With a 1 h step a bucket can overlap two daily windows only in theory;
  // use the step argument to make one bucket span both.
  const first = ist(10, 4, 2, 30);
  const series = [classSeries("pynightlyexport", "2xx", [point(first + DAY_MS + MINUTE_MS, 1)])];
  const { runs } = classifyRuns(series, DAILY, first, first + DAY_MS + 60 * MINUTE_MS, 25 * 3600);
  assert.equal(runs[0].requests, 1);
  assert.equal(runs[1].requests, 0);
});

test("latestClosedRun picks the newest closed occurrence", () => {
  const { runs } = classifyRuns(nightlySeries(), DAILY, NOW_MS - 8 * DAY_MS, NOW_MS);
  assert.deepEqual(latestClosedRun(runs, NOW_MS), { at: ist(10, 5, 2, 30), requests: 1, failed: 0, result: "success" });
  assert.equal(latestClosedRun([], NOW_MS), null);
});

test("raw classifyRuns: non-array series give occurrences without requests", () => {
  const { runs, otherCalls } = classifyRuns(null, WEEKLY, NOW_MS - 14 * DAY_MS, NOW_MS);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.result === "missed"));
  assert.deepEqual(otherCalls, { count: 0, failed: 0 });
});
