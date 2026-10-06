import { describe, expect, it, vi } from "vitest";
import { crosshairSync, overlayPlugin, type PluginChart, type PluginEventArgs } from "../src/chart-plugins";

const MIN = 60000;
const START = Date.UTC(2026, 9, 5, 4, 45);

// A fake chart: x pixels 0..300 map to START..START + 30 min; a stub context.
function fakeChart(plugins: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(target: Record<string, unknown>, key: string) {
        if (key in target) return target[key];
        if (key === "createPattern") return undefined;
        return (...args: unknown[]) => calls.push(`${key}(${args.join(",")})`);
      },
      set(target: Record<string, unknown>, key: string, value: unknown) {
        target[key] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const chart: PluginChart & { calls: string[] } = {
    calls,
    ctx,
    chartArea: { left: 0, right: 300, top: 20, bottom: 120 },
    scales: {
      x: {
        getPixelForValue: (v: number) => ((v - START) / (30 * MIN)) * 300,
        getValueForPixel: (px: number) => START + (px / 300) * 30 * MIN,
      },
    },
    options: { plugins: { yardCrosshair: { start: START, bucketMs: 15 * MIN, count: 2 }, ...plugins } },
    draw: vi.fn(),
  };
  return chart;
}

const move = (x: number, y = 50): PluginEventArgs => ({ event: { type: "mousemove", x, y } });

describe("crosshairSync", () => {
  it("hovering one panel sets the same bucket on every panel and redraws the others", () => {
    const container = document.createElement("div");
    const sync = crosshairSync({ container, tooltipFor: (i) => ({ title: i === 1 ? "10:30-10:45 am" : "10:15-10:30 am", lines: [`Reads: avg ${i}`, `Writes: avg ${i}`] }) });
    const a = fakeChart();
    const b = fakeChart();
    sync.plugin.afterInit!(a);
    sync.plugin.afterInit!(b);
    const args = move(200);
    sync.plugin.afterEvent!(a, args);
    expect(sync.index()).toBe(1);
    expect(args.changed).toBe(true);
    expect(b.draw).toHaveBeenCalledTimes(1);
    expect(a.draw).not.toHaveBeenCalled();
    // Both panels draw the line at the centre of the bucket (10:37:30 → x 225).
    for (const chart of [a, b]) {
      sync.plugin.afterDatasetsDraw!(chart);
      expect(chart.calls).toContain("moveTo(225,20)");
      expect(chart.calls).toContain("lineTo(225,120)");
    }
    const tip = container.querySelector<HTMLElement>(".dtip")!;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("10:30-10:45 am");
    expect(tip.textContent).toContain("Reads: avg 1");
    expect(tip.textContent).toContain("Writes: avg 1");

    // Leaving the panel clears it everywhere.
    sync.plugin.afterEvent!(a, { event: { type: "mouseout", x: null, y: null } });
    expect(sync.index()).toBeNull();
    expect(tip.hidden).toBe(true);
    b.calls.length = 0;
    sync.plugin.afterDatasetsDraw!(b);
    expect(b.calls).toEqual([]);

    sync.destroy();
    expect(container.querySelector(".dtip")).toBeNull();
  });
});

describe("overlayPlugin", () => {
  it("fills the 'No data before' band only when it is set", () => {
    const band = { from: START - 60 * MIN, to: START + 15 * MIN, label: "No data before 5 Oct" };
    const withBand = fakeChart({ yardOverlay: { band } });
    overlayPlugin.beforeDatasetsDraw!(withBand, {});
    // Clamped to the chart area: 0..150.
    expect(withBand.calls).toContain("fillRect(0,20,150,100)");
    expect(withBand.calls).toContain("fillText(No data before 5 Oct,6,26)");

    const without = fakeChart({ yardOverlay: { band: null } });
    overlayPlugin.beforeDatasetsDraw!(without, {});
    expect(without.calls.some((c) => c.startsWith("fillRect"))).toBe(false);
  });

  it("draws the panel title and the 'No activity' text", () => {
    const chart = fakeChart();
    overlayPlugin.afterDatasetsDraw!(chart, {}, { title: "Reads per minute", empty: "No activity in this period" });
    expect(chart.calls).toContain("fillText(Reads per minute,0,16)");
    expect(chart.calls).toContain("fillText(No activity in this period,150,70)");
  });
});
