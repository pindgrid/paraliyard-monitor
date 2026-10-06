// SVG charts drawn with the theme's CSS variables, so switching between the
// white and dark themes repaints them with no redraw. Rules: one metric per
// panel, bars for counts, steps for levels, straight lines for percentages,
// no smoothing, round ticks.
import { DAY, HOUR, IST_OFF, MIN, esc, fDay, fTime, isNum } from "./format";

export type Unit = "count" | "bytes" | "pct";
export interface ChartBucket {
  start: number;
  end: number;
}
export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
  // Light bar behind each value bar, reaching the bucket's peak.
  peaks?: (number | null)[] | null;
  area?: boolean;
}
export interface ChartSpec {
  type: "bar" | "line" | "step";
  unit: Unit;
  height: number;
  from: number;
  to: number;
  buckets: ChartBucket[];
  series: ChartSeries[];
  stacked?: boolean;
  title?: string;
  xLabels?: boolean;
  band?: { to: number; label: string } | null;
  emptyText?: string;
  axisWidth?: number;
  tooltip?: (i: number) => string;
  // Hosts that highlight the same bucket on hover (stacked panels).
  sync?: HTMLElement[];
}
export interface Scale {
  max: number;
  step: number;
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

// A round y axis: steps of 1, 2, 2.5 or 5 × 10^n (in the display unit for
// bytes), whole numbers for small counts, 0-100 % for percentages.
export function scaleFor(max: number, unit: Unit): Scale {
  if (unit === "pct") return { max: 100, step: 25 };
  if (!(max > 0)) return unit === "bytes" ? { max: 1000, step: 250 } : { max: 4, step: 1 };
  let step: number;
  if (unit === "bytes") {
    const base = Math.pow(1000, Math.max(0, Math.floor(Math.log10(max) / 3)));
    step = niceStep(max / base / 4) * base;
  } else if (max >= 1 && max <= 5) step = 1;
  else step = niceStep(max / 4);
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

export function tickLabel(v: number, unit: Unit, sc: Scale): string {
  if (v === 0) return "0";
  if (unit === "pct") return `${v}%`;
  if (unit === "bytes") {
    const k = Math.max(0, Math.floor(Math.log10(sc.max) / 3));
    return `${Number((v / Math.pow(1000, k)).toFixed(2))} ${["B", "kB", "MB", "GB", "TB"][k]}`;
  }
  return v >= 1000 ? Math.round(v).toLocaleString("en-IN") : String(Number(v.toFixed(2)));
}

export function timeStepFor(span: number): number {
  if (span <= 35 * MIN) return 5 * MIN;
  if (span <= 70 * MIN) return 10 * MIN;
  if (span <= 6.5 * HOUR) return HOUR;
  if (span <= 25 * HOUR) return 4 * HOUR;
  if (span <= 8 * DAY) return DAY;
  if (span <= 31 * DAY) return 5 * DAY;
  return 7 * DAY;
}
// Round IST times (whole hours and days in IST) between from and to.
export function timeTicks(from: number, to: number): number[] {
  const step = timeStepFor(to - from);
  const out: number[] = [];
  for (let t = Math.ceil((from + IST_OFF) / step) * step - IST_OFF; t <= to; t += step) out.push(t);
  return out;
}
const xLabel = (t: number, span: number) => (span <= 25 * HOUR ? fTime(t) : fDay(t));

export interface ChartLayout {
  svg: string;
  left: number;
  pw: number;
  topPad: number;
  ph: number;
  hasData: boolean;
}

let uid = 0;

// The chart's SVG at width W (pure: no DOM).
export function chartSvg(spec: ChartSpec, W: number): ChartLayout {
  const H = spec.height;
  const n = spec.buckets.length;
  const id = `c${++uid}`;
  let top = 0;
  for (let i = 0; i < n; i += 1) {
    if (spec.type === "bar" && spec.stacked) top = Math.max(top, spec.series.reduce((s, se) => s + (se.values[i] ?? 0), 0));
    else for (const se of spec.series) top = Math.max(top, se.values[i] ?? 0, se.peaks?.[i] ?? 0);
  }
  const sc = scaleFor(top, spec.unit);
  const ticks: number[] = [];
  for (let v = 0; v <= sc.max + 1e-9; v += sc.step) ticks.push(Number(v.toFixed(6)));
  const labels = ticks.map((v) => tickLabel(v, spec.unit, sc));
  const left = spec.axisWidth ?? Math.max(30, Math.max(...labels.map((l) => l.length)) * 6.3 + 14);
  const right = 6;
  const topPad = spec.title ? 24 : 8;
  const bottom = spec.xLabels === false ? 4 : 22;
  const pw = Math.max(10, W - left - right);
  const ph = H - topPad - bottom;
  const span = spec.to - spec.from;
  const X = (t: number) => left + ((t - spec.from) / span) * pw;
  const Y = (v: number) => topPad + ph - (Math.min(v, sc.max) / sc.max) * ph;
  const f = (x: number) => x.toFixed(1);

  let s = `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  s += `<defs><pattern id="h${id}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="7" style="fill:var(--hatch)"/></pattern></defs>`;
  if (spec.title) s += `<text x="${left}" y="13" class="c-title">${esc(spec.title)}</text>`;
  ticks.forEach((v, k) => {
    const y = f(Y(v));
    s += `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" class="${v === 0 ? "c-base" : "c-grid"}"/>`;
    s += `<text x="${left - 8}" y="${f(Y(v) + 3.5)}" class="c-ytick" text-anchor="end">${esc(labels[k])}</text>`;
  });
  for (const t of timeTicks(spec.from, spec.to)) {
    const x = X(t);
    if (x < left + 2 || x > W - right - 2) continue;
    s += `<line x1="${f(x)}" x2="${f(x)}" y1="${topPad}" y2="${topPad + ph}" class="c-vgrid"/>`;
    if (spec.xLabels !== false) s += `<text x="${f(x)}" y="${H - 5}" class="c-xtick" text-anchor="middle">${esc(xLabel(t, span))}</text>`;
  }
  if (spec.band) {
    const x1 = X(spec.from);
    const x2 = Math.min(X(spec.band.to), W - right);
    if (x2 - x1 > 6) {
      s += `<rect x="${f(x1)}" y="${topPad}" width="${f(x2 - x1)}" height="${ph}" fill="url(#h${id})" opacity=".9"/>`;
      if (x2 - x1 > 90) s += `<text x="${f(x1 + 8)}" y="${topPad + 15}" class="c-band-label">${esc(spec.band.label)}</text>`;
    }
  }
  if (spec.type === "bar") {
    const base = new Array<number>(n).fill(0);
    for (const se of spec.series) {
      spec.buckets.forEach((b, i) => {
        const x0 = X(b.start);
        const w = Math.max(0.6, X(b.end) - x0);
        const gap = w > 5 ? Math.min(3, w * 0.22) : w * 0.12;
        const bx = x0 + gap / 2;
        const bw = Math.max(0.6, w - gap);
        const pk = se.peaks?.[i];
        const v = se.values[i];
        if (isNum(pk) && pk > (v ?? 0)) {
          const yp = Y(pk);
          s += `<rect x="${f(bx)}" y="${f(yp)}" width="${f(bw)}" height="${f(topPad + ph - yp)}" rx="1.5" style="fill:${se.color}" opacity=".26" class="c-peak"/>`;
        }
        if (isNum(v) && v > 0) {
          const y1 = Y(base[i]);
          const h = Math.max(1, y1 - Y(base[i] + v));
          s += `<rect x="${f(bx)}" y="${f(y1 - h)}" width="${f(bw)}" height="${f(h)}" rx="${bw > 4 ? 2 : 0.5}" style="fill:${se.color}" class="c-bar"/>`;
          if (spec.stacked) base[i] += v;
        }
      });
    }
  } else {
    for (const se of spec.series) {
      const segs: [number, number][][] = [];
      let cur: [number, number][] | null = null;
      spec.buckets.forEach((b, i) => {
        const v = se.values[i];
        if (!isNum(v)) {
          cur = null;
          return;
        }
        if (!cur) {
          cur = [];
          segs.push(cur);
        }
        if (spec.type === "step") cur.push([X(b.start), Y(v)], [X(b.end), Y(v)]);
        else cur.push([(X(b.start) + X(b.end)) / 2, Y(v)]);
      });
      for (const seg of segs) {
        const d = seg.map((p, k) => `${k ? "L" : "M"}${f(p[0])},${f(p[1])}`).join("");
        if (se.area && seg.length > 1) {
          s += `<path d="${d}L${f(seg[seg.length - 1][0])},${topPad + ph}L${f(seg[0][0])},${topPad + ph}Z" style="fill:${se.color}" opacity=".12" class="c-area"/>`;
        }
        if (seg.length === 1) s += `<circle cx="${f(seg[0][0])}" cy="${f(seg[0][1])}" r="2.5" style="fill:${se.color}"/>`;
        s += `<path d="${d}" class="c-line" style="stroke:${se.color}"/>`;
      }
    }
  }
  const hasData = spec.series.some((se) => se.values.some((v) => (spec.type === "bar" ? isNum(v) && v > 0 : isNum(v))));
  if (!hasData) s += `<text x="${f(left + pw / 2)}" y="${f(topPad + ph / 2 + 4)}" class="c-empty" text-anchor="middle">${esc(spec.emptyText ?? "No activity in this period")}</text>`;
  s += `<rect class="c-hl" x="0" y="${topPad}" width="0" height="${ph}"/>`;
  s += `<rect class="c-hit" x="${left}" y="${topPad}" width="${pw}" height="${ph}" fill="transparent"/>`;
  s += "</svg>";
  return { svg: s, left, pw, topPad, ph, hasData };
}

// ---------- tooltip ----------

export interface TipRow {
  color: string;
  label: string;
  value: string;
}
export const tipHtml = (title: string, rows: TipRow[]) =>
  `<div class="tt-title">${esc(title)}</div>` +
  rows.map((r) => `<div class="tt-row"><i style="background:${r.color}"></i><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join("");

function tipEl(doc: Document): HTMLElement | null {
  return doc.getElementById("tooltip");
}
export function showTip(doc: Document, x: number, y: number, html: string): void {
  const tip = tipEl(doc);
  if (!tip) return;
  tip.innerHTML = html;
  tip.hidden = false;
  const win = doc.defaultView;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (win && left + r.width > win.innerWidth - 8) left = x - r.width - 14;
  if (win && top + r.height > win.innerHeight - 8) top = y - r.height - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
export function hideTip(doc: Document): void {
  const tip = tipEl(doc);
  if (tip) tip.hidden = true;
}

// ---------- DOM ----------

interface ChartHost extends HTMLElement {
  _highlight?: (i: number | null) => void;
  _spec?: ChartSpec;
  _w?: number;
}
const observed = new WeakSet<HTMLElement>();
let resizer: ResizeObserver | null = null;
function observe(host: ChartHost): void {
  const win = host.ownerDocument.defaultView;
  if (!win || !("ResizeObserver" in win) || observed.has(host)) return;
  resizer ??= new win.ResizeObserver((entries) => {
    for (const e of entries) {
      const h = e.target as ChartHost;
      if (h._spec && Math.abs(e.contentRect.width - (h._w ?? 0)) > 1) draw(h, h._spec);
    }
  });
  resizer.observe(host);
  observed.add(host);
}

// Draws spec into host and redraws it when host changes width.
export function chart(host: HTMLElement, spec: ChartSpec): void {
  const h = host as ChartHost;
  h._spec = spec;
  observe(h);
  draw(h, spec);
}

function draw(host: ChartHost, spec: ChartSpec): void {
  const W = Math.max(160, Math.floor(host.clientWidth || host.getBoundingClientRect().width || 600));
  host._w = W;
  const layout = chartSvg(spec, W);
  host.innerHTML = layout.svg;
  const doc = host.ownerDocument;
  const svg = host.firstElementChild as SVGSVGElement | null;
  const hl = svg?.querySelector<SVGRectElement>(".c-hl");
  const hit = svg?.querySelector<SVGRectElement>(".c-hit");
  if (!svg || !hl || !hit) return;
  const span = spec.to - spec.from;
  const X = (t: number) => layout.left + ((t - spec.from) / span) * layout.pw;
  host._highlight = (i) => {
    const b = i === null ? undefined : spec.buckets[i];
    if (!b) {
      hl.setAttribute("width", "0");
      return;
    }
    hl.setAttribute("x", String(X(b.start)));
    hl.setAttribute("width", String(Math.max(1.5, X(b.end) - X(b.start))));
  };
  const peers = () => (spec.sync?.length ? spec.sync : [host]) as ChartHost[];
  const leave = () => {
    peers().forEach((p) => p._highlight?.(null));
    hideTip(doc);
  };
  const move = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const t = spec.from + ((ev.clientX - r.left - layout.left) / layout.pw) * span;
    const i = spec.buckets.findIndex((b) => t >= b.start && t < b.end);
    if (i < 0) {
      leave();
      return;
    }
    peers().forEach((p) => p._highlight?.(i));
    if (spec.tooltip) showTip(doc, ev.clientX, ev.clientY, spec.tooltip(i));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", leave);
}

// ---------- small charts ----------

// A 30-slot sparkline: bars (idle minutes as short grey ticks, error minutes
// red) or a line with a light area.
export function spark(values: readonly (number | null)[], color: string, opts: { type?: "bar" | "line"; errors?: readonly (number | null)[] | null; min?: number } = {}): string {
  const W = 200;
  const H = 38;
  const n = values.length;
  const nums = values.filter(isNum);
  const mx = Math.max(1e-9, ...nums);
  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  if (opts.type === "line") {
    const lo = opts.min ?? (nums.length ? Math.min(...nums) : 0);
    const rng = mx - lo || 1;
    const pts = values.flatMap((v, i) => (isNum(v) ? [[(i / Math.max(1, n - 1)) * W, H - 3 - ((v - lo) / rng) * (H - 8)]] : []));
    if (pts.length > 1) {
      const d = pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      s += `<path d="${d}L${W},${H}L${pts[0][0].toFixed(1)},${H}Z" style="fill:${color}" opacity=".12"/>`;
      s += `<path d="${d}" fill="none" style="stroke:${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    }
  } else {
    const bw = W / Math.max(1, n);
    values.forEach((v, i) => {
      const val = isNum(v) ? v : 0;
      const h = val > 0 ? Math.max(3, (val / mx) * (H - 2)) : 2;
      const c = (opts.errors?.[i] ?? 0) > 0 ? "var(--c-err)" : val > 0 ? color : "var(--c-idle)";
      s += `<rect x="${(i * bw + bw * 0.14).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw * 0.72).toFixed(2)}" height="${h.toFixed(2)}" rx="1" style="fill:${c}"/>`;
    });
  }
  return `${s}</svg>`;
}

export function donut(parts: { value: number; color: string }[], size: number): string {
  const stroke = 16;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + (p.value || 0), 0);
  const cx = size / 2;
  let s = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" style="stroke:var(--surface-3)" stroke-width="${stroke}"/>`;
  let off = 0;
  for (const p of parts) {
    const len = total ? ((p.value || 0) / total) * c : 0;
    if (len > 0) {
      s += `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" style="stroke:${p.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - 2.5).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cx})"/>`;
    }
    off += len;
  }
  return `${s}</svg>`;
}
