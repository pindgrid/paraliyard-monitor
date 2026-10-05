import { describe, expect, it } from "vitest";
import config from "../public/config.json";

describe("smoke", () => {
  it("runs in jsdom", () => {
    expect(typeof document.createElement).toBe("function");
  });

  it("blocks network access", () => {
    expect(() => fetch("/api/metrics")).toThrow("network disabled in tests");
  });

  it("ships mock mode by default", () => {
    expect(config).toEqual({ mode: "mock", refreshSeconds: 60 });
  });
});
