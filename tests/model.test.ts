import { describe, expect, it } from "vitest";
import { DAY, HOUR, MIN } from "../src/format";
import {
  JOBS,
  addSeries,
  daySquares,
  fnStatus,
  fromApi,
  health,
  occurrence,
  seriesStats,
  shortBucket,
  storageGrowth,
  type ApiMetrics,
  type FnInfo,
  type Model,
} from "../src/model";
import fixture from "./fixtures/api-metrics.json";

const api = fixture as unknown as ApiMetrics;

describe("fromApi (a real GET /api/metrics answer)", () => {
  const m = fromApi(api, Date.parse(api.generatedAt));

  it("reads every service of the yard", () => {
    expect(m.functions).toHaveLength(10);
    expect(m.functions.filter((f) => f.gen === 1).map((f) => f.name)).toEqual(["pyCleanupOnAuthDelete"]);
    expect(m.buckets.map((b) => shortBucket(b.name))).toEqual(["paraliyard", "yard-backups"]);
    expect(m.sites.map((s) => s.name)).toEqual(["paraliyard", "preparaliyard"]);
    expect(m.jobs.map((j) => j.name)).toEqual(["pyNightlyExport", "pyWeeklyAccounts"]);
    expect(m.firestore.name).toBe("yard");
  });

  it("keeps the 30 per-minute series and their minutes", () => {
    expect(m.minutes).toHaveLength(30);
    expect(m.minutes[1] - m.minutes[0]).toBe(MIN);
    expect(m.firestore.reads).toHaveLength(30);
    for (const f of m.functions) expect(f.req).toHaveLength(30);
    expect(m.functions.find((f) => f.gen === 1)!.err).toBeNull();
  });

  it("maps utilisations, instances, bytes and job results", () => {
    for (const f of m.functions) {
      if (f.gen === 1) expect(f.cpu).toBe("na");
      else expect(typeof f.cpu === "number" || f.cpu === "idle" || f.cpu === null).toBe(true);
    }
    expect(m.buckets.every((b) => typeof b.bytes === "number" && b.bytes > 0)).toBe(true);
    const nightly = m.jobs[0];
    expect(nightly.schedule).toBe("Every day, 2:30 am");
    expect(typeof nightly.lastRunAt).toBe("number");
    expect(nightly.lastResult).toBe("success");
    expect(nightly.nextRun! > m.generatedAt).toBe(true);
  });

  it("survives a malformed answer", () => {
    const empty = fromApi({ generatedAt: "nope", services: [] } as ApiMetrics, 1_000_000);
    expect(empty.functions).toEqual([]);
    expect(empty.generatedAt).toBe(1_000_000);
    expect(empty.minutes).toHaveLength(30);
  });
});

const fn = (over: Partial<FnInfo>): FnInfo => ({ id: "function2:x", name: "x", gen: 2, req: [0, 0], err: [0, 0], cpu: "idle", ram: "idle", instances: 0, ...over });

describe("status and health", () => {
  it("fnStatus: errors first, then activity or a live instance, else idle", () => {
    expect(fnStatus(fn({ err: [0, 1] }))).toBe("error");
    expect(fnStatus(fn({ req: [0, 2] }))).toBe("active");
    expect(fnStatus(fn({ instances: 1 }))).toBe("active");
    expect(fnStatus(fn({}))).toBe("idle");
  });

  const model = (over: Partial<Model>): Model => ({
    generatedAt: 0,
    minutes: [],
    firestore: { id: "firestore:yard", name: "yard", reads: null, writes: null, deletes: null },
    functions: [fn({})],
    buckets: [],
    sites: [],
    jobs: [{ id: "scheduler:pyNightlyExport", name: "pyNightlyExport", schedule: "", lastRunAt: 1, lastResult: "success", nextRun: 2 }],
    ...over,
  });

  it("is healthy without errors or failed jobs", () => {
    expect(health(model({}))).toEqual({ ok: true, reasons: [], errs: 0 });
  });

  it("names function errors first, then failed or missed jobs", () => {
    const h = health(
      model({
        functions: [fn({ err: [1, 1] })],
        jobs: [{ id: "scheduler:pyNightlyExport", name: "pyNightlyExport", schedule: "", lastRunAt: 1, lastResult: "missed", nextRun: 2 }],
      }),
    );
    expect(h.ok).toBe(false);
    expect(h.errs).toBe(2);
    expect(h.reasons).toEqual([
      { text: "2 function errors in the last 30 min", open: "sum:functions" },
      { text: "pyNightlyExport missed", open: "job:scheduler:pyNightlyExport" },
    ]);
  });
});

describe("schedules (IST)", () => {
  // Wed 7 Oct 2026, 1:00 am IST.
  const NIGHT = Date.UTC(2026, 9, 6, 19, 30);

  it("finds the next and previous nightly run at 2:30 am IST", () => {
    const job = JOBS["scheduler:pyNightlyExport"];
    expect(occurrence(job, NIGHT, 1)).toBe(Date.UTC(2026, 9, 6, 21, 0));
    expect(occurrence(job, NIGHT, -1)).toBe(Date.UTC(2026, 9, 5, 21, 0));
  });

  it("only runs the weekly job on Sundays at 3:00 am IST", () => {
    const job = JOBS["scheduler:pyWeeklyAccounts"];
    // Sunday 11 Oct 2026, 3:00 am IST.
    expect(occurrence(job, NIGHT, 1)).toBe(Date.UTC(2026, 9, 10, 21, 30));
    // Sunday 4 Oct 2026, 3:00 am IST.
    expect(occurrence(job, NIGHT, -1)).toBe(Date.UTC(2026, 9, 3, 21, 30));
  });

  it("day squares: weekly job colours only Sundays, nightly shows not-yet-due today", () => {
    const now = Date.UTC(2026, 9, 6, 19, 30);
    const nightlyRuns = Array.from({ length: 13 }, (_, k) => ({ t: Date.UTC(2026, 9, 5 - k, 21, 0), v: 1, result: "success" }));
    const nightly = daySquares("scheduler:pyNightlyExport", nightlyRuns, now);
    expect(nightly).toHaveLength(14);
    expect(nightly.slice(0, 13).every((c) => c.cls === "ok")).toBe(true);
    expect(nightly[13].cls).toBe("wait");
    const weekly = daySquares("scheduler:pyWeeklyAccounts", [{ t: Date.UTC(2026, 9, 3, 21, 30), v: 1, result: "success" }], now);
    expect(weekly.filter((c) => c.cls === "ok")).toHaveLength(1);
    expect(weekly.filter((c) => c.cls !== "off").every((c) => c.letter === "S")).toBe(true);
    const failed = daySquares("scheduler:pyNightlyExport", [{ t: Date.UTC(2026, 9, 5, 21, 0), v: 1, result: "failed" }], now);
    expect(failed[12].cls).toBe("fail");
  });
});

describe("series helpers", () => {
  it("adds series per minute and summarises one", () => {
    expect(addSeries([[1, 2], null, [3, null]])).toEqual([4, 2]);
    expect(addSeries([null])).toBeNull();
    expect(seriesStats([1, 3, null, 2])).toEqual({ now: 2, avg: 2, peak: 3, total: 6 });
    expect(seriesStats(null)).toEqual({ now: null, avg: null, peak: null, total: null });
  });

  it("storage growth is bytes per day over the last 7 days", () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ t: i * DAY, v: 100e6 + i * 2e6 }));
    expect(storageGrowth(pts)).toBeCloseTo(2e6);
    expect(storageGrowth([{ t: 0, v: 1 }, { t: HOUR, v: 2 }])).toBeNull();
    expect(storageGrowth(null)).toBeNull();
  });
});
