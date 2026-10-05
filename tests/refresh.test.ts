import { describe, expect, it } from "vitest";
import { REFRESH_KEY, REFRESH_OPTIONS, loadRefresh, pollIntervalMs, saveRefresh, snapRefresh } from "../src/refresh";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("refresh options", () => {
  it("are exactly 30s, 60s and 5m", () => {
    expect(REFRESH_OPTIONS).toEqual([
      { seconds: 30, label: "30s" },
      { seconds: 60, label: "60s" },
      { seconds: 300, label: "5m" },
    ]);
  });

  it("snapRefresh picks the nearest option, at least 30 s", () => {
    expect(snapRefresh(60)).toBe(60);
    expect(snapRefresh(5)).toBe(30);
    expect(snapRefresh(30)).toBe(30);
    expect(snapRefresh(40)).toBe(30);
    expect(snapRefresh(45)).toBe(60);
    expect(snapRefresh(120)).toBe(60);
    expect(snapRefresh(200)).toBe(300);
    expect(snapRefresh(3600)).toBe(300);
    expect(snapRefresh(Number.NaN)).toBe(60);
  });

  it("pollIntervalMs is never below 30 s", () => {
    expect(pollIntervalMs(30)).toBe(30000);
    expect(pollIntervalMs(5)).toBe(30000);
    expect(pollIntervalMs(300)).toBe(300000);
  });
});

describe("pm:refresh storage", () => {
  it("loads a saved option and ignores anything else", () => {
    expect(loadRefresh(memoryStorage({ [REFRESH_KEY]: "300" }), 60)).toBe(300);
    expect(loadRefresh(memoryStorage({ [REFRESH_KEY]: "5" }), 60)).toBe(60);
    expect(loadRefresh(memoryStorage({ [REFRESH_KEY]: "abc" }), 30)).toBe(30);
    expect(loadRefresh(memoryStorage(), 60)).toBe(60);
    expect(loadRefresh(null, 60)).toBe(60);
  });

  it("saves only valid options", () => {
    const storage = memoryStorage();
    saveRefresh(storage, 30);
    expect(storage.data[REFRESH_KEY]).toBe("30");
    saveRefresh(storage, 10);
    expect(storage.data[REFRESH_KEY]).toBe("30");
  });

  it("tolerates a throwing localStorage", () => {
    expect(loadRefresh(throwing, 60)).toBe(60);
    expect(() => saveRefresh(throwing, 30)).not.toThrow();
  });
});
