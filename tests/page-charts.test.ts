import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("creates each chart once and then updates it with update('none')", () => {
    const charts = createPageCharts();
    const heroCanvas = canvas();
    const hostCanvas = canvas();
    charts.hero(heroCanvas, fs(first), T1);
    charts.host(hostCanvas, sites(first), T1);
    expect(FakeChart.created.map((c) => c.config.type)).toEqual(["line", "bar"]);
    const [hero, host] = FakeChart.created;

    charts.hero(heroCanvas, fs(second), T2);
    charts.host(hostCanvas, sites(second), T2);
    expect(FakeChart.created).toHaveLength(2);
    expect(hero.update).toHaveBeenCalledTimes(1);
    expect(hero.update).toHaveBeenCalledWith("none");
    expect(host.update).toHaveBeenCalledWith("none");

    const reads = fs(second)!.recent!.series.readsPerMin!;
    expect(hero.data.datasets[0].data).toHaveLength(30);
    expect(hero.data.datasets[0].data[29]).toEqual({ x: T2, y: reads[29] });
    expect(hero.options.scales.x.min).toBe(T2 - 30 * 60000);
    expect(hero.options.scales.x.max).toBe(T2);

    expect(host.data.labels).toHaveLength(30);
    expect(host.data.labels![29]).toBe("10:37 pm");
    expect(host.data.datasets[0].data).toEqual(sites(second)[0].recent!.series.bytesServed);
  });

  it("does nothing without a 2D context", () => {
    const charts = createPageCharts();
    charts.hero(canvas(null), fs(first), T1);
    charts.host(canvas(null), sites(first), T1);
    expect(FakeChart.created).toHaveLength(0);
  });

  it("destroy() destroys both charts", () => {
    const charts = createPageCharts();
    charts.hero(canvas(), fs(first), T1);
    charts.host(canvas(), sites(first), T1);
    charts.destroy();
    expect(FakeChart.created.every((c) => c.destroy.mock.calls.length === 1)).toBe(true);
    // A later call starts a new chart.
    charts.hero(canvas(), fs(first), T1);
    expect(FakeChart.created).toHaveLength(3);
  });
});
