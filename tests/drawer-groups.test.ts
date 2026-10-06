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
    expect(groupFor("fs")!.series.map((s) => s.metric)).toEqual(["readsPerMin", "writesPerMin", "deletesPerMin"]);
    // Panels replace the clutter reason for hiding: function series all start visible.
    const fn = groupFor("fn:function2:pyMintOnCrewClaim")!;
    expect(fn.series.map((s) => [s.metric, Boolean(s.hidden)])).toEqual([
      ["reqPerMin", false],
      ["errPerMin", false],
      ["instances", false],
      ["cpuPct", false],
      ["memPct", false],
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

// The (service, metric) /api/history calls of each group before panels were
// added. Drawing changes must never add or change a Monitoring call.
const FN2 = ["reqPerMin", "errPerMin", "instances", "cpuPct", "memPct"];
const CALLS: Record<string, string[]> = {
  fs: ["firestore:yard readsPerMin", "firestore:yard writesPerMin", "firestore:yard deletesPerMin"],
  "sum:requests": ["total:function2 reqPerMin", "total:function2 errPerMin", "total:function2 instances"],
  "sum:errors": ["total:function2 reqPerMin", "total:function2 errPerMin", "total:function2 instances"],
  "sum:bytes": [
    "total:bucket bytesStored",
    "bucket:mineral-proton-438104-g8-paraliyard bytesStored",
    "bucket:mineral-proton-438104-g8-yard-backups bytesStored",
  ],
  host: ["total:hosting bytesServed", "hosting:paraliyard bytesServed", "hosting:preparaliyard bytesServed"],
  "site:hosting:paraliyard": ["hosting:paraliyard bytesServed"],
  "site:hosting:preparaliyard": ["hosting:preparaliyard bytesServed"],
  ...Object.fromEntries(
    [
      "pyNightlyExport",
      "pyReadStockistDocs",
      "pyYardStaffOnWrite",
      "pyMintOnCrewClaim",
      "pyDeleteAccountOnRequest",
      "pyStaffLoginOnRequest",
      "pyWeeklyAccounts",
      "pyPushOnNotification",
      "pyMintOnRoleRequest",
    ].map((name) => [`fn:function2:${name}`, FN2.map((m) => `function2:${name} ${m}`)]),
  ),
  "fn:function1:pyCleanupOnAuthDelete": ["function1:pyCleanupOnAuthDelete execPerMin", "function1:pyCleanupOnAuthDelete memBytes"],
  "st:bucket:mineral-proton-438104-g8-paraliyard": [
    "bucket:mineral-proton-438104-g8-paraliyard bytesStored",
    "bucket:mineral-proton-438104-g8-paraliyard reqPerMin",
  ],
  "st:bucket:mineral-proton-438104-g8-yard-backups": [
    "bucket:mineral-proton-438104-g8-yard-backups bytesStored",
    "bucket:mineral-proton-438104-g8-yard-backups reqPerMin",
  ],
  "job:scheduler:pyNightlyExport": ["scheduler:pyNightlyExport runs", "scheduler:pyNightlyExport durationSec"],
  "job:scheduler:pyWeeklyAccounts": ["scheduler:pyWeeklyAccounts runs", "scheduler:pyWeeklyAccounts durationSec"],
};

describe("history calls", () => {
  it("every group issues exactly the same (service, metric) calls as before", () => {
    expect(Object.keys(CALLS).sort()).toEqual([...OPENERS].sort());
    for (const opener of OPENERS) {
      expect(groupFor(opener)!.series.map((s) => `${s.service} ${s.metric}`), opener).toEqual(CALLS[opener]);
    }
  });
});

const titles = (opener: string) => groupFor(opener)!.panels.map((p) => p.title);
const drawn = (opener: string, panel: number) => {
  const group = groupFor(opener)!;
  return group.panels[panel].datasets.map((d) => [group.series[d.series].metric, d.color]);
};

describe("panels", () => {
  it("lays out each group's panels in order", () => {
    expect(titles("fs")).toEqual(["Reads per minute", "Writes and deletes per minute"]);
    expect(titles("fn:function2:pyMintOnCrewClaim")).toEqual(["Requests per minute", "Instances", "CPU and RAM (p99, %)"]);
    expect(titles("fn:function1:pyCleanupOnAuthDelete")).toEqual(["Requests per minute", "RAM (p99, %)"]);
    expect(titles("st:bucket:mineral-proton-438104-g8-yard-backups")).toEqual(["Storage used", "Requests per minute"]);
    expect(titles("host")).toEqual(["Data served per minute"]);
    expect(titles("site:hosting:paraliyard")).toEqual(["Data served per minute"]);
    expect(titles("sum:requests")).toEqual(["Requests per minute"]);
    expect(titles("sum:errors")).toEqual(["Requests per minute"]);
    expect(titles("sum:bytes")).toEqual(["Storage used"]);
    expect(groupFor("job:scheduler:pyNightlyExport")!.panels).toEqual([]);
  });

  it("draws each series with the palette", () => {
    expect(drawn("fs", 0)).toEqual([["readsPerMin", "--straw"]]);
    expect(drawn("fs", 1)).toEqual([
      ["writesPerMin", "--paddy"],
      ["deletesPerMin", "--ember"],
    ]);
    const fn = "fn:function2:pyMintOnCrewClaim";
    // Successful requests and errors, stacked; errors in ember.
    expect(drawn(fn, 0)).toEqual([
      ["reqPerMin", "--straw"],
      ["errPerMin", "--ember"],
    ]);
    const requests = groupFor(fn)!.panels[0];
    expect(requests.stacked).toBe(true);
    expect(requests.datasets[0]).toMatchObject({ label: "Successful", derive: "minus", minus: 1 });
    expect(drawn(fn, 1)).toEqual([["instances", "--ink-2"]]);
    expect(drawn(fn, 2)).toEqual([
      ["cpuPct", "--canal"],
      ["memPct", "--paddy"],
    ]);
    expect(groupFor(fn)!.panels.map((p) => p.kind)).toEqual(["bar", "level", "pct"]);
    // 1st gen: executions only, RAM % from memory bytes.
    const gen1 = "fn:function1:pyCleanupOnAuthDelete";
    expect(drawn(gen1, 0)).toEqual([["execPerMin", "--straw"]]);
    expect(drawn(gen1, 1)).toEqual([["memBytes", "--paddy"]]);
    expect(groupFor(gen1)!.panels[1].datasets[0].derive).toBe("memPct");
    const bucket = "st:bucket:mineral-proton-438104-g8-paraliyard";
    expect(drawn(bucket, 0)).toEqual([["bytesStored", "--canal"]]);
    expect(drawn(bucket, 1)).toEqual([["reqPerMin", "--straw"]]);
    // Hosting: stacked by site; the "All sites" total is not drawn.
    const host = groupFor("host")!.panels[0];
    expect(host.stacked).toBe(true);
    expect(host.datasets.map((d) => [groupFor("host")!.series[d.series].service, d.color])).toEqual([
      ["hosting:paraliyard", "--straw"],
      ["hosting:preparaliyard", "--canal"],
    ]);
    // All functions: errors stacked on successful requests; instances not drawn.
    expect(drawn("sum:requests", 0)).toEqual([
      ["reqPerMin", "--straw"],
      ["errPerMin", "--ember"],
    ]);
    expect(groupFor("sum:requests")!.panels[0].stacked).toBe(true);
    // All buckets: the total plus one step line per bucket.
    const storage = groupFor("sum:bytes")!.panels[0];
    expect(storage.kind).toBe("level");
    expect(storage.datasets.map((d) => [groupFor("sum:bytes")!.series[d.series].service, d.color])).toEqual([
      ["total:bucket", "--ink-2"],
      ["bucket:mineral-proton-438104-g8-paraliyard", "--straw"],
      ["bucket:mineral-proton-438104-g8-yard-backups", "--canal"],
    ]);
  });

  it("never repeats a colour inside a panel and only points at loaded series", () => {
    for (const opener of OPENERS) {
      const group = groupFor(opener)!;
      for (const panel of group.panels) {
        const colors = panel.datasets.map((d) => d.color);
        expect(new Set(colors).size, `${opener} ${panel.title}`).toBe(colors.length);
        for (const d of panel.datasets) {
          expect(group.series[d.series], `${opener} ${panel.title}`).toBeDefined();
          if (d.minus !== undefined) expect(group.series[d.minus]).toBeDefined();
        }
      }
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
