// Refresh control: the only choices are 30 s, 60 s and 5 min, so polling is
// never faster than every 30 s.

export interface RefreshOption {
  seconds: number;
  label: string;
}

export const REFRESH_OPTIONS: readonly RefreshOption[] = [
  { seconds: 30, label: "30s" },
  { seconds: 60, label: "60s" },
  { seconds: 300, label: "5m" },
];

export const REFRESH_KEY = "pm:refresh";
export const MIN_POLL_MS = 30000;

const SECONDS = REFRESH_OPTIONS.map((o) => o.seconds);

export function isRefreshSeconds(value: unknown): value is number {
  return typeof value === "number" && SECONDS.includes(value);
}

// The option nearest to the configured refreshSeconds (the larger on a tie),
// never below 30 s. Anything that is not a number gives 60 s.
export function snapRefresh(configSeconds: number): number {
  if (!Number.isFinite(configSeconds)) return 60;
  let best = SECONDS[0];
  for (const s of SECONDS) {
    if (Math.abs(s - configSeconds) <= Math.abs(best - configSeconds)) best = s;
  }
  return Math.max(30, best);
}

export function pollIntervalMs(seconds: number): number {
  return Math.max(MIN_POLL_MS, seconds * 1000);
}

// Saved choice, or the fallback when nothing valid is saved or storage throws.
export function loadRefresh(storage: Pick<Storage, "getItem"> | null | undefined, fallback: number): number {
  try {
    const raw = storage?.getItem(REFRESH_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return isRefreshSeconds(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveRefresh(storage: Pick<Storage, "setItem"> | null | undefined, seconds: number): void {
  if (!isRefreshSeconds(seconds)) return;
  try {
    storage?.setItem(REFRESH_KEY, String(seconds));
  } catch {
    // Private mode or a full quota: the choice just is not remembered.
  }
}
