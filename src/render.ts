import { NOT_AVAILABLE, formatValue } from "./format";
import { COLUMNS, KIND_LABELS, KIND_ORDER, MAX_KEYS } from "./services";
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

function valueCell(doc: Document, key: string, value: MetricRecord[string] | undefined, prefix = ""): HTMLElement {
  const text = formatValue(key, value);
  const isMissing = text === NOT_AVAILABLE;
  const td = el(doc, "td", isMissing ? text : `${prefix}${text}`, isMissing ? "na" : undefined);
  td.dataset.key = key;
  return td;
}

function renderKind(
  doc: Document,
  kind: Kind,
  services: readonly ServiceInfo[],
  byId: Map<string, ServiceMetrics>,
  totals: MetricRecord | undefined,
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
    for (const column of columns) row.appendChild(valueCell(doc, column.key, data?.metrics[column.key]));
    const trend = el(doc, "td", undefined, "trend");
    trend.appendChild(sparkline(data?.trend.points ?? [], doc));
    row.appendChild(trend);
    body.appendChild(row);
  }
  table.appendChild(body);

  const totalsRow = el(doc, "tr");
  totalsRow.dataset.totals = kind;
  totalsRow.appendChild(el(doc, "th", "Total")).setAttribute("scope", "row");
  for (const column of columns) {
    const prefix = MAX_KEYS.has(column.key) ? "max " : "";
    totalsRow.appendChild(valueCell(doc, column.key, totals?.[column.key], prefix));
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
  const sections = KIND_ORDER.map((kind) => renderKind(doc, kind, services, byId, data?.totals[kind]));
  root.replaceChildren(banner, ...sections);
}
