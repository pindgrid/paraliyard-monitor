import { describe, expect, it } from "vitest";
import { BYTE_AXIS_MIN, DASH, fmt, istDateTime, istDay, istDayTime, istShortTime, istTick, istTime, uniqueTicks } from "../src/fmt";

// The ticks Chart.js would generate from min to max in steps.
function ticksOf(min: number, max: number, step: number): { value: number }[] {
  const out: { value: number }[] = [];
  for (let i = 0; min + i * step <= max + 1e-9; i += 1) out.push({ value: Number((min + i * step).toFixed(6)) });
  return out;
}

describe("uniqueTicks", () => {
  it("hides a tick whose label repeats the previous one", () => {
    const callback = uniqueTicks(fmt.bytes);
    const ticks = ticksOf(0, 1, 0.2);
    const labels = ticks.map((t, i) => callback(t.value, i, ticks));
    expect(labels).toEqual(["0", "0 B", null, "1 B", null, null]);
    const shown = labels.filter((l) => l !== null);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("keeps every label of a 0..1 kB axis", () => {
    const callback = uniqueTicks(fmt.bytes);
    const ticks = ticksOf(0, 1000, 200);
    expect(ticks.map((t, i) => callback(t.value, i, ticks))).toEqual(["0", "200 B", "400 B", "600 B", "800 B", "1.0 kB"]);
    expect(BYTE_AXIS_MIN).toBe(1000);
  });

  it("accepts string values and leaves distinct labels alone", () => {
    const callback = uniqueTicks(fmt.int);
    const ticks = ticksOf(0, 4, 1);
    expect(ticks.map((t, i) => callback(String(t.value), i, ticks))).toEqual(["0", "1", "2", "3", "4"]);
  });
});

// Epoch ms of a wall-clock time in IST (UTC+05:30).
function ist(month: number, day: number, hour: number, minute: number, second = 0): number {
  return Date.UTC(2026, month - 1, day, hour, minute, second) - 330 * 60000;
}

const HOUR = 3600000;
const DAY = 24 * HOUR;
// No-break and narrow no-break spaces, which some ICU versions put before am/pm.
const ODD_SPACES = [String.fromCharCode(0xa0), String.fromCharCode(0x202f)];

describe("IST 12-hour formatters", () => {
  it("clock: 11:07:01 pm", () => {
    expect(istTime(Date.UTC(2026, 9, 5, 17, 37, 1))).toBe("11:07:01 pm");
    expect(istTime(ist(10, 5, 23, 7, 1))).toBe("11:07:01 pm");
    expect(istTime(ist(10, 5, 0, 5, 9))).toBe("12:05:09 am");
    expect(istTime(ist(10, 5, 12, 0, 0))).toBe("12:00:00 pm");
  });

  it("short time: 10:36 pm", () => {
    expect(istShortTime(ist(10, 5, 22, 36))).toBe("10:36 pm");
    expect(istShortTime(ist(10, 5, 9, 4))).toBe("9:04 am");
  });

  it("date-time: 5 Oct 2026, 2:35:47 am", () => {
    expect(istDateTime(ist(10, 5, 2, 35, 47))).toBe("5 Oct 2026, 2:35:47 am");
    expect(istDateTime(Date.UTC(2026, 9, 4, 21, 5, 47))).toBe("5 Oct 2026, 2:35:47 am");
  });

  it("day-time: 6 Oct, 2:30 am", () => {
    expect(istDayTime(ist(10, 6, 2, 30))).toBe("6 Oct, 2:30 am");
  });

  it("ticks per range", () => {
    expect(istTick(ist(10, 5, 22, 36), HOUR)).toBe("10:36 pm");
    expect(istTick(ist(10, 5, 22, 36), DAY)).toBe("10:36 pm");
    expect(istTick(ist(10, 5, 14, 0), 7 * DAY)).toBe("5 Oct, 2 pm");
    expect(istTick(ist(10, 5, 14, 0), 30 * DAY)).toBe("5 Oct");
  });

  it("never adds an IST suffix and gives a dash for invalid times", () => {
    const t = ist(10, 5, 14, 0);
    for (const s of [istTime(t), istShortTime(t), istDateTime(t), istDayTime(t), istTick(t, HOUR), istDay(t)]) {
      expect(s).not.toContain("IST");
      for (const space of ODD_SPACES) expect(s).not.toContain(space);
    }
    for (const f of [istTime, istShortTime, istDateTime, istDayTime]) expect(f(NaN)).toBe(DASH);
    expect(istTick(NaN, HOUR)).toBe(DASH);
  });
});
