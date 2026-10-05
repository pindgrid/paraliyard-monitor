// Chart times are always shown in India Standard Time, whatever the viewer's zone.
export const IST_TIME_ZONE = "Asia/Kolkata";

export const istFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// "05 Oct, 14:00 IST" for epoch ms, or "" for an invalid time.
export function formatIst(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return `${istFormatter.format(new Date(ms))} IST`;
}
