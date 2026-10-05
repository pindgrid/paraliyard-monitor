import { describe, expect, it } from "vitest";
import { daySquares } from "../src/day-squares";
import type { HistoryPoint, RunResult } from "../src/types";

// Epoch ms of a wall-clock time in IST (UTC+05:30).
function ist(month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(2026, month - 1, day, hour, minute) - 330 * 60000;
}

const point = (t: number, v: number, failed = 0): HistoryPoint => ({ t: new Date(t).toISOString(), v, failed });

// One scheduled occurrence as /api/history returns it.
const run = (t: number, result: RunResult, requests = result === "success" ? 1 : 0, failed = 0): HistoryPoint => ({
  t: new Date(t).toISOString(),
  v: requests,
  result,
  requests,
  failed,
});

// "Now" is Monday 5 Oct 2026, 10:00 IST.
const NOW = ist(10, 5, 10, 0);

describe("daySquares", () => {
  it("gives 14 IST days, oldest first, ending today", () => {
    const squares = daySquares([], NOW);
    expect(squares).toHaveLength(14);
    expect(squares[13].start).toBe(ist(10, 5, 0, 0));
    expect(squares[0].start).toBe(ist(9, 22, 0, 0));
    expect(squares.every((s) => s.state === "none")).toBe(true);
    expect(squares[13].label).toBe("5 Oct: no run");
  });

  it("is ok when the day ran without failures and failed when any run failed", () => {
    const points = [
      point(ist(10, 5, 2, 31), 1),
      point(ist(10, 4, 2, 31), 1, 1),
      point(ist(10, 4, 3, 1), 1, 0),
      point(ist(10, 3, 2, 31), 0, 0),
      point(ist(10, 1, 2, 31), 2, 0),
    ];
    const squares = daySquares(points, NOW);
    expect(squares[13].state).toBe("ok");
    expect(squares[12].state).toBe("failed");
    expect(squares[12].label).toBe("4 Oct: failed");
    // A bucket without runs (v 0) is not a run.
    expect(squares[11].state).toBe("none");
    expect(squares[9].state).toBe("ok");
    expect(squares[13].label).toBe("5 Oct: success");
  });

  it("uses IST midnight, not UTC midnight", () => {
    // 4 Oct 23:50 IST is 4 Oct 18:20 UTC; 5 Oct 00:10 IST is still 4 Oct in UTC.
    const lateRun = point(ist(10, 4, 23, 50), 1, 1);
    const earlyRun = point(ist(10, 5, 0, 10), 1, 0);
    const squares = daySquares([lateRun, earlyRun], NOW);
    expect(squares[12].state).toBe("failed");
    expect(squares[13].state).toBe("ok");
  });

  it("scheduled occurrences: off-schedule calls never turn a square red", () => {
    // Every occurrence ran fine; the off-schedule failures are only in otherCalls.
    const response = {
      points: Array.from({ length: 14 }, (_, i) => run(ist(9, 22 + i, 2, 30), "success")),
      otherCalls: { count: 12, failed: 12 },
    };
    const squares = daySquares(response.points, NOW);
    expect(squares.every((s) => s.state === "ok")).toBe(true);
    expect(squares.some((s) => s.state === "failed" || s.state === "missed")).toBe(false);
  });

  it("a failed and a missed occurrence are red squares titled failed and missed; upcoming leaves today empty", () => {
    const points = [
      run(ist(10, 3, 2, 30), "failed", 1, 1),
      run(ist(10, 4, 2, 30), "missed"),
      run(ist(10, 5, 2, 30), "upcoming"),
    ];
    const squares = daySquares(points, ist(10, 5, 2, 40));
    expect(squares[11]).toMatchObject({ state: "failed", label: "3 Oct: failed" });
    expect(squares[12]).toMatchObject({ state: "missed", label: "4 Oct: missed" });
    expect(squares[13]).toMatchObject({ state: "none", label: "5 Oct: no run" });
  });

  it("weekly job over 14 days: only the IST Sunday squares are coloured", () => {
    // Sundays 27 Sep and 4 Oct 03:00 IST are 21:30 UTC on the Saturday before.
    const points = [run(ist(9, 27, 3, 0), "success"), run(ist(10, 4, 3, 0), "missed")];
    const squares = daySquares(points, NOW);
    const coloured = squares.filter((s) => s.state !== "none");
    expect(coloured.map((s) => [s.start, s.state])).toEqual([
      [ist(9, 27, 0, 0), "ok"],
      [ist(10, 4, 0, 0), "missed"],
    ]);
    expect(coloured[1].label).toBe("4 Oct: missed");
    for (const s of coloured) expect(new Date(s.start + 330 * 60000).getUTCDay()).toBe(0);
  });

  it("ignores runs older than 14 days or unknown points", () => {
    const squares = daySquares([point(ist(9, 21, 2, 31), 1, 1), { t: "bad", v: 1 }], NOW);
    expect(squares.every((s) => s.state === "none")).toBe(true);
    expect(daySquares(null, NOW).every((s) => s.state === "none")).toBe(true);
  });
});
