// The storage card's growth chart: total bytes stored over the last 30 days,
// as a step line, drawn by the same panel rules as the drawer charts.
import type { ChartConfiguration } from "chart.js";
import { bucketFor, firstDataAt, noDataBand, sourceStepFor, type XYPoint } from "./chart-shape";
import type { PanelSpec } from "./drawer-groups";
import { istTick } from "./fmt";
import { panelConfig } from "./panel-config";
import type { HistoryPoint, HistoryRange } from "./types";

export const STORAGE_RANGE: HistoryRange = "30d";
export const STORAGE_RANGE_MS = 30 * 86400000;
// The growth points are reloaded at most this often.
export const STORAGE_RELOAD_MS = 15 * 60 * 1000;

export const STORAGE_PANEL: PanelSpec = {
  title: "Storage used, last 30 days",
  kind: "level",
  unit: "bytes",
  heightWeight: 1,
  datasets: [{ series: 0, label: "All buckets", color: "--canal" }],
};

export function storagePoints(points: readonly HistoryPoint[]): XYPoint[] {
  return points.map((p) => ({ x: Date.parse(p.t), y: p.v })).filter((p) => Number.isFinite(p.x));
}

export function storageConfig(points: readonly HistoryPoint[], nowMs: number): ChartConfiguration {
  const raw = storagePoints(points);
  const from = nowMs - STORAGE_RANGE_MS;
  const bucketMs = bucketFor(STORAGE_RANGE);
  return panelConfig(STORAGE_PANEL, {
    from,
    to: nowMs,
    bucketMs,
    sourceStepMs: sourceStepFor(STORAGE_RANGE),
    raw: [raw],
    visible: [],
    band: noDataBand(from, firstDataAt([raw]), bucketMs),
    formatTick: (ms) => istTick(ms, STORAGE_RANGE_MS),
  });
}
