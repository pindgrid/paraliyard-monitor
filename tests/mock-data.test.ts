import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import allowlist from "../src/history-allowlist.json";
import { createLiveHistorySource, createMockHistorySource, HISTORY_UNITS, MOCK_RETENTION_SECONDS } from "../src/history-source";
import { ERROR_SERVICE, mockRecent } from "../src/mock/recent";
import { HISTORY_RANGES, rangeSeconds } from "../src/routes";
import { nextRunAt, occurrencesBetween } from "../src/schedule";
import { JOB_SCHEDULES, RECENT_KEYS, SERVICES } from "../src/services";
import { createMockSource } from "../src/source";
import type { HistoryRange } from "../src/types";

const NOW = Date.UTC(2026, 9, 5, 8, 30, 17);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mockRecent", () => {
  it("is deterministic and has 30 values per key of the kind", () => {
    for (const s of SERVICES) {
      const a = mockRecent(s.id, s.kind, NOW);
      expect(a).toEqual(mockRecent(s.id, s.kind, NOW));
      expect(Object.keys(a.series)).toEqual([...RECENT_KEYS[s.kind]]);
      for (const values of Object.values(a.series)) {
        expect(values).toHaveLength(30);
        for (const v of values ?? []) expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(a.stepSeconds).toBe(60);
      expect(a.from).toBe(new Date(Date.UTC(2026, 9, 5, 8, 0, 0)).toISOString());
    }
  });

  it("slides with time: one minute later shifts the series by one slot", () => {
    const a = mockRecent("firestore:yard", "firestore", NOW);
    const b = mockRecent("firestore:yard", "firestore", NOW + 60000);
    expect(b.series.readsPerMin?.slice(0, 29)).toEqual(a.series.readsPerMin?.slice(1));
  });

  it("has an idle 2nd gen function, a minute with errors and the 1st gen function", () => {
    const idle = mockRecent("function2:pyWeeklyAccounts", "function2", NOW);
    expect(idle.series.reqPerMin?.every((v) => v === 0)).toBe(true);
    expect(idle.series.errPerMin?.every((v) => v === 0)).toBe(true);
    // Any 30-minute window holds exactly one error minute for ERROR_SERVICE.
    for (let m = 0; m < 45; m += 1) {
      const errors = mockRecent(ERROR_SERVICE, "function2", NOW + m * 60000).series.errPerMin ?? [];
      expect(errors.filter((v) => (v ?? 0) > 0)).toHaveLength(1);
      const i = errors.findIndex((v) => (v ?? 0) > 0);
      expect(mockRecent(ERROR_SERVICE, "function2", NOW + m * 60000).series.reqPerMin?.[i]).toBeGreaterThan(0);
    }
    const gen1 = mockRecent("function1:pyCleanupOnAuthDelete", "function1", NOW);
    expect(Object.keys(gen1.series)).toEqual(["execPerMin"]);
  });
});

describe("createMockSource additions", () => {
  it("attaches recent to every service and the schedule fields to jobs, without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const data = await createMockSource(() => NOW).load();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    for (const s of data.services) {
      expect(s.recent).toEqual(mockRecent(s.id, s.kind, NOW));
      if (s.kind === "scheduler") {
        const job = JOB_SCHEDULES[s.id];
        expect(s.schedule).toBe(job.schedule);
        expect(s.cron).toBe(job.cron);
        expect(s.timeZone).toBe("Asia/Kolkata");
        expect(s.nextRun).toBe(new Date(nextRunAt(job.cron, NOW)).toISOString());
        expect(Object.keys(s).slice(-5)).toEqual(["recent", "schedule", "cron", "timeZone", "nextRun"]);
      } else {
        expect(s.nextRun).toBeUndefined();
        expect(Object.keys(s).slice(-1)).toEqual(["recent"]);
      }
    }
  });
});

const AGGREGATES = allowlist.aggregates as Record<string, string[]>;

// Deliberately empty mock answers.
function expectEmpty(service: string, metric: string, range: HistoryRange): boolean {
  if ((metric === "cpuPct" || metric === "memPct") && service === "function2:pyWeeklyAccounts") return true;
  if (metric === "bytesStored" && (range === "1h" || range === "6h")) return true;
  // Runs have one point per scheduled occurrence in the range (within the mock retention).
  if (metric === "runs") {
    const from = Math.max(NOW - rangeSeconds(range) * 1000, NOW - MOCK_RETENTION_SECONDS * 1000);
    return occurrencesBetween(JOB_SCHEDULES[service].cron, from, NOW).length === 0;
  }
  // A job has a duration point only for runs that happened.
  return metric === "durationSec" && !["7d", "30d", "6w"].includes(range);
}

describe("createMockHistorySource", () => {
  it("returns points for every allowlisted pair, aggregate and range", async () => {
    const source = createMockHistorySource(() => NOW);
    const pairs: [string, string][] = [];
    for (const s of SERVICES) for (const metric of allowlist.metricsByKind[s.kind as keyof typeof allowlist.metricsByKind]) pairs.push([s.id, metric]);
    for (const [id, metrics] of Object.entries(AGGREGATES)) for (const metric of metrics) pairs.push([id, metric]);
    for (const [service, metric] of pairs) {
      for (const range of HISTORY_RANGES) {
        const res = await source.load(service, metric, range);
        expect(res.unit, `${service} ${metric}`).toBe(HISTORY_UNITS[metric]);
        if (!expectEmpty(service, metric, range)) expect(res.points.length, `${service} ${metric} ${range}`).toBeGreaterThan(0);
        if (metric === "durationSec" && ["7d", "30d", "6w"].includes(range)) expect(res.points.length).toBeGreaterThan(0);
      }
    }
  });

  it("aggregates sum their services", async () => {
    const source = createMockHistorySource(() => NOW);
    const total = await source.load("total:bucket", "bytesStored", "7d");
    const a = await source.load("bucket:mineral-proton-438104-g8-paraliyard", "bytesStored", "7d");
    const b = await source.load("bucket:mineral-proton-438104-g8-yard-backups", "bytesStored", "7d");
    expect(total.points.map((p) => p.v)).toEqual(a.points.map((p, i) => Number((p.v + b.points[i].v).toFixed(2))));
    expect(total.service).toBe("total:bucket");
  });

  it("scheduler runs are one point per occurrence; durations sit in the windows of runs that happened", async () => {
    const source = createMockHistorySource(() => NOW);
    const runs = await source.load("scheduler:pyNightlyExport", "runs", "30d");
    // 24 days of mock retention: one nightly occurrence per day.
    expect(runs.points.length).toBeGreaterThanOrEqual(23);
    expect(runs.points.every((p) => typeof p.failed === "number" && (p.failed ?? 0) <= p.v)).toBe(true);
    const happened = runs.points.filter((p) => p.result === "success" || p.result === "failed");
    expect(happened.some((p) => (p.failed ?? 0) > 0)).toBe(true);
    expect(happened.some((p) => p.failed === 0)).toBe(true);
    expect(runs.points.some((p) => p.result === "missed")).toBe(true);
    const durations = await source.load("scheduler:pyNightlyExport", "durationSec", "30d");
    expect(durations.points).toHaveLength(happened.length);
    durations.points.forEach((p, i) => {
      const s = Date.parse(happened[i].t);
      const end = Date.parse(p.t);
      // A 5-minute bucket (end - 300 s, end] that overlaps [s, s + 30 min].
      expect(end % 300000).toBe(0);
      expect(end).toBeGreaterThan(s);
      expect(end - 300000).toBeLessThan(s + 30 * 60000);
      expect(p.v).toBeGreaterThanOrEqual(38);
    });
    const weekly = await source.load("scheduler:pyWeeklyAccounts", "runs", "6w");
    expect(weekly.points.length).toBeGreaterThan(0);
    for (const p of weekly.points) {
      // 03:00 IST on a Sunday is 21:30 UTC on a Saturday.
      expect(new Date(p.t).getUTCDay()).toBe(6);
      expect(new Date(p.t).toISOString().slice(11)).toBe("21:30:00.000Z");
    }
  });

  it("is deterministic for aggregates, durations and runs", async () => {
    const a = createMockHistorySource(() => NOW);
    const b = createMockHistorySource(() => NOW);
    for (const [service, metric] of [
      ["total:function2", "reqPerMin"],
      ["total:hosting", "bytesServed"],
      ["scheduler:pyWeeklyAccounts", "runs"],
      ["scheduler:pyNightlyExport", "durationSec"],
    ]) {
      expect(await a.load(service, metric, "6w")).toEqual(await b.load(service, metric, "6w"));
    }
  });
});

describe("createLiveHistorySource allowlist", () => {
  function fakeResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  it("requests total:* ids with the three allowlisted parameters", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const params = new URL(url, "http://x").searchParams;
      return fakeResponse({
        service: params.get("service"),
        metric: params.get("metric"),
        range: params.get("range"),
        unit: "per minute",
        points: [{ t: "2026-10-05T08:25:00.000Z", v: 3, failed: 1 }],
        generatedAt: "2026-10-05T08:30:00.000Z",
      });
    });
    const source = createLiveHistorySource(fetchFn as unknown as typeof fetch);
    const res = await source.load("total:function2", "errPerMin", "1h");
    expect(res.points[0].failed).toBe(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/history?service=total%3Afunction2&metric=errPerMin&range=1h");
  });

  it("rejects anything outside the allowlist without a request", async () => {
    const fetchFn = vi.fn();
    const source = createLiveHistorySource(fetchFn as unknown as typeof fetch);
    for (const [service, metric, range] of [
      ["total:function2", "cpuPct", "1h"],
      ["total:firestore", "readsPerMin", "1h"],
      ["function2:pyMintOnCrewClaim", "durationSec", "1h"],
      ["firestore:yard", "readsPerMin", "2d"],
      ["../admin", "readsPerMin", "1h"],
    ]) {
      await expect(source.load(service, metric, range as HistoryRange)).rejects.toThrow(/allowlisted/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
