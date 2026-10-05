import { istDay } from "./fmt";
import { DAY_MS, istDayStart } from "./schedule";
import type { HistoryPoint } from "./types";

export type DayState = "ok" | "failed" | "none";

export interface DaySquare {
  // Epoch ms of the IST midnight that starts the day.
  start: number;
  state: DayState;
  label: string;
}

export const DAY_SQUARES = 14;

const LABELS: Record<DayState, string> = { ok: "success", failed: "failed", none: "no run" };

// One square per IST day, oldest first, ending today: "failed" when any run
// that day failed, "ok" when it ran and none failed, otherwise "none".
export function daySquares(points: readonly HistoryPoint[] | null | undefined, nowMs: number, days = DAY_SQUARES): DaySquare[] {
  const today = istDayStart(nowMs);
  const runs = (points ?? [])
    .map((p) => ({ t: Date.parse(p.t), v: p.v, failed: p.failed ?? 0 }))
    .filter((p) => Number.isFinite(p.t) && p.v > 0);
  const out: DaySquare[] = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    const start = today - d * DAY_MS;
    const dayRuns = runs.filter((p) => p.t >= start && p.t < start + DAY_MS);
    const state: DayState = dayRuns.length === 0 ? "none" : dayRuns.some((p) => p.failed > 0) ? "failed" : "ok";
    out.push({ start, state, label: `${istDay(start)}: ${LABELS[state]}` });
  }
  return out;
}
