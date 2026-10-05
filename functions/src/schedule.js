"use strict";

// Next run of a Cloud Scheduler job in Asia/Kolkata. IST has no daylight
// saving, so a fixed UTC+05:30 offset is exact. Only the two cron forms the
// jobs use are supported: "m h * * *" (daily) and "m h * * d" (weekly).

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 5 * HOUR_MS + 30 * MINUTE_MS;

const CRON_PATTERN = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/;

function parseCron(cron) {
  const match = typeof cron === "string" ? CRON_PATTERN.exec(cron) : null;
  if (!match) throw new Error(`unsupported cron: ${cron}`);
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error(`unsupported cron: ${cron}`);
  return { minute, hour, weekday: match[3] === "*" ? null : Number(match[3]) };
}

// Epoch ms of the first run strictly after nowMs.
function nextRunAt(cron, nowMs) {
  const { minute, hour, weekday } = parseCron(cron);
  const local = nowMs + IST_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const time = hour * HOUR_MS + minute * MINUTE_MS;
  let candidate = dayStart + time;
  if (weekday === null) {
    if (candidate <= local) candidate += DAY_MS;
  } else {
    candidate += ((weekday - new Date(dayStart).getUTCDay() + 7) % 7) * DAY_MS;
    if (candidate <= local) candidate += 7 * DAY_MS;
  }
  return candidate - IST_OFFSET_MS;
}

module.exports = { IST_OFFSET_MS, nextRunAt, parseCron };
