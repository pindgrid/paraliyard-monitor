// Chart.js configs for the page's hero and hosting charts, and the theme the
// drawer shares. Types only from chart.js, so this module is pure and tests
// call the builders and named callbacks directly. Values follow the design
// reference (themeDefaults, tooltipStyle, makeHero, makeHost, updateHost).
import type { ChartConfiguration, TooltipItem } from "chart.js";
import { bytesTick as axisBytesTick, LIVE_BUCKET_MS, LIVE_BUCKETS, niceAxis, type NiceAxis } from "./chart-shape";
import type { PanelSpec } from "./drawer-groups";
import { BYTE_AXIS_MIN, fmt, istTick, istShortTime, istTime, uniqueTicks } from "./fmt";
import { panelConfig, panelData, type PanelSeries, type PanelWindow } from "./panel-config";
import { recentSeries } from "./recent";
import type { ServiceMetrics } from "./types";

// Light palette (src/styles.css).
export const INK = "#1F2A1E";
export const INK_2 = "#55604E";
export const INK_3 = "#848D79";
export const SURFACE = "#F6F7F1";
export const RULE = "#D0D6C4";
export const STRAW = "#B07A12";
export const PADDY = "#3E7B4F";
export const CANAL = "#2D6A8E";
export const EMBER = "#B8442F";
// Per hosting site, in service order: straw, canal, paddy, ember.
export const SITE_COLORS: readonly string[] = [STRAW, CANAL, PADDY, EMBER];

export const FONT_FAMILY = '"Archivo Variable", Archivo, "Helvetica Neue", Arial, sans-serif';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
export const LIVE_WINDOW_MS = 30 * MINUTE_MS;
export const HOST_SLOTS = 30;

export interface HeroPoint {
  x: number;
  y: number | null;
}

// The parts of Chart.defaults the theme sets.
export interface ThemeTarget {
  font: { family?: string; size?: number };
  color: unknown;
  borderColor: unknown;
}

export function applyTheme(defaults: ThemeTarget): void {
  defaults.font.family = FONT_FAMILY;
  defaults.font.size = 12;
  defaults.color = INK_3;
  defaults.borderColor = RULE;
}

export function tooltipStyle() {
  return {
    backgroundColor: INK,
    titleColor: SURFACE,
    bodyColor: SURFACE,
    padding: 10,
    cornerRadius: 6,
    boxPadding: 4,
    usePointStyle: true,
  };
}

export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- Callbacks ----------

// x ticks of the hero: "10:36 pm".
export function heroTick(value: number | string): string {
  return istTick(Number(value), HOUR_MS);
}

// Hero tooltip title: the time with seconds, "10:36:00 pm".
export function heroTooltipTitle(items: readonly TooltipItem<"line">[]): string {
  const item = items[0];
  return item ? istTime(Number(item.parsed.x)) : "";
}

// " Reads/min: 51.64".
export function rateLabel(item: TooltipItem<"line">): string {
  const y = item.parsed.y;
  return ` ${item.dataset.label ?? ""}: ${fmt.rate(typeof y === "number" ? y : null)}`;
}

// Hosting y ticks: "1.0 kB".
export function bytesTick(value: number | string): string {
  return fmt.bytes(Number(value));
}

// Hosting y ticks without repeated labels: "0", "500 B", "1 kB".
export const hostBytesTick = uniqueTicks((v) => axisBytesTick(v ?? 0));

// " paraliyard: 2.0 kB/min".
export function hostLabel(item: TooltipItem<"bar">): string {
  const y = item.parsed.y;
  return ` ${item.dataset.label ?? ""}: ${fmt.bytes(typeof y === "number" ? y : null)}/min`;
}

// ---------- Hero (Firestore, last 30 minutes) ----------

// Reads on top (about 70 % of the height), writes and deletes below.
export const HERO_PANELS: readonly PanelSpec[] = [
  { title: "Reads per minute", kind: "bar", unit: "count", heightWeight: 0.7, datasets: [{ series: 0, label: "Reads", color: "--straw" }] },
  {
    title: "Writes and deletes per minute",
    kind: "bar",
    unit: "count",
    heightWeight: 0.3,
    stacked: true,
    datasets: [
      { series: 1, label: "Writes", color: "--paddy" },
      { series: 2, label: "Deletes", color: "--ember" },
    ],
  },
];

const HERO_KEYS = ["readsPerMin", "writesPerMin", "deletesPerMin"] as const;

// The 30 one-minute buckets: recent's window, else the 30 minutes up to the
// minute of generatedAt.
export function heroWindow(fs: ServiceMetrics | undefined, generatedAtMs: number): PanelWindow {
  const recentFrom = fs?.recent ? Date.parse(fs.recent.from) : NaN;
  const from = Number.isFinite(recentFrom) ? recentFrom : Math.floor(generatedAtMs / MINUTE_MS) * MINUTE_MS - LIVE_WINDOW_MS;
  return { from, to: from + LIVE_BUCKETS * LIVE_BUCKET_MS, bucketMs: LIVE_BUCKET_MS, sourceStepMs: MINUTE_MS };
}

// Each minute is plotted at the end of its slot, so the newest is "now".
function heroPoints(fs: ServiceMetrics | undefined, key: string, generatedAtMs: number): HeroPoint[] {
  const values = recentSeries(fs, key);
  if (!values) return [];
  const from = fs?.recent ? Date.parse(fs.recent.from) : NaN;
  const step = (fs?.recent?.stepSeconds ?? 60) * 1000;
  const n = values.length;
  return values.map((v, i) => ({
    x: Number.isFinite(from) ? from + (i + 1) * step : generatedAtMs - (n - 1 - i) * step,
    y: typeof v === "number" ? v : null,
  }));
}

// Reads, writes and deletes points, in series order.
export function heroPointsOf(fs: ServiceMetrics | undefined, generatedAtMs: number): HeroPoint[][] {
  return HERO_KEYS.map((key) => heroPoints(fs, key, generatedAtMs));
}

// The bucketed series of each hero panel.
export function heroData(fs: ServiceMetrics | undefined, generatedAtMs: number): PanelSeries[][] {
  const raw = heroPointsOf(fs, generatedAtMs);
  const win = heroWindow(fs, generatedAtMs);
  return HERO_PANELS.map((panel) => panelData(panel, raw, win));
}

export interface HeroPanelConfig {
  weight: number;
  config: ChartConfiguration;
}

// Two stacked bar panels with one y axis each.
export function heroConfig(fs: ServiceMetrics | undefined, generatedAtMs: number): { panels: HeroPanelConfig[] } {
  const raw = heroPointsOf(fs, generatedAtMs);
  const win = heroWindow(fs, generatedAtMs);
  return {
    panels: HERO_PANELS.map((panel) => ({
      weight: panel.heightWeight,
      config: panelConfig(panel, { ...win, raw, visible: [], band: null, formatTick: heroTick }),
    })),
  };
}

// ---------- Hosting (bytes served per minute, stacked per site) ----------

export interface HostData {
  labels: string[];
  datasets: (number | null)[][];
}

// 30 per-minute labels ending at the minute of generatedAt, and each site's
// values aligned to the newest minute.
export function hostData(sites: readonly ServiceMetrics[], generatedAtMs: number): HostData {
  const start = Math.floor(generatedAtMs / MINUTE_MS) * MINUTE_MS - (HOST_SLOTS - 1) * MINUTE_MS;
  const labels = Array.from({ length: HOST_SLOTS }, (_, i) => istShortTime(start + i * MINUTE_MS));
  const datasets = sites.map((site) => {
    const values = recentSeries(site, "bytesServed") ?? [];
    const offset = values.length - HOST_SLOTS;
    return Array.from({ length: HOST_SLOTS }, (_, i) => {
      const v = values[offset + i];
      return typeof v === "number" ? v : null;
    });
  });
  return { labels, datasets };
}

// The y axis of the stacked hosting bars: round byte steps, at least 0..1 kB.
export function hostAxis(data: HostData): NiceAxis {
  let top = 0;
  for (let i = 0; i < HOST_SLOTS; i += 1) top = Math.max(top, data.datasets.reduce((a, d) => a + (d[i] ?? 0), 0));
  return niceAxis(top, "bytes");
}

export function hostConfig(sites: readonly ServiceMetrics[], generatedAtMs: number): ChartConfiguration<"bar", (number | null)[], string> {
  const data = hostData(sites, generatedAtMs);
  const axis = hostAxis(data);
  return {
    type: "bar",
    data: {
      labels: data.labels,
      datasets: sites.map((site, i) => ({
        label: site.name,
        data: data.datasets[i],
        backgroundColor: SITE_COLORS[i % SITE_COLORS.length],
        borderRadius: 2,
        stack: "s",
        tension: 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 6, autoSkip: true, maxRotation: 0 } },
        y: {
          stacked: true,
          beginAtZero: true,
          min: 0,
          max: axis.max,
          suggestedMax: BYTE_AXIS_MIN,
          grid: { color: RULE },
          border: { display: false },
          ticks: { callback: hostBytesTick, stepSize: axis.step, maxTicksLimit: 5, includeBounds: false },
        },
      },
      plugins: {
        // A legend only when there is more than one site.
        legend: {
          display: sites.length > 1,
          position: "bottom",
          labels: { usePointStyle: true, pointStyle: "rect", boxWidth: 22, color: INK_2 },
        },
        tooltip: { ...tooltipStyle(), callbacks: { label: hostLabel } },
      },
    },
  };
}
