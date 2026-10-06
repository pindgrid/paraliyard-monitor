import { describe, expect, it } from "vitest";
import { STORAGE_PANEL, STORAGE_RANGE_MS, storageConfig, storagePoints } from "../src/storage-chart";
import type { HistoryPoint } from "../src/types";

const NOW = Date.UTC(2026, 9, 7, 6, 0, 0);
const DAY = 86400000;

interface StorageChartConfig {
  type: string;
  data: { datasets: { stepped?: boolean; tension?: number }[] };
  options: {
    scales: Record<string, { min?: number; max?: number }>;
    plugins: { yardOverlay: { title: string; band: { label: string } | null } };
  };
}

describe("storage card chart", () => {
  it("is one stepped level line of bytes, never smoothed, on one y axis", () => {
    expect(STORAGE_PANEL).toMatchObject({ kind: "level", unit: "bytes" });
    const points: HistoryPoint[] = [5, 4, 3, 2, 1].map((d, i) => ({ t: new Date(NOW - d * DAY).toISOString(), v: (i + 1) * 10e6 }));
    const config = storageConfig(points, NOW) as unknown as StorageChartConfig;
    expect(config.type).toBe("line");
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0].stepped).toBe(true);
    expect(config.data.datasets[0].tension).toBe(0);
    expect(Object.keys(config.options.scales).sort()).toEqual(["x", "y"]);
    expect(config.options.scales.x.min).toBe(NOW - STORAGE_RANGE_MS);
    expect(config.options.scales.x.max).toBe(NOW);
    expect(config.options.plugins.yardOverlay.title).toBe("Storage used, last 30 days");
    // The data starts 5 days ago, so the empty part is explained.
    expect(config.options.plugins.yardOverlay.band?.label).toMatch(/^No data before /);
  });

  it("drops points with an invalid time", () => {
    expect(storagePoints([{ t: "nope", v: 1 }, { t: new Date(NOW).toISOString(), v: 2 }])).toEqual([{ x: NOW, y: 2 }]);
  });
});
