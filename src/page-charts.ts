// The page's two Chart.js charts (Firestore hero and hosting bars). Each is
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
} from "chart.js";
import { applyTheme, heroConfig, heroData, hostConfig, hostData, LIVE_WINDOW_MS, type HeroPoint } from "./page-chart-config";
import type { ServiceMetrics } from "./types";

Chart.register(LineController, BarController, LineElement, BarElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);
applyTheme(Chart.defaults);

export interface PageCharts {
  hero(canvas: HTMLCanvasElement, fs: ServiceMetrics | undefined, generatedAtMs: number): void;
  host(canvas: HTMLCanvasElement, sites: readonly ServiceMetrics[], generatedAtMs: number): void;
  destroy(): void;
}

type HeroChart = Chart<"line", HeroPoint[]>;
type HostChart = Chart<"bar", (number | null)[], string>;

// Without a 2D context no chart is made; the numbers beside it still work.
function usable(canvas: HTMLCanvasElement): boolean {
  return canvas.getContext("2d") !== null;
}

export function createPageCharts(): PageCharts {
  let heroChart: HeroChart | null = null;
  let hostChart: HostChart | null = null;

  return {
    hero(canvas, fs, generatedAtMs) {
      if (heroChart && heroChart.canvas !== canvas) {
        heroChart.destroy();
        heroChart = null;
      }
      if (!heroChart) {
        if (!usable(canvas)) return;
        heroChart = new Chart(canvas, heroConfig(fs, generatedAtMs));
        return;
      }
      const data = heroData(fs, generatedAtMs);
      heroChart.data.datasets.forEach((dataset, i) => {
        dataset.data = data[i] ?? [];
      });
      const x = heroChart.options.scales?.x;
      if (x) {
        x.min = generatedAtMs - LIVE_WINDOW_MS;
        x.max = generatedAtMs;
      }
      heroChart.update("none");
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
      hostChart.update("none");
    },
    destroy() {
      heroChart?.destroy();
      hostChart?.destroy();
      heroChart = null;
      hostChart = null;
    },
  };
}
