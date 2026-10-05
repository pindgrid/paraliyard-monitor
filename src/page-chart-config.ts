// Chart.js configs for the page's hero and hosting charts, and the theme the
// drawer shares. Types only from chart.js, so this module is pure and tests
// call the builders and named callbacks directly. Values follow the design
// reference (themeDefaults, tooltipStyle, makeHero, makeHost, updateHost).
import type { ChartConfiguration, TooltipItem } from "chart.js";
import { fmt, istTick, istShortTime, istTime } from "./fmt";
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

// " paraliyard: 2.0 kB/min".
export function hostLabel(item: TooltipItem<"bar">): string {
  const y = item.parsed.y;
  return ` ${item.dataset.label ?? ""}: ${fmt.bytes(typeof y === "number" ? y : null)}/min`;
}

// ---------- Hero (Firestore, last 30 minutes) ----------

const HERO_SERIES = [
  { key: "readsPerMin", label: "Reads/min", color: STRAW, axis: "y", fill: true },
  { key: "writesPerMin", label: "Writes/min", color: PADDY, axis: "y1", fill: false },
  { key: "deletesPerMin", label: "Deletes/min", color: EMBER, axis: "y1", fill: false },
] as const;

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

// Reads, writes and deletes points, in dataset order.
export function heroData(fs: ServiceMetrics | undefined, generatedAtMs: number): HeroPoint[][] {
  return HERO_SERIES.map((s) => heroPoints(fs, s.key, generatedAtMs));
}

export function heroConfig(fs: ServiceMetrics | undefined, generatedAtMs: number): ChartConfiguration<"line", HeroPoint[]> {
  const data = heroData(fs, generatedAtMs);
  return {
    type: "line",
    data: {
      datasets: HERO_SERIES.map((s, i) => ({
        label: s.label,
        data: data[i],
        yAxisID: s.axis,
        fill: s.fill ? "origin" : false,
        borderWidth: i ? 1.4 : 2,
        pointRadius: 0,
        tension: 0.3,
        spanGaps: true,
        borderColor: s.color,
        backgroundColor: alpha(s.color, s.fill ? 0.14 : 0),
      })),
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: generatedAtMs - LIVE_WINDOW_MS,
          max: generatedAtMs,
          grid: { display: false },
          ticks: { stepSize: 5 * MINUTE_MS, maxRotation: 0, callback: heroTick },
        },
        y: { beginAtZero: true, grid: { color: RULE }, title: { display: true, text: "reads/min" } },
        y1: {
          beginAtZero: true,
          position: "right",
          grid: { display: false },
          suggestedMax: 4,
          title: { display: true, text: "writes, deletes" },
        },
      },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "line", boxWidth: 22, color: INK_2 } },
        tooltip: { ...tooltipStyle(), callbacks: { title: heroTooltipTitle, label: rateLabel } },
      },
    },
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

export function hostConfig(sites: readonly ServiceMetrics[], generatedAtMs: number): ChartConfiguration<"bar", (number | null)[], string> {
  const data = hostData(sites, generatedAtMs);
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
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 6, autoSkip: true, maxRotation: 0 } },
        y: { stacked: true, beginAtZero: true, grid: { color: RULE }, ticks: { callback: bytesTick, maxTicksLimit: 4 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), callbacks: { label: hostLabel } },
      },
    },
  };
}
