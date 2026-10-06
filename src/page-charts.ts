// The page's Chart.js charts: the Firestore hero (reads panel and writes +
// deletes panel, with a shared crosshair) and the hosting bars. Each is
// created once; later refreshes swap the data and x range and call
// update("none"), so a refresh never rebuilds a chart. Tests replace this
// module (tests/setup.ts mocks it).
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from "chart.js";
import { crosshairSync, overlayPlugin, type CrosshairSync } from "./chart-plugins";
import { fitYAxis } from "./chart-shape";
import { applyTheme, heroConfig, heroData, heroWindow, HERO_PANELS, hostAxis, hostConfig, hostData, roundMinuteTicks } from "./page-chart-config";
import { bucketTooltip } from "./panel-config";
import { storageConfig } from "./storage-chart";
import type { HistoryPoint, ServiceMetrics } from "./types";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);
applyTheme(Chart.defaults);

export interface PageCharts {
  hero(canvas: HTMLCanvasElement, fs: ServiceMetrics | undefined, generatedAtMs: number): void;
  host(canvas: HTMLCanvasElement, sites: readonly ServiceMetrics[], generatedAtMs: number): void;
  // Redrawn only when a new points array arrives (at most every 15 min).
  storage(canvas: HTMLCanvasElement, points: readonly HistoryPoint[], nowMs: number): void;
  destroy(): void;
}

type HostChart = Chart<"bar", (number | null)[], string>;

interface Hero {
  // The reads canvas the hero was made on.
  canvas: HTMLCanvasElement;
  // One chart per panel (null when that canvas is missing or unusable).
  charts: (Chart | null)[];
  sync: CrosshairSync;
}

// Without a 2D context no chart is made; the numbers beside it still work.
function usable(canvas: HTMLCanvasElement): boolean {
  return canvas.getContext("2d") !== null;
}

// The writes + deletes canvas beside the reads canvas, if any.
function writesCanvasOf(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  return canvas.closest(".hero-chart")?.querySelector<HTMLCanvasElement>('canvas[data-panel="writes"]') ?? null;
}

type Scales = Record<string, Record<string, unknown>>;

// Copies the data, x range and ticks, y axis and overlay options of next into
// chart, so the round time ticks, bottom-only labels and shared y width stay.
function swap(chart: Chart, next: ChartConfiguration) {
  chart.data.datasets.forEach((dataset, i) => {
    const fresh = next.data.datasets[i];
    if (fresh) dataset.data = fresh.data;
  });
  const scales = chart.options.scales as Scales | undefined;
  const nextScales = next.options?.scales as Scales | undefined;
  if (scales?.x && nextScales?.x) {
    scales.x.min = nextScales.x.min;
    scales.x.max = nextScales.x.max;
    scales.x.afterBuildTicks = nextScales.x.afterBuildTicks;
    Object.assign(scales.x.ticks as object, { display: (nextScales.x.ticks as { display?: boolean }).display });
  }
  if (scales?.y && nextScales?.y) {
    scales.y.max = nextScales.y.max;
    scales.y.afterFit = nextScales.y.afterFit;
    Object.assign(scales.y.ticks as object, { stepSize: (nextScales.y.ticks as { stepSize?: number }).stepSize });
  }
  const plugins = chart.options.plugins as Record<string, unknown> | undefined;
  const nextPlugins = next.options?.plugins as Record<string, unknown> | undefined;
  if (plugins && nextPlugins) {
    plugins.yardOverlay = nextPlugins.yardOverlay;
    plugins.yardCrosshair = nextPlugins.yardCrosshair;
  }
}

export function createPageCharts(): PageCharts {
  let hero: Hero | null = null;
  let hostChart: HostChart | null = null;
  let storageChart: { chart: Chart; points: readonly HistoryPoint[] } | null = null;
  // The latest hero data, for the shared tooltip.
  let latest: { fs: ServiceMetrics | undefined; at: number } = { fs: undefined, at: 0 };

  function destroyHero() {
    hero?.charts.forEach((c) => c?.destroy());
    hero?.sync.destroy();
    hero = null;
  }

  return {
    hero(canvas, fs, generatedAtMs) {
      latest = { fs, at: generatedAtMs };
      if (hero && hero.canvas !== canvas) destroyHero();
      const { panels } = heroConfig(fs, generatedAtMs);
      if (!hero) {
        if (!usable(canvas)) return;
        const sync = crosshairSync({
          container: canvas.closest<HTMLElement>(".hero-chart"),
          tooltipFor: (index) => bucketTooltip(HERO_PANELS, heroData(latest.fs, latest.at), index, heroWindow(latest.fs, latest.at)),
        });
        const writes = writesCanvasOf(canvas);
        const targets = [canvas, writes && usable(writes) ? writes : null];
        const charts = panels.map(({ config }, i) => {
          const target = targets[i];
          if (!target) return null;
          config.plugins = [sync.plugin as unknown as Plugin, overlayPlugin as unknown as Plugin];
          return new Chart(target, config);
        });
        hero = { canvas, charts, sync };
        return;
      }
      hero.charts.forEach((chart, i) => {
        const next = panels[i];
        if (!chart || !next) return;
        swap(chart, next.config);
        chart.update("none");
      });
    },
    host(canvas, sites, generatedAtMs) {
      if (hostChart && hostChart.canvas !== canvas) {
        hostChart.destroy();
        hostChart = null;
      }
      if (!hostChart) {
        if (!usable(canvas)) return;
        hostChart = new Chart(canvas, hostConfig(sites, generatedAtMs));
        return;
      }
      const data = hostData(sites, generatedAtMs);
      hostChart.data.labels = data.labels;
      if (hostChart.data.datasets.length === sites.length) {
        hostChart.data.datasets.forEach((dataset, i) => {
          dataset.data = data.datasets[i];
        });
      } else {
        hostChart.data.datasets = hostConfig(sites, generatedAtMs).data.datasets;
      }
      const scales = hostChart.options.scales as Scales | undefined;
      if (scales?.x) scales.x.afterBuildTicks = roundMinuteTicks;
      if (scales?.y) {
        const axis = hostAxis(data);
        scales.y.max = axis.max;
        scales.y.afterFit = fitYAxis;
        Object.assign(scales.y.ticks as object, { stepSize: axis.step });
      }
      hostChart.update("none");
    },
    storage(canvas, points, nowMs) {
      if (storageChart && storageChart.chart.canvas === canvas && storageChart.points === points) return;
      storageChart?.chart.destroy();
      storageChart = null;
      if (!usable(canvas)) return;
      const config = storageConfig(points, nowMs);
      config.plugins = [overlayPlugin as unknown as Plugin];
      storageChart = { chart: new Chart(canvas, config), points };
    },
    destroy() {
      destroyHero();
      hostChart?.destroy();
      hostChart = null;
      storageChart?.chart.destroy();
      storageChart = null;
    },
  };
}
