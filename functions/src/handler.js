"use strict";

const { CACHE_TTL_MS } = require("./constants");
const { buildRequests, normalizeWindow } = require("./queries");
const { buildPayload } = require("./aggregate");
const { collect } = require("./collect");

const CACHE_CONTROL = "public, max-age=30, s-maxage=60";
const PATH = "/api/metrics";

// HTTP handler for GET /api/metrics.
// Per window: at most one Monitoring refresh per CACHE_TTL_MS (successful or
// not), concurrent requests share the in-flight refresh, and a failed refresh
// serves the last good data marked stale.
function createHandler({ getClient, now = Date.now, log = console }) {
  const state = new Map();

  function stateFor(windowKey) {
    if (!state.has(windowKey)) {
      state.set(windowKey, { data: null, stale: false, lastAttemptAt: null, inflight: null });
    }
    return state.get(windowKey);
  }

  async function refresh(windowKey, entry) {
    const nowMs = now();
    try {
      const results = await collect(getClient(), buildRequests(windowKey, nowMs), { log });
      entry.data = buildPayload({ results, windowKey, nowMs });
      entry.stale = false;
      const failed = Object.values(results).filter((r) => !r.ok).length;
      if (failed > 0) log.warn(`liveMonitorApi: ${failed} metric call(s) failed`);
    } catch (err) {
      entry.stale = true;
      log.error(`liveMonitorApi: refresh failed: ${err && err.name}`);
    }
  }

  return async function handler(req, res) {
    res.set("Cache-Control", CACHE_CONTROL);
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    if (req.path !== PATH) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const windowKey = normalizeWindow(req.query && req.query.window);
    const entry = stateFor(windowKey);

    if (entry.inflight) {
      await entry.inflight;
    } else if (entry.lastAttemptAt === null || now() - entry.lastAttemptAt >= CACHE_TTL_MS) {
      entry.lastAttemptAt = now();
      entry.inflight = refresh(windowKey, entry).finally(() => {
        entry.inflight = null;
      });
      await entry.inflight;
    }

    if (!entry.data) {
      res.status(503).json({ error: "metrics unavailable" });
      return;
    }
    res.status(200).json(entry.stale ? { ...entry.data, stale: true } : entry.data);
  };
}

module.exports = { CACHE_CONTROL, createHandler };
