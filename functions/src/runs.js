"use strict";

const { RUN_WINDOW_MS, occurrencesBetween } = require("./schedule");

// A scheduler run is one scheduled cron occurrence s. The job function's
// request_count buckets that overlap [s, s + RUN_WINDOW_MS) belong to it;
// every other request (manual or off-schedule calls) is an "other call".
// Shared by /api/history (runs) and /api/metrics (lastRunAt / lastResult).

const RESPONSE_CODE_CLASS = "response_code_class";

// Required on use: aggregate.js requires this module.
function pointsOf(seriesList) {
  return require("./aggregate").pointsOf(seriesList);
}

function isFailed(labels) {
  const value = labels && labels[RESPONSE_CODE_CLASS];
  return typeof value === "string" && value !== "2xx";
}

// series: request_count series grouped by response_code_class. Each point is
// the bucket (end - stepSeconds, end]; it belongs to the earliest occurrence s
// with end > s and end - stepSeconds < s + RUN_WINDOW_MS.
// { runs: [{ at, requests, failed, result }], otherCalls: { count, failed } },
// with one run per occurrence in [fromMs, nowMs], ascending.
function classifyRuns(series, cron, fromMs, nowMs, stepSeconds = 300) {
  const stepMs = stepSeconds * 1000;
  const runs = occurrencesBetween(cron, fromMs, nowMs).map((at) => ({ at, requests: 0, failed: 0, result: null }));
  const otherCalls = { count: 0, failed: 0 };
  for (const p of pointsOf(Array.isArray(series) ? series : [])) {
    if (!(p.v > 0)) continue;
    const run = runs.find((r) => p.t > r.at && p.t - stepMs < r.at + RUN_WINDOW_MS);
    const failed = isFailed(p.labels) ? p.v : 0;
    if (run) {
      run.requests += p.v;
      run.failed += failed;
    } else {
      otherCalls.count += p.v;
      otherCalls.failed += failed;
    }
  }
  for (const r of runs) {
    if (r.failed > 0) r.result = "failed";
    else if (r.requests > 0) r.result = "success";
    else r.result = nowMs >= r.at + RUN_WINDOW_MS ? "missed" : "upcoming";
  }
  return { runs, otherCalls };
}

// The latest run whose window has closed, or null.
function latestClosedRun(runs, nowMs) {
  let best = null;
  for (const r of runs) if (nowMs >= r.at + RUN_WINDOW_MS && (best === null || r.at > best.at)) best = r;
  return best;
}

module.exports = { classifyRuns, latestClosedRun };
