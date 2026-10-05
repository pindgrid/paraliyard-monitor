import { DASH, fmt } from "./fmt";
import type { MetricValue, ServiceMetrics } from "./types";

export type MeterKind = "value" | "idle" | "na" | "unknown";

export interface MeterState {
  kind: MeterKind;
  label: string;
  // Bar width in percent (0 unless kind is "value").
  width: number;
}

export const NOT_REPORTED = "n/a";

// "n/a" when the metric is not reported, "—" when unknown, "idle" when the
// function is not running or reports 0 / idle, otherwise the % width.
export function meterState(value: MetricValue | undefined, { active, na = false }: { active: boolean; na?: boolean }): MeterState {
  if (na) return { kind: "na", label: NOT_REPORTED, width: 0 };
  if (value === null || value === undefined) return { kind: "unknown", label: DASH, width: 0 };
  if (value === "idle" || !active || value === 0 || typeof value !== "number") return { kind: "idle", label: "idle", width: 0 };
  return { kind: "value", label: fmt.pct(value), width: Math.max(0, Math.min(100, value)) };
}

// 1st gen functions report no CPU utilisation.
export function cpuMeter(service: ServiceMetrics, active: boolean): MeterState {
  return meterState(service.metrics.cpuPct, { active, na: service.kind === "function1" });
}

export function ramMeter(service: ServiceMetrics, active: boolean): MeterState {
  return meterState(service.metrics.memPct, { active });
}

// 1st gen functions report no instances.
export function instancesText(service: ServiceMetrics): string {
  if (service.kind === "function1") return NOT_REPORTED;
  const v = service.metrics.instances;
  return typeof v === "number" ? fmt.int(v) : DASH;
}
