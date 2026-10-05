export interface Stats {
  latest: number;
  min: number;
  avg: number;
  max: number;
  p99: number;
}

// Latest (last value), Min, Average, Max and p99 of the known values, or null
// when there are none. p99 is the nearest-rank value at 0.99 * (n - 1).
export function computeStats(values: readonly (number | null | undefined)[]): Stats | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (known.length === 0) return null;
  const sorted = [...known].sort((a, b) => a - b);
  return {
    latest: known[known.length - 1],
    min: sorted[0],
    avg: known.reduce((a, b) => a + b, 0) / known.length,
    max: sorted[sorted.length - 1],
    p99: sorted[Math.floor(0.99 * (sorted.length - 1))],
  };
}

export interface CsvSeries {
  label: string;
  points: readonly { t: number; v: number | null }[];
}

function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

// time,"Series A","Series B" then one row per time (ISO, ascending); empty
// cells where a series has no value at that time.
export function csvText(series: readonly CsvSeries[]): string {
  const byTime = new Map<number, (number | null)[]>();
  series.forEach((s, i) => {
    for (const p of s.points) {
      if (!byTime.has(p.t)) byTime.set(p.t, new Array(series.length).fill(null));
      byTime.get(p.t)![i] = p.v;
    }
  });
  const head = ["time", ...series.map((s) => quote(s.label))].join(",");
  const rows = [...byTime.keys()]
    .sort((a, b) => a - b)
    .map((t) => [new Date(t).toISOString(), ...byTime.get(t)!.map((v) => (v === null ? "" : String(v)))].join(","));
  return [head, ...rows].join("\n");
}

export interface RunRow {
  t: number;
  // True for a failed or missed run.
  failed: boolean;
  durationSec: number | null;
  // success, failed or missed; without it failed decides.
  result?: "success" | "failed" | "missed";
}

export function runResult(r: RunRow): "success" | "failed" | "missed" {
  return r.result ?? (r.failed ? "failed" : "success");
}

export function runsCsvText(rows: readonly RunRow[]): string {
  const lines = rows.map((r) => `${new Date(r.t).toISOString()},${runResult(r)},${r.durationSec ?? ""}`);
  return ["time,result,duration_s", ...lines].join("\n");
}
