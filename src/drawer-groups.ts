import { BYTE_AXIS_MIN, fmt, shortBucket, type Formatter } from "./fmt";
import { addSeries, latestValue, recentSeries } from "./recent";
import { PROJECT_ID, RECENT_KEYS, SERVICES } from "./services";
import type { HistoryRange, MetricsResponse, ServiceInfo } from "./types";

// What each opener (data-open value) shows in the drawer. Port of groupFor in
// the design reference, using only allowlisted (service or aggregate, metric)
// pairs; each series is one /api/history call, at most 5 per group.

export const LINE_RANGES: readonly HistoryRange[] = ["1h", "6h", "24h", "7d", "30d", "6w"];
export const JOB_RANGES: readonly HistoryRange[] = ["7d", "30d", "6w"];

// Light palette (src/styles.css), by CSS variable.
export const COLORS: Readonly<Record<string, string>> = {
  "--straw": "#B07A12",
  "--paddy": "#3E7B4F",
  "--canal": "#2D6A8E",
  "--ember": "#B8442F",
  "--ink-2": "#55604E",
};

export const BUCKET_COLORS = ["--straw", "--canal", "--paddy", "--ember"];
export const SITE_COLORS = ["--straw", "--canal", "--paddy", "--ember"];

export interface SeriesSpec {
  service: string;
  metric: string;
  label: string;
  color: string;
  axis: "y" | "y1";
  format: Formatter;
  hidden?: boolean;
  fill?: boolean;
  stepped?: boolean;
}

export interface AxisSpec {
  title: string;
  format: Formatter;
  max?: number;
  // Byte axes span at least BYTE_AXIS_MIN.
  suggestedMax?: number;
  // A level (e.g. bytes stored) does not start at zero.
  level?: boolean;
}

export interface DrawerGroup {
  opener: string;
  // Id used in /history/<id> deep links.
  target: string;
  type: "line" | "runs";
  title: string;
  sub: string;
  ranges: readonly HistoryRange[];
  defaultRange: HistoryRange;
  axes: { y: AxisSpec; y1?: AxisSpec };
  series: SeriesSpec[];
}

const byKind = (kind: ServiceInfo["kind"]) => SERVICES.filter((s) => s.kind === kind);
const serviceById = (id: string) => SERVICES.find((s) => s.id === id);

function line(group: Omit<DrawerGroup, "type" | "ranges" | "defaultRange">): DrawerGroup {
  return { ...group, type: "line", ranges: LINE_RANGES, defaultRange: "24h" };
}

function functionGroup(service: ServiceInfo, opener: string): DrawerGroup {
  const gen1 = service.kind === "function1";
  const series: SeriesSpec[] = gen1
    ? [
        { service: service.id, metric: "execPerMin", label: "Executions/min", color: "--straw", axis: "y", fill: true, format: fmt.int },
        { service: service.id, metric: "memBytes", label: "Memory (p99)", color: "--paddy", axis: "y1", hidden: true, format: fmt.bytes },
      ]
    : [
        { service: service.id, metric: "reqPerMin", label: "Requests/min", color: "--straw", axis: "y", fill: true, format: fmt.int },
        { service: service.id, metric: "errPerMin", label: "Errors/min", color: "--ember", axis: "y", format: fmt.int },
        { service: service.id, metric: "instances", label: "Instances", color: "--ink-2", axis: "y", stepped: true, hidden: true, format: fmt.int },
        { service: service.id, metric: "cpuPct", label: "CPU % (p99)", color: "--canal", axis: "y1", hidden: true, format: fmt.pct },
        { service: service.id, metric: "memPct", label: "RAM % (p99)", color: "--paddy", axis: "y1", hidden: true, format: fmt.pct },
      ];
  return line({
    opener,
    target: service.id,
    title: service.name,
    sub: gen1
      ? "1st gen Cloud Function. Executions per minute; memory is in the legend."
      : "2nd gen Cloud Function. Instances, CPU and RAM are in the legend.",
    axes: gen1
      ? { y: { title: "per minute", format: fmt.int }, y1: { title: "memory", format: fmt.bytes, suggestedMax: BYTE_AXIS_MIN } }
      : { y: { title: "per minute", format: fmt.int }, y1: { title: "percent", format: fmt.pct, max: 100 } },
    series,
  });
}

function sitesGroup(opener: string, siteId: string | null): DrawerGroup {
  const sites = byKind("hosting");
  const chosen = siteId ? sites.filter((s) => s.id === siteId) : sites;
  const series: SeriesSpec[] = chosen.map((s) => ({
    service: s.id,
    metric: "bytesServed",
    label: s.name,
    color: SITE_COLORS[sites.indexOf(s) % SITE_COLORS.length],
    axis: "y",
    fill: chosen.length === 1,
    format: fmt.bytes,
  }));
  if (!siteId) {
    series.unshift({ service: "total:hosting", metric: "bytesServed", label: "All sites", color: "--ink-2", axis: "y", format: fmt.bytes });
  }
  const site = chosen[0];
  return line({
    opener,
    target: siteId ?? "total:hosting",
    title: siteId && site ? `Hosting: ${site.name}` : "Firebase Hosting",
    sub: "Bytes served per minute (per bucket on ranges over 6 hours)",
    axes: { y: { title: "bytes", format: fmt.bytes, suggestedMax: BYTE_AXIS_MIN } },
    series,
  });
}

// The drawer group for an opener such as "fs", "sum:requests", "fn:<id>",
// "st:<id>", "site:<id>", "host" or "job:<id>", or null for anything else.
export function groupFor(opener: string): DrawerGroup | null {
  if (opener === "fs") {
    const id = "firestore:yard";
    return line({
      opener,
      target: id,
      title: "Firestore: yard",
      sub: "Document reads, writes and deletes per minute",
      axes: { y: { title: "reads/min", format: fmt.rate }, y1: { title: "writes, deletes", format: fmt.rate } },
      series: [
        { service: id, metric: "readsPerMin", label: "Reads/min", color: "--straw", axis: "y", fill: true, format: fmt.rate },
        { service: id, metric: "writesPerMin", label: "Writes/min", color: "--paddy", axis: "y1", format: fmt.rate },
        { service: id, metric: "deletesPerMin", label: "Deletes/min", color: "--ember", axis: "y1", format: fmt.rate },
      ],
    });
  }
  if (opener === "sum:requests" || opener === "sum:errors") {
    return line({
      opener,
      target: "total:function2",
      title: "All functions",
      sub: "Requests and errors per minute, summed across the 2nd gen functions",
      axes: { y: { title: "per minute", format: fmt.int } },
      series: [
        { service: "total:function2", metric: "reqPerMin", label: "Requests/min", color: "--straw", axis: "y", fill: true, hidden: opener === "sum:errors", format: fmt.int },
        { service: "total:function2", metric: "errPerMin", label: "Errors/min", color: "--ember", axis: "y", format: fmt.int },
        { service: "total:function2", metric: "instances", label: "Instances", color: "--ink-2", axis: "y", stepped: true, hidden: true, format: fmt.int },
      ],
    });
  }
  if (opener === "sum:bytes") {
    const buckets = byKind("bucket");
    return line({
      opener,
      target: "total:bucket",
      title: "Storage, all buckets",
      sub: "Bytes stored over time",
      axes: { y: { title: "stored", format: fmt.bytes, level: true, suggestedMax: BYTE_AXIS_MIN } },
      series: [
        { service: "total:bucket", metric: "bytesStored", label: "All buckets", color: "--ink-2", axis: "y", format: fmt.bytes },
        ...buckets.map((b, i) => ({
          service: b.id,
          metric: "bytesStored",
          label: shortBucket(b.name, PROJECT_ID),
          color: BUCKET_COLORS[i % BUCKET_COLORS.length],
          axis: "y" as const,
          format: fmt.bytes,
        })),
      ],
    });
  }
  if (opener === "host") return sitesGroup(opener, null);

  const sep = opener.indexOf(":");
  if (sep < 0) return null;
  const kind = opener.slice(0, sep);
  const service = serviceById(opener.slice(sep + 1));
  if (!service) return null;
  if (kind === "fn" && (service.kind === "function2" || service.kind === "function1")) return functionGroup(service, opener);
  if (kind === "st" && service.kind === "bucket") {
    const buckets = byKind("bucket");
    return line({
      opener,
      target: service.id,
      title: shortBucket(service.name, PROJECT_ID),
      sub: `Storage bucket ${service.name}`,
      axes: { y: { title: "stored", format: fmt.bytes, level: true, suggestedMax: BYTE_AXIS_MIN }, y1: { title: "requests/min", format: fmt.int } },
      series: [
        { service: service.id, metric: "bytesStored", label: "Bytes stored", color: BUCKET_COLORS[buckets.indexOf(service) % 4], axis: "y", fill: true, format: fmt.bytes },
        { service: service.id, metric: "reqPerMin", label: "Requests/min", color: "--canal", axis: "y1", format: fmt.int },
      ],
    });
  }
  if (kind === "site" && service.kind === "hosting") return sitesGroup(opener, service.id);
  if (kind === "job" && service.kind === "scheduler") {
    return {
      opener,
      target: service.id,
      type: "runs",
      title: service.name,
      sub: "Cloud Scheduler job. One run per scheduled time, from the function's requests in the 30 minutes after it.",
      ranges: JOB_RANGES,
      defaultRange: "30d",
      axes: { y: { title: "seconds", format: fmt.seconds } },
      series: [
        { service: service.id, metric: "runs", label: "Runs", color: "--paddy", axis: "y", format: fmt.int },
        { service: service.id, metric: "durationSec", label: "Duration (p99)", color: "--canal", axis: "y", format: fmt.seconds },
      ],
    };
  }
  return null;
}

// Opener for a deep-link id (service id or total:* id), or null.
export function openerForTarget(id: string): string | null {
  if (id === "total:function2") return "sum:requests";
  if (id === "total:bucket") return "sum:bytes";
  if (id === "total:hosting") return "host";
  const service = serviceById(id);
  if (!service) return null;
  switch (service.kind) {
    case "firestore":
      return "fs";
    case "function2":
    case "function1":
      return `fn:${id}`;
    case "bucket":
      return `st:${id}`;
    case "hosting":
      return `site:${id}`;
    case "scheduler":
      return `job:${id}`;
  }
}

function sumLatest(data: MetricsResponse, kind: ServiceInfo["kind"], key: string): number | null {
  return latestValue(addSeries(data.services.filter((s) => s.kind === kind).map((s) => recentSeries(s, key))));
}

// The value of (service or aggregate, metric) in a metrics response, for
// appending live points to short ranges; null when it has none.
export function liveValue(data: MetricsResponse, service: string, metric: string): number | null {
  if (service === "total:function2") {
    if (metric === "instances") return numberOr(data.totals.function2?.instances);
    return sumLatest(data, "function2", metric);
  }
  if (service === "total:bucket") return numberOr(data.totals.bucket?.[metric]);
  if (service === "total:hosting") return sumLatest(data, "hosting", metric);
  const s = data.services.find((v) => v.id === service);
  if (!s) return null;
  if (RECENT_KEYS[s.kind].includes(metric)) return latestValue(recentSeries(s, metric));
  return numberOr(s.metrics[metric]);
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
