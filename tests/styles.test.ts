import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8");
const html = readFileSync("index.html", "utf8");
const main = readFileSync("src/main.ts", "utf8");

function tokens(selector: RegExp): Map<string, string> {
  const block = css.match(selector)?.[1] ?? "";
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

describe("themes", () => {
  const light = tokens(/:root, \[data-theme="light"\] \{([^}]*)\}/);
  const dark = tokens(/\[data-theme="dark"\] \{([^}]*)\}/);

  it("defines the same tokens for the white and the dark theme", () => {
    expect(light.size).toBeGreaterThan(30);
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  it("is a full bright white page in the light theme and a dark page in the dark theme", () => {
    expect(light.get("--bg")).toBe("#ffffff");
    expect(light.get("--surface")).toBe("#ffffff");
    expect(dark.get("--bg")).toBe("#0a0d12");
    expect(css).toMatch(/body \{[^}]*background: var\(--bg\)/);
  });

  it("sets the saved theme before the first paint", () => {
    expect(html).toContain('localStorage.getItem("pm-theme")');
    expect(html.indexOf("pm-theme")).toBeLessThan(html.indexOf("<body"));
  });
});

describe("self-contained", () => {
  it("bundles its fonts and loads nothing from another host", () => {
    expect(main).toContain('import "@fontsource-variable/inter"');
    expect(main).toContain("@fontsource/noto-sans-gurmukhi");
    expect(css).toContain('"Inter Variable"');
    for (const text of [css, html]) {
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  it("keeps the responsive breakpoints, focus ring and reduced motion", () => {
    for (const width of [460, 760, 1024, 1100, 1280, 1360]) expect(css).toContain(`@media (max-width: ${width}px)`);
    expect(css).toMatch(/:focus-visible \{[^}]*outline/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
