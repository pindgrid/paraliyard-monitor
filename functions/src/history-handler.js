"use strict";

const {
  HISTORY_RANGES,
  HISTORY_METRICS,
  validateHistoryQuery,
  buildHistoryRequest,
  toHistoryPoints,
  alignmentOf,
} = require("./history");
const { callOptions, isNotFound, failureLine } = require("./collect");
const { JOB_SCHEDULES } = require("./constants");
const { classifyRuns, markBeforeFirstRun } = require("./runs");

const NO_STORE = "no-store";
// At most this many history calls per rolling window, per instance.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60000;

// 200 responses: browsers keep half the TTL, the CDN keeps the full TTL.
function cacheControlFor(range) {
  const ttlSeconds = HISTORY_RANGES[range].ttlMs / 1000;
  return `public, max-age=${ttlSeconds / 2}, s-maxage=${ttlSeconds}`;
}

// Rolling-window log of call times. Refuses instead of queueing.
function createLimiter({ now, limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS }) {
  const times = [];
  function prune(t) {
    while (times.length > 0 && t - times[0] >= windowMs) times.shift();
  }
  return {
    tryAcquire() {
      const t = now();
      prune(t);
      if (times.length >= limit) return false;
      times.push(t);
      return true;
    },
    // Whole seconds until the oldest slot frees (at least 1).
    retryAfterSeconds() {
      const t = now();
      prune(t);
      if (times.length === 0) return 1;
      return Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000));
    },
  };
}

// Scheduler runs: one point per scheduled occurrence in the range, plus the
// requests outside every run window. Closed occurrences before the first
// observed run are "before-first-run". Raw buckets never leave the backend.
function runsAnswer(series, service, range, nowMs) {
  const metricSpec = HISTORY_METRICS[service.kind].runs;
  const { runs, otherCalls } = classifyRuns(
    series,
    JOB_SCHEDULES[service.id].cron,
    nowMs - HISTORY_RANGES[range].seconds * 1000,
    nowMs,
    alignmentOf(metricSpec, range),
  );
  const points = markBeforeFirstRun(runs, nowMs).map((r) => ({
    t: new Date(r.at).toISOString(),
    v: r.requests,
    result: r.result,
    requests: r.requests,
    failed: r.failed,
  }));
  return { points, otherCalls };
}

function sendError(res, status, error, headers = {}) {
  res.set("Cache-Control", NO_STORE);
  for (const [name, value] of Object.entries(headers)) res.set(name, value);
  res.status(status).json({ error });
}

// GET /api/history?service=<id>&metric=<key>&range=<range>.
// Per (service, metric, range): validation before any call, at most one
// Monitoring call per TTL (successful or not), concurrent requests share the
// in-flight call, at most RATE_LIMIT calls per minute across all keys, and a
// failed call serves the last good answer marked stale.
function createHistoryRoute({ getClient, now = Date.now, log = console, notFoundSeen = new Set() }) {
  const cache = new Map();
  const limiter = createLimiter({ now });

  function logNoData(key) {
    if (notFoundSeen.has(key)) return;
    notFoundSeen.add(key);
    if (typeof log.info === "function") log.info(`liveMonitorApi: key=${key} no data (NOT_FOUND or empty)`);
  }

  async function refresh(query, entry) {
    const { service, metric, range } = query;
    const key = `history/${service.id}/${metric}/${range}`;
    const nowMs = now();
    const isRuns = metric === "runs";
    const answer = (series) => {
      const out = {
        service: service.id,
        metric,
        range,
        unit: HISTORY_METRICS[service.kind][metric].unit,
        points: [],
        generatedAt: new Date(nowMs).toISOString(),
      };
      if (isRuns) {
        const { points, otherCalls } = runsAnswer(series, service, range, nowMs);
        out.points = points;
        out.otherCalls = otherCalls;
      } else {
        out.points = toHistoryPoints(series, metric, range);
      }
      return out;
    };
    try {
      const request = buildHistoryRequest(service, metric, range, nowMs);
      const response = await getClient().listTimeSeries(request, callOptions());
      const series = Array.isArray(response) ? response[0] : null;
      if (!Array.isArray(series)) throw new Error("unexpected listTimeSeries response");
      // A truncated page is reported, never followed: one call per miss.
      const page = response[2];
      if (page && page.nextPageToken) log.warn(`liveMonitorApi: key=${key} more than one page, extra pages not read`);
      entry.data = answer(series);
      entry.stale = false;
      if (series.length === 0 || entry.data.points.length === 0) logNoData(key);
    } catch (err) {
      if (isNotFound(err)) {
        entry.data = answer([]);
        entry.stale = false;
        logNoData(key);
      } else {
        entry.stale = true;
        log.warn(failureLine(key, err));
      }
    }
  }

  function send(res, query, entry, stale) {
    if (!entry.data) {
      sendError(res, 502, "history unavailable");
      return;
    }
    res.set("Cache-Control", cacheControlFor(query.range));
    res.status(200).json(stale ? { ...entry.data, stale: true } : entry.data);
  }

  return async function historyRoute(req, res) {
    const query = validateHistoryQuery(req.query);
    if (!query) {
      sendError(res, 400, "bad request");
      return;
    }

    const cacheKey = `${query.service.id}|${query.metric}|${query.range}`;
    if (!cache.has(cacheKey)) cache.set(cacheKey, { data: null, stale: false, lastAttemptAt: null, inflight: null });
    const entry = cache.get(cacheKey);
    const { ttlMs } = HISTORY_RANGES[query.range];

    if (entry.inflight) {
      await entry.inflight;
    } else if (entry.lastAttemptAt === null || now() - entry.lastAttemptAt >= ttlMs) {
      if (!limiter.tryAcquire()) {
        if (entry.data) {
          send(res, query, entry, true);
          return;
        }
        sendError(res, 429, "too many requests", { "Retry-After": String(limiter.retryAfterSeconds()) });
        return;
      }
      entry.lastAttemptAt = now();
      entry.inflight = refresh(query, entry).finally(() => {
        entry.inflight = null;
      });
      await entry.inflight;
    }

    send(res, query, entry, entry.stale);
  };
}

module.exports = { HISTORY_PATH: "/api/history", RATE_LIMIT, cacheControlFor, createHistoryRoute };
