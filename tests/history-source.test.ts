import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import allowlist from "../src/history-allowlist.json";
import {
  HISTORY_UNITS,
  MOCK_RETENTION_SECONDS,
  createLiveHistorySource,
  createMockHistorySource,
} from "../src/history-source";
import { COUNT_METRICS, HISTORY_RANGES, alignmentSeconds, rangeSeconds } from "../src/routes";
import { SERVICES } from "../src/services";

const NOW = Date.UTC(2026, 9, 5, 8, 30, 17);

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const GOOD = {
  service: "firestore:yard",
  metric: "readsPerMin",
  range: "24h",
  unit: "per minute",
  points: [{ t: "2026-10-05T08:25:00.000Z", v: 3 }],
  generatedAt: "2026-10-05T08:30:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createMockHistorySource", () => {
  it("is identical for identical (service, metric, range, time)", async () => {
    const a = createMockHistorySource(() => NOW);
    const b = createMockHistorySource(() => NOW);
    for (const range of HISTORY_RANGES) {
      expect(await a.load("firestore:yard", "readsPerMin", range)).toEqual(await b.load("firestore:yard", "readsPerMin", range));
    }
    const other = await a.load("firestore:yard", "writesPerMin", "24h");
    expect(other.points.map((p) => p.v)).not.toEqual((await a.load("firestore:yard", "readsPerMin", "24h")).points.map((p) => p.v));
  });

  it("makes zero fetch calls", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const source = createMockHistorySource(() => NOW);
    for (const s of SERVICES) {
      for (const metric of allowlist.metricsByKind[s.kind]) await source.load(s.id, metric, "1h");
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("puts points on the alignment grid ending at floor(now / alignment)", async () => {
    const source = createMockHistorySource(() => NOW);
    for (const range of HISTORY_RANGES) {
      const { points, unit, generatedAt } = await source.load("function2:pyMintOnCrewClaim", "reqPerMin", range);
      const step = alignmentSeconds(range) * 1000;
      const times = points.map((p) => Date.parse(p.t));
      expect(times[times.length - 1]).toBe(Math.floor(NOW / step) * step);
      for (const t of times) expect(t % step).toBe(0);
      expect(points.length).toBeLessThanOrEqual(rangeSeconds(range) / alignmentSeconds(range));
      expect(unit).toBe("per minute");
      expect(generatedAt).toBe(new Date(NOW).toISOString());
    }
  });

  it("keeps gauges within 0-100 % and counts at or above 0", async () => {
    const source = createMockHistorySource(() => NOW);
    for (const s of SERVICES) {
      for (const metric of allowlist.metricsByKind[s.kind]) {
        const { points } = await source.load(s.id, metric, "24h");
        for (const p of points) {
          if (metric === "cpuPct" || metric === "memPct") {
            expect(p.v).toBeGreaterThanOrEqual(0);
            expect(p.v).toBeLessThanOrEqual(100);
          }
          if (COUNT_METRICS.has(metric)) expect(p.v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("has the deliberate empty and late-start cases", async () => {
    const source = createMockHistorySource(() => NOW);
    expect((await source.load("function2:pyWeeklyAccounts", "cpuPct", "24h")).points).toEqual([]);
    expect((await source.load("function2:pyWeeklyAccounts", "memPct", "7d")).points).toEqual([]);
    expect((await source.load("function2:pyMintOnCrewClaim", "cpuPct", "24h")).points.length).toBeGreaterThan(0);
    expect((await source.load("bucket:mineral-proton-438104-g8-paraliyard", "bytesStored", "1h")).points).toEqual([]);
    expect((await source.load("bucket:mineral-proton-438104-g8-paraliyard", "bytesStored", "6h")).points).toEqual([]);
    expect((await source.load("bucket:mineral-proton-438104-g8-paraliyard", "bytesStored", "7d")).points.length).toBe(168);
    for (const range of ["30d", "6w"] as const) {
      const { points } = await source.load("firestore:yard", "readsPerMin", range);
      const first = Date.parse(points[0].t);
      expect(first).toBeGreaterThan(NOW - rangeSeconds(range) * 1000 + alignmentSeconds(range) * 1000);
      expect(first).toBeGreaterThanOrEqual(NOW - MOCK_RETENTION_SECONDS * 1000);
    }
  });

  it("knows a unit for every allowlisted metric", () => {
    for (const metrics of Object.values(allowlist.metricsByKind)) {
      for (const metric of metrics) expect(HISTORY_UNITS[metric], metric).toBeTruthy();
    }
    expect(HISTORY_UNITS.runs).toBe("runs");
  });

  it("returns scheduler runs as scheduled occurrences, deterministically, with failed, missed and other calls", async () => {
    const a = await createMockHistorySource(() => NOW).load("scheduler:pyNightlyExport", "runs", "30d");
    const b = await createMockHistorySource(() => NOW).load("scheduler:pyNightlyExport", "runs", "30d");
    expect(a).toEqual(b);
    expect(a.unit).toBe("runs");
    // One point per 02:30 IST occurrence within the mock retention.
    expect(a.points.length).toBeGreaterThanOrEqual(23);
    for (const p of a.points) {
      expect(new Date(p.t).toISOString().slice(11)).toBe("21:00:00.000Z");
      expect(["success", "failed", "missed", "upcoming"]).toContain(p.result);
      expect(p.v).toBe(p.requests);
      expect(p.failed ?? 0).toBeLessThanOrEqual(p.requests ?? 0);
    }
    expect(a.points.some((p) => p.result === "failed" && (p.failed ?? 0) > 0)).toBe(true);
    expect(a.points.some((p) => p.result === "missed" && p.requests === 0)).toBe(true);
    expect(a.points.some((p) => p.result === "success")).toBe(true);
    expect(a.otherCalls?.count).toBeGreaterThan(0);
    expect(a.otherCalls?.failed).toBeGreaterThan(0);
    // Other metrics carry no otherCalls.
    expect("otherCalls" in (await createMockHistorySource(() => NOW).load("firestore:yard", "readsPerMin", "24h"))).toBe(false);
  });

  it("marks a run whose window is still open as upcoming", async () => {
    // 5 Oct 2026, 2:40 am IST: ten minutes into the nightly window.
    const at = Date.UTC(2026, 9, 4, 21, 10);
    const { points } = await createMockHistorySource(() => at).load("scheduler:pyNightlyExport", "runs", "7d");
    expect(points[points.length - 1]).toMatchObject({ t: "2026-10-04T21:00:00.000Z", result: "upcoming", v: 0, requests: 0, failed: 0 });
  });
});

describe("createLiveHistorySource", () => {
  it("GETs /api/history with the three query parameters, JSON accept and an abort signal", async () => {
    const fetchFn = vi.fn(async () => fakeResponse(GOOD));
    const data = await createLiveHistorySource(fetchFn as unknown as typeof fetch).load("firestore:yard", "readsPerMin", "24h");
    expect(data).toEqual(GOOD);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/history?service=firestore%3Ayard&metric=readsPerMin&range=24h");
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the scheduler runs shape with per-run fields and otherCalls", async () => {
    const runs = {
      service: "scheduler:pyNightlyExport",
      metric: "runs",
      range: "30d",
      unit: "runs",
      points: [
        { t: "2026-09-18T21:00:00.000Z", v: 0, result: "missed", requests: 0, failed: 0 },
        { t: "2026-10-04T21:00:00.000Z", v: 1, result: "success", requests: 1, failed: 0 },
        { t: "2026-10-05T21:00:00.000Z", v: 0, result: "upcoming", requests: 0, failed: 0 },
      ],
      generatedAt: "2026-10-05T21:10:00.000Z",
      otherCalls: { count: 4, failed: 4 },
    };
    const fetchFn = vi.fn(async () => fakeResponse(runs));
    const data = await createLiveHistorySource(fetchFn as unknown as typeof fetch).load("scheduler:pyNightlyExport", "runs", "30d");
    expect(data).toEqual(runs);
    expect(data.otherCalls).toEqual({ count: 4, failed: 4 });
    expect(data.points.map((p) => p.result)).toEqual(["missed", "success", "upcoming"]);
    // A stale answer keeps the same shape.
    const stale = vi.fn(async () => fakeResponse({ ...runs, stale: true }));
    expect((await createLiveHistorySource(stale as unknown as typeof fetch).load("scheduler:pyNightlyExport", "runs", "30d")).stale).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed otherCalls or run point", async () => {
    const base = {
      service: "scheduler:pyNightlyExport",
      metric: "runs",
      range: "30d",
      unit: "runs",
      points: [{ t: "2026-10-04T21:00:00.000Z", v: 1, result: "success", requests: 1, failed: 0 }],
      generatedAt: "2026-10-05T21:10:00.000Z",
      otherCalls: { count: 0, failed: 0 },
    };
    for (const body of [
      { ...base, otherCalls: { count: "4", failed: 4 } },
      { ...base, otherCalls: null },
      { ...base, otherCalls: { count: 4 } },
      { ...base, points: [{ ...base.points[0], result: "late" }] },
      { ...base, points: [{ ...base.points[0], requests: "1" }] },
      { ...base, points: [{ ...base.points[0], failed: null }] },
    ]) {
      const fetchFn = vi.fn(async () => fakeResponse(body));
      await expect(
        createLiveHistorySource(fetchFn as unknown as typeof fetch).load("scheduler:pyNightlyExport", "runs", "30d"),
      ).rejects.toThrow(/unexpected shape/);
    }
  });

  it("rejects non-200 responses", async () => {
    for (const status of [400, 429, 502]) {
      const fetchFn = vi.fn(async () => fakeResponse({ error: "x" }, status));
      await expect(
        createLiveHistorySource(fetchFn as unknown as typeof fetch).load("firestore:yard", "readsPerMin", "24h"),
      ).rejects.toThrow(String(status));
    }
  });

  it("rejects bad shapes", async () => {
    const bad = [
      null,
      [],
      {},
      { ...GOOD, points: "x" },
      { ...GOOD, points: [{ t: 1, v: 2 }] },
      { ...GOOD, points: [{ t: "x", v: "2" }] },
      { ...GOOD, range: "2h" },
      { ...GOOD, unit: undefined },
      { ...GOOD, generatedAt: 5 },
    ];
    for (const body of bad) {
      const fetchFn = vi.fn(async () => fakeResponse(body));
      await expect(
        createLiveHistorySource(fetchFn as unknown as typeof fetch).load("firestore:yard", "readsPerMin", "24h"),
      ).rejects.toThrow();
    }
  });

  it("aborts after 15 s", async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = createLiveHistorySource(fetchFn as unknown as typeof fetch).load("firestore:yard", "readsPerMin", "1h");
    const assertion = expect(result).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await assertion;
  });
});
