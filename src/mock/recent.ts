import { RECENT_KEYS } from "../services";
import type { Kind, RecentSeries } from "../types";

export const RECENT_SLOTS = 30;
const STEP_MS = 60000;

// FNV-1a hash of the text, as a number in [0, 1).
export function seeded(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

// Chance of at least one request in a minute and the largest burst, per
// 2nd gen function. pyWeeklyAccounts stays idle in the sample.
const FUNCTION_LEVELS: Record<string, { p: number; burst: number }> = {
  "function2:pyNightlyExport": { p: 0.04, burst: 1 },
  "function2:pyReadStockistDocs": { p: 0.6, burst: 3 },
  "function2:pyYardStaffOnWrite": { p: 0.45, burst: 2 },
  "function2:pyMintOnCrewClaim": { p: 0.8, burst: 5 },
  "function2:pyDeleteAccountOnRequest": { p: 0.08, burst: 1 },
  "function2:pyStaffLoginOnRequest": { p: 0.5, burst: 2 },
  "function2:pyWeeklyAccounts": { p: 0, burst: 0 },
  "function2:pyPushOnNotification": { p: 0.3, burst: 2 },
  "function2:pyMintOnRoleRequest": { p: 0.25, burst: 2 },
};

// This function always has an error in one minute of every 30.
export const ERROR_SERVICE = "function2:pyMintOnCrewClaim";
const ERROR_MINUTE = 17;

function value(serviceId: string, kind: Kind, key: string, minute: number): number {
  const h = (salt: string) => seeded(`${serviceId}|${key}|${salt}|${minute}`);
  switch (kind) {
    case "function2": {
      const level = FUNCTION_LEVELS[serviceId] ?? { p: 0, burst: 0 };
      const forced = serviceId === ERROR_SERVICE && minute % RECENT_SLOTS === ERROR_MINUTE;
      const req = forced ? 2 : h("a") < level.p ? 1 + Math.floor(h("b") * level.burst) : 0;
      if (key === "reqPerMin") return req;
      // errPerMin
      return forced ? 1 : 0;
    }
    case "function1":
      // The auth-delete trigger fires rarely.
      return seeded(`${serviceId}|${minute}`) > 0.97 ? 1 : 0;
    case "firestore":
      if (key === "readsPerMin") return Math.round(120 + h("r") * 60);
      if (key === "writesPerMin") return Math.round(10 + h("w") * 15);
      return h("d") > 0.9 ? 1 : 0;
    case "bucket":
      if (serviceId.endsWith("-yard-backups")) return h("q") > 0.95 ? 1 : 0;
      return Math.floor(h("q") * 4);
    case "hosting":
      if (serviceId === "hosting:preparaliyard") return 0;
      return Math.round(150000 + h("s") * 110000);
    default:
      return 0;
  }
}

// Deterministic 30-minute series for one service, seeded by its id and the
// absolute minute, so the window slides as time passes. Never fetches.
export function mockRecent(serviceId: string, kind: Kind, nowMs: number): RecentSeries {
  const anchor = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const firstMinute = anchor / STEP_MS - (RECENT_SLOTS - 1);
  const series: Record<string, number[]> = {};
  for (const key of RECENT_KEYS[kind]) {
    series[key] = Array.from({ length: RECENT_SLOTS }, (_, i) => value(serviceId, kind, key, firstMinute + i));
  }
  return { from: new Date(anchor - RECENT_SLOTS * STEP_MS).toISOString(), stepSeconds: 60, series };
}
