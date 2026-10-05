// Next run of a Cloud Scheduler job in Asia/Kolkata (port of
// functions/src/schedule.js). IST has no daylight saving, so a fixed
// UTC+05:30 offset is exact. Only "m h * * *" and "m h * * d" are supported.

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const IST_OFFSET_MS = 5 * HOUR_MS + 30 * MINUTE_MS;

const CRON_PATTERN = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/;

interface Cron {
  minute: number;
  hour: number;
  weekday: number | null;
}

export function parseCron(cron: unknown): Cron {
  const match = typeof cron === "string" ? CRON_PATTERN.exec(cron) : null;
  if (!match) throw new Error(`unsupported cron: ${String(cron)}`);
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error(`unsupported cron: ${String(cron)}`);
  return { minute, hour, weekday: match[3] === "*" ? null : Number(match[3]) };
}

// Epoch ms of the first run strictly after now.
export function nextRunAt(cron: string, now: number): number {
  const { minute, hour, weekday } = parseCron(cron);
  const local = now + IST_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  let candidate = dayStart + hour * HOUR_MS + minute * MINUTE_MS;
  if (weekday === null) {
    if (candidate <= local) candidate += DAY_MS;
  } else {
    candidate += ((weekday - new Date(dayStart).getUTCDay() + 7) % 7) * DAY_MS;
    if (candidate <= local) candidate += 7 * DAY_MS;
  }
  return candidate - IST_OFFSET_MS;
}

// Epoch ms of the IST midnight that starts the day holding t.
export function istDayStart(t: number): number {
  return Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}
