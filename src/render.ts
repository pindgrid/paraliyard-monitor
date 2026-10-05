import { NOT_AVAILABLE, NO_RUN, ageText, formatValue } from "./format";
import { CELL_METRIC, METRIC_LABELS, PRIMARY_METRIC, historyPath, isAllowedPair } from "./routes";
import { AGE_KEYS, COLUMNS, KIND_LABELS, KIND_ORDER, MAX_KEYS } from "./services";
import { sparkline } from "./sparkline";
import type { Kind, MetricRecord, MetricsResponse, ServiceInfo, ServiceMetrics } from "./types";

export type StatusState = "loading" | "ok" | "stale" | "error" | "paused";

export interface Status {
  state: StatusState;
  updatedAt?: string | null;
  mock?: boolean;
}

export const PAUSED_MESSAGE = "Live monitoring is paused";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function timeText(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : "never";
}

export function statusText(status: Status): string {
  const sample = status.mock ? " (sample data)" : "";
  switch (status.state) {
    case "loading":
      return "Loading metrics…";
    case "ok":
      return `Updated ${timeText(status.updatedAt)}${sample}`;
    case "stale":
      return `Showing stale data, last updated ${timeText(status.updatedAt)}${sample}`;
    case "error":
      return `Could not load metrics, retrying. Last updated ${timeText(status.updatedAt)}`;
    case "paused":
      return PAUSED_MESSAGE;
  }
}

interface CellOptions {
  prefix?: string;
  age?: string | null;
  ageAsTitle?: boolean;
}

// The prefix and age only apply to numbers, never to "idle" or "not available".
function valueCell(
  doc: Document,
  key: string,
  value: MetricRecord[string] | undefined,
  { prefix = "", age = null, ageAsTitle = false }: CellOptions = {},
): HTMLElement {
  const text = formatValue(key, value);
  const isMissing = text === NOT_AVAILABLE;
  const isNumber = typeof value === "number" && !isMissing;
  let shown = isNumber ? `${prefix}${text}` : text;
  if (isNumber && age && !ageAsTitle) shown = `${shown} · ${age}`;
  const td = el(doc, "td", shown, isMissing ? "na" : undefined);
  if (isNumber && age && ageAsTitle) td.title = age;
  td.dataset.key = key;
  return td;
}

const NO_RUN_KEYS: ReadonlySet<string> = new Set(["lastRunAt", "lastResult"]);

// Cell for one metric of a record. A scheduler record with lastResult "none"
// shows "no run in 8 days" in both of its cells.
function metricCell(
  doc: Document,
  key: string,
  metrics: MetricRecord | undefined,
  options: CellOptions = {},
): HTMLElement {
  if (NO_RUN_KEYS.has(key) && metrics?.lastResult === "none") {
    const td = el(doc, "td", NO_RUN);
    td.dataset.key = key;
    return td;
  }
  return valueCell(doc, key, metrics?.[key], options);
}

// Moves the cell's content into a link to the history view of an allowlisted
// (service, metric). Text content and data-key stay the same.
function linkToHistory(doc: Document, td: HTMLElement, serviceId: string, metric: string | null): void {
  if (!metric || !isAllowedPair(serviceId, metric)) return;
  const link = el(doc, "a");
  link.setAttribute("href", historyPath(serviceId, metric));
  link.dataset.history = "";
  link.title = `Open ${METRIC_LABELS[metric] ?? metric} history`;
  link.append(...td.childNodes);
  td.appendChild(link);
}

function ageOf(metrics: MetricRecord | undefined, key: string, generatedAt: string | undefined): string | null {
  const atKey = AGE_KEYS[key];
  const at = atKey ? metrics?.[atKey] : undefined;
  return typeof at === "string" ? ageText(generatedAt, at) : null;
}

function renderKind(
  doc: Document,
  kind: Kind,
  services: readonly ServiceInfo[],
  byId: Map<string, ServiceMetrics>,
  totals: MetricRecord | undefined,
  generatedAt: string | undefined,
): HTMLElement {
  const columns = COLUMNS[kind];
  const section = el(doc, "section", undefined, "kind");
  section.dataset.kind = kind;
  section.appendChild(el(doc, "h2", KIND_LABELS[kind]));

  const table = el(doc, "table");
  const headRow = el(doc, "tr");
  headRow.appendChild(el(doc, "th", "Name"));
  for (const column of columns) headRow.appendChild(el(doc, "th", column.label));
  headRow.appendChild(el(doc, "th", "Trend"));
  table.appendChild(el(doc, "thead")).appendChild(headRow);

  const body = el(doc, "tbody");
  for (const service of services.filter((s) => s.kind === kind)) {
    const data = byId.get(service.id);
    const row = el(doc, "tr");
    row.dataset.serviceId = service.id;
    row.appendChild(el(doc, "th", service.name)).setAttribute("scope", "row");
    for (const column of columns) {
      const age = ageOf(data?.metrics, column.key, generatedAt);
      const td = metricCell(doc, column.key, data?.metrics, { age });
      linkToHistory(doc, td, service.id, CELL_METRIC[kind][column.key] ?? null);
      row.appendChild(td);
    }
    const trend = el(doc, "td", undefined, "trend");
    trend.appendChild(sparkline(data?.trend.points ?? [], doc));
    linkToHistory(doc, trend, service.id, PRIMARY_METRIC[kind]);
    row.appendChild(trend);
    body.appendChild(row);
  }
  table.appendChild(body);

  const totalsRow = el(doc, "tr");
  totalsRow.dataset.totals = kind;
  totalsRow.appendChild(el(doc, "th", "Total")).setAttribute("scope", "row");
  for (const column of columns) {
    const prefix = MAX_KEYS.has(column.key) ? "max " : "";
    const age = ageOf(totals, column.key, generatedAt);
    totalsRow.appendChild(metricCell(doc, column.key, totals, { prefix, age, ageAsTitle: true }));
  }
  totalsRow.appendChild(el(doc, "td", "", "trend"));
  table.appendChild(el(doc, "tfoot")).appendChild(totalsRow);

  section.appendChild(table);
  return section;
}

// Rebuilds the dashboard. Uses textContent only, never innerHTML.
export function renderDashboard(
  root: HTMLElement,
  services: readonly ServiceInfo[],
  data: MetricsResponse | null,
  status: Status,
): void {
  const doc = root.ownerDocument;
  const banner = el(doc, "div", statusText(status), `status status-${status.state}`);
  banner.dataset.status = status.state;
  banner.setAttribute("role", "status");

  if (status.state === "paused") {
    root.replaceChildren(banner);
    return;
  }

  const byId = new Map((data?.services ?? []).map((s) => [s.id, s]));
  const sections = KIND_ORDER.map((kind) =>
    renderKind(doc, kind, services, byId, data?.totals[kind], data?.generatedAt),
  );
  root.replaceChildren(banner, ...sections);
}
