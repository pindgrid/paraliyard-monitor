// The one node:fs function the tests use (vitest runs in Node; the project has
// no @types/node).
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
