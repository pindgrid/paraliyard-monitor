import { describe, expect, it } from "vitest";
import allowlist from "../src/history-allowlist.json";
import {
  CELL_METRIC,
  DEFAULT_RANGE,
  HISTORY_RANGES,
  PRIMARY_METRIC,
  alignmentSeconds,
  historyPath,
  isAllowedPair,
  parseRoute,
  rangeSeconds,
} from "../src/routes";
import { COLUMNS, KIND_ORDER, SERVICES } from "../src/services";

describe("history routes", () => {
  it("builds /history/<id>/<metric>?range=<r> with 24h by default", () => {
    expect(historyPath("firestore:yard", "readsPerMin")).toBe("/history/firestore:yard/readsPerMin?range=24h");
    expect(historyPath("function2:pyMintOnCrewClaim", "cpuPct", "7d")).toBe(
      "/history/function2:pyMintOnCrewClaim/cpuPct?range=7d",
    );
    expect(DEFAULT_RANGE).toBe("24h");
  });

  it("parses valid history routes, defaulting the range to 24h", () => {
    expect(parseRoute("/history/firestore:yard/readsPerMin", "?range=6w")).toEqual({
      view: "history",
      service: "firestore:yard",
      metric: "readsPerMin",
      range: "6w",
    });
    expect(parseRoute("/history/firestore:yard/readsPerMin", "")).toEqual({
      view: "history",
      service: "firestore:yard",
      metric: "readsPerMin",
      range: "24h",
    });
    expect(parseRoute("/history/function2%3ApyMintOnCrewClaim/cpuPct/", "?range=1h")).toMatchObject({
      view: "history",
      service: "function2:pyMintOnCrewClaim",
    });
  });

  it("round-trips every allowlisted pair and range", () => {
    for (const s of SERVICES) {
      for (const metric of allowlist.metricsByKind[s.kind]) {
        for (const range of HISTORY_RANGES) {
          const url = new URL(historyPath(s.id, metric, range), "http://localhost");
          expect(parseRoute(url.pathname, url.search)).toEqual({ view: "history", service: s.id, metric, range });
        }
      }
    }
  });

  it("treats invalid service, metric or range as the overview", () => {
    const cases: [string, string][] = [
      ["/", ""],
      ["/history", ""],
      ["/history/firestore:yard", ""],
      ["/history/firestore:other/readsPerMin", ""],
      ["/history/function2:pyMintOnCrewClaim/runs", ""],
      ["/history/function1:pyCleanupOnAuthDelete/cpuPct", ""],
      ["/history/function1:pyCleanupOnAuthDelete/memPct", ""],
      ["/history/firestore:yard/readsPerMin", "?range=90d"],
      ["/history/firestore:yard/readsPerMin", "?range="],
      ["/history/firestore:yard/readsPerMin/extra", ""],
      ["/history/%E0%A4%A/readsPerMin", ""],
      ["/other", ""],
    ];
    for (const [path, search] of cases) expect(parseRoute(path, search), `${path}${search}`).toEqual({ view: "overview" });
  });

  it("isAllowedPair follows the shared allowlist", () => {
    expect(isAllowedPair("function2:pyWeeklyAccounts", "cpuPct")).toBe(true);
    expect(isAllowedPair("function1:pyCleanupOnAuthDelete", "cpuPct")).toBe(false);
    expect(isAllowedPair("scheduler:pyNightlyExport", "runs")).toBe(true);
    expect(isAllowedPair("function2:pyNightlyExport", "runs")).toBe(false);
    expect(isAllowedPair("nope", "runs")).toBe(false);
  });

  it("range lengths and alignments", () => {
    expect(HISTORY_RANGES).toEqual(["1h", "6h", "24h", "7d", "30d", "6w"]);
    expect(rangeSeconds("7d")).toBe(604800);
    expect(alignmentSeconds("30d")).toBe(10800);
    expect(alignmentSeconds("1h")).toBe(60);
  });

  it("sparkline and cell metrics are allowed for every service", () => {
    for (const s of SERVICES) {
      expect(isAllowedPair(s.id, PRIMARY_METRIC[s.kind]), s.id).toBe(true);
    }
    for (const kind of KIND_ORDER) {
      for (const column of COLUMNS[kind]) {
        expect(column.key in CELL_METRIC[kind], `${kind}.${column.key}`).toBe(true);
        const metric = CELL_METRIC[kind][column.key];
        if (metric === null) continue;
        for (const s of SERVICES.filter((v) => v.kind === kind)) expect(isAllowedPair(s.id, metric)).toBe(true);
      }
    }
    expect(CELL_METRIC.function1.memPct).toBe("memBytes");
    expect(CELL_METRIC.function1.cpuPct).toBeNull();
  });
});
