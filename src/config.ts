import type { Config, Mode } from "./types";

export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 30;

const MODES: readonly Mode[] = ["mock", "live", "off"];

// Anything unexpected falls back to mock, which makes no API calls.
export function parseConfig(raw: unknown): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode: "mock", refreshSeconds: DEFAULT_REFRESH_SECONDS };
  }
  const value = raw as Record<string, unknown>;
  const mode = MODES.includes(value.mode as Mode) ? (value.mode as Mode) : "mock";
  let refreshSeconds = DEFAULT_REFRESH_SECONDS;
  if (typeof value.refreshSeconds === "number" && Number.isFinite(value.refreshSeconds)) {
    refreshSeconds = Math.max(MIN_REFRESH_SECONDS, value.refreshSeconds);
  }
  return { mode, refreshSeconds };
}

export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<Config> {
  try {
    const res = await fetchFn("/config.json", { cache: "no-store" });
    if (!res.ok) return parseConfig(null);
    return parseConfig(await res.json());
  } catch {
    return parseConfig(null);
  }
}
