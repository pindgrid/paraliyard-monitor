"use strict";

const { CALL_TIMEOUT_MS, MAX_CONCURRENT_CALLS } = require("./constants");

class AllCallsFailedError extends Error {
  constructor() {
    super("all monitoring calls failed");
    this.name = "AllCallsFailedError";
  }
}

// One RPC per call: explicit timeout, no gax retry (retry: null makes
// CallSettings.merge drop the default retry settings) and no auto-pagination.
function callOptions() {
  return { timeout: CALL_TIMEOUT_MS, retry: null, autoPaginate: false };
}

// Runs the fixed request list with at most MAX_CONCURRENT_CALLS in flight.
// Returns { [key]: { ok: true, series } | { ok: false } }.
async function collect(client, requests) {
  const results = {};
  let next = 0;
  let failures = 0;

  async function worker() {
    while (next < requests.length) {
      const { key, request } = requests[next];
      next += 1;
      try {
        const response = await client.listTimeSeries(request, callOptions());
        const series = Array.isArray(response) ? response[0] : null;
        if (!Array.isArray(series)) throw new Error("unexpected listTimeSeries response");
        results[key] = { ok: true, series };
      } catch {
        results[key] = { ok: false };
        failures += 1;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENT_CALLS, requests.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  if (requests.length > 0 && failures === requests.length) throw new AllCallsFailedError();
  return results;
}

module.exports = { AllCallsFailedError, collect, callOptions };
