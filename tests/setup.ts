import { vi } from "vitest";

// Tests never load the real Chart.js (jsdom has no canvas): charts are no-ops
// unless a test file mocks "../src/charts" itself to inspect them.
vi.mock("../src/charts", () => ({
  PALETTE: [],
  createChart: () => ({ update() {}, resetZoom() {}, destroy() {} }),
}));

// Tests must never touch the network: any un-stubbed fetch fails loudly.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
