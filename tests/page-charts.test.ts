import { beforeEach, describe, expect, it, vi } from "vitest";
import { Y_AXIS_WIDTH } from "../src/chart-shape";
import { createPageCharts } from "../src/page-charts";
import { createMockSource } from "../src/source";
import type { MetricsResponse } from "../src/types";

// The real factory, over a spy Chart class (jsdom has no canvas).
vi.unmock("../src/page-charts");

const { FakeChart } = vi.hoisted(() => {
  class FakeChart {
    static register = vi.fn();
    static defaults = { font: {} as { family?: string; size?: number }, color: "", borderColor: "" };
    static created: FakeChart[] = [];
    canvas: HTMLCanvasElement;
    config: { type: string; data: { labels?: unknown[]; datasets: { data: unknown[] }[] }; options: { scales: Record<string, { min?: number; max?: number }> } };
    data: FakeChart["config"]["data"];
    options: FakeChart["config"]["options"];
    update = vi.fn();
    destroy = vi.fn();
    constructor(canvas: HTMLCanvasElement, config: FakeChart["config"]) {
      this.canvas = canvas;
      this.config = config;
      this.data = config.data;
      this.options = config.options;
      FakeChart.created.push(this);
    }
  }
  return { FakeChart };
});

vi.mock("chart.js", () => ({
  Chart: FakeChart,
  BarController: {},
  BarElement: {},
  CategoryScale: {},
  Filler: {},
  Legend: {},
  LinearScale: {},
  LineController: {},
  LineElement: {},
  PointElement: {},
  Tooltip: {},
}));

const T1 = Date.UTC(2026, 9, 5, 17, 6, 0);
const T2 = T1 + 60000;

function canvas(context: unknown = {}): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.getContext = (() => context) as unknown as HTMLCanvasElement["getContext"];
  return el;
}

let first: MetricsResponse;
let second: MetricsResponse;
const fs = (d: MetricsResponse) => d.services.find((s) => s.kind === "firestore");
const sites = (d: MetricsResponse) => d.services.filter((s) => s.kind === "hosting");

beforeEach(async () => {
  FakeChart.created = [];
  first = await createMockSource(() => T1).load();
  second = await createMockSource(() => T2).load();
});

describe("createPageCharts", () => {
  it("registers the controllers once and applies the theme", () => {
    expect(FakeChart.register).toHaveBeenCalledTimes(1);
    expect(FakeChart.register.mock.calls[0]).toHaveLength(10);
    expect(FakeChart.defaults.font.size).toBe(12);
    expect(FakeChart.defaults.borderColor).toBe("#D0D6C4");
  });

  // The hero markup: a reads canvas and a writes + deletes canvas.
  function heroCanvases() {
    const container = document.createElement("div");
    container.className = "hero-chart";
    const reads = canvas();
    const writes = canvas();
    writes.dataset.panel = "writes";
    for (const c of [reads, writes]) {
      const panel = document.createElement("div");
      panel.className = "hero-panel";
      panel.append(c);
      container.append(panel);
    }
    document.body.append(container);
    return { reads, writes, container };
  }

  it("creates each chart once and then updates it with update('none')", () => {
    const charts = createPageCharts();
    const { reads: heroCanvas, writes: writesCanvas } = heroCanvases();
    const hostCanvas = canvas();
    charts.hero(heroCanvas, fs(first), T1);
    charts.host(hostCanvas, sites(first), T1);
    expect(FakeChart.created.map((c) => c.config.type)).toEqual(["bar", "bar", "bar"]);
    const [reads, writes, host] = FakeChart.created;
    expect(reads.canvas).toBe(heroCanvas);
    expect(writes.canvas).toBe(writesCanvas);
    // Both hero panels share the crosshair and overlay plugins.
    expect((reads.config as unknown as { plugins: { id: string }[] }).plugins.map((p) => p.id)).toEqual(["yardCrosshair", "yardOverlay"]);

    charts.hero(heroCanvas, fs(second), T2);
    charts.host(hostCanvas, sites(second), T2);
    expect(FakeChart.created).toHaveLength(3);
    for (const chart of [reads, writes, host]) {
      expect(chart.update).toHaveBeenCalledTimes(1);
      expect(chart.update).toHaveBeenCalledWith("none");
    }

    const readsSeries = fs(second)!.recent!.series.readsPerMin!;
    expect(reads.data.datasets[0].data).toHaveLength(30);
    expect(reads.data.datasets[0].data[29]).toEqual({ x: T2 - 30000, y: readsSeries[29] });
    expect(reads.options.scales.x.min).toBe(T2 - 30 * 60000);
    expect(reads.options.scales.x.max).toBe(T2);
    expect(writes.data.datasets.map((d) => d.data.length)).toEqual([30, 30]);
    expect(writes.options.scales.x.max).toBe(T2);

    expect(host.data.labels).toHaveLength(30);
    expect(host.data.labels![29]).toBe("10:37 pm");
    expect(host.data.datasets[0].data).toEqual(sites(second)[0].recent!.series.bytesServed);

    // After the refresh: the shared y width, bottom-only hero time labels,
    // the round tick hooks and a round y max.
    type Scale = { max: number; afterFit: (s: { width: number }) => void; afterBuildTicks?: unknown; ticks: { display?: boolean; stepSize: number } };
    const scalesOf = (c: (typeof FakeChart.created)[number]) => c.options.scales as unknown as Record<string, Scale>;
    expect(scalesOf(reads).x.ticks.display).toBe(false);
    expect(scalesOf(writes).x.ticks.display).toBe(true);
    for (const chart of [reads, writes, host]) {
      const { x, y } = scalesOf(chart);
      const fake = { width: 0 };
      y.afterFit(fake);
      expect(fake.width).toBe(Y_AXIS_WIDTH);
      expect(typeof x.afterBuildTicks).toBe("function");
      expect(Number.isInteger(Number((y.max / y.ticks.stepSize).toFixed(9)))).toBe(true);
    }
  });

  it("draws only the reads panel when the writes canvas is missing", () => {
    const charts = createPageCharts();
    const lone = canvas();
    charts.hero(lone, fs(first), T1);
    expect(FakeChart.created).toHaveLength(1);
    charts.hero(lone, fs(second), T2);
    expect(FakeChart.created).toHaveLength(1);
    expect(FakeChart.created[0].update).toHaveBeenCalledWith("none");
  });

  it("does nothing without a 2D context", () => {
    const charts = createPageCharts();
    charts.hero(canvas(null), fs(first), T1);
    charts.host(canvas(null), sites(first), T1);
    expect(FakeChart.created).toHaveLength(0);
  });

  it("destroy() destroys every chart", () => {
    const charts = createPageCharts();
    charts.hero(heroCanvases().reads, fs(first), T1);
    charts.host(canvas(), sites(first), T1);
    expect(FakeChart.created).toHaveLength(3);
    charts.destroy();
    expect(FakeChart.created.every((c) => c.destroy.mock.calls.length === 1)).toBe(true);
    // A later call starts a new chart.
    charts.hero(canvas(), fs(first), T1);
    expect(FakeChart.created).toHaveLength(4);
  });
});
