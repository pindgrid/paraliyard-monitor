import { describe, expect, it } from "vitest";
import { DEMO_START, demoHistory, demoModel, demoValue } from "../src/demo";
import { DAY, MIN } from "../src/format";

const NOW = Date.UTC(2026, 9, 7, 6, 0);

describe("demo data", () => {
  it("is deterministic and has nothing before the data starts", () => {
    expect(demoValue("firestore:yard", "readsPerMin", NOW)).toBe(demoValue("firestore:yard", "readsPerMin", NOW));
    expect(demoValue("firestore:yard", "readsPerMin", DEMO_START - MIN)).toBeNull();
  });

  it("builds the same shape as the live adapter", () => {
    const m = demoModel(NOW);
    expect(m.minutes).toHaveLength(30);
    expect(m.functions).toHaveLength(10);
    expect(m.buckets).toHaveLength(2);
    expect(m.sites).toHaveLength(2);
    expect(m.jobs.map((j) => j.lastResult)).toEqual(["success", "success"]);
    expect(m.buckets.every((b) => (b.bytes ?? 0) > 1e6)).toBe(true);
  });

  it("history: sparse counts, levels every step, a nightly run every day", () => {
    const reads = demoHistory("firestore:yard", "readsPerMin", "24h", NOW).points;
    expect(reads.length).toBeGreaterThan(50);
    expect(reads.every((p) => p.v > 0)).toBe(true);
    const stored = demoHistory("total:bucket", "bytesStored", "30d", NOW).points;
    expect(stored[stored.length - 1].v).toBeGreaterThan(stored[0].v);
    const runs = demoHistory("scheduler:pyNightlyExport", "runs", "7d", NOW).points;
    expect(runs).toHaveLength(7);
    expect(runs.every((r) => r.result === "success")).toBe(true);
    expect(runs[1].t - runs[0].t).toBe(DAY);
  });
});
