import { daySquares } from "./day-squares";
import { BUCKET_COLORS, SITE_COLORS } from "./drawer-groups";
import { DASH, escapeHtml as esc, fmt, istDateMinute, istDayTime, istTime, shortBucket, untilText } from "./fmt";
import { cpuMeter, instancesText, ramMeter, NOT_REPORTED, type MeterState } from "./meters";
import {
  activityCells,
  addSeries,
  isRunningNow,
  latestValue,
  peakOf,
  recentSeries,
  requestSeries,
  sumOf,
  type Series,
} from "./recent";
import { createPageCharts, type PageCharts } from "./page-charts";
import { REFRESH_OPTIONS } from "./refresh";
import { nextRunAt } from "./schedule";
import { JOB_SCHEDULES, PROJECT_ID } from "./services";
import type { HistoryPoint, MetricsResponse, ServiceInfo, ServiceMetrics } from "./types";

// The page, top to bottom: header (with the overall status), KPI cards, the
// Firestore card, the functions table, storage and hosting side by side, the
// scheduler table and the footer. Every element that opens the history
// drawer carries data-open, tabindex="0" and role="button".

export type LiveState = "loading" | "live" | "paused" | "offline";

export interface DashboardStatus {
  state: LiveState;
  mock: boolean;
  // Kill switch: mode "off", nothing is requested.
  off?: boolean;
  stale?: boolean;
  // Seconds until the next attempt after a failed refresh.
  retrySeconds?: number;
  refreshSeconds: number;
  paused: boolean;
  nowMs: number;
  // Scheduler runs history per job id, for the day squares.
  runs?: Readonly<Record<string, readonly HistoryPoint[] | null>>;
  // Total bytes stored over the last 30 days, for the storage card's chart.
  storageGrowth?: readonly HistoryPoint[] | null;
}

export const OPENER_ATTRS = 'role="button" tabindex="0"';

function shell(): string {
  const options = REFRESH_OPTIONS.map(
    (o) => `<button type="button" data-refresh="${o.seconds}" aria-pressed="false">${o.label}</button>`,
  ).join("");
  return `
<div class="wrap" data-dashboard>
  <header class="top">
    <div class="brand">
      <h1>Paraliyard monitor</h1>
      <span class="gur" lang="pa">ਪਰਾਲੀ ਯਾਰਡ</span>
      <span class="proj">${PROJECT_ID}</span>
    </div>
    <div class="controls">
      <span class="status" data-status ${OPENER_ATTRS} hidden></span>
      <span class="live" data-live><i></i><span data-live-text>Live</span></span>
      <span class="updated">Updated <time data-updated>${DASH}</time></span>
      <div class="seg" role="group" aria-label="Refresh every">${options}</div>
      <button class="btn" type="button" data-action="pause" aria-pressed="false">Pause</button>
    </div>
  </header>
  <p class="note" data-note hidden></p>
  <p class="note err" data-error role="status" hidden></p>
  <main class="grid" data-sections></main>
  <footer class="foot" data-footer></footer>
</div>`;
}

const ofKind = (data: MetricsResponse, kinds: readonly ServiceInfo["kind"][]) =>
  data.services.filter((s) => kinds.includes(s.kind));

// One header pattern for every card: title, a one-line description and an
// optional meta on the right.
function cardHead(id: string, title: string, desc: string, meta = ""): string {
  return `<div class="card-head"><div><h2 id="${id}">${title}</h2><p class="card-desc">${desc}</p></div>${meta ? `<p class="card-meta">${meta}</p>` : ""}</div>`;
}

const functionErrors = (data: MetricsResponse) =>
  sumOf(addSeries(ofKind(data, ["function2"]).map((s) => recentSeries(s, "errPerMin"))));

// ---------- Overall status ----------

export interface Health {
  ok: boolean;
  text: string;
  // The drawer the pill opens.
  open: string;
}

// "All healthy", or "Needs attention: …" with every reason: function errors in
// the last 30 minutes, and jobs whose last scheduled run failed or was missed.
export function healthOf(data: MetricsResponse): Health {
  const reasons: { text: string; open: string }[] = [];
  const errors = functionErrors(data);
  const errCount = errors === null ? 0 : Math.round(errors);
  if (errCount > 0) reasons.push({ text: `${errCount} function error${errCount === 1 ? "" : "s"} in 30 min`, open: "sum:errors" });
  for (const job of ofKind(data, ["scheduler"])) {
    const result = job.metrics.lastResult;
    if (result === "failed" || result === "missed") reasons.push({ text: `${job.name} ${result}`, open: `job:${job.id}` });
  }
  if (reasons.length === 0) return { ok: true, text: "All healthy", open: "sum:requests" };
  return { ok: false, text: `Needs attention: ${reasons.map((r) => r.text).join(" · ")}`, open: reasons[0].open };
}

// ---------- KPI cards ----------

// nextRun from the API, else computed from the job's cron.
function jobNextRun(s: ServiceMetrics, nowMs: number): number | null {
  const fromApi = s.nextRun ? Date.parse(s.nextRun) : NaN;
  if (Number.isFinite(fromApi)) return fromApi;
  const job = JOB_SCHEDULES[s.id];
  return job ? nextRunAt(job.cron, nowMs) : null;
}

function kpi(stat: string, open: string, label: string, value: string, sub: string, alert = false): string {
  return `
  <div class="kpi stat${alert ? " alert" : ""}" data-open="${open}" ${OPENER_ATTRS} data-stat="${stat}">
    <span>${label}</span><strong>${value}</strong><small>${sub}</small>
  </div>`;
}

function kpis(data: MetricsResponse, nowMs: number): string {
  const fns = ofKind(data, ["function2", "function1"]);
  const running = fns.filter(isRunningNow).length;
  const reqNow = latestValue(addSeries(fns.map(requestSeries)));
  const errors = functionErrors(data);
  const buckets = ofKind(data, ["bucket"]);
  const stored = data.totals.bucket?.bytesStored;
  const sites = ofKind(data, ["hosting"]);
  const served = sumOf(addSeries(sites.map((s) => recentSeries(s, "bytesServed"))));
  const next = ofKind(data, ["scheduler"])
    .map((s) => ({ s, at: jobNextRun(s, nowMs) }))
    .filter((j): j is { s: ServiceMetrics; at: number } => j.at !== null)
    .sort((a, b) => a.at - b.at)[0];
  const errCount = errors === null ? null : Math.round(errors);
  return `
<section class="kpis" aria-label="Health summary" data-section="strip">
  ${kpi("running", "sum:requests", "Functions running now", `${running} of ${fns.length}`, `${fmt.int(reqNow)} requests/min now`)}
  ${kpi(
    "errors",
    "sum:errors",
    "Function errors, 30 min",
    errCount === null ? DASH : fmt.int(errCount),
    errCount ? "Click to see when" : errCount === 0 ? "No errors" : "Not available",
    Boolean(errCount),
  )}
  ${kpi("stored", "sum:bytes", "Stored in buckets", fmt.bytes(typeof stored === "number" ? stored : null), `${buckets.length} buckets`)}
  ${kpi("hosting", "host", "Hosting served, 30 min", fmt.bytes(served), `${sites.length} sites`)}
  ${kpi(
    "next",
    next ? `job:${esc(next.s.id)}` : "sum:requests",
    "Next scheduled job",
    next ? `in ${untilText(next.at - nowMs)}` : DASH,
    next ? esc(next.s.name) : "No schedule reported",
  )}
</section>`;
}

// ---------- Firestore ----------

// The hero, hosting and storage charts are Chart.js canvases
// (src/page-charts.ts). Their containers are kept across refreshes, so each
// chart is made once.
const CHART_CONTAINERS = [".hero-chart", ".host-chart", ".storage-chart"] as const;

function hero(data: MetricsResponse): string {
  const fs = data.services.find((s) => s.kind === "firestore");
  const reads = recentSeries(fs, "readsPerMin");
  return `
<section class="card hero" aria-labelledby="heroTitle" data-section="hero">
  ${cardHead("heroTitle", "Yard database activity", `Firestore database "${esc(fs?.name ?? "yard")}" · last 30 minutes, updating live`)}
  <div class="hero-body">
    <div class="hero-side">
      <div class="plain" data-open="fs" ${OPENER_ATTRS} aria-label="Open read history">
        <span class="bignum" data-hero="reads">${fmt.rate(latestValue(reads))}</span>
        <span class="unit">document reads per minute now</span>
      </div>
      <dl class="sub">
        <div><dt>Writes/min</dt><dd data-hero="writes">${fmt.rate(latestValue(recentSeries(fs, "writesPerMin")))}</dd></div>
        <div><dt>Deletes/min</dt><dd data-hero="deletes">${fmt.int(latestValue(recentSeries(fs, "deletesPerMin")))}</dd></div>
        <div><dt>Peak, 30 min</dt><dd data-hero="peak">${fmt.rate(peakOf(reads))}</dd></div>
      </dl>
    </div>
    <div class="hero-chart" data-open="fs" ${OPENER_ATTRS} aria-label="Open Firestore history">
      <div class="hero-panel hero-panel--reads"><canvas role="img" aria-label="Reads per minute, last 30 minutes"></canvas></div>
      <div class="hero-panel hero-panel--writes"><canvas data-panel="writes" role="img" aria-label="Writes and deletes per minute, last 30 minutes"></canvas></div>
    </div>
  </div>
</section>`;
}

// ---------- Functions table ----------

function meterCell(kind: "cpu" | "ram", m: MeterState): string {
  return `<td><span class="meter${kind === "ram" ? " m-ram" : ""}" data-meter="${kind}" data-state="${m.kind}"><b style="width:${m.width}%"></b></span><span class="v-${kind}${m.kind === "value" ? "" : " muted"}"${m.kind === "na" ? ' title="Not reported for 1st gen functions"' : ""}>${esc(m.label)}</span></td>`;
}

function heat(requests: Series, errors: Series): string {
  const cells = activityCells(requests, errors)
    .map((c) => {
      if (c.state === "on") {
        const pct = Math.round(c.alpha * 100);
        return `<i class="on" data-alpha="${c.alpha.toFixed(2)}" style="background:color-mix(in srgb,var(--straw) ${pct}%,var(--surface-2))"></i>`;
      }
      return `<i class="${c.state}"></i>`;
    })
    .join("");
  return `<span class="heat" aria-hidden="true">${cells}</span>`;
}

function dotClass(errNow: number | null, running: boolean): string {
  if (typeof errNow === "number" && errNow > 0) return "dot err";
  return running ? "dot on" : "dot";
}

function functionRow(s: ServiceMetrics): string {
  const gen1 = s.kind === "function1";
  const running = isRunningNow(s);
  const req = requestSeries(s);
  const err = gen1 ? null : recentSeries(s, "errPerMin");
  const errNow = latestValue(err);
  return `
<tr data-open="fn:${esc(s.id)}" data-service-id="${esc(s.id)}" ${OPENER_ATTRS} aria-label="Open history for ${esc(s.name)}">
  <th scope="row"><span class="${dotClass(errNow, running)}"></span>${esc(s.name)}</th>
  <td class="gen">${gen1 ? "1st gen" : "2nd gen"}</td>
  ${meterCell("cpu", cpuMeter(s, running))}
  ${meterCell("ram", ramMeter(s, running))}
  <td class="num req">${fmt.int(latestValue(req))}</td>
  <td class="num err">${gen1 ? NOT_REPORTED : fmt.int(errNow)}</td>
  <td class="num inst">${esc(instancesText(s))}</td>
  <td>${heat(req, err)}</td>
</tr>`;
}

function functionsTable(data: MetricsResponse): string {
  const fns = ofKind(data, ["function2", "function1"]);
  const req = addSeries(fns.map(requestSeries));
  const err = addSeries(ofKind(data, ["function2"]).map((s) => recentSeries(s, "errPerMin")));
  const instances = data.totals.function2?.instances;
  const anyRunning = fns.some(isRunningNow);
  const running = fns.filter(isRunningNow).length;
  return `
<section class="card" aria-labelledby="fnTitle" data-section="functions">
  ${cardHead(
    "fnTitle",
    "Cloud Functions",
    "CPU and RAM are p99. Activity shows requests per minute over the last 30 minutes; red marks a minute with errors.",
    `${running} of ${fns.length} running`,
  )}
  <div class="tablewrap">
    <table class="fn">
      <colgroup>
        <col class="c-name"><col class="c-gen"><col class="c-cpu"><col class="c-ram"><col class="c-req"><col class="c-err"><col class="c-inst"><col class="c-act">
      </colgroup>
      <thead><tr>
        <th>Function</th><th>Gen</th><th>CPU</th><th>RAM</th>
        <th class="num">Requests/min</th><th class="num">Errors/min</th><th class="num">Instances</th><th>Activity, 30 min</th>
      </tr></thead>
      <tbody>${fns.map(functionRow).join("")}</tbody>
      <tfoot>
        <tr data-open="sum:requests" ${OPENER_ATTRS} aria-label="Open history for all functions">
          <th scope="row"><span class="${dotClass(latestValue(err), anyRunning)}"></span>All functions</th><td></td><td></td><td></td>
          <td class="num req">${fmt.int(latestValue(req))}</td>
          <td class="num err">${fmt.int(latestValue(err))}</td>
          <td class="num inst">${typeof instances === "number" ? fmt.int(instances) : DASH}</td>
          <td>${heat(req, err)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
</section>`;
}

// ---------- Storage and hosting ----------

function itemRow(open: string, label: string, color: string, name: string, value: string, detail: string): string {
  return `
    <div class="plain bucket" data-open="${open}" ${OPENER_ATTRS} aria-label="${label}">
      <span class="sw" style="background:var(${color})"></span>
      <span class="name">${name}</span>
      <span class="size">${value}</span>
      <span class="full">${detail}</span>
    </div>`;
}

function storageAndHosting(data: MetricsResponse, status: DashboardStatus): string {
  const buckets = ofKind(data, ["bucket"]);
  const sizes = buckets.map((b) => (typeof b.metrics.bytesStored === "number" ? b.metrics.bytesStored : 0));
  const total = sizes.reduce((a, b) => a + b, 0);
  const stored = data.totals.bucket?.bytesStored;
  const sites = ofKind(data, ["hosting"]);
  const servedTotal = sumOf(addSeries(sites.map((s) => recentSeries(s, "bytesServed"))));
  const growth = status.storageGrowth;
  const growthMsg = growth === undefined ? "Loading storage history…" : growth === null ? "Storage history not available" : "";
  return `
<div class="pair" data-section="storage-hosting">
  <section class="card" aria-labelledby="stTitle" data-section="storage">
    ${cardHead("stTitle", "Storage buckets", "Space used per bucket, and the total over the last 30 days", `${fmt.bytes(typeof stored === "number" ? stored : null)} total`)}
    <div class="share" aria-hidden="true">${buckets
      .map((_, i) => `<i style="background:var(${BUCKET_COLORS[i % 4]});flex-grow:${total ? (sizes[i] / total).toFixed(4) : 0}"></i>`)
      .join("")}</div>
    <div class="chart-box">
      <div class="storage-chart" data-open="sum:bytes" ${OPENER_ATTRS} aria-label="Open storage history"><canvas role="img" aria-label="Storage used, last 30 days"></canvas></div>
      <p class="chart-msg" data-storage-msg${growthMsg ? "" : " hidden"}>${growthMsg}</p>
    </div>
    <div class="rows">${buckets
      .map((b, i) =>
        itemRow(
          `st:${esc(b.id)}`,
          `Open history for bucket ${esc(b.name)}`,
          BUCKET_COLORS[i % 4],
          esc(shortBucket(b.name, PROJECT_ID)),
          fmt.bytes(typeof b.metrics.bytesStored === "number" ? b.metrics.bytesStored : null),
          `${esc(b.name)} · ${fmt.int(latestValue(recentSeries(b, "reqPerMin")))} requests/min now`,
        ),
      )
      .join("")}</div>
  </section>
  <section class="card" aria-labelledby="hoTitle" data-section="hosting">
    ${cardHead("hoTitle", "Firebase Hosting", "Data served per minute, last 30 minutes", `${fmt.bytes(servedTotal)} in 30 min`)}
    <div class="chart-box">
      <div class="host-chart" data-open="host" ${OPENER_ATTRS} aria-label="Open hosting history"><canvas role="img" aria-label="Bytes served per minute, last 30 minutes"></canvas></div>
    </div>
    <div class="rows sites">${sites
      .map((h, i) => {
        const served = recentSeries(h, "bytesServed");
        return itemRow(
          `site:${esc(h.id)}`,
          `Open history for site ${esc(h.name)}`,
          SITE_COLORS[i % 4],
          esc(h.name),
          fmt.bytes(sumOf(served)),
          `served in the last 30 minutes · ${fmt.bytes(latestValue(served))}/min now`,
        );
      })
      .join("")}</div>
  </section>
</div>`;
}

// ---------- Scheduler jobs ----------

const RESULT_BADGE: Record<string, string> = {
  success: '<span class="badge">success</span>',
  failed: '<span class="badge fail">failed</span>',
  missed: '<span class="badge fail">missed</span>',
};

function lastRun(s: ServiceMetrics): { when: string; result: string } {
  const at = typeof s.metrics.lastRunAt === "string" ? Date.parse(s.metrics.lastRunAt) : NaN;
  const result = s.metrics.lastResult;
  if (!Number.isFinite(at)) {
    return { when: `<span class="muted">${result === "none" ? "No run in 8 days" : "Not available"}</span>`, result: "" };
  }
  return {
    when: esc(istDateMinute(at)),
    result: RESULT_BADGE[String(result)] ?? '<span class="badge none">unknown</span>',
  };
}

function jobRow(s: ServiceMetrics, status: DashboardStatus): string {
  const at = jobNextRun(s, status.nowMs);
  const schedule = s.schedule ?? JOB_SCHEDULES[s.id]?.schedule ?? "";
  const squares = daySquares(status.runs?.[s.id] ?? null, status.nowMs)
    .map((d) => `<i class="${d.state === "ok" ? "ok" : d.state === "failed" || d.state === "missed" ? "fail" : ""}" data-day="${d.state}" title="${esc(d.label)}"></i>`)
    .join("");
  const last = lastRun(s);
  return `
<tr class="job" data-open="job:${esc(s.id)}" data-job-id="${esc(s.id)}" ${OPENER_ATTRS} aria-label="Open run history for ${esc(s.name)}">
  <th scope="row" class="name">${esc(s.name)}</th>
  <td class="meta">${esc(schedule)}</td>
  <td class="last">${last.when}</td>
  <td class="result">${last.result}</td>
  <td><span class="days" aria-label="Last 14 days">${squares}</span><span class="days-axis"><span>14 days ago</span><span>Today</span></span></td>
  <td class="next"><strong>${at === null ? DASH : `in ${untilText(at - status.nowMs)}`}</strong><span class="meta">${at === null ? "" : esc(istDayTime(at))}</span></td>
</tr>`;
}

function jobs(data: MetricsResponse, status: DashboardStatus): string {
  return `
<section class="card" aria-labelledby="jobTitle" data-section="jobs">
  ${cardHead("jobTitle", "Cloud Scheduler jobs", "Each square is one day: green, the scheduled run succeeded; red, it failed or was missed.")}
  <div class="tablewrap">
    <table class="jobs">
      <colgroup><col class="c-job"><col class="c-sched"><col class="c-last"><col class="c-res"><col class="c-days"><col class="c-next"></colgroup>
      <thead><tr><th>Job</th><th>Schedule</th><th>Last run</th><th>Result</th><th>Last 14 days</th><th>Next run</th></tr></thead>
      <tbody>${ofKind(data, ["scheduler"])
        .map((s) => jobRow(s, status))
        .join("")}</tbody>
    </table>
  </div>
</section>`;
}

// ---------- Header, status, notes and footer ----------

const LIVE_TEXT: Record<LiveState, string> = { loading: "Live", live: "Live", paused: "Paused", offline: "Offline" };
const LIVE_CLASS: Record<LiveState, string> = { loading: "live", live: "live", paused: "live paused", offline: "live down" };

function updateHeader(root: HTMLElement, data: MetricsResponse | null, status: DashboardStatus): void {
  const live = root.querySelector<HTMLElement>("[data-live]")!;
  live.className = LIVE_CLASS[status.state];
  live.dataset.state = status.state;
  root.querySelector("[data-live-text]")!.textContent = LIVE_TEXT[status.state];
  const generated = data ? Date.parse(data.generatedAt) : NaN;
  const time = root.querySelector<HTMLTimeElement>("[data-updated]")!;
  time.textContent = Number.isFinite(generated) ? istTime(generated) : DASH;
  if (Number.isFinite(generated)) time.dateTime = new Date(generated).toISOString();
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-refresh]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.refresh) === status.refreshSeconds));
    button.disabled = Boolean(status.off);
  }
  const pause = root.querySelector<HTMLButtonElement>('button[data-action="pause"]')!;
  pause.textContent = status.paused ? "Resume" : "Pause";
  pause.setAttribute("aria-pressed", String(status.paused));
  pause.disabled = Boolean(status.off);

  const pill = root.querySelector<HTMLElement>("[data-status]")!;
  if (data && !status.off) {
    const health = healthOf(data);
    pill.className = `status ${health.ok ? "ok" : "warn"}`;
    pill.textContent = health.text;
    pill.dataset.open = health.open;
    pill.setAttribute("aria-label", `${health.text}. Open details`);
    pill.hidden = false;
  } else {
    pill.hidden = true;
    delete pill.dataset.open;
  }

  const note = root.querySelector<HTMLElement>("[data-note]")!;
  let noteText = "";
  if (status.off) {
    noteText = "Live monitoring is paused. The kill switch in config.json is set to off, so no metrics are requested.";
  } else if (status.mock) {
    noteText = 'Showing sample data (mock mode). No metrics are requested; set mode to "live" in config.json to see real numbers.';
  } else if (status.stale) {
    noteText = "Showing the last good data: the latest refresh on the server failed.";
  }
  note.textContent = noteText;
  note.hidden = noteText === "";

  const error = root.querySelector<HTMLElement>("[data-error]")!;
  const offline = status.state === "offline";
  error.textContent = offline
    ? `Can't reach the metrics endpoint. Retrying in ${status.retrySeconds ?? status.refreshSeconds} seconds.`
    : "";
  error.hidden = !offline;

  root.querySelector<HTMLElement>("[data-footer]")!.textContent =
    `Data from Google Cloud Monitoring (read-only) · Project ${PROJECT_ID} · Times in IST · ` +
    `Refreshes every ${status.refreshSeconds} s · Click any chart, card or row for its full history`;
}

// One set of page charts per dashboard root.
const pageCharts = new WeakMap<HTMLElement, PageCharts>();

// Destroys the page charts of root (the app calls this when it stops).
export function destroyDashboard(root: HTMLElement): void {
  pageCharts.get(root)?.destroy();
  pageCharts.delete(root);
}

function updateCharts(root: HTMLElement, sections: HTMLElement, data: MetricsResponse, status: DashboardStatus): void {
  let charts = pageCharts.get(root);
  if (!charts) {
    charts = createPageCharts();
    pageCharts.set(root, charts);
  }
  const generated = Date.parse(data.generatedAt);
  const at = Number.isFinite(generated) ? generated : status.nowMs;
  const heroCanvas = sections.querySelector<HTMLCanvasElement>(".hero-chart canvas");
  const hostCanvas = sections.querySelector<HTMLCanvasElement>(".host-chart canvas");
  const storageCanvas = sections.querySelector<HTMLCanvasElement>(".storage-chart canvas");
  if (heroCanvas) charts.hero(heroCanvas, data.services.find((s) => s.kind === "firestore"), at);
  if (hostCanvas) charts.host(hostCanvas, ofKind(data, ["hosting"]), at);
  if (storageCanvas && status.storageGrowth) charts.storage(storageCanvas, status.storageGrowth, status.nowMs);
}

// Renders (or updates) the page in root. Header controls are built once so
// they keep focus; sections are redrawn and a focused opener keeps focus.
// The chart containers (with their canvases) are moved into the new markup.
export function renderDashboard(root: HTMLElement, data: MetricsResponse | null, status: DashboardStatus): void {
  if (!root.querySelector("[data-dashboard]")) root.innerHTML = shell();
  updateHeader(root, data, status);
  const sections = root.querySelector<HTMLElement>("[data-sections]")!;
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const focusedOpener = active && sections.contains(active) ? active.getAttribute("data-open") : null;
  const focusedLabel = active?.getAttribute("aria-label") ?? null;
  if (!data || status.off) {
    destroyDashboard(root);
    sections.innerHTML = status.off ? "" : '<p class="hint" data-loading>Loading metrics…</p>';
    return;
  }
  const kept = CHART_CONTAINERS.map((selector) => sections.querySelector<HTMLElement>(selector));
  sections.innerHTML = [kpis(data, status.nowMs), hero(data), functionsTable(data), storageAndHosting(data, status), jobs(data, status)].join("");
  CHART_CONTAINERS.forEach((selector, i) => {
    const old = kept[i];
    if (old) sections.querySelector(selector)?.replaceWith(old);
  });
  updateCharts(root, sections, data, status);
  if (focusedOpener) {
    const candidates = [...sections.querySelectorAll<HTMLElement>("[data-open]")].filter((el) => el.dataset.open === focusedOpener);
    (candidates.find((el) => el.getAttribute("aria-label") === focusedLabel) ?? candidates[0])?.focus();
  }
}
