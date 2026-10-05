import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { RUNS_RELOAD_MS, startApp, type AppHandle } from "../src/app";
import { REFRESH_KEY } from "../src/refresh";
import type { Config } from "../src/types";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

interface Call {
  url: string;
  at: number;
}

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function stubFetch(metrics: () => Response = () => fakeResponse(sample)) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    if (url === "/api/metrics") return metrics();
    return fakeResponse({ error: "not found" }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const metricsTimes = (calls: Call[]) => calls.filter((c) => c.url === "/api/metrics").map((c) => c.at);
const gapsOf = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);
const runsTimes = (calls: Call[]) => calls.filter((c) => c.url.includes("metric=runs")).map((c) => c.at);

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const refreshButtons = () => [...root.querySelectorAll<HTMLButtonElement>(".seg button[data-refresh]")];
// The data-refresh of the pressed button.
const pressed = () => refreshButtons().find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.refresh;
const pauseButton = () => root.querySelector<HTMLButtonElement>('button[data-action="pause"]')!;
const liveState = () => root.querySelector<HTMLElement>("[data-live]")?.dataset.state;

function choose(seconds: number) {
  root.querySelector<HTMLButtonElement>(`button[data-refresh="${seconds}"]`)!.click();
}

const live: Config = { mode: "live", refreshSeconds: 60 };

let root: HTMLElement;
let app: AppHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("refresh control", () => {
  it("offers exactly 30s, 60s and 5m as a segmented group, with no <select>", async () => {
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: live, storage: null });
    expect(root.querySelector("select")).toBeNull();
    const group = root.querySelector<HTMLElement>('.seg[role="group"][aria-label="Refresh every"]')!;
    expect(group).not.toBeNull();
    expect(refreshButtons().map((b) => [b.dataset.refresh, b.textContent, b.type])).toEqual([
      ["30", "30s", "button"],
      ["60", "60s", "button"],
      ["300", "5m", "button"],
    ]);
    expect(refreshButtons().every((b) => group.contains(b))).toBe(true);
    // aria-pressed follows the current choice.
    expect(refreshButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    choose(30);
    expect(refreshButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  });

  it("a tampered data-refresh under 30 s is ignored", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    await vi.advanceTimersByTimeAsync(0);
    const button = root.querySelector<HTMLButtonElement>('button[data-refresh="30"]')!;
    button.dataset.refresh = "5";
    button.click();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(pressed()).toBe("60");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const gaps = gapsOf(metricsTimes(calls));
    expect(gaps.length).toBeGreaterThan(2);
    expect(gaps.every((g) => g === 60 * SECOND)).toBe(true);
  });

  it("never fetches more often than every 30 s, for every option", async () => {
    for (const seconds of [30, 60, 300]) {
      const { fetchFn, calls } = stubFetch();
      app = await startApp({ root, fetchFn, config: live, storage: null });
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      // Changing the option 10 s after a fetch does not fetch sooner.
      choose(seconds);
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      const gaps = gapsOf(metricsTimes(calls));
      expect(gaps.length, String(seconds)).toBeGreaterThan(2);
      for (const gap of gaps) expect(gap, String(seconds)).toBeGreaterThanOrEqual(30 * SECOND);
      // After the change the cadence is the chosen option.
      expect(gaps.slice(1).every((g) => g === seconds * SECOND), String(seconds)).toBe(true);
      expect(gaps[0]).toBe(seconds === 60 ? 60 * SECOND : 10 * SECOND + seconds * SECOND);
      app.stop();
      app = null;
    }
  });

  it("switching options back and forth quickly still keeps 30 s between fetches", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live, storage: null });
    for (let i = 0; i < 12; i += 1) {
      choose(i % 2 === 0 ? 30 : 300);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
      choose(60);
      await vi.advanceTimersByTimeAsync(5 * SECOND);
    }
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    for (const gap of gapsOf(metricsTimes(calls))) expect(gap).toBeGreaterThanOrEqual(30 * SECOND);
  });

  it("persists the choice to pm:refresh and uses it next time", async () => {
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: live });
    choose(300);
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("300");
    app.stop();
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live });
    expect(pressed()).toBe("300");
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(metricsTimes(calls)).toEqual([0, 300, 600].map((s) => metricsTimes(calls)[0] + s * SECOND));
  });

  it("tolerates a throwing storage", async () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live, storage: throwing });
    expect(pressed()).toBe("60");
    expect(() => choose(30)).not.toThrow();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(gapsOf(metricsTimes(calls)).slice(1).every((g) => g === 30 * SECOND)).toBe(true);
    app.stop();

    // localStorage itself throwing on access.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    app = await startApp({ root, fetchFn: stubFetch().fetchFn, config: live });
    expect(() => choose(300)).not.toThrow();
    expect(pressed()).toBe("300");
  });
});

describe("polling", () => {
  it("polls only while the tab is visible", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live, storage: null });
    await vi.advanceTimersByTimeAsync(0);
    choose(30);
    setVisibility("hidden");
    const before = metricsTimes(calls).length;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(metricsTimes(calls)).toHaveLength(before);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(metricsTimes(calls)).toHaveLength(before + 1);
  });

  it("Pause stops polling and Resume restarts it", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live, storage: null });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(metricsTimes(calls)).toHaveLength(3);

    pauseButton().click();
    expect(liveState()).toBe("paused");
    expect(root.querySelector("[data-live-text]")?.textContent).toBe("Paused");
    expect(pauseButton().textContent).toBe("Resume");
    expect(pauseButton().getAttribute("aria-pressed")).toBe("true");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(metricsTimes(calls)).toHaveLength(3);

    pauseButton().click();
    expect(pauseButton().textContent).toBe("Pause");
    await vi.advanceTimersByTimeAsync(0);
    // More than one interval has passed: Resume fetches at once, then every 60 s.
    expect(metricsTimes(calls)).toHaveLength(4);
    expect(liveState()).toBe("live");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(metricsTimes(calls)).toHaveLength(6);
  });

  it("a quick Pause and Resume does not fetch sooner than one interval", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: live, storage: null });
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    pauseButton().click();
    pauseButton().click();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    for (const gap of gapsOf(metricsTimes(calls))) expect(gap).toBeGreaterThanOrEqual(60 * SECOND);
  });

  it("off mode makes zero fetches and disables the controls", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: { mode: "off", refreshSeconds: 60 } });
    expect(refreshButtons()).toHaveLength(3);
    expect(refreshButtons().every((b) => b.disabled)).toBe(true);
    expect(pauseButton().disabled).toBe(true);
    // A click on a disabled button changes nothing.
    choose(30);
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(pressed()).toBe("60");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(0);
  });

  it("a failed fetch shows Offline and .note.err with the retry interval", async () => {
    let failing = true;
    const { fetchFn } = stubFetch(() => (failing ? fakeResponse({ error: "x" }, 503) : fakeResponse(sample)));
    app = await startApp({ root, fetchFn, config: live, storage: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(liveState()).toBe("offline");
    const err = root.querySelector<HTMLElement>(".note.err")!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe("Can't reach the metrics endpoint. Retrying in 120 seconds.");
    await vi.advanceTimersByTimeAsync(120 * SECOND);
    expect(err.textContent).toContain("Retrying in 240 seconds");
    failing = false;
    await vi.advanceTimersByTimeAsync(240 * SECOND);
    expect(liveState()).toBe("live");
    expect(root.querySelector<HTMLElement>(".note.err")?.hidden).toBe(true);
  });
});

describe("runs history for the day squares", () => {
  it("is reloaded at most every 10 minutes", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 30 }, storage: null });
    await vi.advanceTimersByTimeAsync(35 * MINUTE);
    const times = runsTimes(calls);
    // Two jobs per load: at 0, 10, 20 and 30 minutes.
    expect(times).toHaveLength(8);
    const rounds = [...new Set(times)];
    expect(rounds).toHaveLength(4);
    for (const gap of gapsOf(rounds)) expect(gap).toBeGreaterThanOrEqual(RUNS_RELOAD_MS);
    expect(RUNS_RELOAD_MS).toBe(10 * MINUTE);
    // Meanwhile metrics were polled every 30 s.
    expect(metricsTimes(calls).length).toBeGreaterThan(60);
  });

  it("failed loads are not retried sooner", async () => {
    const { fetchFn, calls } = stubFetch();
    app = await startApp({ root, fetchFn, config: { mode: "live", refreshSeconds: 30 }, storage: null });
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    // The stub answers 404 to history: still only the first load.
    expect(runsTimes(calls)).toHaveLength(2);
  });
});
