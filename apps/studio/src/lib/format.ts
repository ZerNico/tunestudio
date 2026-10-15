const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const shortDateWithYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const fullDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60],
  ["hour", 60 * 60],
  ["day", 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
];

/** "Just now", "12 minutes ago", "yesterday", "3 weeks ago", then a date past two months. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const seconds = Math.round((date.getTime() - now) / 1000);
  const elapsed = Math.abs(seconds);
  if (elapsed < 60) return "Just now";
  if (elapsed >= 60 * 24 * 60 * 60) {
    return (date.getFullYear() === new Date(now).getFullYear() ? shortDate : shortDateWithYear).format(date);
  }
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [candidate, candidateSize] of UNITS) {
    if (elapsed >= candidateSize) [unit, size] = [candidate, candidateSize];
  }
  const text = relative.format(Math.round(seconds / size), unit);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Oct 14, 2026, 2:31 PM", for tooltips next to relative times. */
export function formatFullDate(iso: string): string {
  return fullDate.format(new Date(iso));
}

/** "4.2 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** "3:41" or "1:02:05", for media and chart lengths. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "1.25 s", "-0.5 s": a time in seconds, without float noise. */
export function formatSeconds(seconds: number): string {
  return `${Number(seconds.toFixed(3))} s`;
}

/** "312.5": a number without float noise. */
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}
