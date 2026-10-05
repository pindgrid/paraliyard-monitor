import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDashboard } from "../src/dashboard";
import { bindOpeners, createDrawer, type Drawer } from "../src/drawer";
import type { DrawerChartSpec } from "../src/drawer-chart";
import { createMockHistorySource, type HistorySource } from "../src/history-source";
import { createMockSource } from "../src/source";
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
    // Instances, CPU and RAM start hidden.
    expect(rowState()).toEqual([false, false, true, true, true]);
    expect(charts[0].spec.datasets.map((d) => Boolean(d.hidden))).toEqual([false, false, true, true, true]);
    const toggle = charts[0].spec.onLegendToggle!;
    toggle(1, false);
    expect(rowState()).toEqual([false, true, true, true, true]);
    expect(aside().querySelector('.dstats tbody tr[data-row="1"]')?.getAttribute("data-hidden")).toBe("true");
    toggle(3, true);
    expect(rowState()).toEqual([false, true, true, false, true]);
    // A legend toggle never loads anything.
    expect(loads).toHaveLength(5);
    // Values come from the loaded points.
    const cpuRow = aside().querySelectorAll(".dstats tbody tr")[3];
    expect(cpuRow.querySelectorAll("td")[1].textContent).toMatch(/^\d+%$/);
  });

  it("an older deep link's metric starts visible", async () => {
    drawer.open("fn:function2:pyMintOnCrewClaim", { metric: "cpuPct" });
    await drawer.settled();
    expect(charts[0].spec.datasets.map((d) => Boolean(d.hidden))).toEqual([false, false, true, false, true]);
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
    // 24h at 5-minute alignment.
    expect(lines.length - 1).toBe(288);
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
});
