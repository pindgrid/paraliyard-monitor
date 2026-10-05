"use strict";

// request_count series shaped like the live request log of the two job
// functions (figures copied from the analyst's acceptance criteria). No tests
// live here. Buckets are 300 s, aligned at :02/:07/... to show that the
// alignment phase does not matter.
//
// pyNightlyExport (daily 02:30 IST):
//   2026-09-19 18:20 IST: 4 non-2xx requests (off schedule).
//   2026-10-05 02:35 IST: 1 2xx request (the 02:30 run).
// pyWeeklyAccounts (Sundays 03:00 IST):
//   2026-09-24 00:20 IST (a Thursday): 3 non-2xx requests (off schedule).
//   2026-10-04 03:05 IST (a Sunday): 1 2xx request (the 03:00 run).

const IST_OFFSET_MS = 330 * 60000;

// Epoch ms of a wall-clock time in IST.
function ist(month, day, hour, minute) {
  return Date.UTC(2026, month - 1, day, hour, minute) - IST_OFFSET_MS;
}

// 2026-10-06 00:00 IST: after the 5 Oct nightly window, before the 6 Oct run.
const NOW_MS = ist(10, 6, 0, 0);

function point(endMs, value) {
  return {
    interval: { endTime: { seconds: String(Math.floor(endMs / 1000)), nanos: 0 } },
    value: { int64Value: String(value) },
  };
}

function classSeries(serviceName, cls, points) {
  return {
    resource: { labels: { service_name: serviceName } },
    metric: { labels: { response_code_class: cls } },
    points,
  };
}

function nightlySeries() {
  return [
    // 18:20 IST lies in the bucket (18:17, 18:22].
    classSeries("pynightlyexport", "5xx", [point(ist(9, 19, 18, 22), 4)]),
    // 02:35 IST lies in the bucket (02:32, 02:37].
    classSeries("pynightlyexport", "2xx", [point(ist(10, 5, 2, 37), 1)]),
  ];
}

function weeklySeries() {
  return [
    classSeries("pyweeklyaccounts", "5xx", [point(ist(9, 24, 0, 22), 3)]),
    classSeries("pyweeklyaccounts", "2xx", [point(ist(10, 4, 3, 7), 1)]),
  ];
}

module.exports = { NOW_MS, ist, point, classSeries, nightlySeries, weeklySeries };
