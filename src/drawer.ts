import { createDrawerChart, type DrawerChart, type DrawerChartFactory, type XYPoint } from "./drawer-chart";
import { COLORS, groupFor, liveValue, type DrawerGroup } from "./drawer-groups";
import { DASH, escapeHtml as esc, fmt, istDateTime } from "./fmt";
import type { HistorySource } from "./history-source";
import { rangeSeconds } from "./routes";
import { computeStats, csvText, runsCsvText, type RunRow } from "./stats";
import type { HistoryPoint, HistoryRange, MetricsResponse } from "./types";

// The right-hand history drawer: a modal dialog with a scrim, range buttons,
// one bundled Chart.js chart, an HTML legend that also drives the stats table,
// and a client-side CSV download. Each series is one HistorySource call.

export interface DrawerOptions {
  doc: Document;
  host: HTMLElement;
  source: HistorySource;
  createChart?: DrawerChartFactory;
  now?: () => number;
  // Close, Escape or a scrim click; the owner then calls close().
  onClose: () => void;
  // A range button was pressed (the drawer has already reloaded).
  onRange?: (range: HistoryRange) => void;
}

export interface OpenOptions {
  range?: HistoryRange | null;
  // Make this metric visible (older deep links name one metric).
  metric?: string | null;
}

export interface Drawer {
  open(opener: string, options?: OpenOptions): boolean;
  close(): void;
  isOpen(): boolean;
  current(): { group: DrawerGroup; range: HistoryRange } | null;
  appendLive(data: MetricsResponse): void;
  // Resolves when the latest load has finished (for tests and the app).
  settled(): Promise<void>;
  destroy(): void;
}

// Ranges at or under this many seconds get live points from each refresh.
const LIVE_APPEND_MAX_SECONDS = 6 * 3600;

const FOCUSABLE = 'button:not([disabled]), [href], select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function color(variable: string): string {
  return COLORS[variable] ?? COLORS["--straw"];
}

function toXY(points: readonly HistoryPoint[]): XYPoint[] {
  return points.map((p) => ({ x: Date.parse(p.t), y: p.v })).filter((p) => Number.isFinite(p.x));
}

// Opens the drawer for clicks and Enter / Space on any [data-open] element in root.
export function bindOpeners(root: HTMLElement, open: (opener: string, from: HTMLElement) => void): () => void {
  const openerOf = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.("[data-open]") as HTMLElement | null;
    return el && root.contains(el) ? el : null;
  };
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const el = openerOf(event.target);
    if (!el?.dataset.open) return;
    event.preventDefault();
    open(el.dataset.open, el);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const el = openerOf(event.target);
    // Only the opener itself, not a control inside it.
    if (!el?.dataset.open || el !== event.target) return;
    event.preventDefault();
    open(el.dataset.open, el);
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKey);
  };
}

export function createDrawer({ doc, host, source, createChart = createDrawerChart, now = Date.now, onClose, onRange }: DrawerOptions): Drawer {
  const scrim = doc.createElement("div");
  scrim.className = "scrim";
  const aside = doc.createElement("aside");
  aside.className = "drawer";
  aside.setAttribute("role", "dialog");
  aside.setAttribute("aria-modal", "true");
  aside.setAttribute("aria-labelledby", "dTitle");
  aside.setAttribute("aria-hidden", "true");
  aside.innerHTML = `
  <div class="dhead">
    <div><h2 id="dTitle"></h2><p data-d="sub"></p></div>
    <button class="btn" type="button" data-d="close">Close</button>
  </div>
  <div class="drow">
    <div class="seg" data-d="ranges" role="group" aria-label="Time range"></div>
    <button class="btn" type="button" data-d="csv">Download CSV</button>
  </div>
  <div class="dchart"><canvas data-d="canvas"></canvas><div class="dmsg" data-d="msg" hidden></div></div>
  <div class="dlegend" data-d="legend" role="group" aria-label="Series"></div>
  <div data-d="stats"></div>
  <p class="dfoot" data-d="foot"></p>`;
  host.append(scrim, aside);

  const part = <T extends HTMLElement>(name: string) => aside.querySelector<T>(`[data-d="${name}"]`)!;
  const title = aside.querySelector<HTMLElement>("#dTitle")!;

  let group: DrawerGroup | null = null;
  let range: HistoryRange | null = null;
  let visible: boolean[] = [];
  let data: XYPoint[][] = [];
  let runRows: RunRow[] = [];
  let chart: DrawerChart | null = null;
  let token = 0;
  let pending: Promise<void> = Promise.resolve();
  let lastFocus: HTMLElement | null = null;
  let lastOpener: string | null = null;
  let open = false;

  function message(text: string) {
    const msg = part("msg");
    msg.textContent = text;
    msg.hidden = text === "";
  }

  function destroyChart() {
    chart?.destroy();
    chart = null;
  }

  function renderRanges() {
    if (!group) return;
    part("ranges").innerHTML = group.ranges
      .map((r) => `<button type="button" data-range="${r}" aria-pressed="${r === range}">${r}</button>`)
      .join("");
  }

  function renderLegend() {
    if (!group || group.type === "runs") {
      part("legend").innerHTML = "";
      return;
    }
    part("legend").innerHTML = group.series
      .map(
        (s, i) =>
          `<button type="button" data-series="${i}" aria-pressed="${visible[i]}"><span class="sw" style="background:var(${s.color})"></span>${esc(s.label)}</button>`,
      )
      .join("");
  }

  function renderStats() {
    if (!group || group.type === "runs") return;
    const rows = group.series
      .map((s, i) => {
        const swatch = `<span class="sw" style="background:var(${s.color})"></span>`;
        const cls = visible[i] ? "" : ' class="muted" data-hidden="true"';
        const stats = computeStats((data[i] ?? []).map((p) => p.y));
        if (!stats) return `<tr${cls} data-row="${i}"><td>${swatch}${esc(s.label)}</td><td colspan="5" class="muted">No data</td></tr>`;
        return `<tr${cls} data-row="${i}"><td>${swatch}${esc(s.label)}</td><td>${s.format(stats.latest)}</td><td>${s.format(stats.min)}</td><td>${s.format(stats.avg)}</td><td>${s.format(stats.max)}</td><td>${s.format(stats.p99)}</td></tr>`;
      })
      .join("");
    part("stats").innerHTML = `<table class="dstats"><thead><tr><th>Series</th><th>Latest</th><th>Min</th><th>Average</th><th>Max</th><th>p99</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function buildLine(g: DrawerGroup, r: HistoryRange, results: (HistoryPoint[] | null)[]) {
    data = results.map((points) => (points ? toXY(points) : []));
    const to = now();
    const from = to - rangeSeconds(r) * 1000;
    const failed = results.every((p) => p === null);
    const empty = data.every((d) => d.length === 0);
    message(failed ? "Couldn't load history. Try again in a minute." : empty ? "No data for this range." : "");
    chart = createChart(part<HTMLCanvasElement>("canvas"), {
      kind: "line",
      from,
      to,
      formatX: istDateTime,
      axes: g.axes,
      formats: g.series.map((s) => s.format),
      datasets: g.series.map((s, i) => ({
        label: s.label,
        color: color(s.color),
        axis: s.axis,
        data: data[i],
        hidden: !visible[i],
        fill: s.fill,
        stepped: s.stepped,
      })),
    });
    renderStats();
    const count = data.reduce((a, d) => a + d.length, 0);
    part("foot").textContent =
      `${count.toLocaleString("en-IN")} points from ${istDateTime(from)} to ${istDateTime(to)}. Use the legend to hide or show a line.` +
      (rangeSeconds(r) <= LIVE_APPEND_MAX_SECONDS ? " New points are added live." : "");
  }

  function buildRuns(g: DrawerGroup, results: (HistoryPoint[] | null)[]) {
    const [runs, durations] = results;
    const durationAt = new Map((durations ?? []).map((p) => [p.t, p.v]));
    runRows = (runs ?? [])
      .filter((p) => p.v > 0)
      .map((p) => ({ t: Date.parse(p.t), failed: (p.failed ?? 0) > 0, durationSec: durationAt.get(p.t) ?? null }))
      .filter((r) => Number.isFinite(r.t))
      .sort((a, b) => a.t - b.t);
    data = [];
    message(runs === null ? "Couldn't load run history. Try again in a minute." : runRows.length ? "" : "No runs recorded in this range.");
    chart = createChart(part<HTMLCanvasElement>("canvas"), {
      kind: "bar",
      formatX: istDateTime,
      axes: g.axes,
      formats: [fmt.seconds],
      labels: runRows.map((r) => istDateTime(r.t)),
      datasets: [
        {
          label: "Run duration (s)",
          color: color("--paddy"),
          axis: "y",
          data: runRows.map((r) => ({ x: r.t, y: r.durationSec ?? 0 })),
          barColors: runRows.map((r) => color(r.failed ? "--ember" : "--paddy")),
        },
      ],
    });
    const ok = runRows.filter((r) => !r.failed).length;
    const durs = runRows.map((r) => r.durationSec).filter((d): d is number => d !== null);
    const lastFail = [...runRows].reverse().find((r) => r.failed);
    const latest = [...runRows].reverse().slice(0, 30);
    part("stats").innerHTML = `
<table class="dstats" data-table="summary"><thead><tr><th>Runs</th><th>Succeeded</th><th>Success rate</th><th>Avg duration</th><th>Last failure</th></tr></thead>
<tbody><tr><td>${runRows.length}</td><td>${ok}</td><td>${runRows.length ? `${Math.round((ok / runRows.length) * 100)}%` : DASH}</td>
<td>${durs.length ? fmt.seconds(durs.reduce((a, b) => a + b, 0) / durs.length) : DASH}</td><td>${lastFail ? `around ${esc(istDateTime(lastFail.t))}` : "None"}</td></tr></tbody></table>
<table class="dstats" data-table="runs" style="margin-top:14px"><thead><tr><th>Run time</th><th>Result</th><th>Duration</th></tr></thead><tbody>
${latest
  .map(
    (r) =>
      `<tr><td>around ${esc(istDateTime(r.t))}</td><td><span class="badge${r.failed ? " fail" : ""}" style="margin:0">${r.failed ? "failed" : "success"}</span></td><td>${fmt.seconds(r.durationSec)}</td></tr>`,
  )
  .join("")}
</tbody></table>`;
    part("foot").textContent =
      "Runs are read from the job function's requests in time buckets, so run times are approximate. Bar colour shows the result." +
      (runRows.length > 30 ? " The table lists the latest 30 runs; the CSV has all of them." : "");
  }

  function load(): Promise<void> {
    const g = group;
    const r = range;
    if (!g || !r) return Promise.resolve();
    const mine = (token += 1);
    destroyChart();
    message("Loading history…");
    part("stats").innerHTML = "";
    part("foot").textContent = "";
    pending = Promise.all(
      g.series.map((s) =>
        source.load(s.service, s.metric, r).then(
          (res) => res.points,
          () => null,
        ),
      ),
    ).then((results) => {
      if (mine !== token || !open) return;
      if (g.type === "runs") buildRuns(g, results);
      else buildLine(g, r, results);
    });
    return pending;
  }

  function downloadCsv() {
    if (!group) return;
    const text =
      group.type === "runs"
        ? runsCsvText(runRows)
        : csvText(group.series.map((s, i) => ({ label: s.label, points: (data[i] ?? []).map((p) => ({ t: p.x, v: p.y })) })));
    const blob = new Blob([text], { type: "text/csv" });
    const win = doc.defaultView;
    const urls = win?.URL ?? URL;
    if (typeof urls.createObjectURL !== "function") return;
    const href = urls.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = href;
    a.download = `${group.title.replace(/[^\w-]+/g, "_")}_${range ?? ""}.csv`;
    a.click();
    (win ?? globalThis).setTimeout(() => urls.revokeObjectURL(href), 2000);
  }

  function focusables(): HTMLElement[] {
    return [...aside.querySelectorAll<HTMLElement>(FOCUSABLE)];
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement as HTMLElement | null;
    if (!active || !aside.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Focus that leaves the open drawer comes back to it.
  function onFocusIn(event: FocusEvent) {
    if (open && event.target instanceof Node && !aside.contains(event.target)) part("close").focus();
  }

  function onAsideClick(event: MouseEvent) {
    const target = event.target as Element;
    if (target.closest('[data-d="close"]')) {
      onClose();
      return;
    }
    if (target.closest('[data-d="csv"]')) {
      downloadCsv();
      return;
    }
    const rangeButton = target.closest<HTMLElement>("[data-range]");
    if (rangeButton && group) {
      const next = rangeButton.dataset.range as HistoryRange;
      if (!group.ranges.includes(next)) return;
      range = next;
      renderRanges();
      void load();
      onRange?.(next);
      return;
    }
    const legendButton = target.closest<HTMLElement>("[data-series]");
    if (legendButton && group) {
      const i = Number(legendButton.dataset.series);
      visible[i] = !visible[i];
      chart?.setVisible(i, visible[i]);
      renderLegend();
      renderStats();
    }
  }

  const onScrimClick = () => {
    if (open) onClose();
  };

  aside.addEventListener("click", onAsideClick);
  scrim.addEventListener("click", onScrimClick);
  doc.addEventListener("keydown", onKeydown);
  doc.addEventListener("focusin", onFocusIn);

  return {
    open(opener, options = {}) {
      const next = groupFor(opener);
      if (!next) return false;
      if (!open) {
        const active = doc.activeElement as HTMLElement | null;
        lastFocus = active && active !== doc.body ? active : null;
        lastOpener = active?.getAttribute?.("data-open") ?? opener;
      }
      group = next;
      range = options.range && next.ranges.includes(options.range) ? options.range : next.defaultRange;
      visible = next.series.map((s) => !s.hidden || s.metric === options.metric);
      title.textContent = next.title;
      part("sub").textContent = next.sub;
      aside.dataset.opener = opener;
      renderRanges();
      renderLegend();
      open = true;
      aside.classList.add("open");
      aside.setAttribute("aria-hidden", "false");
      scrim.classList.add("show");
      part("close").focus();
      void load();
      return true;
    },
    close() {
      if (!open) return;
      open = false;
      token += 1;
      group = null;
      range = null;
      destroyChart();
      aside.classList.remove("open");
      aside.setAttribute("aria-hidden", "true");
      scrim.classList.remove("show");
      delete aside.dataset.opener;
      // The page may have been redrawn: fall back to the same opener.
      const target =
        lastFocus && lastFocus.isConnected
          ? lastFocus
          : lastOpener
            ? [...doc.querySelectorAll<HTMLElement>("[data-open]")].find((el) => el.dataset.open === lastOpener) ?? null
            : null;
      lastFocus = null;
      target?.focus();
    },
    isOpen: () => open,
    current: () => (open && group && range ? { group, range } : null),
    appendLive(metrics) {
      if (!open || !group || !range || group.type === "runs" || !chart) return;
      if (rangeSeconds(range) > LIVE_APPEND_MAX_SECONDS) return;
      const t = Date.parse(metrics.generatedAt);
      if (!Number.isFinite(t)) return;
      const from = t - rangeSeconds(range) * 1000;
      group.series.forEach((s, i) => {
        const v = liveValue(metrics, s.service, s.metric);
        const series = data[i] ?? (data[i] = []);
        const last = series[series.length - 1];
        if (v === null || (last && last.x >= t)) return;
        series.push({ x: t, y: v });
        while (series.length > 0 && series[0].x < from) series.shift();
        chart?.setData(i, series, from, t);
      });
      renderStats();
    },
    settled: () => pending,
    destroy() {
      aside.removeEventListener("click", onAsideClick);
      scrim.removeEventListener("click", onScrimClick);
      doc.removeEventListener("keydown", onKeydown);
      doc.removeEventListener("focusin", onFocusIn);
      destroyChart();
      open = false;
      token += 1;
      scrim.remove();
      aside.remove();
    },
  };
}
