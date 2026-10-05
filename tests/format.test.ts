import { describe, expect, it } from "vitest";
import { IDLE, ageText, formatBytes, formatValue } from "../src/format";
import { sparkline } from "../src/sparkline";

describe("formatValue", () => {
  it("shows null and undefined as not available", () => {
    for (const key of ["cpuPct", "reqPerMin", "bytesStored", "instances", "lastRunAt", "lastResult"]) {
      expect(formatValue(key, null)).toBe("not available");
      expect(formatValue(key, undefined)).toBe("not available");
    }
  });

  it("shows a real 0 as 0", () => {
    for (const key of ["cpuPct", "reqPerMin", "bytesStored", "instances", "errPerMin"]) {
      expect(formatValue(key, 0)).toBe("0");
    }
  });

  it("formats percentages, rates, counts and bytes", () => {
    expect(formatValue("cpuPct", 21.4)).toBe("21.4 %");
    expect(formatValue("memPct", 12.5)).toBe("12.5 %");
    expect(formatValue("reqPerMin", 3.4)).toBe("3.4 /min");
    expect(formatValue("errPerMin", 0.004)).toBe("<0.01 /min");
    expect(formatValue("readsPerMin", 142.456)).toBe("142.46 /min");
    expect(formatValue("instances", 7)).toBe("7");
    expect(formatValue("memBytes", 67108864)).toBe("64 MB");
    expect(formatValue("bytesStored", 42949673)).toBe("41 MB");
    expect(formatValue("bytesServed", 2147483648)).toBe("2 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats the scheduler fields", () => {
    const iso = "2025-12-31T21:00:00.000Z";
    expect(formatValue("lastRunAt", iso)).toBe(new Date(iso).toLocaleString());
    expect(formatValue("lastRunAt", "garbage")).toBe("not available");
    expect(formatValue("lastResult", "success")).toBe("success");
    expect(formatValue("lastResult", "failed")).toBe("failed");
  });

  it("treats non-finite numbers as not available", () => {
    expect(formatValue("cpuPct", NaN)).toBe("not available");
    expect(formatValue("reqPerMin", Infinity)).toBe("not available");
  });
});

describe("ageText", () => {
  const generatedAt = "2026-01-01T12:00:00.000Z";

  it("shows just now under a minute", () => {
    expect(ageText(generatedAt, generatedAt)).toBe("just now");
    expect(ageText(generatedAt, "2026-01-01T11:59:30.000Z")).toBe("just now");
  });

  it("shows whole minutes", () => {
    expect(ageText(generatedAt, "2026-01-01T11:37:00.000Z")).toBe("23 min ago");
  });

  it("is null for invalid input", () => {
    expect(ageText(generatedAt, "garbage")).toBeNull();
    expect(ageText("garbage", generatedAt)).toBeNull();
    expect(ageText(generatedAt, null)).toBeNull();
    expect(ageText(undefined, generatedAt)).toBeNull();
  });

  it("passes idle through formatValue", () => {
    expect(formatValue("cpuPct", IDLE)).toBe("idle");
  });
});

describe("sparkline", () => {
  it("draws an svg polyline for points", () => {
    const node = sparkline([
      { t: "2026-01-01T11:02:00.000Z", v: 2 },
      { t: "2026-01-01T11:01:00.000Z", v: 1 },
    ]);
    expect(node).toBeInstanceOf(SVGElement);
    const svg = node as SVGElement;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(2);
  });

  it("handles a single point and all-zero values", () => {
    expect(sparkline([{ t: "2026-01-01T11:01:00.000Z", v: 0 }])).toBeInstanceOf(SVGElement);
  });

  it("returns not available text with no points", () => {
    const node = sparkline([]);
    expect(node.nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe("not available");
  });
});
