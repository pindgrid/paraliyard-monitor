import { vi } from "vitest";

// Tests never load the real Chart.js (jsdom has no canvas): charts are no-ops
// unless a test file mocks "../src/charts" itself to inspect them.
vi.mock("../src/charts", () => ({
  PALETTE: [],
  createChart: () => ({ update() {}, resetZoom() {}, destroy() {} }),
}));

// Same for the drawer's Chart.js adapter. Drawer tests that inspect charts
// pass their own createChart.
vi.mock("../src/drawer-chart", () => ({
  createDrawerChart: () => ({ setVisible() {}, setData() {}, destroy() {} }),
}));

// Tests must never touch the network: any un-stubbed fetch fails loudly.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
