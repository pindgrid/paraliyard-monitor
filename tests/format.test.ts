import { describe, expect, it } from "vitest";
import { DASH, HOUR, MIN, bytes, esc, fDay, fDayTime, fFull, fTime, fTimeSec, istDayStart, istHour, istWeekday, last, num, pct, sum, until } from "../src/format";

// 7 Oct 2026, 2:30:15 am IST.
const T = Date.UTC(2026, 9, 6, 21, 0, 15);

describe("numbers", () => {
  it("num: 0, <0.1, one decimal below 10, whole numbers with en-IN grouping from 10", () => {
    expect(num(0)).toBe("0");
    expect(num(0.004)).toBe("<0.1");
    expect(num(0.25)).toBe("0.3");
    expect(num(2.44)).toBe("2.4");
    expect(num(3)).toBe("3");
    expect(num(9.96)).toBe("10");
    expect(num(292.4)).toBe("292");
    expect(num(123456)).toBe("1,23,456");
    expect(num(null)).toBe(DASH);
    expect(num(Number.NaN)).toBe(DASH);
  });

  it("bytes uses one decimal below 100 of a unit and whole numbers above", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1500)).toBe("1.5 kB");
    expect(bytes(62_900_383)).toBe("62.9 MB");
    expect(bytes(110_000_059)).toBe("110 MB");
    expect(bytes(2.5e9)).toBe("2.5 GB");
    expect(bytes(null)).toBe(DASH);
  });

  it("pct, until, sum and last", () => {
    expect(pct(33.6)).toBe("34%");
    expect(pct(null)).toBe(DASH);
    expect(until(-5)).toBe("now");
    expect(until(22 * MIN)).toBe("22m");
    expect(until(4 * HOUR + 12 * MIN)).toBe("4h 12m");
    expect(until(97 * HOUR)).toBe("4d 1h");
    expect(sum([1, null, 2.5])).toBe(3.5);
    expect(sum(null)).toBe(0);
    expect(last([1, 2, 3])).toBe(3);
    expect(last([])).toBeNull();
  });

  it("escapes HTML", () => {
    expect(esc(`<b a="x">&'`)).toBe("&lt;b a=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("IST times", () => {
  it("formats 12-hour IST with lowercase am/pm", () => {
    expect(fTime(T)).toBe("2:30 am");
    expect(fTimeSec(T)).toBe("2:30:15 am");
    expect(fDay(T)).toBe("7 Oct");
    expect(fDayTime(T)).toBe("7 Oct, 2:30 am");
    expect(fFull(T)).toBe("7 Oct 2026, 2:30 am");
  });

  it("finds the IST hour, day start and weekday", () => {
    expect(istHour(T)).toBeCloseTo(2.504, 2);
    // Midnight IST is 18:30 UTC the day before.
    expect(istDayStart(T)).toBe(Date.UTC(2026, 9, 6, 18, 30));
    // 7 Oct 2026 is a Wednesday.
    expect(istWeekday(T)).toBe(3);
  });
});
