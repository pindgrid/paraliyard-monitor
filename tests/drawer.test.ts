import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDashboard } from "../src/dashboard";
import { bindOpeners, createDrawer, type Drawer } from "../src/drawer";
import type { DrawerChartSpec, XYPoint } from "../src/drawer-chart";
import { liveValue } from "../src/drawer-groups";
import { fmt, istDay } from "../src/fmt";
import { createMockHistorySource, type HistorySource } from "../src/history-source";
import { panelData } from "../src/panel-config";
import { createMockSource } from "../src/source";
import { computeStats } from "../src/stats";
import type { HistoryRange, HistoryResponse, MetricsResponse } from "../src/types";

const NOW = Date.UTC(2026, 9, 5, 8, 30, 0);

interface Load {
  service: string;
  metric: string;
  range: HistoryRange;
}

let root: HTMLElement;
let data: MetricsResponse;
let drawer: Drawer;
let loads: Load[];
let charts: { spec: DrawerChartSpec; visible: [number, boolean][]; setData: number[]; destroyed: boolean }[];
let onRange: ReturnType<typeof vi.fn>;
let unbind: () => void;

function recordingSource(): HistorySource {
  const mock = createMockHistorySource(() => NOW);
  return {
    load(service, metric, range) {
      loads.push({ service, metric, range });
      return mock.load(service, metric, range);
    },
  };
}

beforeEach(async () => {
  vi.setSystemTime(NOW);
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
  data = await createMockSource(() => NOW).load();
  renderDashboard(root, data, { state: "live", mock: true, refreshSeconds: 60, paused: false, nowMs: NOW });
  loads = [];
  charts = [];
  onRange = vi.fn();
  drawer = createDrawer({
    doc: document,
    host: document.body,
    source: recordingSource(),
    now: () => NOW,
    onClose: () => drawer.close(),
    onRange,
    createChart: (_canvas, spec) => {
      const entry = { spec, visible: [] as [number, boolean][], setData: [] as number[], destroyed: false };
      charts.push(entry);
      return {
        setVisible: (i, v) => entry.visible.push([i, v]),
        setData: (i) => entry.setData.push(i),
        destroy: () => {
          entry.destroyed = true;
        },
      };
    },
  });
  unbind = bindOpeners(root, (opener) => drawer.open(opener));
});

afterEach(() => {
  unbind();
  drawer.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const aside = () => document.querySelector<HTMLElement>("aside.drawer")!;
const scrim = () => document.querySelector<HTMLElement>(".scrim")!;
const titleText = () => document.getElementById("dTitle")?.textContent;
const key = (target: EventTarget, k: string, shiftKey = false) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));

const OPENERS: [string, string, string][] = [
  ["hero", '.hero [data-open="fs"].plain', "Firestore: yard"],
  ["hero chart", '.hero-chart[data-open="fs"]', "Firestore: yard"],
  ["health: running", '[data-stat="running"]', "All functions"],
  ["health: errors", '[data-stat="errors"]', "All functions"],
  ["health: stored", '[data-stat="stored"]', "Storage, all buckets"],
  ["health: hosting", '[data-stat="hosting"]', "Firebase Hosting"],
  ["health: next job", '[data-stat="next"]', "pyNightlyExport"],
  ["function row", 'tr[data-open="fn:function2:pyMintOnCrewClaim"]', "pyMintOnCrewClaim"],
  ["1st gen row", 'tr[data-open="fn:function1:pyCleanupOnAuthDelete"]', "pyCleanupOnAuthDelete"],
  ["footer row", 'tfoot tr[data-open="sum:requests"]', "All functions"],
  ["bucket row", '[data-open="st:bucket:mineral-proton-438104-g8-yard-backups"]', "yard-backups"],
  ["hosting chart", '.host-chart[data-open="host"]', "Firebase Hosting"],
  ["site row", '[data-open="site:hosting:paraliyard"]', "Hosting: paraliyard"],
  ["job row", '.job[data-open="job:scheduler:pyWeeklyAccounts"]', "pyWeeklyAccounts"],
];

describe("opening", () => {
  it("opens from every opener kind by click and by Enter", async () => {
    for (const [name, selector, title] of OPENERS) {
      const el = root.querySelector<HTMLElement>(selector);
      expect(el, name).not.toBeNull();
      el!.click();
      expect(drawer.isOpen(), `${name} click`).toBe(true);
      expect(titleText(), name).toBe(title);
      await drawer.settled();
      drawer.close();

      el!.focus();
      key(el!, "Enter");
      expect(drawer.isOpen(), `${name} Enter`).toBe(true);
      expect(titleText(), name).toBe(title);
      await drawer.settled();
      drawer.close();
    }
  });

  it("Space opens too, and each open makes one call per series, at most 5", async () => {
    const row = root.querySelector<HTMLElement>('tr[data-open="fn:function2:pyMintOnCrewClaim"]')!;
    row.focus();
    key(row, " ");
    await drawer.settled();
    expect(loads.map((l) => l.metric)).toEqual(["reqPerMin", "errPerMin", "instances", "cpuPct", "memPct"]);
    expect(loads.every((l) => l.range === "24h" && l.service === "function2:pyMintOnCrewClaim")).toBe(true);
  });

  it("is a modal dialog with a scrim", async () => {
    expect(aside().getAttribute("role")).toBe("dialog");
    expect(aside().getAttribute("aria-modal")).toBe("true");
    expect(aside().getAttribute("aria-hidden")).toBe("true");
    root.querySelector<HTMLElement>('.hero-chart[data-open="fs"]')!.click();
    expect(aside().classList.contains("open")).toBe(true);
    expect(aside().getAttribute("aria-hidden")).toBe("false");
    expect(scrim().classList.contains("show")).toBe(true);
    await drawer.settled();
  });
});

describe("closing and focus", () => {
  async function openFromRow() {
    const row = root.querySelector<HTMLElement>('tr[data-open="fn:function2:pyMintOnCrewClaim"]')!;
    row.focus();
    key(row, "Enter");
    await drawer.settled();
    // Focus moves into the drawer, onto Close.
    expect(document.activeElement?.getAttribute("data-d")).toBe("close");
    expect(aside().contains(document.activeElement)).toBe(true);
    return row;
  }

  it("the Close button closes and restores focus", async () => {
    const row = await openFromRow();
    aside().querySelector<HTMLElement>('[data-d="close"]')!.click();
    expect(drawer.isOpen()).toBe(false);
    expect(aside().getAttribute("aria-hidden")).toBe("true");
    expect(scrim().classList.contains("show")).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("Escape closes and restores focus", async () => {
    const row = await openFromRow();
    key(document, "Escape");
    expect(drawer.isOpen()).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("a scrim click closes and restores focus", async () => {
    const row = await openFromRow();
    scrim().click();
    expect(drawer.isOpen()).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("restores focus to the same opener after the page was redrawn", async () => {
    await openFromRow();
    renderDashboard(root, data, { state: "live", mock: true, refreshSeconds: 60, paused: false, nowMs: NOW });
    key(document, "Escape");
    expect(document.activeElement?.getAttribute("data-open")).toBe("fn:function2:pyMintOnCrewClaim");
  });

  it("traps Tab inside the drawer", async () => {
    await openFromRow();
    const items = [...aside().querySelectorAll<HTMLElement>("button")];
    const first = items[0];
    const last = items[items.length - 1];
    expect(first.getAttribute("data-d")).toBe("close");
    last.focus();
    key(last, "Tab");
    expect(document.activeElement).toBe(first);
    key(first, "Tab", true);
    expect(document.activeElement).toBe(last);
    // Focus that escapes to the page comes back.
    root.querySelector<HTMLElement>('[data-stat="running"]')!.focus();
    expect(aside().contains(document.activeElement)).toBe(true);
  });
});

describe("legend and stats", () => {
  it("shows Series, Latest, Min, Average, Max and p99, and a Chart.js legend toggle mutes its row", async () => {
    root.querySelector<HTMLElement>('tr[data-open="fn:function2:pyMintOnCrewClaim"]')!.click();
    await drawer.settled();
    const headers = [...aside().querySelectorAll(".dstats thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Series", "Latest", "Min", "Average", "Max", "p99"]);
    const rowState = () => [...aside().querySelectorAll<HTMLElement>(".dstats tbody tr")].map((tr) => tr.classList.contains("muted"));
    // No HTML legend: the chart draws it.
    expect(aside().querySelector(".dlegend")).toBeNull();
    expect(aside().querySelector("[data-series]")).toBeNull();
    // Every series starts visible: each has its own panel.
    expect(rowState()).toEqual([false, false, false, false, false]);
    expect(charts[0].spec.datasets.map((d) => Boolean(d.hidden))).toEqual([false, false, false, false, false]);
    expect(charts[0].spec.panels?.map((p) => p.title)).toEqual(["Requests per minute", "Instances", "CPU and RAM (p99, %)"]);
    const toggle = charts[0].spec.onLegendToggle!;
    toggle(1, false);
    expect(rowState()).toEqual([false, true, false, false, false]);
    expect(aside().querySelector('.dstats tbody tr[data-row="1"]')?.getAttribute("data-hidden")).toBe("true");
    toggle(3, false);
    expect(rowState()).toEqual([false, true, false, true, false]);
    toggle(1, true);
    expect(rowState()).toEqual([false, false, false, true, false]);
    // A legend toggle never loads anything.
    expect(loads).toHaveLength(5);
    // Values come from the loaded points.
    const cpuRow = aside().querySelectorAll(".dstats tbody tr")[3];
    expect(cpuRow.querySelectorAll("td")[1].textContent).toMatch(/^\d+%$/);
  });

  it("an older deep link's metric starts visible", async () => {
    drawer.open("fn:function2:pyMintOnCrewClaim", { metric: "cpuPct" });
    await drawer.settled();
    expect(charts[0].spec.datasets[3].hidden).toBe(false);
    // All errors starts with requests hidden, unless the link names them.
    drawer.open("sum:errors");
    await drawer.settled();
    expect(charts[1].spec.datasets.map((d) => Boolean(d.hidden))).toEqual([true, false, false]);
    drawer.open("sum:errors", { metric: "reqPerMin" });
    await drawer.settled();
    expect(charts[2].spec.datasets[0].hidden).toBe(false);
  });

  it("stats are computed from the raw points, not the buckets", async () => {
    drawer.open("fs");
    await drawer.settled();
    const mock = createMockHistorySource(() => NOW);
    const metrics = ["readsPerMin", "writesPerMin", "deletesPerMin"];
    const rows = [...aside().querySelectorAll(".dstats tbody tr")];
    for (const [i, metric] of metrics.entries()) {
      const raw = (await mock.load("firestore:yard", metric, "24h")).points.map((p) => p.v);
      const stats = computeStats(raw)!;
      const cells = [...rows[i].querySelectorAll("td")].map((td) => td.textContent);
      expect(cells.slice(1), metric).toEqual([stats.latest, stats.min, stats.avg, stats.max, stats.p99].map((v) => fmt.rate(v)));
    }
    // The chart gets the same raw points and buckets them itself.
    const spec = charts[0].spec;
    expect(spec.datasets[0].data).toHaveLength(288);
    expect(spec.panelContext).toMatchObject({ bucketMs: 15 * 60000, sourceStepMs: 5 * 60000, band: null });
  });
});

describe("bucket note", () => {
  it("explains the range's buckets and source resolution under the chart", async () => {
    drawer.open("fs");
    await drawer.settled();
    const note = () => aside().querySelector('[data-d="note"]')?.textContent;
    expect(aside().querySelector(".dchart + .dnote")).not.toBeNull();
    expect(note()).toBe("Solid bar: average per 15 min. Light bar: busiest 5 min.");
    aside().querySelector<HTMLElement>('[data-range="7d"]')!.click();
    await drawer.settled();
    expect(note()).toBe("Solid bar: average per 2 h. Light bar: busiest hour.");
    drawer.open("st:bucket:mineral-proton-438104-g8-paraliyard", { range: "30d" });
    await drawer.settled();
    expect(note()).toBe("Solid bar: average per 6 h. Light bar: busiest 3 h. Lines show the last value in each 6 h.");
    expect(aside().querySelector('[data-d="foot"]')?.textContent).toContain("Click a legend item to hide or show a series.");
  });

  it("a group whose first point is after the range start gets a 'No data before' band", async () => {
    const first = NOW - 2 * 3600000;
    const source: HistorySource = {
      async load(service, metric, range) {
        const points = Array.from({ length: 24 }, (_, i) => ({ t: new Date(first + i * 300000).toISOString(), v: 1 }));
        return { service, metric, range, unit: "per minute", generatedAt: new Date(NOW).toISOString(), points };
      },
    };
    const specs: DrawerChartSpec[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const own = createDrawer({
      doc: document,
      host,
      source,
      now: () => NOW,
      onClose: () => own.close(),
      createChart: (_canvas, spec) => {
        specs.push(spec);
        return { setVisible() {}, setData() {}, destroy() {} };
      },
    });
    own.open("fs");
    await own.settled();
    expect(specs[0].panelContext!.band).toEqual({ from: NOW - 86400000, to: first, label: `No data before ${istDay(first)}` });
    own.destroy();
  });
});

describe("times", () => {
  it("tooltip titles and the footer read like '5 Oct 2026, 2:35:47 am', with no IST suffix", async () => {
    drawer.open("fs", { range: "1h" });
    await drawer.settled();
    const spec = charts[0].spec;
    // 5 Oct 2026, 2:35:47 am IST.
    expect(spec.formatX(Date.UTC(2026, 9, 4, 21, 5, 47))).toBe("5 Oct 2026, 2:35:47 am");
    // 1h range: ticks are short times. NOW is 2:00 pm IST.
    expect(spec.formatTick?.(NOW)).toBe("2:00 pm");
    const foot = aside().querySelector('[data-d="foot"]')!.textContent ?? "";
    expect(foot).toContain("from 5 Oct 2026, 1:00:00 pm to 5 Oct 2026, 2:00:00 pm");
    expect(foot).not.toContain(" IST");

    drawer.open("job:scheduler:pyNightlyExport");
    await drawer.settled();
    const runs = charts[1].spec;
    expect(runs.labels?.every((l) => /^\d+ \w+ \d{4}, \d{1,2}:\d\d:\d\d [ap]m$/.test(l))).toBe(true);
    expect(aside().textContent).not.toContain(" IST");
  });
});

describe("CSV", () => {
  async function readBlob(blob: Blob): Promise<string> {
    if (typeof blob.text === "function") return blob.text();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
  }

  it("builds the file with a client-side Blob and never fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:test";
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    root.querySelector<HTMLElement>('.hero-chart[data-open="fs"]')!.click();
    await drawer.settled();
    aside().querySelector<HTMLElement>('[data-d="csv"]')!.click();
    expect(create).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(blobs[0].type).toBe("text/csv");
    const lines = (await readBlob(blobs[0])).split("\n");
    expect(lines[0]).toBe('time,"Reads/min","Writes/min","Deletes/min"');
    // 24h at 5-minute alignment: the raw points, not the 15-minute buckets.
    expect(lines.length - 1).toBe(288);
    const raw = await createMockHistorySource(() => NOW).load("firestore:yard", "readsPerMin", "24h");
    expect(lines.length - 1).toBe(raw.points.length);
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z,[\d.]+,[\d.]+,[\d.]+$/);

    drawer.open("job:scheduler:pyNightlyExport");
    await drawer.settled();
    aside().querySelector<HTMLElement>('[data-d="csv"]')!.click();
    const runs = (await readBlob(blobs[1])).split("\n");
    expect(runs[0]).toBe("time,result,duration_s");
    expect(runs.length).toBeGreaterThan(20);
    // A missed run has no duration.
    expect(runs.slice(1).every((l) => /^\S+Z,((success|failed),\d+|missed,)$/.test(l))).toBe(true);
    expect(runs.some((l) => l.includes(",missed,"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ranges", () => {
  it("range buttons refetch every series with the new range", async () => {
    root.querySelector<HTMLElement>('.hero-chart[data-open="fs"]')!.click();
    await drawer.settled();
    const buttons = [...aside().querySelectorAll<HTMLElement>("[data-range]")];
    expect(buttons.map((b) => b.dataset.range)).toEqual(["1h", "6h", "24h", "7d", "30d", "6w"]);
    expect(aside().querySelector('[data-range="24h"]')?.getAttribute("aria-pressed")).toBe("true");
    loads = [];
    aside().querySelector<HTMLElement>('[data-range="7d"]')!.click();
    await drawer.settled();
    expect(loads).toEqual([
      { service: "firestore:yard", metric: "readsPerMin", range: "7d" },
      { service: "firestore:yard", metric: "writesPerMin", range: "7d" },
      { service: "firestore:yard", metric: "deletesPerMin", range: "7d" },
    ]);
    expect(onRange).toHaveBeenCalledWith("7d");
    expect(aside().querySelector('[data-range="7d"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(drawer.current()?.range).toBe("7d");
    expect(charts[0].destroyed).toBe(true);
    expect(charts[1].spec.to! - charts[1].spec.from!).toBe(7 * 86400000);
  });

  it("jobs offer 7d, 30d and 6w and show a runs table with durations", async () => {
    root.querySelector<HTMLElement>('.job[data-open="job:scheduler:pyNightlyExport"]')!.click();
    await drawer.settled();
    expect([...aside().querySelectorAll<HTMLElement>("[data-range]")].map((b) => b.dataset.range)).toEqual(["7d", "30d", "6w"]);
    expect(loads).toEqual([
      { service: "scheduler:pyNightlyExport", metric: "runs", range: "30d" },
      { service: "scheduler:pyNightlyExport", metric: "durationSec", range: "30d" },
    ]);
    const rows = [...aside().querySelectorAll('[data-table="runs"] tbody tr')];
    expect(rows.length).toBeGreaterThan(20);
    expect(rows[0].querySelector("td")?.textContent).toMatch(/^around \d+ \w+ \d{4}, \d{1,2}:\d\d:\d\d [ap]m$/);
    expect(rows.some((r) => r.textContent?.includes("failed"))).toBe(true);
    // Runs that happened have a duration; a missed run has none.
    for (const r of rows) {
      const duration = r.querySelectorAll("td")[2].textContent ?? "";
      if (r.querySelector('[data-result="missed"]')) expect(duration).toBe("—");
      else expect(duration).toMatch(/^\d+s$/);
    }
    expect(charts[0].spec.kind).toBe("bar");
    loads = [];
    aside().querySelector<HTMLElement>('[data-range="6w"]')!.click();
    await drawer.settled();
    expect(loads.map((l) => l.range)).toEqual(["6w", "6w"]);
    expect(onRange).toHaveBeenCalledWith("6w");
  });
});

describe("job runs are scheduled occurrences", () => {
  // Scheduled 02:30 IST (21:00 UTC the day before).
  const at = (day: number) => Date.UTC(2026, 9, day - 1, 21, 0);
  const iso = (ms: number) => new Date(ms).toISOString();

  // A /api/history-shaped fixture for pyNightlyExport.
  function fixtureSource(): HistorySource {
    return {
      async load(service, metric, range): Promise<HistoryResponse> {
        const base = { service, metric, range, generatedAt: iso(NOW) };
        if (metric === "runs") {
          return {
            ...base,
            unit: "runs",
            points: [
              { t: iso(at(1)), v: 1, result: "success", requests: 1, failed: 0 },
              { t: iso(at(2)), v: 2, result: "failed", requests: 2, failed: 1 },
              { t: iso(at(3)), v: 0, result: "missed", requests: 0, failed: 0 },
              { t: iso(at(4)), v: 1, result: "success", requests: 1, failed: 0 },
              { t: iso(at(6)), v: 0, result: "upcoming", requests: 0, failed: 0 },
            ],
            otherCalls: { count: 6, failed: 4 },
          };
        }
        // Two 5-minute buckets in the 1 Oct window (the max counts), one in
        // the 2 Oct window, one outside every window.
        return {
          ...base,
          unit: "seconds",
          points: [
            { t: iso(at(1) + 300000), v: 40 },
            { t: iso(at(1) + 600000), v: 55 },
            { t: iso(at(2) + 300000), v: 61 },
            { t: iso(at(2) + 6 * 3600000), v: 999 },
          ],
        };
      },
    };
  }

  function openFixture() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return "blob:test";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const own = createDrawer({ doc: document, host, source: fixtureSource(), now: () => NOW, onClose: () => own.close(), createChart: () => ({ setVisible() {}, setData() {}, destroy() {} }) });
    own.open("job:scheduler:pyNightlyExport");
    return { own, host, blobs };
  }

  it("lists only closed occurrences with success, failed and missed badges", async () => {
    const { own, host } = openFixture();
    await own.settled();
    const rows = [...host.querySelectorAll('[data-table="runs"] tbody tr')];
    // Newest first; the upcoming occurrence is left out.
    expect(rows.map((r) => r.querySelector(".badge")?.textContent)).toEqual(["success", "missed", "failed", "success"]);
    expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual([
      "around 4 Oct 2026, 2:30:00 am",
      "around 3 Oct 2026, 2:30:00 am",
      "around 2 Oct 2026, 2:30:00 am",
      "around 1 Oct 2026, 2:30:00 am",
    ]);
    const missed = rows[1].querySelector(".badge")!;
    expect(missed.getAttribute("data-result")).toBe("missed");
    expect(missed.classList.contains("fail")).toBe(true);
    // Duration: the max over buckets overlapping the run window; none when missed.
    expect(rows.map((r) => r.querySelectorAll("td")[2].textContent)).toEqual(["—", "—", "61s", "55s"]);
    own.destroy();
  });

  it("shows other calls with their failures, apart from Runs and the success rate", async () => {
    const { own, host } = openFixture();
    await own.settled();
    const heads = [...host.querySelectorAll('[data-table="summary"] thead th')].map((th) => th.textContent);
    const cells = [...host.querySelectorAll('[data-table="summary"] tbody td')].map((td) => td.textContent);
    const cell = (name: string) => cells[heads.indexOf(name)];
    expect(heads).toContain("Other calls");
    expect(cell("Other calls")).toBe("6 (4 failed)");
    // 4 closed occurrences, 2 succeeded: the 6 other calls (4 failed) are not counted.
    expect(cell("Runs")).toBe("4");
    expect(cell("Succeeded")).toBe("2");
    expect(cell("Success rate")).toBe("50%");
    own.destroy();
  });

  it("the CSV has a result column with missed runs", async () => {
    const { own, host, blobs } = openFixture();
    await own.settled();
    host.querySelector<HTMLElement>('[data-d="csv"]')!.click();
    const text =
      typeof blobs[0].text === "function"
        ? await blobs[0].text()
        : await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(blobs[0]);
          });
    expect(text.split("\n")).toEqual([
      "time,result,duration_s",
      `${iso(at(1))},success,55`,
      `${iso(at(2))},failed,61`,
      `${iso(at(3))},missed,`,
      `${iso(at(4))},success,`,
    ]);
    own.destroy();
  });

  it("with the mock source, lists only 02:30 IST occurrences, a missed badge and other calls", async () => {
    drawer.open("job:scheduler:pyNightlyExport");
    await drawer.settled();
    const rows = [...aside().querySelectorAll('[data-table="runs"] tbody tr')];
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) expect(r.querySelector("td")?.textContent).toMatch(/, 2:30:00 am$/);
    expect(rows.some((r) => r.querySelector('[data-result="missed"]')?.textContent === "missed")).toBe(true);
    expect(aside().querySelector('[data-cell="other-calls"]')?.textContent).toMatch(/^\d+ \(\d+ failed\)$/);
  });
});

describe("job occurrences before the first run", () => {
  // Scheduled 02:30 IST in September (21:00 UTC the day before).
  const sep = (day: number) => Date.UTC(2026, 8, day - 1, 21, 0);
  const iso = (ms: number) => new Date(ms).toISOString();
  const point = (day: number, result: NonNullable<HistoryResponse["points"][number]["result"]>, requests = 0, failed = 0) => ({
    t: iso(sep(day)),
    v: requests,
    result,
    requests,
    failed,
  });

  function openWith(points: HistoryResponse["points"]) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return "blob:test";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const specs: DrawerChartSpec[] = [];
    const source: HistorySource = {
      async load(service, metric, range): Promise<HistoryResponse> {
        const base = { service, metric, range, generatedAt: iso(NOW) };
        if (metric === "runs") return { ...base, unit: "runs", points, otherCalls: { count: 0, failed: 0 } };
        return { ...base, unit: "seconds", points: [{ t: iso(sep(18) + 300000), v: 42 }] };
      },
    };
    const own = createDrawer({
      doc: document,
      host,
      source,
      now: () => NOW,
      onClose: () => own.close(),
      createChart: (_canvas, spec) => {
        specs.push(spec);
        return { setVisible() {}, setData() {}, destroy() {} };
      },
    });
    own.open("job:scheduler:pyNightlyExport");
    return { own, host, blobs, specs };
  }

  const readText = (blob: Blob) =>
    typeof blob.text === "function"
      ? blob.text()
      : new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(blob);
        });

  it("leaves leading before-first-run occurrences out of the bars, table, summary and CSV, with a note", async () => {
    const { own, host, blobs, specs } = openWith([
      point(15, "before-first-run"),
      point(16, "before-first-run"),
      point(17, "before-first-run"),
      point(18, "success", 1),
      point(19, "failed", 1, 1),
      point(20, "missed"),
      point(21, "success", 1),
    ]);
    await own.settled();
    // Bars: only the four runs from 18 Sep.
    expect(specs[0].datasets[0].data.map((p) => p.x)).toEqual([sep(18), sep(19), sep(20), sep(21)]);
    expect(specs[0].labels).toHaveLength(4);
    const rows = [...host.querySelectorAll('[data-table="runs"] tbody tr')];
    expect(rows.map((r) => r.querySelector(".badge")?.textContent)).toEqual(["success", "missed", "failed", "success"]);
    expect(host.querySelector('[data-result="before-first-run"]')).toBeNull();
    const heads = [...host.querySelectorAll('[data-table="summary"] thead th')].map((th) => th.textContent);
    const cells = [...host.querySelectorAll('[data-table="summary"] tbody td')].map((td) => td.textContent);
    const cell = (name: string) => cells[heads.indexOf(name)];
    expect(cell("Runs")).toBe("4");
    expect(cell("Succeeded")).toBe("2");
    expect(cell("Success rate")).toBe("50%");
    expect(host.textContent).toContain("No runs recorded before 18 Sep");
    expect(host.querySelector<HTMLElement>('[data-d="msg"]')!.hidden).toBe(true);
    host.querySelector<HTMLElement>('[data-d="csv"]')!.click();
    expect((await readText(blobs[0])).split("\n")).toEqual([
      "time,result,duration_s",
      `${iso(sep(18))},success,42`,
      `${iso(sep(19))},failed,`,
      `${iso(sep(20))},missed,`,
      `${iso(sep(21))},success,`,
    ]);
    own.destroy();
  });

  it("with only before-first-run and upcoming occurrences shows no runs and a — success rate", async () => {
    const { own, host, specs } = openWith([point(15, "before-first-run"), point(16, "before-first-run"), point(17, "upcoming")]);
    await own.settled();
    expect(specs[0].datasets[0].data).toEqual([]);
    expect(host.querySelector('[data-d="msg"]')?.textContent).toBe("No runs recorded in this range.");
    expect(host.textContent).toContain("No runs recorded in this range");
    expect(host.textContent).not.toContain("No runs recorded before");
    const heads = [...host.querySelectorAll('[data-table="summary"] thead th')].map((th) => th.textContent);
    const cells = [...host.querySelectorAll('[data-table="summary"] tbody td')].map((td) => td.textContent);
    expect(cells[heads.indexOf("Runs")]).toBe("0");
    expect(cells[heads.indexOf("Success rate")]).toBe("—");
    expect(host.querySelectorAll('[data-table="runs"] tbody tr')).toHaveLength(0);
    own.destroy();
  });
});

describe("live append", () => {
  it("adds each refresh to ranges of 6h or less only", async () => {
    drawer.open("fs", { range: "1h" });
    await drawer.settled();
    const later = await createMockSource(() => NOW + 60000).load();
    drawer.appendLive(later);
    expect(charts[0].setData).toEqual([0, 1, 2]);
    // The same refresh again adds nothing.
    drawer.appendLive(later);
    expect(charts[0].setData).toEqual([0, 1, 2]);
    expect(loads).toHaveLength(3);

    drawer.open("fs", { range: "24h" });
    await drawer.settled();
    drawer.appendLive(await createMockSource(() => NOW + 120000).load());
    expect(charts[1].setData).toEqual([]);
  });

  it("a live point updates the current (last) bucket without adding buckets", async () => {
    // 2:02 pm: the next refresh (2:03 pm) falls in the same 5-minute bucket.
    const base = NOW + 120000;
    const updates: { index: number; data: XYPoint[]; from?: number; to?: number }[] = [];
    const specs: DrawerChartSpec[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const own = createDrawer({
      doc: document,
      host,
      source: createMockHistorySource(() => base),
      now: () => base,
      onClose: () => own.close(),
      createChart: (_canvas, spec) => {
        specs.push(spec);
        return { setVisible() {}, setData: (index, data, from, to) => updates.push({ index, data: [...data], from, to }), destroy() {} };
      },
    });
    for (const range of ["1h", "6h"] as const) {
      updates.length = 0;
      own.open("fs", { range });
      await own.settled();
      const spec = specs[specs.length - 1];
      const panel = spec.panels![0];
      const win = { from: spec.from!, to: spec.to!, bucketMs: spec.panelContext!.bucketMs, sourceStepMs: spec.panelContext!.sourceStepMs };
      const before = panelData(panel, spec.datasets.map((d) => d.data), win)[0].buckets;
      const later = await createMockSource(() => base + 60000).load();
      own.appendLive(later);
      expect(updates.map((u) => u.index), range).toEqual([0, 1, 2]);
      const raw = spec.datasets.map((d, i) => updates.find((u) => u.index === i)?.data ?? d.data);
      const u = updates[0];
      expect([u.from, u.to], range).toEqual([base + 60000 - (range === "1h" ? 1 : 6) * 3600000, base + 60000]);
      const after = panelData(panel, raw, { ...win, from: u.from!, to: u.to! })[0].buckets;
      expect(after, range).toHaveLength(before.length);
      const live = liveValue(later, "firestore:yard", "readsPerMin")!;
      expect(raw[0][raw[0].length - 1], range).toEqual({ x: base + 60000, y: live });
      // The live point is part of the last bucket.
      const last = after[after.length - 1];
      expect(last.start, range).toBeLessThan(base + 60000);
      expect(last.end, range).toBeGreaterThanOrEqual(base + 60000);
      expect(last.peak, range).toBeGreaterThanOrEqual(live);
    }
    own.destroy();
  });
});
