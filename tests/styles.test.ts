import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Paths are relative to the project root, where vitest runs.
const css = readFileSync("src/styles.css", "utf8");
const html = readFileSync("index.html", "utf8");
const main = readFileSync("src/main.ts", "utf8");

const PALETTE: Record<string, string> = {
  "--bg": "#E7EADF",
  "--surface": "#F6F7F1",
  "--surface-2": "#E1E5D7",
  "--ink": "#1F2A1E",
  "--ink-2": "#55604E",
  "--ink-3": "#848D79",
  "--rule": "#D0D6C4",
  "--straw": "#B07A12",
  "--straw-soft": "#F0E3C2",
  "--paddy": "#3E7B4F",
  "--canal": "#2D6A8E",
  "--ember": "#B8442F",
  "--idle": "#C4CAB7",
};

describe("styles.css", () => {
  it("defines the 13 light palette values exactly, once each", () => {
    expect(Object.keys(PALETTE)).toHaveLength(13);
    for (const [name, value] of Object.entries(PALETTE)) {
      const defs = [...css.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
      expect(defs, name).toEqual([value]);
    }
  });

  it("is light only", () => {
    expect(css).toMatch(/color-scheme:\s*light;/);
    expect(css).not.toMatch(/color-scheme:\s*dark/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(css).not.toMatch(/data-theme/);
  });

  it("keeps the breakpoints, focus-visible and reduced-motion rules", () => {
    for (const width of [780, 820, 880, 940]) expect(css).toContain(`@media (max-width: ${width}px)`);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("caps the hero's left column at 300px, makes it a size container, fits the big number and keeps a single column at 780px", () => {
    const hero = css.match(/(?:^|\n)\.hero\s*\{([^}]*)\}/)?.[1] ?? "";
    const columns = hero.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? "";
    expect(columns).toMatch(/^minmax\(230px,\s*300px\)\s+1fr$/);
    expect(hero).not.toContain("max-content");

    const left = css.match(/\.hero\s*>\s*:first-child\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(left).toMatch(/container-type:\s*inline-size|container:[^;]*\/\s*inline-size/);

    const bignum = css.match(/\.bignum\s*\{([^}]*)\}/)?.[1] ?? "";
    const clamp = bignum.match(/font-size:\s*clamp\((\d+)px,\s*(\d+(?:\.\d+)?)cqi,\s*(\d+)px\)/);
    expect(clamp).not.toBeNull();
    const [min, n, max] = [Number(clamp![1]), Number(clamp![2]), Number(clamp![3])];
    expect(n).toBeLessThanOrEqual(20);
    expect(max).toBeLessThanOrEqual(64);
    expect(bignum).toMatch(/white-space:\s*nowrap/);
    expect(bignum).toMatch(/max-width:\s*100%/);
    for (const value of ["1,234.56", "130.00", "160.00"]) {
      expect(value.length * 0.62 * max, value).toBeLessThanOrEqual(300);
      expect(value.length * 0.62 * Math.max(min, (n * 230) / 100), value).toBeLessThanOrEqual(230);
    }

    const hint = css.match(/\.hint\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(hint).not.toMatch(/nowrap/);
    expect(hint).not.toMatch(/width:/);

    expect(css).toMatch(/@media \(max-width: 780px\) \{ \.hero \{ grid-template-columns: 1fr;/);
  });

  it("has no CSS for the removed SVG charts, select, inline legend or drawer legend buttons", () => {
    for (const selector of [".spark", ".bars", ".legend-inline", ".refresh select", ".dlegend"]) {
      expect(css, selector).not.toContain(selector);
    }
  });

  it("uses the bundled Archivo Variable family and no remote URLs", () => {
    expect(css).toMatch(/--font:\s*"Archivo Variable", "Archivo", "Helvetica Neue", Arial, sans-serif;/);
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/@import/);
  });
});

describe("page shell", () => {
  it("index.html has no CDN, Google Fonts or external tags", () => {
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg|cdnjs/);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).toContain("<title>Paraliyard monitor</title>");
  });

  it("main.ts imports the bundled fonts and the stylesheet", () => {
    expect(main).toContain('import "@fontsource-variable/archivo/wdth.css";');
    expect(main).toContain('import "@fontsource/noto-sans-gurmukhi/500.css";');
    expect(main).toContain('import "./styles.css";');
  });
});
