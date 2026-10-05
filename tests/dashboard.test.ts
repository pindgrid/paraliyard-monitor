import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { destroyDashboard, renderDashboard, type DashboardStatus } from "../src/dashboard";
import { bindOpeners } from "../src/drawer";
import { createPageCharts } from "../src/page-charts";
import { createMockSource } from "../src/source";
import type { HistoryPoint, MetricsResponse, ServiceMetrics } from "../src/types";

// Monday 5 Oct 2026, 14:00:00 IST.
const NOW = Date.UTC(2026, 9, 5, 8, 30, 0);

let root: HTMLElement;
let data: MetricsResponse;

function status(over: Partial<DashboardStatus> = {}): DashboardStatus {
  return { state: "live", mock: true, refreshSeconds: 60, paused: false, nowMs: NOW, ...over };
}

function service(id: string): ServiceMetrics {
  return data.services.find((s) => s.id === id)!;
}

function row(id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`tr[data-service-id="${id}"]`)!;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

beforeEach(async () => {
  vi.mocked(createPageCharts).mockClear();
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
  data = await createMockSource(() => NOW).load();
});

describe("renderDashboard sections (mock fixture)", () => {
  it("renders the header with brand, project, indicator, IST update time and controls", () => {
    renderDashboard(root, data, status());
    const header = root.querySelector("header.top")!;
    expect(text(header.querySelector("h1"))).toBe("Paraliyard monitor");
    expect(text(header.querySelector(".gur"))).toBe("ਪਰਾਲੀ ਯਾਰਡ");
    expect(header.querySelector(".gur")?.getAttribute("lang")).toBe("pa");
    expect(text(header.querySelector(".proj"))).toBe("mineral-proton-438104-g8");
    expect(text(header.querySelector("[data-live]"))).toBe("Live");
    expect(text(header)).toContain("Updated 2:00:00 pm");
    expect(root.querySelector("select")).toBeNull();
    const buttons = [...header.querySelectorAll<HTMLButtonElement>('.seg[role="group"][aria-label="Refresh every"] button[data-refresh]')];
    expect(buttons.map((b) => [b.dataset.refresh, b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["30", "30s", "false"],
      ["60", "60s", "true"],
      ["300", "5m", "false"],
    ]);
    renderDashboard(root, data, status({ refreshSeconds: 300 }));
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(text(header.querySelector('button[data-action="pause"]'))).toBe("Pause");
    // Light palette only: no Theme button.
    expect([...root.querySelectorAll("button")].some((b) => /theme/i.test(b.textContent ?? ""))).toBe(false);
    expect(root.querySelector("#themeBtn")).toBeNull();
  });

  it("shows Live, Paused and Offline with the retry interval", () => {
    renderDashboard(root, data, status({ state: "paused", paused: true }));
    expect(text(root.querySelector("[data-live]"))).toBe("Paused");
    expect(root.querySelector("[data-live]")?.className).toBe("live paused");
    expect(text(root.querySelector('button[data-action="pause"]'))).toBe("Resume");
    renderDashboard(root, data, status({ state: "offline", mock: false, retrySeconds: 120 }));
    expect(text(root.querySelector("[data-live]"))).toBe("Offline");
    expect(root.querySelector("[data-live]")?.className).toBe("live down");
    const err = root.querySelector<HTMLElement>(".note.err")!;
    expect(err.hidden).toBe(false);
    expect(text(err)).toContain("Retrying in 120 seconds");
    renderDashboard(root, data, status());
    expect(root.querySelector<HTMLElement>(".note.err")?.hidden).toBe(true);
  });

  it("shows the mock note", () => {
    renderDashboard(root, data, status());
    const note = root.querySelector<HTMLElement>("[data-note]")!;
    expect(note.hidden).toBe(false);
    expect(text(note)).toContain("Showing sample data (mock mode)");
    renderDashboard(root, data, status({ mock: false }));
    expect(root.querySelector<HTMLElement>("[data-note]")?.hidden).toBe(true);
  });

  it("renders the Firestore hero from the newest minute and the 30-minute peak", () => {
    renderDashboard(root, data, status());
    const hero = root.querySelector('[data-section="hero"]')!;
    const reads = service("firestore:yard").recent!.series.readsPerMin!;
    expect(text(hero.querySelector('[data-hero="reads"]'))).toBe((reads[29] as number).toFixed(2));
    expect(text(hero.querySelector('[data-hero="peak"]'))).toBe(Math.max(...(reads as number[])).toFixed(2));
    // The "reads/min" axis title is drawn by Chart.js (tests/page-chart-config.test.ts).
    for (const label of ["document reads per minute", "Writes/min", "Deletes/min", "Peak, 30 min"]) {
      expect(text(hero)).toContain(label);
    }
    expect(hero.querySelector(".hero-chart canvas")).not.toBeNull();
    expect(hero.querySelector("svg")).toBeNull();
  });

  it("renders the 5-stat health strip", () => {
    renderDashboard(root, data, status());
    const stats = [...root.querySelectorAll<HTMLElement>('[data-section="strip"] .stat')];
    expect(stats.map((s) => text(s.querySelector("span")))).toEqual([
      "Functions running now",
      "Function errors, 30 min",
      "Stored in buckets",
      "Hosting served, 30 min",
      "Next scheduled job",
    ]);
    expect(text(stats[0].querySelector("strong"))).toMatch(/^\d+ of 10$/);
    // The mock always has one error minute in the window.
    expect(text(stats[1].querySelector("strong"))).toBe("1");
    expect(stats[1].classList.contains("alert")).toBe(true);
    expect(text(stats[2].querySelector("strong"))).toBe("53.7 MB");
    expect(text(stats[2].querySelector("small"))).toBe("2 buckets");
    expect(text(stats[3].querySelector("small"))).toBe("2 sites");
    // 14:00 IST Monday: the nightly job runs next at 02:30 IST.
    expect(text(stats[4].querySelector("strong"))).toBe("in 12h 30m");
    expect(text(stats[4].querySelector("small"))).toBe("pyNightlyExport");
    expect(stats[4].dataset.open).toBe("job:scheduler:pyNightlyExport");
  });

  it("renders the functions table with 10 rows and an All functions footer", () => {
    renderDashboard(root, data, status());
    const rows = root.querySelectorAll('[data-section="functions"] tbody tr');
    expect(rows).toHaveLength(10);
    const footer = root.querySelector('[data-section="functions"] tfoot tr')!;
    expect(text(footer.querySelector("th"))).toBe("All functions");
    expect(footer.getAttribute("data-open")).toBe("sum:requests");
    expect(footer.querySelectorAll(".heat i")).toHaveLength(30);
    expect(text(footer.querySelector(".inst"))).toBe("7");
    expect(text(row("function1:pyCleanupOnAuthDelete").querySelector(".gen"))).toBe("1st gen");
    expect(text(row("function2:pyMintOnCrewClaim").querySelector(".gen"))).toBe("2nd gen");
  });

  it("renders storage, hosting and the two scheduler jobs", () => {
    renderDashboard(root, data, status());
    const storage = root.querySelector('[data-section="storage"]')!;
    expect(text(storage.querySelector("h2"))).toBe("Storage buckets");
    expect(text(storage.querySelector(".block-head p"))).toBe("53.7 MB total");
    expect([...storage.querySelectorAll(".bucket .name")].map(text)).toEqual(["paraliyard", "yard-backups"]);
    const hosting = root.querySelector('[data-section="hosting"]')!;
    expect(text(hosting.querySelector("h2"))).toBe("Firebase Hosting");
    expect(hosting.querySelector(".host-chart canvas")).not.toBeNull();
    expect(hosting.querySelector("svg")).toBeNull();
    expect([...hosting.querySelectorAll(".sites .name")].map(text)).toEqual(["paraliyard", "preparaliyard"]);
    const jobs = [...root.querySelectorAll<HTMLElement>('[data-section="jobs"] .job')];
    expect(jobs.map((j) => text(j.querySelector(".name")))).toEqual(["pyNightlyExport", "pyWeeklyAccounts"]);
    expect(text(jobs[0])).toContain("Every day, 2:30 am");
    expect(text(jobs[1])).toContain("Sundays, 3:00 am");
    expect(text(jobs[0].querySelector(".next strong"))).toBe("in 12h 30m");
    // Sunday 11 Oct 03:00 IST.
    expect(text(jobs[1].querySelector(".next strong"))).toBe("in 5d 13h");
    expect(text(jobs[0].querySelector(".last"))).toContain("success");
    for (const job of jobs) expect(job.querySelectorAll(".days i")).toHaveLength(14);
  });

  it("gives every opener data-open, tabindex 0 and role button", () => {
    renderDashboard(root, data, status());
    const openers = [...root.querySelectorAll<HTMLElement>("[data-open]")];
    const kinds = new Set(openers.map((el) => el.dataset.open!.split(":")[0]));
    expect([...kinds].sort()).toEqual(["fn", "fs", "host", "job", "site", "st", "sum"]);
    for (const el of openers) {
      expect(el.getAttribute("tabindex"), el.dataset.open).toBe("0");
      expect(el.getAttribute("role"), el.dataset.open).toBe("button");
    }
  });
});

describe("meters and activity strip", () => {
  it("idle for an idle 2nd gen function, n/a for 1st gen CPU and Instances, % width otherwise", () => {
    renderDashboard(root, data, status());
    const idle = row("function2:pyWeeklyAccounts");
    expect(idle.querySelector('[data-meter="cpu"]')?.getAttribute("data-state")).toBe("idle");
    expect(text(idle.querySelector(".v-cpu"))).toBe("idle");
    expect(text(idle.querySelector(".v-ram"))).toBe("idle");
    expect(idle.querySelector<HTMLElement>('[data-meter="cpu"] b')?.style.width).toBe("0%");

    const gen1 = row("function1:pyCleanupOnAuthDelete");
    expect(gen1.querySelector('[data-meter="cpu"]')?.getAttribute("data-state")).toBe("na");
    expect(text(gen1.querySelector(".v-cpu"))).toBe("n/a");
    expect(text(gen1.querySelector(".inst"))).toBe("n/a");
    expect(text(gen1.querySelector(".err"))).toBe("n/a");

    // pyMintOnCrewClaim has 2 instances, so it is running.
    const busy = row("function2:pyMintOnCrewClaim");
    expect(busy.querySelector('[data-meter="cpu"]')?.getAttribute("data-state")).toBe("value");
    expect(busy.querySelector<HTMLElement>('[data-meter="cpu"] b')?.style.width).toBe("21.4%");
    expect(text(busy.querySelector(".v-cpu"))).toBe("21%");
    expect(busy.querySelector<HTMLElement>('[data-meter="ram"] b')?.style.width).toBe("38.9%");
  });

  it("colours cells from the per-minute series", () => {
    const mint = service("function2:pyMintOnCrewClaim");
    const req = new Array<number>(30).fill(0);
    const err = new Array<number>(30).fill(0);
    req[0] = 1;
    req[1] = 5;
    req[2] = 3;
    err[2] = 1;
    mint.recent!.series = { reqPerMin: req, errPerMin: err };
    renderDashboard(root, data, status());
    const cells = [...row("function2:pyMintOnCrewClaim").querySelectorAll<HTMLElement>(".heat i")];
    expect(cells).toHaveLength(30);
    expect(cells[0].className).toBe("on");
    expect(cells[0].dataset.alpha).toBe("0.50");
    expect(cells[0].getAttribute("style")).toContain("var(--straw) 50%");
    expect(cells[1].dataset.alpha).toBe("1.00");
    expect(cells[2].className).toBe("err");
    expect(cells[3].className).toBe("idle");
    // A failed series shows unknown cells.
    mint.recent!.series = { reqPerMin: null, errPerMin: null };
    renderDashboard(root, data, status());
    expect([...row("function2:pyMintOnCrewClaim").querySelectorAll(".heat i")].every((c) => c.className === "none")).toBe(true);
  });
});

describe("page charts (Chart.js, mocked in tests/setup.ts)", () => {
  const charts = () => vi.mocked(createPageCharts).mock.results.map((r) => r.value as { hero: Mock; host: Mock; destroy: Mock });

  it("are created once per root and updated with each render's data, on the same canvas", async () => {
    renderDashboard(root, data, status());
    const heroCanvas = root.querySelector(".hero-chart canvas");
    const hostCanvas = root.querySelector(".host-chart canvas");
    const later = await createMockSource(() => NOW + 60000).load();
    renderDashboard(root, later, status({ nowMs: NOW + 60000 }));

    expect(createPageCharts).toHaveBeenCalledTimes(1);
    const [page] = charts();
    expect(page.hero).toHaveBeenCalledTimes(2);
    expect(page.host).toHaveBeenCalledTimes(2);
    const fsOf = (d: MetricsResponse) => d.services.find((s) => s.kind === "firestore");
    const sitesOf = (d: MetricsResponse) => d.services.filter((s) => s.kind === "hosting");
    expect(page.hero.mock.calls[0]).toEqual([heroCanvas, fsOf(data), Date.parse(data.generatedAt)]);
    expect(page.hero.mock.calls[1]).toEqual([heroCanvas, fsOf(later), Date.parse(later.generatedAt)]);
    expect(page.host.mock.calls[1]).toEqual([hostCanvas, sitesOf(later), Date.parse(later.generatedAt)]);
    expect(page.hero.mock.calls[1][1]).not.toEqual(page.hero.mock.calls[0][1]);
    // The containers and canvases are the same elements across renders.
    expect(root.querySelector(".hero-chart canvas")).toBe(heroCanvas);
    expect(root.querySelector(".host-chart canvas")).toBe(hostCanvas);
    expect(heroCanvas?.isConnected).toBe(true);
    expect(root.querySelector('[data-section="hero"] svg')).toBeNull();
    expect(root.querySelector('[data-section="hosting"] svg')).toBeNull();
  });

  it("click and Enter on .hero-chart and .host-chart still open the fs and host drawers", () => {
    renderDashboard(root, data, status());
    renderDashboard(root, data, status());
    const opened: string[] = [];
    const unbind = bindOpeners(root, (opener) => opened.push(opener));
    for (const selector of [".hero-chart", ".host-chart"]) {
      const el = root.querySelector<HTMLElement>(selector)!;
      expect(el.getAttribute("role")).toBe("button");
      expect(el.getAttribute("tabindex")).toBe("0");
      el.click();
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    unbind();
    expect(opened).toEqual(["fs", "fs", "host", "host"]);
  });

  it("a focused chart keeps focus across a refresh", () => {
    renderDashboard(root, data, status());
    const chart = root.querySelector<HTMLElement>(".hero-chart")!;
    chart.focus();
    renderDashboard(root, data, status());
    expect(document.activeElement).toBe(chart);
  });

  it("are not created in off mode or before data has loaded, and destroyDashboard destroys them", () => {
    renderDashboard(root, null, status({ state: "paused", off: true, mock: false, paused: true }));
    renderDashboard(root, null, status({ state: "loading" }));
    expect(createPageCharts).not.toHaveBeenCalled();
    renderDashboard(root, data, status());
    destroyDashboard(root);
    expect(charts()[0].destroy).toHaveBeenCalledTimes(1);
  });
});

describe("times (IST, 12-hour, no suffix)", () => {
  // 5 Oct 2026, 11:07:01 pm IST.
  const LATE = Date.UTC(2026, 9, 5, 17, 37, 1);

  it("shows the update time, last run and next run with fixed timestamps", () => {
    data.generatedAt = new Date(LATE).toISOString();
    const nightly = service("scheduler:pyNightlyExport");
    // 5 Oct 2026, 2:35:47 am IST.
    nightly.metrics.lastRunAt = new Date(Date.UTC(2026, 9, 4, 21, 5, 47)).toISOString();
    nightly.metrics.lastResult = "success";
    // 6 Oct, 2:30 am IST.
    nightly.nextRun = "2026-10-05T21:00:00.000Z";
    renderDashboard(root, data, status({ nowMs: LATE }));
    expect(text(root.querySelector("header.top"))).toContain("Updated 11:07:01 pm");
    const job = root.querySelector<HTMLElement>('[data-job-id="scheduler:pyNightlyExport"]')!;
    const last = job.querySelector(".last")!;
    expect(text(last).startsWith("around 5 Oct 2026, 2:35:47 am")).toBe(true);
    expect(text(last.querySelector(".badge"))).toBe("success");
    const nextMeta = job.querySelectorAll(".next .meta");
    expect(text(nextMeta[nextMeta.length - 1])).toBe("6 Oct, 2:30 am");
    expect(text(job.querySelector(".next strong"))).toBe("in 3h 22m");
  });

  it("no rendered text has an IST suffix and 'Times in IST' appears at most once", () => {
    renderDashboard(root, data, status());
    const all = text(root);
    expect(all.split("Times in IST").length - 1).toBeLessThanOrEqual(1);
    expect(all.replace("Times in IST", "")).not.toContain(" IST");
    expect(text(root.querySelector('[data-section="jobs"] .block-head p'))).toBe("Each square is one day; green ran successfully, red failed.");
  });
});

describe("day squares", () => {
  it("are green, red or empty per IST day from the runs history", () => {
    const ist = (day: number, h: number, m: number) => new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60000).toISOString();
    const runs: HistoryPoint[] = [
      { t: ist(5, 2, 31), v: 1, failed: 0 },
      { t: ist(4, 2, 31), v: 1, failed: 1 },
      { t: ist(2, 2, 31), v: 1, failed: 0 },
    ];
    renderDashboard(root, data, status({ runs: { "scheduler:pyNightlyExport": runs, "scheduler:pyWeeklyAccounts": [] } }));
    const days = [...root.querySelectorAll<HTMLElement>('[data-job-id="scheduler:pyNightlyExport"] .days i')];
    expect(days.map((d) => d.className).slice(-4)).toEqual(["ok", "", "fail", "ok"]);
    expect(days[13].title).toBe("5 Oct: success");
    expect(days[12].title).toBe("4 Oct: failed");
    expect(days[11].title).toBe("3 Oct: no run");
    const weekly = [...root.querySelectorAll('[data-job-id="scheduler:pyWeeklyAccounts"] .days i')];
    expect(weekly.every((d) => d.className === "")).toBe(true);
  });
});

describe("focus", () => {
  it("a focused opener keeps focus across a refresh", () => {
    renderDashboard(root, data, status());
    root.querySelector<HTMLElement>('tr[data-open="fn:function2:pyMintOnCrewClaim"]')!.focus();
    renderDashboard(root, data, status());
    expect(document.activeElement?.getAttribute("data-open")).toBe("fn:function2:pyMintOnCrewClaim");
  });
});

describe("paused without data (off mode)", () => {
  it("renders the header and the kill-switch note, with controls disabled", () => {
    renderDashboard(root, null, status({ state: "paused", off: true, mock: false, paused: true }));
    expect(text(root.querySelector("[data-live]"))).toBe("Paused");
    expect(text(root.querySelector("[data-note]"))).toContain("Live monitoring is paused");
    const refresh = [...root.querySelectorAll<HTMLButtonElement>("button[data-refresh]")];
    expect(refresh).toHaveLength(3);
    expect(refresh.every((b) => b.disabled)).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('button[data-action="pause"]')?.disabled).toBe(true);
    expect(root.querySelectorAll("[data-open]")).toHaveLength(0);
  });
});
