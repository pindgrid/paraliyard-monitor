import { describe, expect, it } from "vitest";
import csv from "../data/paraliyard-services.csv?raw";
import sample from "../src/mock/sample-metrics.json";
import { COLUMNS, KIND_ORDER, MAX_KEYS, SERVICES } from "../src/services";
import type { Kind, MetricsResponse, MetricValue } from "../src/types";

const fixture = sample as unknown as MetricsResponse;

const TYPE_TO_KIND: Record<string, Kind> = {
  "Cloud Function (2nd gen)": "function2",
  "Cloud Function (1st gen)": "function1",
  "Firestore database": "firestore",
  "Storage bucket": "bucket",
  "Firebase Hosting site": "hosting",
  "Cloud Scheduler job": "scheduler",
};

function inventory(): { kind: Kind; name: string }[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0].split(",");
  const typeCol = header.indexOf("Type");
  const nameCol = header.indexOf("Name");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return { kind: TYPE_TO_KIND[cols[typeCol]], name: cols[nameCol] };
  });
}

function expectedTotal(key: string, values: MetricValue[]): MetricValue {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return null;
  if (key === "lastRunAt") {
    return (present as string[]).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  }
  if (key === "lastResult") return present.includes("failed") ? "failed" : "success";
  const numbers = present as number[];
  if (MAX_KEYS.has(key)) return Math.max(...numbers);
  return numbers.reduce((a, b) => a + b, 0);
}

describe("service list", () => {
  it("has one service per inventory row with matching kinds", () => {
    const rows = inventory();
    expect(rows).toHaveLength(17);
    expect(SERVICES).toHaveLength(17);
    for (const row of rows) {
      expect(row.kind).toBeDefined();
      const matches = SERVICES.filter((s) => s.kind === row.kind && s.name === row.name);
      expect(matches, `${row.kind}:${row.name}`).toHaveLength(1);
    }
  });

  it("uses unique kind:name ids", () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SERVICES) expect(s.id).toBe(`${s.kind}:${s.name}`);
  });

  it("covers every kind in the display order", () => {
    expect(new Set(SERVICES.map((s) => s.kind))).toEqual(new Set(KIND_ORDER));
  });
});

describe("mock fixture", () => {
  it("has exactly the service ids from services.ts", () => {
    expect(fixture.services.map((s) => s.id)).toEqual(SERVICES.map((s) => s.id));
  });

  it("is a 1h, non-stale response with 60 sorted trend points per service", () => {
    expect(fixture.window).toBe("1h");
    expect(fixture.stale).toBe(false);
    for (const s of fixture.services) {
      expect(s.trend.points, s.id).toHaveLength(60);
      const times = s.trend.points.map((p) => Date.parse(p.t));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it("has the metric keys of each kind's columns", () => {
    for (const s of fixture.services) {
      expect(Object.keys(s.metrics), s.id).toEqual(COLUMNS[s.kind].map((c) => c.key));
    }
    for (const kind of KIND_ORDER) {
      expect(Object.keys(fixture.totals[kind] ?? {}), kind).toEqual(COLUMNS[kind].map((c) => c.key));
    }
  });

  it("includes the documented nulls", () => {
    const byId = new Map(fixture.services.map((s) => [s.id, s]));
    expect(byId.get("function1:pyCleanupOnAuthDelete")?.metrics.cpuPct).toBeNull();
    expect(byId.get("hosting:paraliyard")?.metrics.reqPerMin).toBeNull();
    expect(byId.get("hosting:preparaliyard")?.metrics.reqPerMin).toBeNull();
    const results = fixture.services.filter((s) => s.kind === "scheduler").map((s) => s.metrics.lastResult);
    expect(results).toContain(null);
  });

  it("totals follow the totals rules", () => {
    for (const kind of KIND_ORDER) {
      const ofKind = fixture.services.filter((s) => s.kind === kind);
      for (const { key } of COLUMNS[kind]) {
        const expected = expectedTotal(key, ofKind.map((s) => s.metrics[key]));
        const actual = fixture.totals[kind]?.[key];
        if (typeof expected === "number") {
          expect(actual, `${kind}.${key}`).toBeCloseTo(expected, 6);
        } else {
          expect(actual, `${kind}.${key}`).toBe(expected);
        }
      }
    }
  });
});
