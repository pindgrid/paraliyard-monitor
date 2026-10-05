import { describe, expect, it } from "vitest";
import { drawerPath, isHistoryPath, parseDrawerRoute } from "../src/drawer-route";

describe("parseDrawerRoute", () => {
  it("parses /history/<id>?range= for service and total ids", () => {
    expect(parseDrawerRoute("/history/firestore:yard", "?range=7d")).toEqual({
      target: "firestore:yard",
      opener: "fs",
      metric: null,
      range: "7d",
    });
    expect(parseDrawerRoute("/history/total:function2", "?range=1h")?.opener).toBe("sum:requests");
    expect(parseDrawerRoute("/history/total:bucket", "")?.opener).toBe("sum:bytes");
    expect(parseDrawerRoute("/history/total:hosting/", "?range=6w")?.opener).toBe("host");
    expect(parseDrawerRoute("/history/hosting:paraliyard", "")?.opener).toBe("site:hosting:paraliyard");
    expect(parseDrawerRoute("/history/bucket:mineral-proton-438104-g8-paraliyard", "")?.opener).toBe(
      "st:bucket:mineral-proton-438104-g8-paraliyard",
    );
    expect(parseDrawerRoute("/history/function2%3ApyMintOnCrewClaim", "")?.target).toBe("function2:pyMintOnCrewClaim");
  });

  it("parses the older /history/<id>/<metric>?range= form", () => {
    expect(parseDrawerRoute("/history/function2:pyMintOnCrewClaim/cpuPct", "?range=24h")).toEqual({
      target: "function2:pyMintOnCrewClaim",
      opener: "fn:function2:pyMintOnCrewClaim",
      metric: "cpuPct",
      range: "24h",
    });
    expect(parseDrawerRoute("/history/scheduler:pyNightlyExport/runs", "")?.metric).toBe("runs");
    expect(parseDrawerRoute("/history/total:function2/errPerMin", "?range=6h")?.metric).toBe("errPerMin");
  });

  it("defaults to 24h, or 30d for jobs", () => {
    expect(parseDrawerRoute("/history/firestore:yard", "")?.range).toBe("24h");
    expect(parseDrawerRoute("/history/scheduler:pyWeeklyAccounts", "")?.range).toBe("30d");
  });

  it("returns null for anything not allowlisted", () => {
    for (const [path, search] of [
      ["/", ""],
      ["/history", ""],
      ["/history/", ""],
      ["/history/firestore:nope", ""],
      ["/history/total:firestore", ""],
      ["/history/function2:pyMintOnCrewClaim/runs", ""],
      ["/history/function1:pyCleanupOnAuthDelete/cpuPct", ""],
      ["/history/total:function2/cpuPct", ""],
      ["/history/firestore:yard", "?range=2d"],
      ["/history/scheduler:pyNightlyExport", "?range=1h"],
      ["/history/scheduler:pyNightlyExport", "?range=24h"],
      ["/history/firestore:yard/readsPerMin/extra", ""],
      ["/history/%E0%A4%A", ""],
      ["/history/__proto__", ""],
    ]) {
      expect(parseDrawerRoute(path, search), `${path}${search}`).toBeNull();
    }
  });
});

describe("drawerPath and isHistoryPath", () => {
  it("builds paths that parse back", () => {
    expect(drawerPath("total:function2", "6h")).toBe("/history/total:function2?range=6h");
    const route = parseDrawerRoute("/history/total:function2", "?range=6h");
    expect(route?.range).toBe("6h");
    expect(isHistoryPath("/history/x")).toBe(true);
    expect(isHistoryPath("/history")).toBe(true);
    expect(isHistoryPath("/historyx")).toBe(false);
    expect(isHistoryPath("/")).toBe(false);
  });
});
