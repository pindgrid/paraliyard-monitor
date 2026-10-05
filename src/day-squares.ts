import { istDay } from "./fmt";
import { DAY_MS, istDayStart } from "./schedule";
import type { HistoryPoint } from "./types";

// "missed": a scheduled run had no request in its window. Drawn red like "failed".
// Occurrences before the job's first run ("before-first-run") draw as "none".
export type DayState = "ok" | "failed" | "missed" | "none";

export interface DaySquare {
  // Epoch ms of the IST midnight that starts the day.
  start: number;
  state: DayState;
  label: string;
}

export const DAY_SQUARES = 14;

const LABELS: Record<DayState, string> = { ok: "success", failed: "failed", missed: "missed", none: "no run" };

type RunState = Exclude<DayState, "none">;

// State of one runs point: scheduled occurrences carry their result (an
// upcoming run, or one before the job's first run, is not a state); older
// points without one count as a run when v > 0, failed when any was non-2xx.
function runState(p: HistoryPoint): RunState | null {
  if (p.result === "success") return "ok";
  if (p.result === "failed" || p.result === "missed") return p.result;
  if (p.result === "upcoming" || p.result === "before-first-run") return null;
  if (!(p.v > 0)) return null;
  return (p.failed ?? 0) > 0 ? "failed" : "ok";
}

// One square per IST day of the scheduled time, oldest first, ending today:
// "failed" when any run that day failed, else "missed" when one was missed,
// "ok" when it ran, otherwise "none". Off-schedule calls never reach here.
export function daySquares(points: readonly HistoryPoint[] | null | undefined, nowMs: number, days = DAY_SQUARES): DaySquare[] {
  const today = istDayStart(nowMs);
  const runs = (points ?? [])
    .map((p) => ({ t: Date.parse(p.t), state: runState(p) }))
    .filter((p): p is { t: number; state: RunState } => Number.isFinite(p.t) && p.state !== null);
  const out: DaySquare[] = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    const start = today - d * DAY_MS;
    const dayRuns = runs.filter((p) => p.t >= start && p.t < start + DAY_MS).map((p) => p.state);
    const state: DayState = dayRuns.includes("failed")
      ? "failed"
      : dayRuns.includes("missed")
        ? "missed"
        : dayRuns.includes("ok")
          ? "ok"
          : "none";
    out.push({ start, state, label: `${istDay(start)}: ${LABELS[state]}` });
  }
  return out;
}
