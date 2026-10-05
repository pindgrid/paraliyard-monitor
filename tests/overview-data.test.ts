import { describe, expect, it } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import type { TimePoint } from "../src/charts";
import { buildOverviewSpecs, pickTarget, type OverviewChart } from "../src/overview-data";
import { isAllowedPair } from "../src/routes";
import type { MetricsResponse } from "../src/types";

function fixture(): MetricsResponse {
  return structuredClone(sample) as unknown as MetricsResponse;
}

function chart(charts: OverviewChart[], id: string): OverviewChart {
  const found = charts.find((c) => c.id === id);
  if (!found) throw new Error(`missing chart ${id}`);
  return found;
}

describe("buildOverviewSpecs", () => {
  it("shapes the mock payload into six charts", () => {
    const charts = buildOverviewSpecs(fixture());
    expect(charts.map((c) => c.id)).toEqual(["requests", "cpuRam", "firestore", "bucketBytes", "hostingBytes", "scheduler"]);
    expect(charts.map((c) => c.spec.kind)).toEqual(["line", "bar", "line", "bar", "bar", "bar"]);
    for (const c of charts) expect(c.title.length).toBeGreaterThan(0);
  });

  it("requests: one line per 2nd gen function from trends.reqPerMin", () => {
    const requests = chart(buildOverviewSpecs(fixture()), "requests");
    expect(requests.spec.timeAxis).toBe(true);
    expect(requests.spec.datasets).toHaveLength(9);
    const mint = requests.spec.datasets.find((d) => d.label === "pyMintOnCrewClaim");
    expect((mint?.data as TimePoint[]).map((p) => p.y)).toEqual([3, 4, 2, 5, 3, 4]);
    expect((mint?.data as TimePoint[])[5].x).toBe(Date.parse("2026-01-01T12:00:00.000Z"));
  });

  it("CPU/RAM: grouped bars where idle is an empty bar labelled idle, never 0", () => {
    const cpuRam = chart(buildOverviewSpecs(fixture()), "cpuRam");
    expect(cpuRam.spec.datasets.map((d) => d.label)).toEqual(["CPU % (p99)", "RAM % (p99)"]);
    const idleIndex = cpuRam.spec.labels?.indexOf("pyWeeklyAccounts") ?? -1;
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    for (const dataset of cpuRam.spec.datasets) {
      expect(dataset.data[idleIndex]).toBeNull();
      expect(dataset.data[idleIndex]).not.toBe(0);
      expect(dataset.notes?.[idleIndex]).toBe("idle");
    }
    const mintIndex = cpuRam.spec.labels?.indexOf("pyMintOnCrewClaim") ?? -1;
    expect(cpuRam.spec.datasets[0].data[mintIndex]).toBe(21.4);
    expect(cpuRam.spec.datasets[0].notes?.[mintIndex]).toBeNull();
    const idleEntry = cpuRam.entries.find((e) => e.target.service === "function2:pyWeeklyAccounts");
    expect(idleEntry?.text).toContain("idle");
  });

  it("CPU/RAM: a failed value is an empty bar labelled not available", () => {
    const data = fixture();
    const target = data.services.find((s) => s.id === "function2:pyNightlyExport");
    if (!target) throw new Error("fixture missing service");
    target.metrics.cpuPct = null;
    const cpuRam = chart(buildOverviewSpecs(data), "cpuRam");
    const i = cpuRam.spec.labels?.indexOf("pyNightlyExport") ?? -1;
    expect(cpuRam.spec.datasets[0].data[i]).toBeNull();
    expect(cpuRam.spec.datasets[0].notes?.[i]).toBe("not available");
    expect(cpuRam.spec.datasets[1].data[i]).toBe(18.4);
  });

  it("firestore: separate reads, writes and deletes lines", () => {
    const fs = chart(buildOverviewSpecs(fixture()), "firestore");
    expect(fs.spec.datasets.map((d) => d.label)).toEqual(["Reads/min", "Writes/min", "Deletes/min"]);
    expect((fs.spec.datasets[0].data as TimePoint[]).map((p) => p.y)).toEqual([141, 150, 138, 145, 140, 143]);
    expect((fs.spec.datasets[2].data as TimePoint[]).map((p) => p.y)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(fs.datasetTargets.map((t) => t?.metric)).toEqual(["readsPerMin", "writesPerMin", "deletesPerMin"]);
  });

  it("bucket and hosting byte bars", () => {
    const charts = buildOverviewSpecs(fixture());
    const bucket = chart(charts, "bucketBytes");
    expect(bucket.spec.datasets[0].data).toEqual([42949673, 10737418]);
    const hosting = chart(charts, "hostingBytes");
    expect(hosting.spec.labels).toEqual(["paraliyard", "preparaliyard"]);
    expect(hosting.spec.datasets[0].data).toEqual([12582912, 0]);
    expect(hosting.spec.datasets[0].notes).toEqual([null, null]);
  });

  it("scheduler: hours since the last run with result colours and the no-run note", () => {
    const data = fixture();
    let scheduler = chart(buildOverviewSpecs(data), "scheduler");
    expect(scheduler.spec.datasets[0].data).toEqual([15, 110.5]);
    const colors = scheduler.spec.datasets[0].color as string[];
    expect(colors[0]).not.toBe(colors[1]);
    expect(scheduler.entries[0].text).toContain("success");
    expect(scheduler.entries[1].text).toContain("result not available");

    const nightly = data.services.find((s) => s.id === "scheduler:pyNightlyExport");
    if (!nightly) throw new Error("fixture missing service");
    nightly.metrics.lastRunAt = null;
    nightly.metrics.lastResult = "none";
    scheduler = chart(buildOverviewSpecs(data), "scheduler");
    expect(scheduler.spec.datasets[0].data[0]).toBeNull();
    expect(scheduler.spec.datasets[0].notes?.[0]).toBe("no run in 8 days");
    expect(scheduler.entries[0].text).toContain("no run in 8 days");
  });

  it("builds empty charts before the first payload", () => {
    const charts = buildOverviewSpecs(null);
    expect(charts).toHaveLength(6);
    for (const c of charts) for (const d of c.spec.datasets) expect(d.data.every((v) => v === null || typeof v === "object")).toBe(true);
    expect(chart(charts, "cpuRam").spec.datasets[0].notes?.every((n) => n === "not available")).toBe(true);
  });

  it("every chart element and legend target is an allowed history pair", () => {
    const charts = buildOverviewSpecs(fixture());
    let checked = 0;
    for (const c of charts) {
      c.spec.datasets.forEach((dataset, d) => {
        const legend = pickTarget(c, d, null);
        expect(legend, `${c.id} legend ${d}`).not.toBeNull();
        expect(isAllowedPair(legend!.service, legend!.metric)).toBe(true);
        dataset.data.forEach((_v, i) => {
          const target = pickTarget(c, d, i);
          expect(target, `${c.id} ${d} ${i}`).not.toBeNull();
          expect(isAllowedPair(target!.service, target!.metric), `${c.id} ${d} ${i}`).toBe(true);
          checked += 1;
        });
      });
      for (const entry of c.entries) expect(isAllowedPair(entry.target.service, entry.target.metric)).toBe(true);
    }
    expect(checked).toBeGreaterThan(50);
    expect(pickTarget(charts[0], 99, 0)).toBeNull();
  });
});
