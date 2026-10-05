import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "../src/poller";

const SECOND = 1000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("createPoller", () => {
  it("runs immediately and then once per interval", async () => {
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59 * SECOND);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 60 * SECOND);
    expect(task).toHaveBeenCalledTimes(5);
    poller.stop();
  });

  it("waits one interval first when runImmediately is false", async () => {
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task, runImmediately: false });
    poller.start();
    await vi.advanceTimersByTimeAsync(59 * SECOND);
    expect(task).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(task).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("never overlaps a slow task", async () => {
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    const task = vi.fn(async () => {
      starts.push(Date.now());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 90 * SECOND));
      inFlight -= 1;
    });
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(peak).toBe(1);
    // Each cycle is 90 s of work plus a 60 s gap: starts at 0, 150, 300, 450, 600 s.
    const offsets = starts.map((t) => (t - starts[0]) / SECOND);
    expect(offsets).toEqual([0, 150, 300, 450, 600]);
    poller.stop();
  });

  it("does not run while hidden and resumes when visible", async () => {
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    expect(task).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(task).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("schedules the remaining time when visible again before the delay passed", async () => {
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(39 * SECOND);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(task).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("does not start while hidden until the tab is visible", async () => {
    setVisibility("hidden");
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(task).toHaveBeenCalledTimes(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("backs off on failures up to the cap and resets after a success", async () => {
    let fail = false;
    const runTimes: number[] = [];
    const task = vi.fn(async () => {
      runTimes.push(Date.now());
      if (fail) throw new Error("down");
    });
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.currentDelay()).toBe(60 * SECOND);

    fail = true;
    const expectedDelays = [120, 240, 480, 600, 600];
    for (const seconds of expectedDelays) {
      const before = task.mock.calls.length;
      await vi.advanceTimersByTimeAsync(poller.currentDelay());
      expect(task.mock.calls.length).toBe(before + 1);
      expect(poller.currentDelay()).toBe(seconds * SECOND);
    }
    const gaps = runTimes.slice(1).map((t, i) => (t - runTimes[i]) / SECOND);
    expect(gaps).toEqual([60, 120, 240, 480, 600]);

    fail = false;
    await vi.advanceTimersByTimeAsync(600 * SECOND);
    expect(poller.currentDelay()).toBe(60 * SECOND);
    const count = task.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(task.mock.calls.length).toBe(count + 1);
    poller.stop();
  });

  it("runs nothing after stop", async () => {
    const task = vi.fn(async () => {});
    const poller = createPoller({ intervalMs: 60 * SECOND, task });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
