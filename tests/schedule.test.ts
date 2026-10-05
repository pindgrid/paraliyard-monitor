import { describe, expect, it } from "vitest";
import { RUN_WINDOW_MS, istDayStart, nextRunAt, occurrencesBetween } from "../src/schedule";
import { JOB_SCHEDULES } from "../src/services";

// Epoch ms of a wall-clock time in IST (UTC+05:30).
function ist(month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(2026, month - 1, day, hour, minute) - 330 * 60000;
}

const DAILY = JOB_SCHEDULES["scheduler:pyNightlyExport"].cron;
const WEEKLY = JOB_SCHEDULES["scheduler:pyWeeklyAccounts"].cron;

describe("JOB_SCHEDULES", () => {
  it("copies the CSV values in Asia/Kolkata", () => {
    expect(JOB_SCHEDULES).toEqual({
      "scheduler:pyNightlyExport": { cron: "30 2 * * *", timeZone: "Asia/Kolkata", schedule: "Every day, 2:30 am" },
      "scheduler:pyWeeklyAccounts": { cron: "0 3 * * 0", timeZone: "Asia/Kolkata", schedule: "Sundays, 3:00 am" },
    });
    // Only the display text changed: the cron strings stay the same.
    expect(DAILY).toBe("30 2 * * *");
    expect(WEEKLY).toBe("0 3 * * 0");
  });
});

describe("nextRunAt", () => {
  it("daily 30 2 * * *: next 02:30 IST", () => {
    // 2026-10-05 is a Monday.
    expect(nextRunAt(DAILY, ist(10, 5, 1, 0))).toBe(ist(10, 5, 2, 30));
    expect(nextRunAt(DAILY, ist(10, 5, 2, 29))).toBe(ist(10, 5, 2, 30));
    expect(nextRunAt(DAILY, ist(10, 5, 2, 30))).toBe(ist(10, 6, 2, 30));
    expect(nextRunAt(DAILY, ist(10, 5, 3, 0))).toBe(ist(10, 6, 2, 30));
    expect(nextRunAt(DAILY, ist(10, 6, 0, 15))).toBe(ist(10, 6, 2, 30));
    expect(new Date(nextRunAt(DAILY, ist(10, 5, 1, 0))).toISOString()).toBe("2026-10-04T21:00:00.000Z");
  });

  it("weekly 0 3 * * 0: Saturday gives Sunday 03:00 IST", () => {
    // 2026-10-03 is a Saturday.
    expect(nextRunAt(WEEKLY, ist(10, 3, 12, 0))).toBe(ist(10, 4, 3, 0));
  });

  it("weekly: Sunday before 03:00 IST is the same day", () => {
    expect(nextRunAt(WEEKLY, ist(10, 4, 1, 0))).toBe(ist(10, 4, 3, 0));
    expect(nextRunAt(WEEKLY, ist(10, 4, 2, 59))).toBe(ist(10, 4, 3, 0));
  });

  it("weekly: Sunday at or after 03:00 IST is the next Sunday", () => {
    expect(nextRunAt(WEEKLY, ist(10, 4, 3, 0))).toBe(ist(10, 11, 3, 0));
    expect(nextRunAt(WEEKLY, ist(10, 4, 3, 1))).toBe(ist(10, 11, 3, 0));
    expect(nextRunAt(WEEKLY, ist(10, 5, 9, 0))).toBe(ist(10, 11, 3, 0));
  });

  it("throws on unsupported cron forms", () => {
    for (const cron of ["*/5 * * * *", "0 3 * * 1-5", "0 3 1 * *", "60 1 * * *", "0 24 * * *", "0 3 * * 7", ""]) {
      expect(() => nextRunAt(cron, ist(10, 5, 0, 0)), cron).toThrow(/unsupported cron/);
    }
  });
});

describe("occurrencesBetween (port of functions/src/schedule.js)", () => {
  it("daily over 30 days is every 02:30 IST (21:00 UTC)", () => {
    const to = ist(10, 6, 12, 0);
    const list = occurrencesBetween(DAILY, to - 30 * 86400000, to);
    expect([30, 31]).toContain(list.length);
    for (const s of list) expect(new Date(s).toISOString().slice(11)).toBe("21:00:00.000Z");
    expect(list[list.length - 1]).toBe(ist(10, 6, 2, 30));
  });

  it("weekly over 14 days is only Sundays at 03:00 IST", () => {
    const to = ist(10, 6, 12, 0);
    expect(occurrencesBetween(WEEKLY, to - 14 * 86400000, to)).toEqual([ist(9, 27, 3, 0), ist(10, 4, 3, 0)]);
  });

  it("includes both bounds and throws on unsupported crons", () => {
    expect(occurrencesBetween(DAILY, ist(10, 4, 2, 30), ist(10, 5, 2, 30))).toEqual([ist(10, 4, 2, 30), ist(10, 5, 2, 30)]);
    expect(occurrencesBetween(DAILY, ist(10, 4, 2, 31), ist(10, 5, 2, 29))).toEqual([]);
    expect(() => occurrencesBetween("*/5 * * * *", 0, 1)).toThrow(/unsupported cron/);
    expect(RUN_WINDOW_MS).toBe(30 * 60000);
  });
});

describe("istDayStart", () => {
  it("returns the IST midnight", () => {
    expect(istDayStart(ist(10, 5, 0, 0))).toBe(ist(10, 5, 0, 0));
    expect(istDayStart(ist(10, 5, 23, 59))).toBe(ist(10, 5, 0, 0));
    // 00:10 IST on the 6th is still the 5th in UTC.
    expect(istDayStart(ist(10, 6, 0, 10))).toBe(ist(10, 6, 0, 0));
  });
});
