import { describe, expect, it } from "vitest";
import { JOB_RANGES, LINE_RANGES, groupFor, liveValue, openerForTarget } from "../src/drawer-groups";
import { isAllowedHistoryTarget } from "../src/history-source";
import { SERVICES } from "../src/services";
import { createMockSource } from "../src/source";

const OPENERS = [
  "fs",
  "sum:requests",
  "sum:errors",
  "sum:bytes",
  "host",
  ...SERVICES.filter((s) => s.kind === "function2" || s.kind === "function1").map((s) => `fn:${s.id}`),
  ...SERVICES.filter((s) => s.kind === "bucket").map((s) => `st:${s.id}`),
  ...SERVICES.filter((s) => s.kind === "hosting").map((s) => `site:${s.id}`),
  ...SERVICES.filter((s) => s.kind === "scheduler").map((s) => `job:${s.id}`),
];

describe("groupFor", () => {
  it("every opener maps to at most 5 allowlisted series", () => {
    for (const opener of OPENERS) {
      const group = groupFor(opener);
      expect(group, opener).not.toBeNull();
      expect(group!.series.length, opener).toBeGreaterThan(0);
      expect(group!.series.length, opener).toBeLessThanOrEqual(5);
      for (const s of group!.series) expect(isAllowedHistoryTarget(s.service, s.metric), `${opener} ${s.service} ${s.metric}`).toBe(true);
      expect(group!.ranges).toContain(group!.defaultRange);
      expect(openerForTarget(group!.target), opener).not.toBeNull();
    }
  });

  it("uses 1h-6w for lines and 7d/30d/6w with 30d default for jobs", () => {
    expect(LINE_RANGES).toEqual(["1h", "6h", "24h", "7d", "30d", "6w"]);
    expect(JOB_RANGES).toEqual(["7d", "30d", "6w"]);
    expect(groupFor("fs")!.defaultRange).toBe("24h");
    const job = groupFor("job:scheduler:pyNightlyExport")!;
    expect(job.type).toBe("runs");
    expect(job.ranges).toEqual(JOB_RANGES);
    expect(job.defaultRange).toBe("30d");
    expect(job.series.map((s) => s.metric)).toEqual(["runs", "durationSec"]);
  });

  it("matches the reference groups", () => {
    expect(groupFor("fs")!.series.map((s) => [s.metric, s.axis])).toEqual([
      ["readsPerMin", "y"],
      ["writesPerMin", "y1"],
      ["deletesPerMin", "y1"],
    ]);
    const fn = groupFor("fn:function2:pyMintOnCrewClaim")!;
    expect(fn.series.map((s) => [s.metric, Boolean(s.hidden)])).toEqual([
      ["reqPerMin", false],
      ["errPerMin", false],
      ["instances", true],
      ["cpuPct", true],
      ["memPct", true],
    ]);
    // 1st gen: no CPU or instances.
    expect(groupFor("fn:function1:pyCleanupOnAuthDelete")!.series.map((s) => s.metric)).toEqual(["execPerMin", "memBytes"]);
    expect(groupFor("sum:errors")!.series[0].hidden).toBe(true);
    expect(groupFor("sum:requests")!.series[0].hidden).toBe(false);
    expect(groupFor("sum:bytes")!.series.map((s) => s.service)).toEqual([
      "total:bucket",
      "bucket:mineral-proton-438104-g8-paraliyard",
      "bucket:mineral-proton-438104-g8-yard-backups",
    ]);
    expect(groupFor("st:bucket:mineral-proton-438104-g8-yard-backups")!.title).toBe("yard-backups");
    expect(groupFor("host")!.series.map((s) => s.service)).toEqual(["total:hosting", "hosting:paraliyard", "hosting:preparaliyard"]);
    expect(groupFor("site:hosting:preparaliyard")!.series.map((s) => s.service)).toEqual(["hosting:preparaliyard"]);
  });

  it("returns null for anything else", () => {
    for (const opener of ["", "fn", "fn:firestore:yard", "st:function2:pyMintOnCrewClaim", "job:function2:pyNightlyExport", "fn:nope", "sum:other", "x:y"]) {
      expect(groupFor(opener), opener).toBeNull();
    }
  });
});

describe("openerForTarget", () => {
  it("maps deep-link ids to openers", () => {
    expect(openerForTarget("firestore:yard")).toBe("fs");
    expect(openerForTarget("total:function2")).toBe("sum:requests");
    expect(openerForTarget("total:bucket")).toBe("sum:bytes");
    expect(openerForTarget("total:hosting")).toBe("host");
    expect(openerForTarget("function2:pyMintOnCrewClaim")).toBe("fn:function2:pyMintOnCrewClaim");
    expect(openerForTarget("scheduler:pyWeeklyAccounts")).toBe("job:scheduler:pyWeeklyAccounts");
    expect(openerForTarget("total:firestore")).toBeNull();
    expect(openerForTarget("nope")).toBeNull();
  });
});

describe("liveValue", () => {
  it("reads now values from recent, metrics and totals", async () => {
    const now = Date.UTC(2026, 9, 5, 8, 30);
    const data = await createMockSource(() => now).load();
    const fs = data.services.find((s) => s.id === "firestore:yard")!;
    const reads = fs.recent!.series.readsPerMin!;
    expect(liveValue(data, "firestore:yard", "readsPerMin")).toBe(reads[29]);
    expect(liveValue(data, "function2:pyMintOnCrewClaim", "cpuPct")).toBe(21.4);
    expect(liveValue(data, "total:bucket", "bytesStored")).toBe(data.totals.bucket!.bytesStored);
    expect(liveValue(data, "total:function2", "instances")).toBe(7);
    const sum = data.services.filter((s) => s.kind === "function2").reduce((a, s) => a + (s.recent!.series.reqPerMin![29] ?? 0), 0);
    expect(liveValue(data, "total:function2", "reqPerMin")).toBe(sum);
    expect(liveValue(data, "function2:pyWeeklyAccounts", "cpuPct")).toBeNull();
    expect(liveValue(data, "scheduler:pyNightlyExport", "runs")).toBeNull();
  });
});
