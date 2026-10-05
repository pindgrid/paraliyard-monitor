import { describe, expect, it } from "vitest";
import { IST_TIME_ZONE, formatIst, istFormatter } from "../src/time";

describe("formatIst", () => {
  it("shows India Standard Time regardless of the viewer's zone", () => {
    // 12:00 UTC is 17:30 IST.
    const text = formatIst(Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(text).toContain("17:30");
    expect(text).toContain("Jan");
    expect(text).toContain("01");
    expect(text.endsWith("IST")).toBe(true);
    // 20:00 UTC is 01:30 the next day in IST.
    const late = formatIst(Date.UTC(2026, 0, 1, 20, 0, 0));
    expect(late).toContain("01:30");
    expect(late).toContain("02");
  });

  it("uses an explicit Asia/Kolkata formatter", () => {
    expect(IST_TIME_ZONE).toBe("Asia/Kolkata");
    // ICU may report the zone under its older alias.
    expect(["Asia/Kolkata", "Asia/Calcutta"]).toContain(istFormatter.resolvedOptions().timeZone);
  });

  it("returns an empty string for an invalid time", () => {
    expect(formatIst(Number.NaN)).toBe("");
  });
});
