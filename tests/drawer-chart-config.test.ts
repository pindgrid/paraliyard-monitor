import { describe, expect, it, vi } from "vitest";
import type { ChartEvent, LegendElement, LegendItem, TooltipItem } from "chart.js";
import { drawerConfig, type DrawerChartSpec } from "../src/drawer-chart";
import { fmt, istDateTime, istTick } from "../src/fmt";

// The real adapter's pure config (tests/setup.ts mocks the module elsewhere).
vi.unmock("../src/drawer-chart");

const HOUR = 3600000;
// 5 Oct 2026, 2:35:47 am IST.
const T = Date.UTC(2026, 9, 4, 21, 5, 47);

function lineSpec(onLegendToggle?: DrawerChartSpec["onLegendToggle"]): DrawerChartSpec {
  return {
    kind: "line",
    from: T - HOUR,
    to: T,
    formatX: istDateTime,
    formatTick: (ms) => istTick(ms, HOUR),
    axes: { y: { title: "reads/min", format: fmt.rate }, y1: { title: "writes, deletes", format: fmt.rate } },
    formats: [fmt.rate, fmt.rate, fmt.rate],
    datasets: [
      { label: "Reads/min", color: "#B07A12", axis: "y", data: [{ x: T, y: 51.64 }], fill: true },
      { label: "Writes/min", color: "#3E7B4F", axis: "y1", data: [] },
      { label: "Deletes/min", color: "#B8442F", axis: "y1", data: [], hidden: true },
    ],
    onLegendToggle,
  };
}

// The options object as plain records (Chart.js option types are unions).
function options(spec: DrawerChartSpec) {
  const cfg = drawerConfig(spec);
  return cfg.options as unknown as {
    scales: Record<string, { ticks: { callback: (v: number) => string } }>;
    plugins: {
      legend: { display: boolean; position?: string; labels?: Record<string, unknown>; onClick?: (...args: unknown[]) => void };
      tooltip: Record<string, unknown> & { callbacks: { title: (items: unknown[]) => string; label: (item: unknown) => string } };
    };
  };
}

describe("drawerConfig", () => {
  it("line charts enable the Chart.js legend at the bottom with line point styles", () => {
    const legend = options(lineSpec()).plugins.legend;
    expect(legend.display).toBe(true);
    expect(legend.position).toBe("bottom");
    expect(legend.labels).toMatchObject({ usePointStyle: true, pointStyle: "line", boxWidth: 22, color: "#55604E" });
    expect(typeof legend.onClick).toBe("function");
  });

  it("keeps series hidden by default hidden", () => {
    expect(drawerConfig(lineSpec()).data.datasets.map((d) => d.hidden)).toEqual([false, false, true]);
  });

  it("a legend click toggles that dataset and reports the new visibility", () => {
    const toggles: [number, boolean][] = [];
    const legend = options(lineSpec((i, v) => toggles.push([i, v]))).plugins.legend;
    const shown = [true, true, false];
    const chart = {
      isDatasetVisible: (i: number) => shown[i],
      hide: (i: number) => {
        shown[i] = false;
      },
      show: (i: number) => {
        shown[i] = true;
      },
    };
    const element = { chart } as unknown as LegendElement<"line">;
    const item = { datasetIndex: 1, text: "Writes/min" } as LegendItem;
    const event = {} as ChartEvent;
    legend.onClick!.call(element, event, item, element);
    expect(shown).toEqual([true, false, false]);
    expect(item.hidden).toBe(true);
    legend.onClick!.call(element, event, { datasetIndex: 2, text: "Deletes/min" } as LegendItem, element);
    expect(shown).toEqual([true, false, true]);
    legend.onClick!.call(element, event, item, element);
    expect(toggles).toEqual([
      [1, false],
      [2, true],
      [1, true],
    ]);
  });

  it("uses the shared tooltip style with IST date-time titles and per-range ticks", () => {
    const opts = options(lineSpec());
    expect(opts.plugins.tooltip).toMatchObject({
      backgroundColor: "#1F2A1E",
      titleColor: "#F6F7F1",
      bodyColor: "#F6F7F1",
      padding: 10,
      cornerRadius: 6,
      boxPadding: 4,
      usePointStyle: true,
    });
    const item = { parsed: { x: T, y: 51.64 }, datasetIndex: 0, dataset: { label: "Reads/min" } } as unknown as TooltipItem<"line">;
    expect(opts.plugins.tooltip.callbacks.title([item])).toBe("5 Oct 2026, 2:35:47 am");
    expect(opts.plugins.tooltip.callbacks.label(item)).toBe(" Reads/min: 51.64");
    // 1h range: short 12-hour ticks.
    expect(opts.scales.x.ticks.callback(T)).toBe("2:35 am");
  });

  it("run bars have no legend", () => {
    const spec: DrawerChartSpec = {
      kind: "bar",
      formatX: istDateTime,
      axes: { y: { title: "seconds", format: fmt.seconds } },
      formats: [fmt.seconds],
      labels: [istDateTime(T)],
      datasets: [{ label: "Run duration (s)", color: "#3E7B4F", axis: "y", data: [{ x: T, y: 12 }] }],
    };
    expect(options(spec).plugins.legend.display).toBe(false);
  });
});
