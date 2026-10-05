"use strict";

require("./no-network");

const test = require("node:test");
const assert = require("node:assert/strict");
const { JOB_SCHEDULES } = require("../src/constants");
const { nextRunAt } = require("../src/schedule");

// Epoch ms of a wall-clock time in IST (UTC+05:30).
function ist(month, day, hour, minute) {
  return Date.UTC(2026, month - 1, day, hour, minute) - 330 * 60000;
}

const DAILY = JOB_SCHEDULES["scheduler:pyNightlyExport"].cron;
const WEEKLY = JOB_SCHEDULES["scheduler:pyWeeklyAccounts"].cron;

test("job schedules are the CSV values in Asia/Kolkata", () => {
  assert.deepEqual(JOB_SCHEDULES["scheduler:pyNightlyExport"], {
    cron: "30 2 * * *",
    timeZone: "Asia/Kolkata",
    schedule: "Daily 02:30 IST",
  });
  assert.deepEqual(JOB_SCHEDULES["scheduler:pyWeeklyAccounts"], {
    cron: "0 3 * * 0",
    timeZone: "Asia/Kolkata",
    schedule: "Sundays 03:00 IST",
  });
  assert.ok(Object.isFrozen(JOB_SCHEDULES));
});

test("daily: before 02:30 IST is the same day, at or after is the next day", () => {
  // 2026-10-05 is a Monday.
  assert.equal(nextRunAt(DAILY, ist(10, 5, 1, 0)), ist(10, 5, 2, 30));
  assert.equal(nextRunAt(DAILY, ist(10, 5, 2, 29)), ist(10, 5, 2, 30));
  assert.equal(nextRunAt(DAILY, ist(10, 5, 2, 30)), ist(10, 6, 2, 30));
  assert.equal(nextRunAt(DAILY, ist(10, 5, 3, 0)), ist(10, 6, 2, 30));
  assert.equal(nextRunAt(DAILY, ist(10, 5, 23, 59)), ist(10, 6, 2, 30));
  // 00:15 IST is still the previous UTC day.
  assert.equal(nextRunAt(DAILY, ist(10, 6, 0, 15)), ist(10, 6, 2, 30));
  assert.equal(new Date(nextRunAt(DAILY, ist(10, 5, 1, 0))).toISOString(), "2026-10-04T21:00:00.000Z");
});

test("weekly: Saturday gives the next day, Sunday before 03:00 the same day", () => {
  // 2026-10-03 is a Saturday, 2026-10-04 a Sunday.
  assert.equal(nextRunAt(WEEKLY, ist(10, 3, 12, 0)), ist(10, 4, 3, 0));
  assert.equal(nextRunAt(WEEKLY, ist(10, 4, 1, 0)), ist(10, 4, 3, 0));
  assert.equal(nextRunAt(WEEKLY, ist(10, 4, 2, 59)), ist(10, 4, 3, 0));
  assert.equal(new Date(nextRunAt(WEEKLY, ist(10, 4, 2, 59))).toISOString(), "2026-10-03T21:30:00.000Z");
});

test("weekly: Sunday at or after 03:00 IST gives the next Sunday", () => {
  assert.equal(nextRunAt(WEEKLY, ist(10, 4, 3, 0)), ist(10, 11, 3, 0));
  assert.equal(nextRunAt(WEEKLY, ist(10, 4, 3, 1)), ist(10, 11, 3, 0));
  assert.equal(nextRunAt(WEEKLY, ist(10, 5, 9, 0)), ist(10, 11, 3, 0));
});

test("unsupported cron forms throw", () => {
  for (const cron of ["*/5 * * * *", "0 3 * * 1-5", "0 3 1 * *", "60 1 * * *", "0 24 * * *", "0 3 * * 7", "", null, 5]) {
    assert.throws(() => nextRunAt(cron, ist(10, 5, 0, 0)), /unsupported cron/, String(cron));
  }
});
