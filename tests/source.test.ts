import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { createLiveSource, createMockSource } from "../src/source";

const NOW = Date.UTC(2026, 9, 5, 8, 30, 0);

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createMockSource", () => {
  it("returns the fixture moved so the newest point is now, without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const data = await createMockSource().load();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(data.services).toHaveLength(17);
    const newest = Math.max(...data.services.flatMap((s) => s.trend.points.map((p) => Date.parse(p.t))));
    expect(newest).toBe(NOW);
    expect(data.generatedAt).toBe(new Date(NOW).toISOString());
    const nightly = data.services.find((s) => s.id === "scheduler:pyNightlyExport");
    expect(Date.parse(String(nightly?.metrics.lastRunAt))).toBe(NOW - 15 * 3600 * 1000);
    expect(data.totals.scheduler?.lastRunAt).toBe(nightly?.metrics.lastRunAt);
  });

  it("moves cpuAt and memAt so their ages stay the same", async () => {
    const data = await createMockSource().load();
    const mint = data.services.find((s) => s.id === "function2:pyMintOnCrewClaim");
    expect(Date.parse(String(mint?.metrics.cpuAt))).toBe(NOW - 23 * 60000);
    expect(Date.parse(String(mint?.metrics.memAt))).toBe(NOW - 60000);
    expect(data.totals.function2?.cpuAt).toBe(mint?.metrics.cpuAt);
    const idle = data.services.find((s) => s.id === "function2:pyWeeklyAccounts");
    expect(idle?.metrics.cpuAt).toBeNull();
  });

  it("does not modify the bundled fixture", async () => {
    await createMockSource().load();
    expect(sample.generatedAt).toBe("2026-01-01T12:00:00.000Z");
  });
});

describe("createLiveSource", () => {
  it("requests exactly /api/metrics with JSON accept and an abort signal", async () => {
    const fetchFn = vi.fn(async () => fakeResponse(sample));
    const data = await createLiveSource(fetchFn as unknown as typeof fetch).load();
    expect(data.services).toHaveLength(17);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/metrics");
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => fakeResponse({ error: "metrics unavailable" }, 503));
    await expect(createLiveSource(fetchFn as unknown as typeof fetch).load()).rejects.toThrow(/503/);
  });

  it("throws on a body without a services array", async () => {
    for (const body of [null, {}, { services: "x", totals: {} }, { services: [] }, []]) {
      const fetchFn = vi.fn(async () => fakeResponse(body));
      await expect(createLiveSource(fetchFn as unknown as typeof fetch).load()).rejects.toThrow();
    }
  });

  it("aborts after 15 s", async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = createLiveSource(fetchFn as unknown as typeof fetch).load();
    const assertion = expect(result).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await assertion;
  });
});
