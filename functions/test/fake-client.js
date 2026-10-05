"use strict";

// Recording fake of MetricServiceClient. No tests live here.
// Every method called on it is recorded, so tests can prove that only
// listTimeSeries is ever used.

const { RESOURCES, SERVICES } = require("../src/constants");
const { QUERY_DEFS, buildFilter } = require("../src/queries");

function metricTypeOf(filter) {
  const match = /metric\.type = "([^"]+)"/.exec(filter);
  return match ? match[1] : null;
}

// Matches on the whole filter too: run.requests and scheduler.runs share a metric type.
function defOf(request) {
  const type = metricTypeOf(request.filter);
  return QUERY_DEFS.find((d) => d.metricType === type && request.filter === buildFilter(d)) || null;
}

function point(endMs, value) {
  return {
    interval: { endTime: { seconds: String(Math.floor(endMs / 1000)), nanos: 0 } },
    value: Number.isInteger(value) ? { int64Value: String(value) } : { doubleValue: value },
  };
}

// Plausible series for every service covered by a request.
function defaultSeries(request) {
  const def = defOf(request);
  if (!def) return [];
  const endMs = Number(request.interval.endTime.seconds) * 1000;
  const label = RESOURCES[def.kind].label;
  const out = [];
  for (const service of SERVICES.filter((s) => s.kind === def.kind)) {
    const resource = { labels: { [label]: service.resourceLabel } };
    const values = def.aligner === "ALIGN_DELTA" ? [3, 2, 1] : [0.4, 0.3, 0.2];
    const points = values.map((v, i) => point(endMs - i * 60000, v));
    if (def.key === "run.requests") {
      out.push({ resource, metric: { labels: { response_code_class: "2xx" } }, points });
      out.push({ resource, metric: { labels: { response_code_class: "5xx" } }, points: [point(endMs, 1)] });
    } else if (def.key === "scheduler.runs") {
      out.push({ resource, metric: { labels: { response_code_class: "2xx" } }, points: [point(endMs - 3600000, 1)] });
    } else {
      out.push({ resource, metric: { labels: {} }, points });
    }
  }
  return out;
}

// One plausible series for a single-service (history) filter: a point per
// alignment period across the interval, newest first, at most 400 points.
function historySeries(request) {
  const match = /resource\.labels\.([a-z_]+) = "([^"]+)"/.exec(request.filter);
  if (!match) return [];
  const startMs = Number(request.interval.startTime.seconds) * 1000;
  const endMs = Number(request.interval.endTime.seconds) * 1000;
  const stepMs = request.aggregation.alignmentPeriod.seconds * 1000;
  const delta = request.aggregation.perSeriesAligner === "ALIGN_DELTA";
  const points = [];
  for (let i = 0, t = endMs; t > startMs && i < 400; i += 1, t -= stepMs) {
    points.push(point(t, delta ? (i % 3) + 1 : 0.25 + (i % 4) * 0.05));
  }
  return [{ resource: { labels: { [match[1]]: match[2] } }, metric: { labels: {} }, points }];
}

// respond(request, callIndex) returns series, or throws to make that call fail.
function createFakeClient({ respond = defaultSeries, delayMs = 0 } = {}) {
  const calls = [];
  const state = { inFlight: 0, peak: 0 };

  async function listTimeSeries(request, index) {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const series = await respond(request, index);
      return [series, null, {}];
    } finally {
      state.inFlight -= 1;
    }
  }

  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args) => {
          calls.push({ method: prop, request: args[0], options: args[1] });
          if (prop === "listTimeSeries") return listTimeSeries(args[0], calls.length - 1);
          throw new Error(`fake client: unexpected method ${prop}`);
        };
      },
    },
  );

  return {
    client,
    calls,
    peakConcurrency: () => state.peak,
    methods: () => [...new Set(calls.map((c) => c.method))],
  };
}

module.exports = { createFakeClient, defaultSeries, historySeries, metricTypeOf };
