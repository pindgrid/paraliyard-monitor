// Tests must never touch the network: any un-stubbed fetch fails loudly.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
