import { describe, expect, it } from "vitest";

// Every .ts and .json file under src/, keyed like "../src/app.ts".
const files = import.meta.glob("../src/**/*.{ts,json}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ENTRY = "../src/main.ts";

// Matches the specifier of `from "./x"` (static import/export, any line
// layout), side-effect `import "./x"` and dynamic `import("./x")`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolve(from: string, specifier: string): string | undefined {
  const dir = from.slice(0, from.lastIndexOf("/"));
  const base = normalize(`${dir}/${specifier}`);
  return [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => candidate in files);
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const match of (files[file] ?? "").matchAll(SPECIFIER)) {
      const target = resolve(file, match[1]);
      if (target !== undefined && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

const reachable = reachableFrom(ENTRY);

describe("src reachability", () => {
  it("walks the real import graph", () => {
    expect(files).toHaveProperty([ENTRY]);
    expect(reachable.has("../src/app.ts")).toBe(true);
    expect(reachable.has("../src/mock/sample-metrics.json")).toBe(true);
  });

  it("reaches every .ts and .json file under src/ from main.ts", () => {
    const unreachable = Object.keys(files).filter((file) => !reachable.has(file));
    expect(unreachable, `unreachable: ${unreachable.join(", ")}`).toEqual([]);
  });

  it("has no deleted dead modules", () => {
    for (const name of ["charts", "overview", "overview-data", "history-view", "render", "sparkline", "format", "time"]) {
      expect(Object.keys(files), name).not.toContain(`../src/${name}.ts`);
    }
  });

  it("does not import chartjs-plugin-zoom", () => {
    for (const file of reachable) {
      expect(files[file], file).not.toContain("chartjs-plugin-zoom");
    }
  });
});
