// Two small inline Chart.js plugins (no plugin dependency): a crosshair shared
// by a set of stacked panels with one HTML tooltip, and an overlay that draws
// the panel title, the "No data before" band and the "No activity" text.
// Draw-only and client-side. They read their options from
// options.plugins.yardCrosshair and options.plugins.yardOverlay (set by
// src/panel-config.ts).
import type { NoDataBand } from "./chart-shape";
import { FONT_FAMILY, INK_2, INK_3 } from "./page-chart-config";
import type { BucketTooltip } from "./panel-config";

export interface CrosshairOptions {
  start: number;
  bucketMs: number;
  count: number;
}

export interface OverlayOptions {
  title?: string;
  band?: NoDataBand | null;
  empty?: string | null;
}

// The parts of a Chart.js chart the plugins use (tests pass fakes).
export interface PluginChart {
  ctx: CanvasRenderingContext2D;
  chartArea: { left: number; right: number; top: number; bottom: number };
  scales: Record<string, { getPixelForValue(value: number): number; getValueForPixel(pixel: number): number | undefined } | undefined>;
  options: { plugins?: Record<string, unknown> };
  canvas?: HTMLCanvasElement;
  draw(): void;
}

export interface PluginEventArgs {
  event: { type: string; x: number | null; y: number | null };
  changed?: boolean;
}

export interface YardPlugin {
  id: string;
  afterInit?(chart: PluginChart): void;
  afterDestroy?(chart: PluginChart): void;
  afterEvent?(chart: PluginChart, args: PluginEventArgs): void;
  beforeDatasetsDraw?(chart: PluginChart, args: unknown, options?: OverlayOptions): void;
  afterDatasetsDraw?(chart: PluginChart, args?: unknown, options?: OverlayOptions): void;
}

export interface CrosshairSync {
  plugin: YardPlugin;
  index(): number | null;
  // Sets the hovered bucket on every chart of the group (null: none).
  setIndex(index: number | null, source?: PluginChart, x?: number): void;
  destroy(): void;
}

function crosshairOptions(chart: PluginChart): CrosshairOptions | null {
  const o = chart.options.plugins?.yardCrosshair as CrosshairOptions | undefined;
  return o && o.count > 0 && o.bucketMs > 0 ? o : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// One hovered bucket for a group of charts: a vertical line on each and one
// tooltip <div class="dtip"> in the container.
export function crosshairSync({ container, tooltipFor }: { container: HTMLElement | null; tooltipFor: (index: number) => BucketTooltip | null }): CrosshairSync {
  const charts: PluginChart[] = [];
  let current: number | null = null;
  let tip: HTMLElement | null = null;

  function renderTip(source?: PluginChart, x?: number) {
    if (!container) return;
    const content = current === null ? null : tooltipFor(current);
    if (!content) {
      if (tip) tip.hidden = true;
      return;
    }
    const doc = container.ownerDocument;
    if (!tip) {
      tip = doc.createElement("div");
      tip.className = "dtip";
      tip.setAttribute("role", "tooltip");
      container.append(tip);
    }
    const title = doc.createElement("div");
    title.className = "dtip-title";
    title.textContent = content.title;
    tip.replaceChildren(
      title,
      ...content.lines.map((text) => {
        const line = doc.createElement("div");
        line.textContent = text;
        return line;
      }),
    );
    tip.hidden = false;
    if (source?.canvas && x !== undefined) {
      const left = source.canvas.getBoundingClientRect().left - container.getBoundingClientRect().left + x;
      tip.style.left = `${Math.round(left)}px`;
      // Beside the line, on the side with more room.
      tip.style.transform = left > container.clientWidth / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)";
    }
  }

  function setIndex(next: number | null, source?: PluginChart, x?: number) {
    const changed = next !== current;
    current = next;
    if (changed) for (const c of charts) if (c !== source) c.draw();
    renderTip(source, x);
  }

  const plugin: YardPlugin = {
    id: "yardCrosshair",
    afterInit(chart) {
      if (!charts.includes(chart)) charts.push(chart);
    },
    afterDestroy(chart) {
      const i = charts.indexOf(chart);
      if (i >= 0) charts.splice(i, 1);
    },
    afterEvent(chart, args) {
      const { type, x, y } = args.event;
      const o = crosshairOptions(chart);
      const scale = chart.scales.x;
      const area = chart.chartArea;
      if (type === "mouseout" || !o || !scale || x === null || y === null || x < area.left || x > area.right || y < area.top || y > area.bottom) {
        if (current !== null) {
          setIndex(null, chart);
          args.changed = true;
        }
        return;
      }
      if (type !== "mousemove" && type !== "touchstart" && type !== "touchmove" && type !== "click") return;
      const value = scale.getValueForPixel(x);
      if (value === undefined) return;
      const index = clamp(Math.floor((value - o.start) / o.bucketMs), 0, o.count - 1);
      if (index !== current) args.changed = true;
      setIndex(index, chart, x);
    },
    afterDatasetsDraw(chart) {
      const o = crosshairOptions(chart);
      const scale = chart.scales.x;
      if (current === null || !o || !scale) return;
      const { left, right, top, bottom } = chart.chartArea;
      const px = clamp(scale.getPixelForValue(o.start + (current + 0.5) * o.bucketMs), left, right);
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = INK_3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  return {
    plugin,
    index: () => current,
    setIndex,
    destroy() {
      tip?.remove();
      tip = null;
      charts.length = 0;
      current = null;
    },
  };
}

const BAND_FILL = "rgba(132,141,121,0.12)";

// Diagonal hatching, or a flat tint where patterns are not available.
function hatch(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (typeof ctx.createPattern !== "function" || typeof document === "undefined") return BAND_FILL;
  const tile = document.createElement("canvas");
  tile.width = 8;
  tile.height = 8;
  const t = tile.getContext("2d");
  if (!t) return BAND_FILL;
  t.fillStyle = BAND_FILL;
  t.fillRect(0, 0, 8, 8);
  t.strokeStyle = "rgba(132,141,121,0.45)";
  t.lineWidth = 1;
  t.beginPath();
  t.moveTo(0, 8);
  t.lineTo(8, 0);
  t.stroke();
  return ctx.createPattern(tile, "repeat") ?? BAND_FILL;
}

function overlayOptions(chart: PluginChart, options?: OverlayOptions): OverlayOptions {
  return options ?? (chart.options.plugins?.yardOverlay as OverlayOptions | undefined) ?? {};
}

export const overlayPlugin: YardPlugin = {
  id: "yardOverlay",
  beforeDatasetsDraw(chart, _args, options) {
    const { band } = overlayOptions(chart, options);
    const scale = chart.scales.x;
    if (!band || !scale) return;
    const { left, right, top, bottom } = chart.chartArea;
    const x1 = clamp(scale.getPixelForValue(band.from), left, right);
    const x2 = clamp(scale.getPixelForValue(band.to), left, right);
    if (x2 <= x1) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = hatch(ctx);
    ctx.fillRect(x1, top, x2 - x1, bottom - top);
    if (x2 - x1 > 90) {
      ctx.fillStyle = INK_3;
      ctx.font = `11px ${FONT_FAMILY}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(band.label, x1 + 6, top + 6);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart, _args, options) {
    const { title, empty } = overlayOptions(chart, options);
    const { left, right, top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    if (title) {
      ctx.fillStyle = INK_2;
      ctx.font = `600 12px ${FONT_FAMILY}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(title, left, top - 4);
    }
    if (empty) {
      ctx.fillStyle = INK_3;
      ctx.font = `12px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(empty, (left + right) / 2, (top + bottom) / 2);
    }
    ctx.restore();
  },
};
