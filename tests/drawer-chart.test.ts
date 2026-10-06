import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketFor, sourceStepFor, Y_AXIS_WIDTH } from "../src/chart-shape";
import { createDrawerChart, type DrawerChartSpec } from "../src/drawer-chart";
import { groupFor } from "../src/drawer-groups";
import { istDateTime, istTick } from "../src/fmt";

// The real adapter, over a spy Chart class (jsdom has no canvas).
vi.unmock("../src/drawer-chart");

const { FakeChart } = vi.hoisted(() => {
  type Scale = {
    min?: number;
    max?: number;
    afterFit?: (s: { width: number }) => void;
    afterBuildTicks?: (s: unknown) => void;
    ticks: { display?: boolean; stepSize?: number };
  };
  class FakeChart {
    static register = vi.fn();
    static defaults = { font: {} as { family?: string; size?: number }, color: "", borderColor: "" };
    static created: FakeChart[] = [];
    canvas: HTMLCanvasElement;
    config: {
      data: { datasets: { data: unknown[]; hidden?: boolean; seriesIndex?: number }[] };
      options: {
        scales: Record<string, Scale>;
        plugins: { legend: { onClick?: (e: unknown, item: { datasetIndex: number }, legend: unknown) => void } };
      };
    };
    data: FakeChart["config"]["data"];
    options: FakeChart["config"]["options"];
    update = vi.fn();
    destroy = vi.fn();
    setDatasetVisibility = vi.fn();
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

const MIN = 60000;
const HOUR = 60 * MIN;
// 5 Oct 2026, 2:00 pm IST.
const T = Date.UTC(2026, 9, 5, 8, 30);
const OPENER = "fn:function2:pyMintOnCrewClaim";

function canvas(): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];
  return el;
}

function setup(value = 37) {
  const group = groupFor(OPENER)!;
  const from = T - 24 * HOUR;
  const step = sourceStepFor("24h");
  const points = (v: number) => Array.from({ length: 288 }, (_, i) => ({ x: from + (i + 1) * step, y: v }));
  const container = document.createElement("div");
  container.className = "dchart";
  const target = canvas();
  container.append(target);
  document.body.append(container);
  const onLegendToggle = vi.fn();
  const spec: DrawerChartSpec = {
    kind: "line",
    datasets: group.series.map((s) => ({ label: s.metric, color: "#3E7B4F", data: points(value) })),
    panels: group.panels,
    panelContext: { bucketMs: bucketFor("24h"), sourceStepMs: step, band: null },
    from,
    to: T,
    formatX: istDateTime,
    formatTick: (ms) => istTick(ms, 24 * HOUR),
    formats: [],
    onLegendToggle,
  };
  const chart = createDrawerChart(target, spec);
  return { group, container, chart, onLegendToggle, points };
}

// Every chart: shared y width, bottom-only time labels, a round y max.
function expectRules(panels: ReturnType<typeof setup>["group"]["panels"]) {
  const charts = FakeChart.created;
  expect(charts).toHaveLength(panels.length);
  charts.forEach((c, p) => {
    const { x, y } = c.options.scales;
    const fake = { width: 0 };
    y.afterFit!(fake);
    expect(fake.width, panels[p].title).toBe(Y_AXIS_WIDTH);
    expect(typeof x.afterBuildTicks, panels[p].title).toBe("function");
    expect(x.ticks.display, panels[p].title).toBe(p === panels.length - 1);
    const step = y.ticks.stepSize!;
    if (panels[p].unit === "pct") {
      expect([y.max, step], panels[p].title).toEqual([100, 25]);
    } else {
      expect(Number.isInteger(Number((y.max! / step).toFixed(9))), panels[p].title).toBe(true);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5], panels[p].title).toContain(Number(mantissa.toFixed(6)));
    }
  });
}

beforeEach(() => {
  FakeChart.created = [];
  document.body.innerHTML = "";
});

describe("createDrawerChart panels", () => {
  it("sizes panels by CSS classes only, not by heightWeight", () => {
    const { group, container } = setup();
    expect(container.classList.contains("dpanels")).toBe(true);
    expect(container.style.height).toBe("");
    const wrappers = [...container.querySelectorAll<HTMLElement>(".dpanel")];
    expect(wrappers).toHaveLength(group.panels.length);
    wrappers.forEach((w, i) => {
      const panel = group.panels[i];
      expect(w.classList.contains("dpanel--legend"), panel.title).toBe(panel.datasets.length > 1);
      expect(w.classList.contains("dpanel--last"), panel.title).toBe(i === group.panels.length - 1);
      expect(w.style.flex, panel.title).toBe("");
      expect(w.style.height, panel.title).toBe("");
    });
    const source = readFileSync("src/drawer-chart.ts", "utf8");
    expect(source).not.toContain("heightWeight");
    expect(source).not.toContain("PANEL_HEIGHT_PX");
  });

  it("only the bottom chart labels the times; every chart has the shared y width", () => {
    const { group } = setup();
    expectRules(group.panels);
  });

  it("keeps the rules after new data and after a legend toggle, with update('none')", () => {
    const { group, chart, onLegendToggle, points } = setup();
    chart.setData(0, points(4321));
    expectRules(group.panels);
    for (const c of FakeChart.created) expect(c.update).toHaveBeenLastCalledWith("none");
    // The axis followed the new data (4321 requests minus 37 errors).
    expect(FakeChart.created[0].options.scales.y.max).toBeGreaterThanOrEqual(4284);

    // A legend click on the first panel's second series.
    const first = FakeChart.created[0];
    const index = first.data.datasets.findIndex((d, k) => k > 0 && d.seriesIndex !== first.data.datasets[0].seriesIndex);
    first.options.plugins.legend.onClick!({}, { datasetIndex: index }, { chart: { data: first.data } });
    expect(onLegendToggle).toHaveBeenCalledWith(first.data.datasets[index].seriesIndex, false);
    expectRules(group.panels);
    for (const c of FakeChart.created) expect(c.update).toHaveBeenLastCalledWith("none");

    chart.setVisible(first.data.datasets[index].seriesIndex!, true);
    expectRules(group.panels);
  });

  it("destroy() removes the wrappers and the classes and keeps the container height", () => {
    const { container, chart } = setup();
    container.style.height = "";
    chart.destroy();
    expect(container.querySelectorAll(".dpanel")).toHaveLength(0);
    expect(container.classList.contains("dpanels")).toBe(false);
    expect(container.style.height).toBe("");
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(FakeChart.created.every((c) => c.destroy.mock.calls.length === 1)).toBe(true);
  });
});
