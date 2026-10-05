import { describe, expect, it } from "vitest";
import { computeStats, csvText, runsCsvText } from "../src/stats";

describe("computeStats", () => {
  it("gives latest, min, average, max and p99", () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    values.push(5);
    const stats = computeStats(values);
    // Sorted: 0..5, 5, 6..100; index floor(0.99 * 101) = 99 holds 98.
    expect(stats).toEqual({ latest: 5, min: 0, avg: (5050 + 5) / 102, max: 100, p99: 98 });
  });

  it("skips unknown values and is null without any", () => {
    expect(computeStats([null, 3, undefined, 1])).toEqual({ latest: 1, min: 1, avg: 2, max: 3, p99: 1 });
    expect(computeStats([null, undefined])).toBeNull();
    expect(computeStats([])).toBeNull();
  });
});

describe("csvText", () => {
  it("writes one row per time with a column per series", () => {
    const t0 = Date.UTC(2026, 9, 5, 8, 0);
    const t1 = t0 + 60000;
    const text = csvText([
      { label: "Reads/min", points: [{ t: t1, v: 2 }, { t: t0, v: 1 }] },
      { label: 'Say "hi"', points: [{ t: t1, v: 7 }] },
    ]);
    expect(text.split("\n")).toEqual([
      'time,"Reads/min","Say ""hi"""',
      "2026-10-05T08:00:00.000Z,1,",
      "2026-10-05T08:01:00.000Z,2,7",
    ]);
  });

  it("writes runs with result and duration", () => {
    const t = Date.UTC(2026, 9, 4, 21, 0, 47);
    expect(runsCsvText([{ t, failed: true, durationSec: 41 }, { t: t + 86400000, failed: false, durationSec: null }])).toBe(
      "time,result,duration_s\n2026-10-04T21:00:47.000Z,failed,41\n2026-10-05T21:00:47.000Z,success,",
    );
  });
});
