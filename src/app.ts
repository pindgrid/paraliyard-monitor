// The dashboard page: header, health banner, KPI cards, database, functions,
// storage, hosting, scheduled jobs and the history drawer. Data comes from
// /api/metrics and /api/history in live mode, from src/demo.ts in mock mode,
// and nothing is requested in off mode (the config.json kill switch).
import { chart, donut, hideTip, spark, tipHtml, type ChartSpec } from "./charts";
import { demoHistory, demoModel } from "./demo";
import { DASH, DAY, HOUR, MIN, bytes, esc, fDay, fDayTime, fFull, fTime, fTimeSec, isNum, last, num, pct, sum, until, type Series } from "./format";
import {
  BUCKET,
  BUCKET_COLORS,
  RANGES,
  RANGE_MS,
  RUN_RANGES,
  SITE_COLORS,
  SOURCE_STEP,
  SRC_WORD,
  STEP_WORD,
  bucketize,
  groupFor,
  isRange,
  type Bucket,
  type DrawerGroup,
  type PanelSpec,
  type Range,
} from "./history";
import {
  JOBS,
  PROJECT_ID,
  addSeries,
  daySquares,
  fnStatus,
  fromApi,
  health,
  seriesStats,
  shortBucket,
  storageGrowth,
  type ApiMetrics,
  type FnInfo,
  type FnStatus,
  type Gauge,
  type Health,
  type Model,
  type OtherCalls,
  type Point,
} from "./model";

export type Mode = "live" | "mock" | "off";
export interface Config {
  mode: Mode;
  refreshSeconds: number;
}
export const REFRESH_CHOICES = [30, 60, 300] as const;
export const CONFIG_RECHECK_MS = 10 * MIN;
export const STORAGE_RELOAD_MS = 15 * MIN;
export const RUNS_RELOAD_MS = 10 * MIN;
const API = "/api";
const FETCH_TIMEOUT_MS = 15000;

// Anything unexpected means mock: sample data, no requests.
export function parseConfig(raw: unknown): Config {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode: Mode = value.mode === "live" || value.mode === "off" ? value.mode : "mock";
  const wanted = typeof value.refreshSeconds === "number" ? value.refreshSeconds : 60;
  const refreshSeconds = REFRESH_CHOICES.reduce((best, c) => (Math.abs(c - wanted) < Math.abs(best - wanted) ? c : best), 60);
  return { mode, refreshSeconds };
}

async function getJSON(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { headers: { Accept: "application/json" }, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status === 429 ? "Busy, try again in a moment" : "Request failed"} (${r.status})`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadConfig(fetchFn: typeof fetch): Promise<Config> {
  try {
    return parseConfig(await getJSON(fetchFn, "/config.json"));
  } catch {
    return parseConfig(null);
  }
}

// ---------- markup ----------

const ICON = {
  logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="M12 13c-3 0-5-2-5-5 3 0 5 2 5 5z"/><path d="M12 13c3 0 5-2 5-5-3 0-5 2-5 5z"/><path d="M12 8c-2 0-3.5-1.6-3.5-4C10.5 4 12 5.6 12 8z"/><path d="M12 8c2 0 3.5-1.6 3.5-4C13.5 4 12 5.6 12 8z"/></svg>',
  moon: '<svg class="theme-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg class="theme-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  chevron: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  ok: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  bad: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  pause: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 7v10M15 7v10"/></svg>',
  okSmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  badSmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6M12 17v.5"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  db: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  bolt: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg>',
  globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  schedule: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};

const OPENER = 'role="button" tabindex="0"';
const head = (id: string, icon: string, title: string, desc: string, action = "") =>
  `<div class="card-head"><div><h2 id="${id}"><span class="h-icon" aria-hidden="true">${icon}</span>${title}</h2><p>${desc}</p></div>${action}</div>`;
const historyBtn = (open: string, label: string) => `<button class="chip-btn" type="button" data-open="${open}">${label} ${ICON.chevron}</button>`;

function shell(): string {
  const refresh = REFRESH_CHOICES.map((s) => `<button type="button" data-s="${s}">${s === 300 ? "5m" : `${s}s`}</button>`).join("");
  return `
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="#overview" aria-label="Paraliyard Monitor, top of page">
      <span class="logo" aria-hidden="true">${ICON.logo}</span>
      <span class="brand-text"><strong>Paraliyard Monitor</strong>
        <span class="brand-sub"><span class="gur" lang="pa">ਪਰਾਲੀ ਯਾਰਡ</span><span aria-hidden="true">·</span><span>${PROJECT_ID}</span></span></span>
    </a>
    <nav class="nav" aria-label="Sections">
      ${["overview", "database", "functions", "storage", "hosting", "jobs"].map((id) => `<a href="#${id}" data-nav="${id}">${id === "overview" ? "Overview" : id[0].toUpperCase() + id.slice(1)}</a>`).join("")}
    </nav>
    <div class="actions">
      <span class="pill ok" data-status ${OPENER} hidden></span>
      <span class="live" data-live><i></i><span data-live-text>Live</span></span>
      <span class="updated" data-updated>${DASH}</span>
      <div class="seg" data-refresh-seg role="group" aria-label="Refresh every">${refresh}</div>
      <button class="icon-btn" type="button" data-theme-btn aria-label="Switch theme" title="Switch between white and dark">${ICON.moon}${ICON.sun}</button>
    </div>
  </div>
</header>
<main class="main">
  <p class="note" data-note hidden></p>
  <section class="banner" id="overview" aria-live="polite">
    <div class="banner-main">
      <div class="status-icon" data-banner-icon aria-hidden="true"></div>
      <div><h1 data-banner-title>Loading…</h1><p class="banner-sub" data-banner-sub></p><ul class="reasons" data-banner-reasons hidden></ul></div>
    </div>
    <div class="facts" data-facts></div>
  </section>
  <div class="sections" data-sections>
    <section class="kpis" data-kpis aria-label="Key numbers"></section>
    <section class="card" id="database" aria-labelledby="dbTitle">
      ${head("dbTitle", ICON.db, "Database activity", "Firestore database “yard” · per minute, last 30 minutes, updating live", historyBtn("fs", "Full history"))}
      <div class="db-grid">
        <div class="chart-stack">
          <div class="chart" data-chart="reads" data-open="fs" ${OPENER} aria-label="Reads per minute. Open full history"></div>
          <div class="chart" data-chart="writes" data-open="fs" ${OPENER} aria-label="Writes and deletes per minute. Open full history"></div>
          <div class="legend"><span><i class="sw" style="background:var(--c-reads)"></i>Reads</span><span><i class="sw" style="background:var(--c-writes)"></i>Writes</span><span><i class="sw" style="background:var(--c-deletes)"></i>Deletes</span></div>
        </div>
        <div class="stats-panel">
          <div class="big"><b data-reads-now>${DASH}</b><span>reads / min now</span></div>
          <table class="mini" aria-label="Database summary, last 30 minutes">
            <thead><tr><th>Last 30 min</th><th>Now</th><th>Avg</th><th>Peak</th><th>Total</th></tr></thead>
            <tbody data-db-stats></tbody>
          </table>
        </div>
      </div>
    </section>
    <section class="card" id="functions" aria-labelledby="fnTitle">
      ${head("fnTitle", ICON.bolt, "Cloud Functions", "CPU and RAM are p99 · activity shows requests per minute over 30 minutes, red marks a minute with errors")}
      <div class="toolbar">
        <div class="filters" data-fn-filters role="group" aria-label="Filter functions"></div>
        <label class="search">${ICON.search}<input data-fn-search type="search" placeholder="Search functions" autocomplete="off" aria-label="Search functions"></label>
      </div>
      <div class="tablewrap">
        <table class="fn" aria-label="Cloud Functions">
          <colgroup><col style="width:23%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:9%"><col style="width:10%"><col style="width:10%"><col style="width:13%"></colgroup>
          <thead><tr data-fn-head></tr></thead>
          <tbody data-fn-body></tbody>
          <tfoot data-fn-foot></tfoot>
        </table>
      </div>
    </section>
    <div class="two">
      <section class="card" id="storage" aria-labelledby="stTitle">
        ${head("stTitle", ICON.layers, "Cloud Storage", "Space used per bucket, and the total over 30 days", historyBtn("sum:storage", "History"))}
        <div class="storage-top"><div class="donut" data-donut></div><div class="rows" data-bucket-rows></div></div>
        <div class="push">
          <p class="sub-title">Storage used, last 30 days <span data-growth></span></p>
          <div class="chart" data-chart="storage" data-open="sum:storage" ${OPENER} aria-label="Storage used over 30 days. Open history"></div>
        </div>
      </section>
      <section class="card" id="hosting" aria-labelledby="hoTitle">
        ${head("hoTitle", ICON.globe, "Firebase Hosting", "Data served per minute, last 30 minutes", historyBtn("sum:hosting", "History"))}
        <div class="chart" data-chart="hosting" data-open="sum:hosting" ${OPENER} aria-label="Data served per minute. Open history"></div>
        <div class="rows push" data-site-rows></div>
      </section>
    </div>
    <section class="card" id="jobs" aria-labelledby="jobTitle">
      ${head("jobTitle", ICON.schedule, "Scheduled jobs", "Each square is one day: green, the scheduled run succeeded · red, it failed or was missed · dashed, nothing scheduled")}
      <div class="jobs" data-job-list></div>
    </section>
  </div>
  <footer class="footer"><span data-foot></span><span>Times in IST · Click any chart, card or row for its full history</span></footer>
</main>
<div class="scrim" data-scrim></div>
<aside class="drawer" data-drawer role="dialog" aria-modal="true" aria-labelledby="dTitle" aria-hidden="true">
  <div class="d-head">
    <div><h2 id="dTitle" data-d-title></h2><p data-d-sub></p></div>
    <button class="icon-btn" type="button" data-d-close aria-label="Close">${ICON.close}</button>
  </div>
  <div class="d-body">
    <div class="d-row">
      <div class="seg" data-d-range role="group" aria-label="Time range"></div>
      <button class="chip-btn" type="button" data-d-csv>${ICON.download}Download CSV</button>
    </div>
    <div data-d-stats></div>
    <div class="chart-stack" data-d-charts></div>
    <div data-d-table></div>
    <p class="d-foot" data-d-foot></p>
  </div>
</aside>
<div class="tooltip" id="tooltip" role="tooltip" hidden></div>`;
}

// ---------- app ----------

type Store = Pick<Storage, "getItem" | "setItem">;
export interface AppOptions {
  root: HTMLElement;
  fetchFn?: typeof fetch;
  doc?: Document;
  config?: Config;
  // Where the theme and refresh choices are kept (default: localStorage, if reachable).
  storage?: Store | null;
}
export interface AppHandle {
  stop(): void;
}

interface DrawerState {
  open: string;
  range: Range;
  g: DrawerGroup;
  token: number;
  lastFocus: Element | null;
  series?: { pi: number; si: number }[];
  results?: Point[][];
  runs?: Point[];
  other?: OtherCalls | null;
}

const FN_COLS: { key: string | null; label: string; r?: boolean }[] = [
  { key: "name", label: "Function" },
  { key: "status", label: "Status" },
  { key: "cpu", label: "CPU p99" },
  { key: "ram", label: "RAM p99" },
  { key: "req", label: "Req / min", r: true },
  { key: "err", label: "Errors 30m", r: true },
  { key: "inst", label: "Instances", r: true },
  { key: null, label: "Activity, 30 min" },
];
const STATUS_ORDER: Record<FnStatus, number> = { error: 0, active: 1, idle: 2 };
const STATUS_LABEL: Record<FnStatus, string> = { active: "Active", idle: "Idle", error: "Error" };

function sortValue(f: FnInfo, key: string): number | string {
  if (key === "name") return f.name.toLowerCase();
  if (key === "status") return STATUS_ORDER[fnStatus(f)];
  if (key === "cpu") return isNum(f.cpu) ? f.cpu : -1;
  if (key === "ram") return isNum(f.ram) ? f.ram : -1;
  if (key === "req") return last(f.req) ?? 0;
  if (key === "err") return sum(f.err);
  if (key === "inst") return f.instances ?? -1;
  return 0;
}
function meterCell(v: Gauge, color: string): string {
  if (v === "na") return '<span class="muted" title="Not reported for 1st gen functions">n/a</span>';
  if (!isNum(v)) return '<div class="meter"><span class="bar"></span><span class="val muted">idle</span></div>';
  return `<div class="meter"><span class="bar"><b style="width:${Math.min(100, Math.max(2, v))}%;background:${color}"></b></span><span class="val">${pct(v)}</span></div>`;
}
const fmtUnit = (unit: PanelSpec["unit"], v: number | null) => (unit === "bytes" ? bytes(v) : unit === "pct" ? pct(v) : num(v));
const minuteBuckets = (minutes: number[]) => minutes.map((t) => ({ start: t, end: t + MIN }));

export async function startApp({ root, fetchFn = fetch, doc = document, config, storage }: AppOptions): Promise<AppHandle> {
  const win = doc.defaultView ?? window;
  let store: Store | null = null;
  if (storage !== undefined) store = storage;
  else {
    try {
      store = win.localStorage;
    } catch {
      store = null;
    }
  }
  const read = (k: string) => {
    try {
      return store?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const write = (k: string, v: string) => {
    try {
      store?.setItem(k, v);
    } catch {
      /* private mode */
    }
  };

  const cfg = config ?? (await loadConfig(fetchFn));
  root.innerHTML = shell();
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const saved = Number(read("pm-refresh"));
  const state = {
    mode: cfg.mode,
    model: null as Model | null,
    online: true,
    err: "",
    refresh: (REFRESH_CHOICES as readonly number[]).includes(saved) ? saved : cfg.refreshSeconds,
    timer: null as ReturnType<typeof setTimeout> | null,
    configTimer: null as ReturnType<typeof setInterval> | null,
    storage: undefined as Point[] | null | undefined,
    storageAt: 0,
    runs: {} as Record<string, Point[]>,
    other: {} as Record<string, OtherCalls | null>,
    runsAt: 0,
    fnFilter: "all" as "all" | FnStatus,
    fnQuery: "",
    fnSort: { key: "status", dir: 1 },
    drawer: null as DrawerState | null,
    stopped: false,
  };

  async function loadModel(): Promise<Model> {
    return state.mode === "live" ? fromApi((await getJSON(fetchFn, `${API}/metrics`)) as ApiMetrics) : demoModel(Date.now());
  }
  async function loadHistory(id: string, metric: string, range: Range): Promise<{ points: Point[]; otherCalls?: OtherCalls | null }> {
    if (state.mode !== "live") return demoHistory(id, metric, range, Date.now());
    const d = (await getJSON(fetchFn, `${API}/history?service=${encodeURIComponent(id)}&metric=${encodeURIComponent(metric)}&range=${range}`)) as {
      points?: (Omit<Point, "t"> & { t: string })[];
      otherCalls?: OtherCalls;
    };
    return {
      points: (d.points ?? []).map((p) => ({ ...p, t: Date.parse(p.t) })).filter((p) => isNum(p.t)),
      otherCalls: d.otherCalls ?? null,
    };
  }

  // ---------- header, banner, KPIs ----------

  function renderHeader(m: Model | null, h: Health | null) {
    const live = $("[data-live]");
    const off = state.mode === "off";
    live.className = `live${off ? " paused" : !state.online ? " down" : ""}`;
    $("[data-live-text]").textContent = off ? "Paused" : !state.online ? "Offline" : state.mode === "live" ? "Live" : "Live demo";
    const updated = $("[data-updated]");
    updated.textContent = m ? fTimeSec(m.generatedAt) : DASH;
    updated.title = m ? `Last updated ${fFull(m.generatedAt)}` : "";
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-refresh-seg] button")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.s) === state.refresh));
      b.disabled = off;
    }
    const pill = $("[data-status]");
    if (m && h) {
      pill.hidden = false;
      pill.className = `pill ${h.ok ? "ok" : "bad"}`;
      pill.innerHTML = h.ok ? `${ICON.okSmall}All healthy` : `${ICON.badSmall}${h.reasons.length} issue${h.reasons.length > 1 ? "s" : ""}`;
      pill.dataset.open = h.ok ? "sum:functions" : h.reasons[0].open;
      pill.setAttribute("aria-label", h.ok ? "All healthy. Open details" : `${h.reasons.map((r) => r.text).join(", ")}. Open details`);
    } else {
      pill.hidden = true;
      delete pill.dataset.open;
    }
    const note = $("[data-note]");
    note.className = "note";
    if (off) {
      note.hidden = false;
      note.textContent = "Live monitoring is paused: the kill switch in config.json is set to off, so nothing is requested.";
    } else if (!state.online) {
      note.hidden = false;
      note.className = "note err";
      note.textContent = `Can't reach the metrics service (${state.err}). Retrying in ${state.refresh} seconds.`;
    } else if (state.mode === "mock") {
      note.hidden = false;
      note.innerHTML = '<b>Demo data.</b>&nbsp;Sample numbers shaped like the yard; set mode to "live" in config.json to see real numbers.';
    } else if (m?.stale) {
      note.hidden = false;
      note.textContent = "Showing the last good data: the latest refresh on the server failed.";
    } else note.hidden = true;
    $("[data-foot]").textContent = `Data from Google Cloud Monitoring (read-only) · Project ${PROJECT_ID} · Refreshes every ${state.refresh} s`;
  }

  function renderBanner(m: Model, h: Health) {
    $("#overview").className = `banner${h.ok ? "" : " bad"}`;
    $("[data-banner-icon]").innerHTML = h.ok ? ICON.ok : ICON.bad;
    $("[data-banner-title]").textContent = h.ok ? "All systems healthy" : "Needs attention";
    const count = m.functions.length + 1 + m.buckets.length + m.sites.length + m.jobs.length;
    $("[data-banner-sub]").textContent = `${count} services monitored across Cloud Functions, Firestore, Cloud Storage, Hosting and Scheduler.`;
    const ul = $("[data-banner-reasons]");
    ul.hidden = h.ok;
    ul.innerHTML = h.reasons.map((r) => `<li><button type="button" data-open="${esc(r.open)}">${esc(r.text)}</button></li>`).join("");
    const nightly = m.jobs.find((j) => j.id === "scheduler:pyNightlyExport");
    const next = m.jobs.filter((j) => j.nextRun !== null).sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))[0];
    const facts: [string, string][] = [
      ["Errors, 30 min", h.errs ? `${h.errs} error${h.errs > 1 ? "s" : ""}` : "None"],
      ["Last nightly export", nightly?.lastRunAt ? `${nightly.lastResult === "success" ? "✓ " : ""}${fDayTime(nightly.lastRunAt)}` : DASH],
      ["Next job", next?.nextRun ? `in ${until(next.nextRun - Date.now())}` : DASH],
    ];
    $("[data-facts]").innerHTML = facts.map((f) => `<div class="fact"><span>${esc(f[0])}</span><b>${esc(f[1])}</b></div>`).join("");
  }

  function renderKpis(m: Model) {
    const req = addSeries(m.functions.map((f) => f.req)) ?? [];
    const err = addSeries(m.functions.map((f) => f.err)) ?? [];
    const active = m.functions.filter((f) => fnStatus(f) !== "idle").length;
    const errs = Math.round(sum(err));
    const reads = m.firestore.reads ?? [];
    const stored = m.buckets.reduce((s, b) => s + (b.bytes ?? 0), 0);
    const served = addSeries(m.sites.map((s) => s.served)) ?? [];
    const next = m.jobs.filter((j) => j.nextRun !== null).sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))[0];
    const growth = storageGrowth(state.storage);
    const conf = next ? JOBS[next.id] : undefined;
    const nextPct = next?.nextRun && conf ? Math.max(0, Math.min(100, 100 - ((next.nextRun - Date.now()) / conf.every) * 100)) : 0;
    const peakReads = Math.max(0, ...reads.filter(isNum));
    const cards: { open: string; color: string; label: string; value: string; unit: string; sub: string; alert?: boolean; spark?: string; progress?: number }[] = [
      { open: "sum:functions", color: "var(--c-req)", label: "Function requests", value: num(last(req)), unit: "/ min", sub: `${active} of ${m.functions.length} functions active`, spark: spark(req, "var(--c-req)", { errors: err }) },
      { open: "sum:functions", color: "var(--c-err)", label: "Errors, 30 min", value: num(errs), unit: "", sub: errs ? "Click to see when" : "No errors", alert: errs > 0, spark: spark(err, "var(--c-err)") },
      { open: "fs", color: "var(--c-reads)", label: "Database reads", value: num(last(reads)), unit: "/ min", sub: `Peak ${num(peakReads)} in 30 min`, spark: spark(reads, "var(--c-reads)") },
      {
        open: "sum:storage",
        color: "var(--c-storage)",
        label: "Storage used",
        value: bytes(stored),
        unit: "",
        sub: growth !== null ? `${growth >= 0 ? "+" : "−"}${bytes(Math.abs(growth))} / day over 7 days` : `${m.buckets.length} buckets`,
        spark: state.storage?.length ? spark(state.storage.map((p) => p.v), "var(--c-storage)", { type: "line" }) : spark(new Array<number>(30).fill(0), "var(--c-storage)"),
      },
      { open: "sum:hosting", color: "var(--c-site-2)", label: "Hosting served, 30 min", value: bytes(sum(served)), unit: "", sub: `${m.sites.length} sites · ${bytes(last(served) ?? 0)} / min now`, spark: spark(served, "var(--c-site-2)") },
      { open: next ? `job:${next.id}` : "sum:functions", color: "var(--c-writes)", label: "Next scheduled job", value: next?.nextRun ? `in ${until(next.nextRun - Date.now())}` : DASH, unit: "", sub: next?.nextRun ? `${next.name} · ${fTime(next.nextRun)}` : "No schedule", progress: nextPct },
    ];
    $("[data-kpis]").innerHTML = cards
      .map(
        (c) =>
          `<div class="kpi${c.alert ? " alert" : ""}" data-open="${esc(c.open)}" ${OPENER} aria-label="${esc(`${c.label}: ${c.value} ${c.unit}`.trim())}">` +
          `<div class="kpi-label"><i style="background:${c.color}"></i>${esc(c.label)}</div>` +
          `<div class="kpi-value num">${esc(c.value)}${c.unit ? `<small>${esc(c.unit)}</small>` : ""}</div>` +
          `<div class="kpi-sub">${esc(c.sub)}</div>` +
          (c.progress !== undefined
            ? `<div class="progress" title="Time until the next run"><b style="width:${c.progress.toFixed(1)}%"></b></div><div class="kpi-foot"><span>Last run</span><span>Next run</span></div>`
            : `<div class="kpi-spark">${c.spark ?? ""}</div>`) +
          "</div>",
      )
      .join("");
  }

  // ---------- sections ----------

  function renderDatabase(m: Model) {
    const fs = m.firestore;
    const bk = minuteBuckets(m.minutes);
    const from = m.minutes[0];
    const to = m.minutes[29] + MIN;
    const tt = (i: number) =>
      tipHtml(`${fTime(m.minutes[i])} – ${fTime(m.minutes[i] + MIN)}`, [
        { color: "var(--c-reads)", label: "Reads", value: `${num(fs.reads?.[i])} / min` },
        { color: "var(--c-writes)", label: "Writes", value: `${num(fs.writes?.[i])} / min` },
        { color: "var(--c-deletes)", label: "Deletes", value: `${num(fs.deletes?.[i])} / min` },
      ]);
    const a = $('[data-chart="reads"]');
    const b = $('[data-chart="writes"]');
    const sync = [a, b];
    chart(a, { type: "bar", unit: "count", height: 220, from, to, buckets: bk, title: "Reads per minute", xLabels: false, axisWidth: 46, series: [{ label: "Reads", color: "var(--c-reads)", values: fs.reads ?? [] }], tooltip: tt, sync });
    chart(b, {
      type: "bar",
      unit: "count",
      height: 140,
      from,
      to,
      buckets: bk,
      stacked: true,
      title: "Writes and deletes per minute",
      axisWidth: 46,
      series: [
        { label: "Writes", color: "var(--c-writes)", values: fs.writes ?? [] },
        { label: "Deletes", color: "var(--c-deletes)", values: fs.deletes ?? [] },
      ],
      tooltip: tt,
      sync,
    });
    const r = seriesStats(fs.reads);
    $("[data-reads-now]").textContent = num(r.now);
    const row = (c: string, l: string, st: ReturnType<typeof seriesStats>) =>
      `<tr><td><i class="sw" style="background:${c}"></i>${l}</td><td>${num(st.now)}</td><td>${num(st.avg)}</td><td>${num(st.peak)}</td><td>${num(st.total)}</td></tr>`;
    $("[data-db-stats]").innerHTML = row("var(--c-reads)", "Reads", r) + row("var(--c-writes)", "Writes", seriesStats(fs.writes)) + row("var(--c-deletes)", "Deletes", seriesStats(fs.deletes));
  }

  function renderFunctions(m: Model) {
    const counts: Record<"all" | FnStatus, number> = { all: m.functions.length, active: 0, idle: 0, error: 0 };
    for (const f of m.functions) counts[fnStatus(f)] += 1;
    const filters: ["all" | FnStatus, string][] = [
      ["all", "All"],
      ["active", "Active"],
      ["idle", "Idle"],
      ["error", "Errors"],
    ];
    $("[data-fn-filters]").innerHTML = filters.map((f) => `<button type="button" data-filter="${f[0]}" aria-pressed="${state.fnFilter === f[0]}">${f[1]} <b>${counts[f[0]]}</b></button>`).join("");
    $("[data-fn-head]").innerHTML = FN_COLS.map((c) => {
      const sorted = c.key !== null && state.fnSort.key === c.key;
      const ind = sorted && state.fnSort.dir < 0 ? "▼" : "▲";
      return `<th${c.r ? ' class="r"' : ""}${sorted ? ` aria-sort="${state.fnSort.dir > 0 ? "ascending" : "descending"}"` : ""}>${
        c.key ? `<button type="button" data-sort="${c.key}">${c.label} <span class="sort-ind">${ind}</span></button>` : c.label
      }</th>`;
    }).join("");
    const q = state.fnQuery.trim().toLowerCase();
    const list = m.functions.filter((f) => (state.fnFilter === "all" || fnStatus(f) === state.fnFilter) && (!q || f.name.toLowerCase().includes(q)));
    const { key, dir } = state.fnSort;
    list.sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      return (va < vb ? -1 : va > vb ? 1 : a.name.localeCompare(b.name)) * dir;
    });
    $("[data-fn-body]").innerHTML = list.length
      ? list
          .map((f) => {
            const st = fnStatus(f);
            const errs = Math.round(sum(f.err));
            return (
              `<tr data-open="fn:${esc(f.id)}" data-fn="${esc(f.id)}" ${OPENER} aria-label="Open history for ${esc(f.name)}">` +
              `<td><div class="fname"><span>${esc(f.name)}</span><em class="gen">${f.gen === 1 ? "1st gen" : "2nd gen"}</em></div></td>` +
              `<td><span class="status ${st}">${STATUS_LABEL[st]}</span></td>` +
              `<td>${meterCell(f.cpu, "var(--c-cpu)")}</td><td>${meterCell(f.ram, "var(--c-ram)")}</td>` +
              `<td class="r num">${num(last(f.req))}</td>` +
              `<td class="r num"${errs ? ' style="color:var(--bad);font-weight:600"' : ""}>${f.err ? num(errs) : '<span class="muted">n/a</span>'}</td>` +
              `<td class="r num">${f.instances === null ? '<span class="muted">n/a</span>' : num(f.instances)}</td>` +
              `<td class="act">${spark(f.req ?? [], "var(--c-req)", { errors: f.err ?? [] })}</td></tr>`
            );
          })
          .join("")
      : '<tr class="empty-row"><td colspan="8">No functions match this filter.</td></tr>';
    const req = addSeries(m.functions.map((f) => f.req)) ?? [];
    const err = addSeries(m.functions.map((f) => f.err)) ?? [];
    const inst = m.functions.reduce((s, f) => s + (f.instances ?? 0), 0);
    $("[data-fn-foot]").innerHTML =
      `<tr data-open="sum:functions" ${OPENER} aria-label="Open history for all functions"><td><div class="fname">All functions</div></td><td></td><td></td><td></td>` +
      `<td class="r num">${num(last(req))}</td><td class="r num">${num(Math.round(sum(err)))}</td><td class="r num">${num(inst)}</td><td class="act">${spark(req, "var(--c-req)", { errors: err })}</td></tr>`;
  }

  function renderStorage(m: Model) {
    const total = m.buckets.reduce((s, b) => s + (b.bytes ?? 0), 0);
    $("[data-donut]").innerHTML =
      donut(m.buckets.map((b, i) => ({ value: b.bytes ?? 0, color: BUCKET_COLORS[i % BUCKET_COLORS.length] })), 148) +
      `<div class="donut-center"><div><b>${bytes(total)}</b><span>total</span></div></div>`;
    $("[data-bucket-rows]").innerHTML = m.buckets
      .map((b, i) => {
        const share = total ? ((b.bytes ?? 0) / total) * 100 : 0;
        const color = BUCKET_COLORS[i % BUCKET_COLORS.length];
        return (
          `<div class="row" data-open="st:${esc(b.id)}" ${OPENER} aria-label="Open history for bucket ${esc(b.name)}">` +
          `<i class="sw" style="background:${color}"></i><span class="name">${esc(shortBucket(b.name))}</span><span class="value">${bytes(b.bytes)}</span>` +
          `<span class="detail"><span>${share.toFixed(0)}% of total</span><span>${num(last(b.req) ?? 0)} requests / min</span></span>` +
          `<span class="sharebar"><b style="width:${share.toFixed(1)}%;background:${color}"></b></span></div>`
        );
      })
      .join("");
    const growth = storageGrowth(state.storage);
    $("[data-growth]").textContent = growth !== null ? `${growth >= 0 ? "+" : "−"}${bytes(Math.abs(growth))} / day` : "";
    const host = $('[data-chart="storage"]');
    if (!state.storage) {
      host.innerHTML = `<div class="d-msg">${state.storage === null ? "Storage history not available" : "Loading storage history…"}</div>`;
      return;
    }
    const now = Date.now();
    const from = now - 30 * DAY;
    const step = 6 * HOUR;
    const bk: { start: number; end: number }[] = [];
    for (let t = Math.floor(from / step) * step; t < now; t += step) bk.push({ start: t, end: t + step });
    const pts = state.storage;
    let k = 0;
    let carry: number | null = null;
    const vals = bk.map((b) => {
      while (k < pts.length && pts[k].t < b.end) {
        carry = pts[k].v;
        k += 1;
      }
      return carry;
    });
    const first = pts.length ? pts[0].t : null;
    chart(host, {
      type: "step",
      unit: "bytes",
      height: 168,
      from,
      to: now,
      buckets: bk,
      axisWidth: 58,
      series: [{ label: "Total", color: "var(--c-storage)", values: vals, area: true }],
      band: first !== null && first - from > step ? { to: first, label: `No data before ${fDay(first)}` } : null,
      emptyText: "No storage data yet",
      tooltip: (i) => tipHtml(`${fDayTime(bk[i].start)} – ${fTime(bk[i].end)}`, [{ color: "var(--c-storage)", label: "Total stored", value: bytes(vals[i]) }]),
    });
  }

  function renderHosting(m: Model) {
    const bk = minuteBuckets(m.minutes);
    chart($('[data-chart="hosting"]'), {
      type: "bar",
      unit: "bytes",
      height: 190,
      from: m.minutes[0],
      to: m.minutes[29] + MIN,
      buckets: bk,
      stacked: true,
      axisWidth: 58,
      series: m.sites.map((s, i) => ({ label: s.name, color: SITE_COLORS[i % SITE_COLORS.length], values: s.served ?? [] })),
      tooltip: (i) =>
        tipHtml(
          `${fTime(m.minutes[i])} – ${fTime(m.minutes[i] + MIN)}`,
          m.sites.map((s, k) => ({ color: SITE_COLORS[k % SITE_COLORS.length], label: s.name, value: `${bytes(s.served?.[i] ?? 0)} / min` })),
        ),
    });
    const total = m.sites.reduce((s, x) => s + sum(x.served), 0);
    $("[data-site-rows]").innerHTML = m.sites
      .map((s, i) => {
        const t = sum(s.served);
        const share = total ? (t / total) * 100 : 0;
        const color = SITE_COLORS[i % SITE_COLORS.length];
        return (
          `<div class="row" data-open="site:${esc(s.id)}" ${OPENER} aria-label="Open history for site ${esc(s.name)}">` +
          `<i class="sw" style="background:${color}"></i><span class="name">${esc(s.name)}.web.app</span><span class="value">${bytes(t)}</span>` +
          `<span class="detail"><span>served in 30 min</span><span>${bytes(last(s.served) ?? 0)} / min now</span></span>` +
          `<span class="sharebar"><b style="width:${share.toFixed(1)}%;background:${color}"></b></span></div>`
        );
      })
      .join("");
  }

  function renderJobs(m: Model) {
    const now = Date.now();
    $("[data-job-list]").innerHTML = m.jobs
      .map((j) => {
        const runs = state.runs[j.id];
        const other = state.other[j.id];
        const cells = daySquares(j.id, runs, now);
        const res = j.lastResult;
        const badge =
          res === "success"
            ? '<span class="badge ok">✓ Succeeded</span>'
            : res === "failed" || res === "missed"
              ? `<span class="badge bad">${res === "failed" ? "Failed" : "Missed"}</span>`
              : '<span class="badge none">No result</span>';
        const recent = (runs ?? []).filter((r) => r.result === "success" || r.result === "failed" || r.result === "missed");
        const okCount = recent.filter((r) => r.result === "success").length;
        return (
          `<div class="job" data-open="job:${esc(j.id)}" data-job="${esc(j.id)}" ${OPENER} aria-label="Open run history for ${esc(j.name)}">` +
          `<div class="job-head"><div><div class="job-name">${esc(j.name)}</div><div class="job-sched">${ICON.clock}${esc(j.schedule)} IST</div></div>${badge}</div>` +
          `<div class="job-grid"><div><span>Last run</span><b>${j.lastRunAt ? esc(fFull(j.lastRunAt)) : DASH}</b></div>` +
          `<div><span>Next run</span><b>${j.nextRun ? `in ${until(j.nextRun - now)}` : DASH}</b><small>${j.nextRun ? esc(fDayTime(j.nextRun)) : ""}</small></div></div>` +
          `<div><div class="days-caption"><span>Last 14 days</span><span>${recent.length ? `${okCount} of ${recent.length} runs succeeded (30 days)` : ""}</span></div>` +
          `<div class="days">${cells.map((c) => `<i class="${c.cls}" title="${esc(c.label)}"></i>`).join("")}</div>` +
          `<div class="days-labels">${cells.map((c) => `<span>${c.letter}</span>`).join("")}</div></div>` +
          `<div class="job-note">${
            other?.count ? esc(`${other.count} off-schedule call${other.count > 1 ? "s" : ""} in 30 days (${other.failed} with errors), not counted as runs`) : "No off-schedule calls in 30 days"
          }</div></div>`
        );
      })
      .join("");
  }

  function renderAll() {
    const m = state.model;
    const h = m ? health(m) : null;
    renderHeader(m, h);
    const sections = $("[data-sections]");
    if (state.mode === "off") {
      $("#overview").className = "banner";
      $("[data-banner-icon]").innerHTML = ICON.pause;
      $("[data-banner-title]").textContent = "Monitoring paused";
      $("[data-banner-sub]").textContent = "The kill switch is on. Set mode to \"live\" in config.json to resume.";
      $("[data-facts]").innerHTML = "";
      sections.hidden = true;
      return;
    }
    sections.hidden = false;
    if (!m || !h) return;
    renderBanner(m, h);
    renderKpis(m);
    renderDatabase(m);
    renderFunctions(m);
    renderStorage(m);
    renderHosting(m);
    renderJobs(m);
  }

  // ---------- drawer ----------

  function setUrl(changes: Record<string, string | null>) {
    try {
      const u = new URL(win.location.href);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) u.searchParams.delete(k);
        else u.searchParams.set(k, v);
      }
      win.history.replaceState(null, "", u);
    } catch {
      /* pages opened from disk cannot rewrite their URL */
    }
  }

  async function openDrawer(open: string, range?: string | null, updateUrl = true) {
    if (!state.model || state.mode === "off") return;
    const g = groupFor(open, state.model);
    if (!g) return;
    const ranges = g.runs ? RUN_RANGES : RANGES;
    const r: Range = isRange(range) && ranges.includes(range) ? range : g.defaultRange;
    state.drawer = { open, range: r, g, token: 0, lastFocus: state.drawer ? state.drawer.lastFocus : doc.activeElement };
    $("[data-d-title]").textContent = g.title;
    $("[data-d-sub]").textContent = g.sub;
    $("[data-d-range]").innerHTML = ranges.map((x) => `<button type="button" data-range="${x}" aria-pressed="${x === r}">${x}</button>`).join("");
    const dr = $("[data-drawer]");
    dr.classList.add("open");
    dr.setAttribute("aria-hidden", "false");
    $("[data-scrim]").classList.add("show");
    doc.body.style.overflow = "hidden";
    if (updateUrl) setUrl({ open, range: r });
    setTimeout(() => $<HTMLButtonElement>("[data-d-close]").focus({ preventScroll: true }), 60);
    await loadDrawer();
  }

  function closeDrawer() {
    if (!state.drawer) return;
    const focus = state.drawer.lastFocus as HTMLElement | null;
    state.drawer = null;
    const dr = $("[data-drawer]");
    dr.classList.remove("open");
    dr.setAttribute("aria-hidden", "true");
    $("[data-scrim]").classList.remove("show");
    doc.body.style.overflow = "";
    hideTip(doc);
    setUrl({ open: null, range: null });
    focus?.focus?.({ preventScroll: true });
  }

  async function loadDrawer() {
    const d = state.drawer;
    if (!d) return;
    const token = (d.token = Math.random());
    $("[data-d-charts]").innerHTML = '<div class="d-msg">Loading history…</div>';
    $("[data-d-stats]").innerHTML = "";
    $("[data-d-table]").innerHTML = "";
    $("[data-d-foot]").textContent = "";
    try {
      if (d.g.runs) {
        const res = await loadHistory(d.g.runs.id, "runs", d.range);
        if (state.drawer !== d || d.token !== token) return;
        d.runs = res.points;
        d.other = res.otherCalls ?? null;
        renderRunsDrawer(d);
        return;
      }
      const series: { pi: number; si: number; id: string; metric: string }[] = [];
      d.g.panels.forEach((p, pi) => p.series.forEach((s, si) => series.push({ pi, si, id: s.id, metric: s.metric })));
      const results = await Promise.all(series.map((x) => loadHistory(x.id, x.metric, d.range).then((r) => r.points)));
      if (state.drawer !== d || d.token !== token) return;
      d.series = series;
      d.results = results;
      renderLineDrawer(d);
    } catch (e) {
      if (state.drawer !== d) return;
      $("[data-d-charts]").innerHTML = `<div class="d-msg">Couldn’t load the history: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
    }
  }

  function renderLineDrawer(d: DrawerState) {
    const { g, range } = d;
    const now = Date.now();
    const from = now - RANGE_MS[range];
    const bms = BUCKET[range];
    const src = SOURCE_STEP[range];
    const raw = (pi: number, si: number) => {
      const k = (d.series ?? []).findIndex((x) => x.pi === pi && x.si === si);
      return d.results?.[k] ?? [];
    };
    $("[data-d-charts]").innerHTML =
      g.panels.map((_, pi) => `<div class="chart" data-d-panel="${pi}"></div>`).join("") +
      `<div class="legend">${g.panels
        .flatMap((p) => p.series)
        .map((s) => `<span><i class="sw" style="background:${s.color}"></i>${esc(s.label)}</span>`)
        .join("")}</div>`;
    const built = g.panels.map((p, pi) => ({
      p,
      series: p.series.map((s, si) => {
        let pts = raw(pi, si);
        if (s.scale) pts = pts.map((q) => ({ t: q.t, v: q.v * (s.scale ?? 1) }));
        if (s.minus !== undefined) {
          const other = new Map(raw(pi, s.minus).map((q) => [q.t, q.v]));
          pts = pts.map((q) => ({ t: q.t, v: Math.max(0, q.v - (other.get(q.t) ?? 0)) }));
        }
        const b: Bucket[] = bucketize(pts, from, now, bms, src, p.type === "bar" ? "bar" : p.type === "step" ? "step" : "max");
        return { s, b, pts };
      }),
    }));
    const firstT = Math.min(...built.flatMap((x) => x.series.map((y) => (y.pts[0] ? y.pts[0].t : Infinity))));
    const band = Number.isFinite(firstT) && firstT - from > bms ? { to: firstT, label: `No data before ${fDay(firstT)}` } : null;
    const buckets = built[0].series[0].b.map((b) => ({ start: b.start, end: b.end }));
    const span = RANGE_MS[range];
    const tooltip = (i: number) => {
      const b = buckets[i];
      const title = span <= DAY ? `${fTime(b.start)} – ${fTime(b.end)}` : `${fDayTime(b.start)} – ${span <= 7 * DAY ? fTime(b.end) : fDayTime(b.end)}`;
      return tipHtml(
        title,
        built.flatMap((x) =>
          x.series.map((y) => {
            const v = y.b[i].y;
            const pk = y.b[i].pk;
            const value = v === null ? "no data" : x.p.type === "bar" && bms > src && isNum(pk) ? `${fmtUnit(x.p.unit, v)} avg · ${fmtUnit(x.p.unit, pk)} peak` : fmtUnit(x.p.unit, v);
            return { color: y.s.color, label: y.s.label, value };
          }),
        ),
      );
    };
    const hosts: HTMLElement[] = [];
    const stats: { label: string; color: string; unit: PanelSpec["unit"]; latest: number | null; min: number | null; avg: number | null; max: number | null }[] = [];
    built.forEach((x, pi) => {
      const host = $(`[data-d-panel="${pi}"]`);
      hosts.push(host);
      const spec: ChartSpec = {
        type: x.p.type,
        unit: x.p.unit,
        height: x.p.height,
        from: buckets[0].start,
        to: now,
        buckets,
        title: x.p.title,
        stacked: x.p.stacked,
        axisWidth: 58,
        xLabels: pi === built.length - 1,
        emptyText: x.p.empty,
        band,
        series: x.series.map((y) => ({
          label: y.s.label,
          color: y.s.color,
          values: y.b.map((b) => b.y),
          area: y.s.area,
          peaks: x.p.type === "bar" && !x.p.stacked && bms > src ? y.b.map((b) => b.pk) : null,
        })),
        tooltip,
        sync: hosts,
      };
      chart(host, spec);
      for (const y of x.series) {
        const v = y.b.map((b) => b.y).filter(isNum);
        stats.push({
          label: y.s.label,
          color: y.s.color,
          unit: x.p.unit,
          latest: last(y.b.map((b) => b.y).filter((q): q is number => q !== null)),
          min: v.length ? Math.min(...v) : null,
          avg: v.length ? sum(v) / v.length : null,
          max: v.length ? Math.max(...v) : null,
        });
      }
    });
    const main = stats[0];
    $("[data-d-stats]").innerHTML = main
      ? `<div class="stat-grid">${(
          [
            ["Latest", main.latest],
            ["Average", main.avg],
            ["Highest", main.max],
            ["Lowest", main.min],
          ] as [string, number | null][]
        )
          .map((s) => `<div class="stat"><span>${s[0]} · ${esc(main.label)}</span><b>${fmtUnit(main.unit, s[1])}</b></div>`)
          .join("")}</div>`
      : "";
    $("[data-d-table]").innerHTML =
      '<table class="dt"><thead><tr><th>Series</th><th>Latest</th><th>Min</th><th>Average</th><th>Max</th></tr></thead><tbody>' +
      stats
        .map((s) => `<tr><td><i class="sw" style="background:${s.color}"></i>${esc(s.label)}</td><td>${fmtUnit(s.unit, s.latest)}</td><td>${fmtUnit(s.unit, s.min)}</td><td>${fmtUnit(s.unit, s.avg)}</td><td>${fmtUnit(s.unit, s.max)}</td></tr>`)
        .join("") +
      "</tbody></table>";
    const hasBars = g.panels.some((p) => p.type === "bar") && bms > src;
    $("[data-d-foot]").textContent =
      (hasBars ? `Bars: solid is the average per ${STEP_WORD[range]}, the light part reaches the busiest ${SRC_WORD[range]}. ` : `Each point covers ${STEP_WORD[range]}. `) +
      `From ${fFull(from)} to ${fFull(now)}. Hover a chart for exact values.`;
  }

  function renderRunsDrawer(d: DrawerState) {
    const now = Date.now();
    const from = now - RANGE_MS[d.range];
    const runs = (d.runs ?? []).filter((r) => r.result === "success" || r.result === "failed" || r.result === "missed");
    const dayStart = (t: number) => Math.floor((t + 5.5 * HOUR) / DAY) * DAY - 5.5 * HOUR;
    const buckets: { start: number; end: number }[] = [];
    for (let t = dayStart(from); t < now; t += DAY) buckets.push({ start: t, end: t + DAY });
    const inBucket = (b: { start: number; end: number }) => runs.filter((r) => r.t >= b.start && r.t < b.end);
    const ok: Series = buckets.map((b) => inBucket(b).filter((r) => r.result === "success").length);
    const bad: Series = buckets.map((b) => inBucket(b).filter((r) => r.result !== "success").length);
    $("[data-d-charts]").innerHTML =
      '<div class="chart" data-d-panel="0"></div><div class="legend"><span><i class="sw" style="background:var(--c-writes)"></i>Succeeded</span><span><i class="sw" style="background:var(--c-deletes)"></i>Failed or missed</span></div>';
    chart($('[data-d-panel="0"]'), {
      type: "bar",
      unit: "count",
      height: 200,
      from: buckets[0].start,
      to: now,
      buckets,
      stacked: true,
      title: "Scheduled runs per day",
      axisWidth: 40,
      emptyText: "No scheduled runs in this period",
      series: [
        { label: "Succeeded", color: "var(--c-writes)", values: ok },
        { label: "Failed or missed", color: "var(--c-deletes)", values: bad },
      ],
      tooltip: (i) => {
        const rows = inBucket(buckets[i]).map((r) => ({ color: r.result === "success" ? "var(--c-writes)" : "var(--c-deletes)", label: fTime(r.t), value: r.result ?? "" }));
        return tipHtml(fDay(buckets[i].start + 12 * HOUR), rows.length ? rows : [{ color: "var(--c-idle)", label: "No run", value: "" }]);
      },
    });
    const okN = runs.filter((r) => r.result === "success").length;
    const lastFail = [...runs].reverse().find((r) => r.result !== "success");
    $("[data-d-stats]").innerHTML = `<div class="stat-grid">${[
      ["Runs", String(runs.length)],
      ["Succeeded", String(okN)],
      ["Success rate", runs.length ? `${Math.round((okN / runs.length) * 100)}%` : DASH],
      ["Last failure", lastFail ? fDay(lastFail.t) : "None"],
    ]
      .map((s) => `<div class="stat"><span>${s[0]}</span><b>${esc(s[1])}</b></div>`)
      .join("")}</div>`;
    $("[data-d-table]").innerHTML =
      '<table class="dt"><thead><tr><th>Scheduled run</th><th>Result</th><th>Requests</th></tr></thead><tbody>' +
      [...runs]
        .reverse()
        .slice(0, 30)
        .map((r) => `<tr><td>${esc(fFull(r.t))}</td><td><span class="badge ${r.result === "success" ? "ok" : "bad"}">${esc(r.result ?? "")}</span></td><td>${num(r.requests ?? null)}</td></tr>`)
        .join("") +
      "</tbody></table>";
    $("[data-d-foot]").textContent =
      (d.other?.count ? `${d.other.count} off-schedule calls (${d.other.failed} with errors) are not counted as runs. ` : "") +
      "A run counts when the job function answers within 30 minutes of its scheduled time.";
  }

  function downloadCsv() {
    const d = state.drawer;
    if (!d) return;
    let csv: string;
    if (d.g.runs) csv = "scheduled_time,result,requests\n" + (d.runs ?? []).map((r) => `${new Date(r.t).toISOString()},${r.result ?? ""},${r.requests ?? ""}`).join("\n");
    else {
      const labels = d.g.panels.flatMap((p) => p.series.map((s) => s.label));
      csv =
        "series,time,value\n" +
        (d.results ?? [])
          .map((pts, k) => pts.map((p) => `"${labels[k]}",${new Date(p.t).toISOString()},${p.v}`).join("\n"))
          .filter(Boolean)
          .join("\n");
    }
    const a = doc.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${d.g.title.replace(/[^\w.-]+/g, "_")}_${d.range}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- side data and loop ----------

  async function loadSide(force: boolean) {
    if (state.mode === "off") return;
    const now = Date.now();
    const tasks: Promise<void>[] = [];
    if (force || now - state.storageAt > STORAGE_RELOAD_MS) {
      state.storageAt = now;
      tasks.push(
        loadHistory("total:bucket", "bytesStored", "30d").then(
          (r) => {
            state.storage = r.points;
          },
          () => {
            if (state.storage === undefined) state.storage = null;
          },
        ),
      );
    }
    if ((force || now - state.runsAt > RUNS_RELOAD_MS) && state.model) {
      state.runsAt = now;
      for (const j of state.model.jobs) {
        tasks.push(
          loadHistory(j.id, "runs", "30d").then(
            (r) => {
              state.runs[j.id] = r.points;
              state.other[j.id] = r.otherCalls ?? null;
            },
            () => undefined,
          ),
        );
      }
    }
    if (tasks.length === 0) return;
    await Promise.all(tasks);
    if (!state.stopped) renderAll();
  }

  // The latest storage and runs load (the first one is awaited at start).
  let sidePending: Promise<void> = Promise.resolve();
  async function tick() {
    if (state.stopped || state.mode === "off") return;
    try {
      state.model = await loadModel();
      state.online = true;
      state.err = "";
    } catch (e) {
      state.online = false;
      state.err = e instanceof Error ? e.message : String(e);
    }
    if (state.stopped) return;
    renderAll();
    sidePending = loadSide(false);
    if (state.drawer && (state.drawer.range === "1h" || state.drawer.range === "6h")) void loadDrawer();
  }
  function schedule() {
    if (state.timer) clearTimeout(state.timer);
    if (state.stopped || state.mode === "off") return;
    state.timer = setTimeout(async () => {
      if (doc.visibilityState !== "hidden") await tick();
      schedule();
    }, state.refresh * 1000);
  }
  const onVisibility = () => {
    if (doc.visibilityState === "visible") {
      void tick();
      schedule();
    }
  };

  // ---------- events ----------

  const onClick = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (!t?.closest) return;
    const filter = t.closest<HTMLElement>("[data-filter]");
    if (filter && state.model) {
      state.fnFilter = filter.dataset.filter as "all" | FnStatus;
      renderFunctions(state.model);
      return;
    }
    const sort = t.closest<HTMLElement>("[data-sort]");
    if (sort && state.model) {
      const k = sort.dataset.sort ?? "status";
      state.fnSort = state.fnSort.key === k ? { key: k, dir: -state.fnSort.dir } : { key: k, dir: k === "name" || k === "status" ? 1 : -1 };
      renderFunctions(state.model);
      return;
    }
    const rb = t.closest<HTMLElement>("[data-d-range] [data-range]");
    if (rb && state.drawer && isRange(rb.dataset.range)) {
      state.drawer.range = rb.dataset.range;
      for (const b of root.querySelectorAll("[data-d-range] button")) b.setAttribute("aria-pressed", String(b === rb));
      setUrl({ range: rb.dataset.range });
      void loadDrawer();
      return;
    }
    const rs = t.closest<HTMLButtonElement>("[data-refresh-seg] [data-s]");
    if (rs && !rs.disabled) {
      const s = Number(rs.dataset.s);
      if ((REFRESH_CHOICES as readonly number[]).includes(s)) {
        state.refresh = s;
        write("pm-refresh", String(s));
        renderHeader(state.model, state.model ? health(state.model) : null);
        schedule();
      }
      return;
    }
    if (t.closest("[data-theme-btn]")) {
      const next = doc.documentElement.dataset.theme === "dark" ? "light" : "dark";
      doc.documentElement.dataset.theme = next;
      write("pm-theme", next);
      $("[data-theme-btn]").setAttribute("aria-label", next === "dark" ? "Switch to white theme" : "Switch to dark theme");
      return;
    }
    if (t.closest("[data-d-close]") || t.closest("[data-scrim]")) {
      closeDrawer();
      return;
    }
    if (t.closest("[data-d-csv]")) {
      downloadCsv();
      return;
    }
    const opener = t.closest<HTMLElement>("[data-open]");
    if (opener?.dataset.open && !t.closest("[data-drawer]")) {
      e.preventDefault();
      void openDrawer(opener.dataset.open);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && state.drawer) {
      closeDrawer();
      return;
    }
    const el = e.target as HTMLElement | null;
    if ((e.key === "Enter" || e.key === " ") && el?.matches?.("[data-open][role=button]") && el.dataset.open) {
      e.preventDefault();
      void openDrawer(el.dataset.open);
    }
  };
  const onSearch = (e: Event) => {
    state.fnQuery = (e.target as HTMLInputElement).value;
    if (state.model) renderFunctions(state.model);
  };
  root.addEventListener("click", onClick);
  doc.addEventListener("keydown", onKey);
  $("[data-fn-search]").addEventListener("input", onSearch);
  doc.addEventListener("visibilitychange", onVisibility);

  // The section in view is highlighted in the nav.
  let io: IntersectionObserver | null = null;
  if ("IntersectionObserver" in win) {
    const links = [...root.querySelectorAll<HTMLElement>("[data-nav]")];
    io = new win.IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.dataset.nav === en.target.id));
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const id of ["overview", "database", "functions", "storage", "hosting", "jobs"]) {
      const el = root.querySelector(`#${id}`);
      if (el) io.observe(el);
    }
  }
  $("[data-theme-btn]").setAttribute("aria-label", doc.documentElement.dataset.theme === "dark" ? "Switch to white theme" : "Switch to dark theme");

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.configTimer) clearInterval(state.configTimer);
    root.removeEventListener("click", onClick);
    doc.removeEventListener("keydown", onKey);
    doc.removeEventListener("visibilitychange", onVisibility);
    io?.disconnect();
  }

  // ---------- start ----------

  if (state.mode === "off") {
    renderAll();
    return { stop };
  }
  await tick();
  await sidePending;
  schedule();
  if (state.mode === "live") {
    // Honour the kill switch in tabs that stay open.
    state.configTimer = setInterval(async () => {
      const next = await loadConfig(fetchFn);
      if (next.mode === "off" && !state.stopped) {
        state.mode = "off";
        if (state.timer) clearTimeout(state.timer);
        closeDrawer();
        renderAll();
      }
    }, CONFIG_RECHECK_MS);
  }
  const params = new URLSearchParams(win.location.search);
  const open = params.get("open");
  if (open) void openDrawer(open, params.get("range"), false);
  return { stop };
}
