import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChartConfiguration } from "chart.js";
import { bucketFor, sourceStepFor } from "../src/chart-shape";
import { groupFor } from "../src/drawer-groups";
import { istTick } from "../src/fmt";
import { createMockHistorySource } from "../src/history-source";
import { heroConfig, hostConfig } from "../src/page-chart-config";
import { panelConfig, type PanelDatasetMeta } from "../src/panel-config";
import { SERVICES } from "../src/services";
import { createMockSource } from "../src/source";

// One sweep over every chart config the page and the drawer produce.

// 5 Oct 2026, 2:00 pm IST.
const NOW = Date.UTC(2026, 9, 5, 8, 30);

const ids = (kind: string) => SERVICES.filter((s) => s.kind === kind).map((s) => s.id);
const OPENERS = [
  "fs",
  "sum:requests",
  "sum:bytes",
  "host",
  ...ids("hosting").map((id) => `site:${id}`),
  ...ids("function2").map((id) => `fn:${id}`),
  ...ids("function1").map((id) => `fn:${id}`),
  ...ids("bucket").map((id) => `st:${id}`),
];

interface Named {
  name: string;
  config: ChartConfiguration;
  // Series drawn (not counting light peak twins).
  series: number;
}

async function allConfigs(): Promise<Named[]> {
  const out: Named[] = [];
  const data = await createMockSource(() => NOW).load();
  const fs = data.services.find((s) => s.kind === "firestore");
  heroConfig(fs, NOW).panels.forEach((p, i) => out.push({ name: `hero ${i}`, config: p.config, series: i === 0 ? 1 : 2 }));
  const sites = data.services.filter((s) => s.kind === "hosting");
  out.push({ name: "host", config: hostConfig(sites, NOW) as unknown as ChartConfiguration, series: sites.length });
  const source = createMockHistorySource(() => NOW);
  for (const opener of OPENERS) {
    const group = groupFor(opener)!;
    const raw = await Promise.all(
      group.series.map(async (s) => (await source.load(s.service, s.metric, "24h")).points.map((p) => ({ x: Date.parse(p.t), y: p.v }))),
    );
    const ctx = {
      from: NOW - 86400000,
      to: NOW,
      bucketMs: bucketFor("24h"),
      sourceStepMs: sourceStepFor("24h"),
      raw,
      visible: [],
      band: null,
      formatTick: (ms: number) => istTick(ms, 86400000),
    };
    for (const panel of group.panels) out.push({ name: `${opener} ${panel.title}`, config: panelConfig(panel, ctx), series: panel.datasets.length });
  }
  return out;
}

type Dataset = { tension?: number; backgroundColor?: unknown; borderColor?: unknown; label?: string } & Partial<PanelDatasetMeta>;

describe("every chart config", () => {
  it("covers the hero panels, hosting and every drawer group's panels", async () => {
    const configs = await allConfigs();
    expect(configs.filter((c) => c.name.startsWith("hero"))).toHaveLength(2);
    expect(configs.some((c) => c.name === "host")).toBe(true);
    for (const opener of OPENERS) expect(configs.some((c) => c.name.startsWith(`${opener} `)), opener).toBe(true);
  });

  it("has a single y scale: no y1 and no right-hand y axis", async () => {
    for (const { name, config } of await allConfigs()) {
      const scales = (config.options?.scales ?? {}) as Record<string, { position?: string; axis?: string }>;
      expect(Object.keys(scales), name).not.toContain("y1");
      const yScales = Object.entries(scales).filter(([id, s]) => id.startsWith("y") || s.axis === "y");
      expect(yScales, name).toHaveLength(1);
      for (const [, s] of yScales) expect(s.position, name).not.toBe("right");
      for (const d of config.data.datasets) expect((d as { yAxisID?: string }).yAxisID ?? "y", name).toBe("y");
    }
  });

  it("never curves a line: tension is 0 or undefined", async () => {
    for (const { name, config } of await allConfigs()) {
      for (const d of config.data.datasets as Dataset[]) {
        if (d.tension !== undefined) expect(d.tension, `${name} ${d.label}`).toBe(0);
      }
    }
  });

  it("never repeats a colour inside a panel (a light peak twin is the same series)", async () => {
    for (const { name, config } of await allConfigs()) {
      const solid = (config.data.datasets as Dataset[]).filter((d) => !d.peak);
      const colors = solid.map((d) => String(d.borderColor ?? d.backgroundColor));
      expect(new Set(colors).size, name).toBe(colors.length);
      for (const twin of (config.data.datasets as Dataset[]).filter((d) => d.peak)) {
        expect(solid.some((d) => d.seriesIndex === twin.seriesIndex), name).toBe(true);
      }
    }
  });

  it("shows the legend only when there is more than one series", async () => {
    for (const { name, config, series } of await allConfigs()) {
      const legend = (config.options?.plugins as { legend?: { display?: boolean } } | undefined)?.legend;
      expect(Boolean(legend?.display), name).toBe(series > 1);
    }
  });
});

describe("dependencies", () => {
  it("has Chart.js as the only chart library and no new runtime dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@fontsource-variable/archivo", "@fontsource/noto-sans-gurmukhi", "chart.js"]);
  });
});
