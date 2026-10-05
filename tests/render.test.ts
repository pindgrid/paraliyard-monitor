import { beforeEach, describe, expect, it } from "vitest";
import sample from "../src/mock/sample-metrics.json";
import { renderDashboard } from "../src/render";
import { KIND_ORDER, SERVICES } from "../src/services";
import type { MetricsResponse } from "../src/types";

function fixture(): MetricsResponse {
  return structuredClone(sample) as unknown as MetricsResponse;
}

const EXPECTED_HEADERS: Record<string, string[]> = {
  function2: ["Name", "CPU % (p99)", "RAM % (p99)", "Requests/min", "Errors/min", "Instances", "Trend"],
  function1: ["Name", "CPU %", "Executions/min", "Memory (p99)", "RAM % (p99)", "Trend"],
  firestore: ["Name", "Reads/min", "Writes/min", "Deletes/min", "Trend"],
  bucket: ["Name", "Requests/min", "Bytes stored", "Trend"],
  hosting: ["Name", "Bytes served", "Trend"],
  scheduler: ["Name", "Last run", "Last result", "Trend"],
};

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.appendChild(root);
});

function cell(serviceId: string, key: string): HTMLElement {
  const row = root.querySelector<HTMLElement>(`tr[data-service-id="${serviceId}"]`);
  const td = row?.querySelector<HTMLElement>(`td[data-key="${key}"]`);
  if (!td) throw new Error(`missing cell ${serviceId} ${key}`);
  return td;
}

describe("renderDashboard", () => {
  it("renders exactly one row per service", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok", updatedAt: sample.generatedAt, mock: true });
    const rows = [...root.querySelectorAll<HTMLElement>("tr[data-service-id]")];
    expect(rows).toHaveLength(17);
    expect(rows.map((r) => r.dataset.serviceId)).toEqual(SERVICES.map((s) => s.id));
  });

  it("renders a section per kind with the kind's column headers", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    const sections = [...root.querySelectorAll<HTMLElement>("section[data-kind]")];
    expect(sections.map((s) => s.dataset.kind)).toEqual([...KIND_ORDER]);
    for (const section of sections) {
      const headers = [...section.querySelectorAll("thead th")].map((th) => th.textContent);
      expect(headers, section.dataset.kind).toEqual(EXPECTED_HEADERS[section.dataset.kind ?? ""]);
      const columnCount = headers.length;
      for (const row of section.querySelectorAll("tbody tr, tfoot tr")) {
        expect(row.children).toHaveLength(columnCount);
      }
    }
  });

  it("gives every row a trend cell with an svg", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    for (const row of root.querySelectorAll("tr[data-service-id]")) {
      expect(row.querySelector("td.trend svg"), row.getAttribute("data-service-id") ?? "").not.toBeNull();
    }
  });

  it("renders one totals row per kind with max labels for CPU and RAM", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    const totals = [...root.querySelectorAll<HTMLElement>("tr[data-totals]")];
    expect(totals).toHaveLength(6);
    const fn2 = root.querySelector<HTMLElement>('tr[data-totals="function2"]');
    expect(fn2?.querySelector('[data-key="cpuPct"]')?.textContent).toBe("max 21.4 %");
    expect(fn2?.querySelector('[data-key="memPct"]')?.textContent).toBe("max 38.9 %");
    expect(fn2?.querySelector('[data-key="instances"]')?.textContent).toBe("7");
    const fn1 = root.querySelector<HTMLElement>('tr[data-totals="function1"]');
    expect(fn1?.querySelector('[data-key="cpuPct"]')?.textContent).toBe("not available");
  });

  it("shows not available for pyCleanupOnAuthDelete CPU", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    const td = cell("function1:pyCleanupOnAuthDelete", "cpuPct");
    expect(td.textContent).toBe("not available");
    expect(td.classList.contains("na")).toBe(true);
  });

  it("renders a nulled metric as not available, never 0", () => {
    const data = fixture();
    const target = data.services.find((s) => s.id === "function2:pyMintOnCrewClaim");
    if (!target) throw new Error("fixture missing service");
    target.metrics.reqPerMin = null;
    target.metrics.instances = null;
    renderDashboard(root, SERVICES, data, { state: "ok" });
    expect(cell("function2:pyMintOnCrewClaim", "reqPerMin").textContent).toBe("not available");
    expect(cell("function2:pyMintOnCrewClaim", "instances").textContent).toBe("not available");
  });

  it("never shows 0 for a null value anywhere", () => {
    const data = fixture();
    renderDashboard(root, SERVICES, data, { state: "ok" });
    const byId = new Map(data.services.map((s) => [s.id, s]));
    for (const td of root.querySelectorAll<HTMLElement>("tr[data-service-id] td[data-key]")) {
      const id = td.closest<HTMLElement>("tr")?.dataset.serviceId ?? "";
      const value = byId.get(id)?.metrics[td.dataset.key ?? ""];
      if (value === null) {
        expect(td.textContent, `${id} ${td.dataset.key}`).toBe("not available");
      }
    }
  });

  it("renders a real 0 as 0", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    expect(cell("function2:pyWeeklyAccounts", "reqPerMin").textContent).toBe("0");
    expect(cell("function1:pyCleanupOnAuthDelete", "execPerMin").textContent).toBe("0");
    expect(cell("hosting:preparaliyard", "bytesServed").textContent).toBe("0");
  });

  it("renders all rows with nulls when there is no data", () => {
    renderDashboard(root, SERVICES, null, { state: "loading" });
    expect(root.querySelectorAll("tr[data-service-id]")).toHaveLength(17);
    for (const td of root.querySelectorAll("td[data-key]")) expect(td.textContent).toBe("not available");
    for (const td of root.querySelectorAll("tr[data-service-id] td.trend")) {
      expect(td.textContent).toBe("not available");
    }
  });

  it("does not interpret service data as HTML", () => {
    const data = fixture();
    data.services[11].metrics.reqPerMin = null;
    (data.services[15].metrics as Record<string, unknown>).lastResult = "<img src=x onerror=alert(1)>";
    renderDashboard(root, SERVICES, data, { state: "ok" });
    expect(root.querySelector("img")).toBeNull();
    expect(cell("scheduler:pyNightlyExport", "lastResult").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("shows a status banner for each state", () => {
    const at = "2026-01-01T12:00:00.000Z";
    const cases = [
      ["loading", /Loading/],
      ["ok", /Updated/],
      ["stale", /stale/],
      ["error", /Could not load metrics/],
      ["paused", /Live monitoring is paused/],
    ] as const;
    for (const [state, pattern] of cases) {
      renderDashboard(root, SERVICES, fixture(), { state, updatedAt: at });
      const banner = root.querySelector<HTMLElement>("[data-status]");
      expect(banner?.dataset.status).toBe(state);
      expect(banner?.textContent).toMatch(pattern);
    }
    renderDashboard(root, SERVICES, fixture(), { state: "ok", updatedAt: at });
    expect(root.querySelector("[data-status]")?.textContent).toContain(new Date(at).toLocaleTimeString());
  });

  it("shows the age of a CPU value next to it", () => {
    const data = fixture();
    const target = data.services.find((s) => s.id === "function2:pyMintOnCrewClaim");
    if (!target) throw new Error("fixture missing service");
    target.metrics.cpuPct = 12;
    target.metrics.cpuAt = new Date(Date.parse(data.generatedAt) - 23 * 60000).toISOString();
    renderDashboard(root, SERVICES, data, { state: "ok" });
    const td = cell("function2:pyMintOnCrewClaim", "cpuPct");
    expect(td.textContent).toContain("12 %");
    expect(td.textContent).toContain("· 23 min ago");
    expect(td.classList.contains("na")).toBe(false);
  });

  it("shows idle for an idle service's CPU and RAM and 0 for its counts", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    for (const key of ["cpuPct", "memPct"]) {
      const td = cell("function2:pyWeeklyAccounts", key);
      expect(td.textContent).toBe("idle");
      expect(td.classList.contains("na")).toBe(false);
    }
    for (const key of ["reqPerMin", "errPerMin", "instances"]) {
      expect(cell("function2:pyWeeklyAccounts", key).textContent).toBe("0");
    }
    const row = root.querySelector('tr[data-service-id="function2:pyWeeklyAccounts"]');
    expect(row?.querySelector("td.trend svg")).not.toBeNull();
  });

  it("shows not available with the na class for a failed query", () => {
    const data = fixture();
    const target = data.services.find((s) => s.id === "function2:pyNightlyExport");
    if (!target) throw new Error("fixture missing service");
    target.metrics.cpuPct = null;
    target.metrics.cpuAt = null;
    renderDashboard(root, SERVICES, data, { state: "ok" });
    const td = cell("function2:pyNightlyExport", "cpuPct");
    expect(td.textContent).toBe("not available");
    expect(td.classList.contains("na")).toBe(true);
  });

  it("never prefixes idle or not available totals with max", () => {
    const data = fixture();
    const totals = data.totals.function2;
    if (!totals) throw new Error("fixture missing totals");
    totals.cpuPct = "idle";
    totals.cpuAt = null;
    totals.memPct = null;
    totals.memAt = null;
    renderDashboard(root, SERVICES, data, { state: "ok" });
    const fn2 = root.querySelector<HTMLElement>('tr[data-totals="function2"]');
    expect(fn2?.querySelector('[data-key="cpuPct"]')?.textContent).toBe("idle");
    expect(fn2?.querySelector('[data-key="memPct"]')?.textContent).toBe("not available");
    expect(root.textContent).not.toContain("max idle");
    expect(root.textContent).not.toContain("max not available");
  });

  it("puts the age of the max total in its title", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "ok" });
    const fn2 = root.querySelector<HTMLElement>('tr[data-totals="function2"]');
    const cpu = fn2?.querySelector<HTMLElement>('[data-key="cpuPct"]');
    expect(cpu?.textContent).toBe("max 21.4 %");
    expect(cpu?.title).toBe("23 min ago");
  });

  it("shows no run in 8 days for a job without runs, not available for a failed query", () => {
    const data = fixture();
    const nightly = data.services.find((s) => s.id === "scheduler:pyNightlyExport");
    const weekly = data.services.find((s) => s.id === "scheduler:pyWeeklyAccounts");
    const totals = data.totals.scheduler;
    if (!nightly || !weekly || !totals) throw new Error("fixture missing scheduler data");
    nightly.metrics.lastRunAt = null;
    nightly.metrics.lastResult = "none";
    weekly.metrics.lastRunAt = null;
    weekly.metrics.lastResult = null;
    totals.lastRunAt = null;
    totals.lastResult = "none";
    renderDashboard(root, SERVICES, data, { state: "ok" });
    for (const key of ["lastRunAt", "lastResult"]) {
      const noRun = cell("scheduler:pyNightlyExport", key);
      expect(noRun.textContent, key).toBe("no run in 8 days");
      expect(noRun.classList.contains("na"), key).toBe(false);
      const failed = cell("scheduler:pyWeeklyAccounts", key);
      expect(failed.textContent, key).toBe("not available");
      expect(failed.classList.contains("na"), key).toBe(true);
      const total = root.querySelector<HTMLElement>(`tr[data-totals="scheduler"] [data-key="${key}"]`);
      expect(total?.textContent, key).toBe("no run in 8 days");
      expect(total?.classList.contains("na"), key).toBe(false);
    }
  });

  it("paused shows only the paused message", () => {
    renderDashboard(root, SERVICES, fixture(), { state: "paused" });
    expect(root.textContent).toBe("Live monitoring is paused");
    expect(root.querySelectorAll("tr")).toHaveLength(0);
  });
});
