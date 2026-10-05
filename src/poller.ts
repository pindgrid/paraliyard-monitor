export interface PollerOptions {
  intervalMs: number;
  task: () => Promise<unknown>;
  doc?: Document;
  maxIntervalMs?: number;
  // Run the task as soon as start() is called (default) or wait one interval.
  runImmediately?: boolean;
}

export interface Poller {
  start(): void;
  stop(): void;
  currentDelay(): number;
}

// setTimeout-chained poller: ticks never overlap, nothing runs while the tab is
// hidden, and consecutive failures double the delay up to maxIntervalMs.
export function createPoller({
  intervalMs,
  task,
  doc = document,
  maxIntervalMs = 600000,
  runImmediately = true,
}: PollerOptions): Poller {
  let started = false;
  let running = false;
  let failures = 0;
  let lastDoneAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hidden = () => doc.visibilityState === "hidden";
  const currentDelay = () => Math.min(intervalMs * 2 ** failures, maxIntervalMs);

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs: number) {
    clearTimer();
    if (!started || hidden()) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  }

  async function run() {
    if (!started || running || hidden()) return;
    running = true;
    try {
      await task();
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      running = false;
      lastDoneAt = Date.now();
    }
    schedule(currentDelay());
  }

  function onVisibilityChange() {
    if (!started) return;
    if (hidden()) {
      clearTimer();
      return;
    }
    if (running || timer !== null) return;
    const delay = currentDelay();
    const elapsed = lastDoneAt === null ? Infinity : Date.now() - lastDoneAt;
    if (elapsed >= delay) void run();
    else schedule(delay - elapsed);
  }

  return {
    start() {
      if (started) return;
      started = true;
      doc.addEventListener("visibilitychange", onVisibilityChange);
      if (runImmediately) {
        void run();
      } else {
        lastDoneAt = Date.now();
        schedule(currentDelay());
      }
    },
    stop() {
      started = false;
      clearTimer();
      doc.removeEventListener("visibilitychange", onVisibilityChange);
    },
    currentDelay,
  };
}
