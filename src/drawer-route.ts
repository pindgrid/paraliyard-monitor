import { groupFor, openerForTarget } from "./drawer-groups";
import { isAllowedHistoryTarget } from "./history-source";
import type { HistoryRange } from "./types";

// Deep links to the drawer: /history/<id>?range=<range>, and the older
// /history/<id>/<metric>?range=<range> which also shows that metric.

export interface DrawerRoute {
  target: string;
  opener: string;
  // Metric named by the older form; it is made visible.
  metric: string | null;
  range: HistoryRange;
}

const ROUTE_PATTERN = /^\/history\/([^/]+)(?:\/([^/]+))?\/?$/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function isHistoryPath(pathname: string): boolean {
  return pathname === "/history" || pathname.startsWith("/history/");
}

// The drawer route, or null for anything not allowlisted: unknown id or
// metric, or a range the drawer does not offer for that kind.
export function parseDrawerRoute(pathname: string, search: string): DrawerRoute | null {
  const match = ROUTE_PATTERN.exec(pathname);
  if (!match) return null;
  const target = decode(match[1]);
  const metric = match[2] === undefined ? null : decode(match[2]);
  if (target === null || (match[2] !== undefined && metric === null)) return null;
  const opener = openerForTarget(target);
  const group = opener ? groupFor(opener) : null;
  if (!opener || !group) return null;
  if (metric !== null) {
    if (!isAllowedHistoryTarget(target, metric)) return null;
    if (!group.series.some((s) => s.service === target && s.metric === metric)) return null;
  }
  const range = new URLSearchParams(search).get("range") ?? group.defaultRange;
  if (!(group.ranges as readonly string[]).includes(range)) return null;
  return { target, opener, metric, range: range as HistoryRange };
}

// Ids only use [A-Za-z0-9:-], so they go into the path as is.
export function drawerPath(target: string, range: HistoryRange): string {
  return `/history/${target}?range=${range}`;
}
