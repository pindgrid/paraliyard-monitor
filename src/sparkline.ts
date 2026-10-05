import { NOT_AVAILABLE } from "./format";
import type { TrendPoint } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 120;
const HEIGHT = 24;
const PAD = 2;

// Inline SVG line for a trend, or the text "not available" when there is no data.
export function sparkline(points: readonly TrendPoint[], doc: Document = document): Node {
  const usable = points
    .map((p) => ({ t: Date.parse(p.t), v: p.v }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (usable.length === 0) return doc.createTextNode(NOT_AVAILABLE);

  const minT = usable[0].t;
  const spanT = usable[usable.length - 1].t - minT || 1;
  const maxV = Math.max(...usable.map((p) => p.v));
  const minV = Math.min(0, ...usable.map((p) => p.v));
  const spanV = maxV - minV || 1;

  const coords = usable.map((p) => {
    const x = usable.length === 1 ? WIDTH / 2 : PAD + ((p.t - minT) / spanT) * (WIDTH - 2 * PAD);
    const y = HEIGHT - PAD - ((p.v - minV) / spanV) * (HEIGHT - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (coords.length === 1) coords.push(coords[0]);

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("width", String(WIDTH));
  svg.setAttribute("height", String(HEIGHT));
  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `trend of ${usable.length} points`);
  const line = doc.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", coords.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  svg.appendChild(line);
  return svg;
}
