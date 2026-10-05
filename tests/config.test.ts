import { describe, expect, it, vi } from "vitest";
import shipped from "../public/config.json";
import { loadConfig, parseConfig } from "../src/config";

function fakeFetch(respond: () => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return respond();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

describe("loadConfig", () => {
  it("requests /config.json without the HTTP cache", async () => {
    const fetchFn = fakeFetch(() => jsonResponse('{"mode":"live","refreshSeconds":90}'));
    expect(await loadConfig(fetchFn)).toEqual({ mode: "live", refreshSeconds: 90 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("/config.json", { cache: "no-store" });
  });

  it("falls back to mock for a missing file", async () => {
    const fetchFn = fakeFetch(() => jsonResponse("not found", 404));
    expect(await loadConfig(fetchFn)).toEqual({ mode: "mock", refreshSeconds: 60 });
  });

  it("falls back to mock when fetch throws", async () => {
    const fetchFn = fakeFetch(() => {
      throw new TypeError("offline");
    });
    expect(await loadConfig(fetchFn)).toEqual({ mode: "mock", refreshSeconds: 60 });
  });

  it("falls back to mock for invalid JSON", async () => {
    const fetchFn = fakeFetch(() => jsonResponse("{mode: live"));
    expect(await loadConfig(fetchFn)).toEqual({ mode: "mock", refreshSeconds: 60 });
  });

  it("falls back to mock for an unknown mode and for null", async () => {
    expect(await loadConfig(fakeFetch(() => jsonResponse('{"mode":"x"}')))).toEqual({
      mode: "mock",
      refreshSeconds: 60,
    });
    expect(await loadConfig(fakeFetch(() => jsonResponse("null")))).toEqual({ mode: "mock", refreshSeconds: 60 });
  });
});

describe("parseConfig", () => {
  it("keeps off and live", () => {
    expect(parseConfig({ mode: "off", refreshSeconds: 60 }).mode).toBe("off");
    expect(parseConfig({ mode: "live", refreshSeconds: 60 }).mode).toBe("live");
    expect(parseConfig({ mode: "mock", refreshSeconds: 60 }).mode).toBe("mock");
  });

  it("rejects non-object values", () => {
    for (const raw of [null, undefined, "live", 42, ["live"]]) {
      expect(parseConfig(raw)).toEqual({ mode: "mock", refreshSeconds: 60 });
    }
  });

  it("clamps and defaults refreshSeconds", () => {
    const cases: [unknown, number][] = [
      [5, 30],
      [30, 30],
      [120, 120],
      ["abc", 60],
      [null, 60],
      [NaN, 60],
      [Infinity, 60],
      [undefined, 60],
    ];
    for (const [refreshSeconds, expected] of cases) {
      expect(parseConfig({ mode: "live", refreshSeconds }).refreshSeconds, String(refreshSeconds)).toBe(expected);
    }
  });
});

describe("shipped config", () => {
  it("public/config.json is mock mode", () => {
    expect(shipped).toEqual({ mode: "mock", refreshSeconds: 60 });
    expect(parseConfig(shipped)).toEqual({ mode: "mock", refreshSeconds: 60 });
  });
});
