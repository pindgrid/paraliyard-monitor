import { daySquares } from "./day-squares";
import { BUCKET_COLORS, SITE_COLORS } from "./drawer-groups";
import { DASH, escapeHtml as esc, fmt, istDateTime, istTime, shortBucket, untilText } from "./fmt";
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
import { REFRESH_OPTIONS } from "./refresh";
import { nextRunAt } from "./schedule";
import { JOB_SCHEDULES, PROJECT_ID } from "./services";
import type { HistoryPoint, MetricsResponse, ServiceInfo, ServiceMetrics } from "./types";

// The page from the design reference: header, notes, Firestore hero, health
// strip, functions table, storage + hosting and scheduler jobs. Every element
// that opens the history drawer carries data-open, tabindex="0" and role="button".

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
}

export const OPENER_ATTRS = 'role="button" tabindex="0"';

function shell(): string {
  const options = REFRESH_OPTIONS.map((o) => `<option value="${o.seconds}">${o.label}</option>`).join("");
  return `
<div class="wrap" data-dashboard>
  <header class="top">
    <div class="brand">
      <h1>Paraliyard monitor</h1>
      <span class="gur" lang="pa">ਪਰਾਲੀ ਯਾਰਡ</span>
      <span class="proj">${PROJECT_ID}</span>
    </div>
    <div class="controls">
      <span class="live" data-live><i></i><span data-live-text>Live</span></span>
      <span>Updated <time data-updated>${DASH}</time></span>
      <label class="refresh">Refresh <select data-action="refresh" aria-label="Refresh every">${options}</select></label>
      <button class="btn" type="button" data-action="pause" aria-pressed="false">Pause</button>
    </div>
  </header>
  <p class="note" data-note hidden></p>
  <p class="note err" data-error role="status" hidden></p>
  <div data-sections></div>
</div>`;
}

const ofKind = (data: MetricsResponse, kinds: readonly ServiceInfo["kind"][]) =>
  data.services.filter((s) => kinds.includes(s.kind));

// ---------- Hero ----------

const W = 600;
const H = 220;

function pathOf(values: Series, max: number): string {
  if (!values || values.length === 0) return "";
  const n = values.length;
  return values
    .map((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * W;
      const y = H - ((typeof v === "number" ? v : 0) / (max || 1)) * (H - 10);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function heroChart(fs: ServiceMetrics | undefined): string {
  const reads = recentSeries(fs, "readsPerMin");
  const writes = recentSeries(fs, "writesPerMin");
  const deletes = recentSeries(fs, "deletesPerMin");
  const readsMax = Math.max(1, peakOf(reads) ?? 0);
  const rightMax = Math.max(4, peakOf(writes) ?? 0, peakOf(deletes) ?? 0);
  const readsPath = pathOf(reads, readsMax);
  const area = readsPath ? `${readsPath} L${W},${H} L0,${H} Z` : "";
  return `
<svg class="spark" viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none" role="img" aria-label="Reads, writes and deletes per minute, last 30 minutes">
  <line class="grid" x1="0" y1="${H}" x2="${W}" y2="${H}"></line>
  <line class="grid" x1="0" y1="10" x2="${W}" y2="10"></line>
  <path class="reads-area" d="${area}"></path>
  <path class="reads" d="${readsPath}"></path>
  <path class="writes" d="${pathOf(writes, rightMax)}"></path>
  <path class="deletes" d="${pathOf(deletes, rightMax)}"></path>
  <text x="2" y="${H + 16}">30 min ago</text>
  <text x="${W - 2}" y="${H + 16}" text-anchor="end">now</text>
  <text x="2" y="22">${fmt.rate(readsMax)} reads/min</text>
  <text x="${W - 2}" y="22" text-anchor="end">${fmt.rate(rightMax)} writes, deletes</text>
</svg>
<div class="legend-inline"><span style="--c:var(--straw)">Reads/min</span><span style="--c:var(--paddy)">Writes/min</span><span style="--c:var(--ember)">Deletes/min</span></div>`;
}

function hero(data: MetricsResponse): string {
  const fs = data.services.find((s) => s.kind === "firestore");
  const reads = recentSeries(fs, "readsPerMin");
  return `
<section class="hero" aria-labelledby="heroTitle" data-section="hero">
  <div>
    <h2 id="heroTitle">Yard database activity</h2>
    <p class="src">Firestore database "${esc(fs?.name ?? "yard")}"</p>
    <div class="plain" data-open="fs" ${OPENER_ATTRS} aria-label="Open read history">
      <span class="bignum" data-hero="reads">${fmt.rate(latestValue(reads))}</span>
      <span class="unit">document reads per minute</span>
    </div>
    <dl class="sub">
      <div><dt>Writes/min</dt><dd data-hero="writes">${fmt.rate(latestValue(recentSeries(fs, "writesPerMin")))}</dd></div>
      <div><dt>Deletes/min</dt><dd data-hero="deletes">${fmt.int(latestValue(recentSeries(fs, "deletesPerMin")))}</dd></div>
      <div><dt>Peak, 30 min</dt><dd data-hero="peak">${fmt.rate(peakOf(reads))}</dd></div>
    </dl>
    <p class="hint">Last 30 minutes, updating live. Click the chart or any row below to see its full history.</p>
  </div>
  <div class="hero-chart" data-open="fs" ${OPENER_ATTRS} aria-label="Open Firestore history">${heroChart(fs)}</div>
</section>`;
}

// ---------- Health strip ----------

// nextRun from the API, else computed from the job's cron.
function jobNextRun(s: ServiceMetrics, nowMs: number): number | null {
  const fromApi = s.nextRun ? Date.parse(s.nextRun) : NaN;
  if (Number.isFinite(fromApi)) return fromApi;
  const job = JOB_SCHEDULES[s.id];
  return job ? nextRunAt(job.cron, nowMs) : null;
}

function strip(data: MetricsResponse, nowMs: number): string {
  const fns = ofKind(data, ["function2", "function1"]);
  const running = fns.filter(isRunningNow).length;
  const reqNow = latestValue(addSeries(fns.map(requestSeries)));
  const errors = sumOf(addSeries(ofKind(data, ["function2"]).map((s) => recentSeries(s, "errPerMin"))));
  const buckets = ofKind(data, ["bucket"]);
  const stored = data.totals.bucket?.bytesStored;
  const sites = ofKind(data, ["hosting"]);
  const served = sumOf(addSeries(sites.map((s) => recentSeries(s, "bytesServed"))));
  const jobs = ofKind(data, ["scheduler"])
    .map((s) => ({ s, at: jobNextRun(s, nowMs) }))
    .filter((j): j is { s: ServiceMetrics; at: number } => j.at !== null)
    .sort((a, b) => a.at - b.at);
  const next = jobs[0];
  const errCount = errors === null ? null : Math.round(errors);
  return `
<section class="strip" aria-label="Health summary" data-section="strip">
  <div class="plain stat" data-open="sum:requests" ${OPENER_ATTRS} data-stat="running">
    <span>Functions running now</span><strong>${running} of ${fns.length}</strong><small>${fmt.int(reqNow)} requests/min now</small>
  </div>
  <div class="plain stat${errCount ? " alert" : ""}" data-open="sum:errors" ${OPENER_ATTRS} data-stat="errors">
    <span>Function errors, 30 min</span><strong>${errCount === null ? DASH : errCount}</strong><small>${errCount ? "Click to see when" : errCount === 0 ? "No errors" : "Not available"}</small>
  </div>
  <div class="plain stat" data-open="sum:bytes" ${OPENER_ATTRS} data-stat="stored">
    <span>Stored in buckets</span><strong>${fmt.bytes(typeof stored === "number" ? stored : null)}</strong><small>${buckets.length} buckets</small>
  </div>
  <div class="plain stat" data-open="host" ${OPENER_ATTRS} data-stat="hosting">
    <span>Hosting served, 30 min</span><strong>${fmt.bytes(served)}</strong><small>${sites.length} sites</small>
  </div>
  <div class="plain stat" data-open="${next ? `job:${esc(next.s.id)}` : "sum:requests"}" ${OPENER_ATTRS} data-stat="next">
    <span>Next scheduled job</span><strong>${next ? `in ${untilText(next.at - nowMs)}` : DASH}</strong><small>${next ? esc(next.s.name) : "No schedule reported"}</small>
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
  return `
<section class="block" aria-labelledby="fnTitle" data-section="functions">
  <div class="block-head">
    <h2 id="fnTitle">Cloud Functions</h2>
    <p>CPU and RAM are p99. Activity strip shows requests per minute for the last 30 minutes; red marks a minute with errors.</p>
  </div>
  <div class="tablewrap">
    <table class="fn">
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

function hostingBars(sites: ServiceMetrics[]): string {
  const series = sites.map((s) => recentSeries(s, "bytesServed"));
  const totals = addSeries(series);
  const max = Math.max(1, peakOf(totals) ?? 0);
  const n = 30;
  const bw = W / n;
  const bars: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let y = H;
    series.forEach((values, k) => {
      const v = values && typeof values[i] === "number" ? (values[i] as number) : 0;
      if (v <= 0) return;
      const h = (v / max) * (H - 10);
      y -= h;
      bars.push(`<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" style="fill:var(${SITE_COLORS[k % SITE_COLORS.length]})"></rect>`);
    });
  }
  return `
<svg class="bars" viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none" role="img" aria-label="Bytes served per minute, last 30 minutes">
  ${bars.join("")}
  <text x="2" y="${H + 16}">30 min ago</text>
  <text x="${W - 2}" y="${H + 16}" text-anchor="end">now</text>
  <text x="2" y="12">${fmt.bytes(max)}/min</text>
</svg>`;
}

function storageAndHosting(data: MetricsResponse): string {
  const buckets = ofKind(data, ["bucket"]);
  const sizes = buckets.map((b) => (typeof b.metrics.bytesStored === "number" ? b.metrics.bytesStored : 0));
  const total = sizes.reduce((a, b) => a + b, 0);
  const stored = data.totals.bucket?.bytesStored;
  const sites = ofKind(data, ["hosting"]);
  return `
<div class="cols" data-section="storage-hosting">
  <section class="block" aria-labelledby="stTitle" data-section="storage">
    <div class="block-head"><h2 id="stTitle">Storage buckets</h2><p>${fmt.bytes(typeof stored === "number" ? stored : null)} total</p></div>
    <div class="share" aria-hidden="true">${buckets
      .map((_, i) => `<i style="background:var(${BUCKET_COLORS[i % 4]});flex-grow:${total ? (sizes[i] / total).toFixed(4) : 0}"></i>`)
      .join("")}</div>
    ${buckets
      .map(
        (b, i) => `
    <div class="plain bucket" data-open="st:${esc(b.id)}" ${OPENER_ATTRS} aria-label="Open history for bucket ${esc(b.name)}">
      <span class="sw" style="background:var(${BUCKET_COLORS[i % 4]})"></span>
      <span class="name">${esc(shortBucket(b.name, PROJECT_ID))}</span>
      <span class="size">${fmt.bytes(typeof b.metrics.bytesStored === "number" ? b.metrics.bytesStored : null)}</span>
      <span class="full">${esc(b.name)}, ${fmt.int(latestValue(recentSeries(b, "reqPerMin")))} requests/min now</span>
    </div>`,
      )
      .join("")}
  </section>
  <section class="block" aria-labelledby="hoTitle" data-section="hosting">
    <div class="block-head"><h2 id="hoTitle">Firebase Hosting</h2><p>Bytes served per minute</p></div>
    <div class="host-chart" data-open="host" ${OPENER_ATTRS} aria-label="Open hosting history">${hostingBars(sites)}</div>
    <div class="sites">${sites
      .map((h, i) => {
        const served = recentSeries(h, "bytesServed");
        return `
      <div class="plain bucket" data-open="site:${esc(h.id)}" ${OPENER_ATTRS} aria-label="Open history for site ${esc(h.name)}">
        <span class="sw" style="background:var(${SITE_COLORS[i % 4]})"></span>
        <span class="name">${esc(h.name)}</span>
        <span class="size">${fmt.bytes(sumOf(served))}</span>
        <span class="full">served in the last 30 minutes, ${fmt.bytes(latestValue(served))}/min now</span>
      </div>`;
      })
      .join("")}</div>
  </section>
</div>`;
}

// ---------- Scheduler jobs ----------

function lastRun(s: ServiceMetrics): string {
  const at = typeof s.metrics.lastRunAt === "string" ? Date.parse(s.metrics.lastRunAt) : NaN;
  const result = s.metrics.lastResult;
  if (!Number.isFinite(at)) {
    return result === "none" ? '<span class="muted">No run in 8 days</span>' : '<span class="muted">Not available</span>';
  }
  const badge =
    result === "success"
      ? '<span class="badge">success</span>'
      : result === "failed"
        ? '<span class="badge fail">failed</span>'
        : '<span class="badge none">unknown</span>';
  return `around ${esc(istDateTime(at))}${badge}`;
}

function jobRow(s: ServiceMetrics, status: DashboardStatus): string {
  const at = jobNextRun(s, status.nowMs);
  const schedule = s.schedule ?? JOB_SCHEDULES[s.id]?.schedule ?? "";
  const squares = daySquares(status.runs?.[s.id] ?? null, status.nowMs)
    .map((d) => `<i class="${d.state === "ok" ? "ok" : d.state === "failed" ? "fail" : ""}" data-day="${d.state}" title="${esc(d.label)}"></i>`)
    .join("");
  return `
<div class="plain job" data-open="job:${esc(s.id)}" data-job-id="${esc(s.id)}" ${OPENER_ATTRS} aria-label="Open run history for ${esc(s.name)}">
  <span><span class="name">${esc(s.name)}</span><span class="meta">${esc(schedule)}</span></span>
  <span><span class="meta">Last run</span><span class="last">${lastRun(s)}</span></span>
  <span><span class="days" aria-label="Last 14 days">${squares}</span><span class="days-axis"><span>14 days ago</span><span>Today</span></span></span>
  <span class="next"><span class="meta">Next run</span><strong>${at === null ? DASH : `in ${untilText(at - status.nowMs)}`}</strong><span class="meta">${at === null ? "" : esc(istDateTime(at))}</span></span>
</div>`;
}

function jobs(data: MetricsResponse, status: DashboardStatus): string {
  return `
<section class="block" aria-labelledby="jobTitle" data-section="jobs">
  <div class="block-head"><h2 id="jobTitle">Cloud Scheduler jobs</h2><p>Each square is one day in IST; green ran successfully, red failed.</p></div>
  ${ofKind(data, ["scheduler"])
    .map((s) => jobRow(s, status))
    .join("")}
</section>`;
}

// ---------- Header and notes ----------

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
  const select = root.querySelector<HTMLSelectElement>('select[data-action="refresh"]')!;
  select.value = String(status.refreshSeconds);
  select.disabled = Boolean(status.off);
  const pause = root.querySelector<HTMLButtonElement>('button[data-action="pause"]')!;
  pause.textContent = status.paused ? "Resume" : "Pause";
  pause.setAttribute("aria-pressed", String(status.paused));
  pause.disabled = Boolean(status.off);

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
}

// Renders (or updates) the page in root. Header controls are built once so
// they keep focus; sections are redrawn and a focused opener keeps focus.
export function renderDashboard(root: HTMLElement, data: MetricsResponse | null, status: DashboardStatus): void {
  if (!root.querySelector("[data-dashboard]")) root.innerHTML = shell();
  updateHeader(root, data, status);
  const sections = root.querySelector<HTMLElement>("[data-sections]")!;
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  const focusedOpener = active && sections.contains(active) ? active.getAttribute("data-open") : null;
  const focusedLabel = active?.getAttribute("aria-label") ?? null;
  if (!data) {
    sections.innerHTML = status.off ? "" : '<p class="hint" data-loading>Loading metrics…</p>';
    return;
  }
  sections.innerHTML = [hero(data), strip(data, status.nowMs), functionsTable(data), storageAndHosting(data), jobs(data, status)].join("");
  if (focusedOpener) {
    const candidates = [...sections.querySelectorAll<HTMLElement>("[data-open]")].filter((el) => el.dataset.open === focusedOpener);
    (candidates.find((el) => el.getAttribute("aria-label") === focusedLabel) ?? candidates[0])?.focus();
  }
}
