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

const MESSAGE_LIMIT = 200;
const NOT_FOUND = 5;
const silentLog = { info() {}, warn() {} };

// NOT_FOUND means the metric has no data yet (e.g. a service that never ran).
function isNotFound(err) {
  return Boolean(err) && (err.code === NOT_FOUND || String(err.message).includes("Cannot find metric(s)"));
}

// One line per failed call: key, numeric code and a bounded single-line message.
// Never reads metadata, details, headers or stack.
function failureLine(key, err) {
  const code = err && Number.isInteger(err.code) ? err.code : "unknown";
  const msg = String((err && err.message) ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, MESSAGE_LIMIT);
  return `liveMonitorApi: metric call failed key=${key} code=${code} message=${msg}`;
}

// Runs the fixed request list with at most MAX_CONCURRENT_CALLS in flight.
// Returns { [key]: { ok: true, series } | { ok: false } }. NOT_FOUND counts as
// a successful call with no series and is logged via log.info (when present)
// once per key in notFoundSeen; other errors are logged via log.warn.
async function collect(client, requests, { log = silentLog, notFoundSeen = new Set() } = {}) {
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
      } catch (err) {
        if (isNotFound(err)) {
          results[key] = { ok: true, series: [] };
          if (!notFoundSeen.has(key)) {
            notFoundSeen.add(key);
            if (typeof log.info === "function") log.info(`liveMonitorApi: key=${key} no data (NOT_FOUND)`);
          }
        } else {
          results[key] = { ok: false };
          failures += 1;
          log.warn(failureLine(key, err));
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENT_CALLS, requests.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  if (requests.length > 0 && failures === requests.length) throw new AllCallsFailedError();
  return results;
}

module.exports = { AllCallsFailedError, collect, callOptions, isNotFound, failureLine };
