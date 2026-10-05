import { describe, expect, it } from "vitest";
import { cpuMeter, instancesText, meterState, ramMeter } from "../src/meters";
import type { Kind, MetricRecord, ServiceMetrics } from "../src/types";

function svc(kind: Kind, metrics: MetricRecord): ServiceMetrics {
  return { id: `${kind}:x`, kind, name: "x", metrics, trend: { points: [] }, trends: {} };
}

describe("meterState", () => {
  it("is a % width for a running function", () => {
    expect(meterState(42.4, { active: true })).toEqual({ kind: "value", label: "42%", width: 42.4 });
    expect(meterState(140, { active: true }).width).toBe(100);
  });

  it("is idle for idle values, 0 or a function that is not running", () => {
    for (const [value, active] of [
      ["idle", true],
      [0, true],
      [35, false],
    ] as const) {
      expect(meterState(value, { active })).toEqual({ kind: "idle", label: "idle", width: 0 });
    }
  });

  it("is n/a when not reported and unknown when null", () => {
    expect(meterState(12, { active: true, na: true })).toEqual({ kind: "na", label: "n/a", width: 0 });
    expect(meterState(null, { active: true })).toEqual({ kind: "unknown", label: "—", width: 0 });
  });
});

describe("function meters", () => {
  it("1st gen CPU and instances are n/a, RAM is a meter", () => {
    const gen1 = svc("function1", { cpuPct: null, memPct: 12.5, execPerMin: 0 });
    expect(cpuMeter(gen1, true).kind).toBe("na");
    expect(instancesText(gen1)).toBe("n/a");
    expect(ramMeter(gen1, true)).toEqual({ kind: "value", label: "13%", width: 12.5 });
  });

  it("2nd gen: idle when idle, % otherwise", () => {
    const idle = svc("function2", { cpuPct: "idle", memPct: "idle", instances: 0 });
    expect(cpuMeter(idle, false).label).toBe("idle");
    expect(ramMeter(idle, false).label).toBe("idle");
    expect(instancesText(idle)).toBe("0");
    const busy = svc("function2", { cpuPct: 21.4, memPct: 38.9, instances: 2 });
    expect(cpuMeter(busy, true)).toEqual({ kind: "value", label: "21%", width: 21.4 });
    expect(ramMeter(busy, true).width).toBe(38.9);
    expect(instancesText(busy)).toBe("2");
    expect(instancesText(svc("function2", { instances: null }))).toBe("—");
  });
});
