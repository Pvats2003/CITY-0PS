import { format, parseISO, isValid } from "date-fns";

export function todayISO(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function fmtDate(d: string | Date, pattern = "MMM d, yyyy"): string {
  const date = typeof d === "string" ? parseISO(d) : d;
  if (!isValid(date)) return "-";
  return format(date, pattern);
}

export function fmtTime(d: string | Date, pattern = "h:mm a"): string {
  const date = typeof d === "string" ? parseISO(d) : d;
  if (!isValid(date)) return "-";
  return format(date, pattern);
}

export function fmtDateTime(d: string | Date): string {
  return `${fmtDate(d)}, ${fmtTime(d)}`;
}

export function fmtDuration(minutes: number): string {
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  const sign = minutes < 0 ? "-" : "";
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

export function fmtHours(hours: number, digits = 1): string {
  return `${hours.toFixed(digits)}h`;
}

export function minutesBetween(startISO: string, endISO: string): number {
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / 60000;
}

export function relTime(d: string): string {
  const date = parseISO(d);
  if (!isValid(date)) return "-";
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (Math.abs(diffMin) < 1) return "just now";
  if (Math.abs(diffMin) < 60) return diffMin > 0 ? `${diffMin}m ago` : `in ${-diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (Math.abs(diffH) < 24) return diffH > 0 ? `${diffH}h ago` : `in ${-diffH}h`;
  const diffD = Math.round(diffH / 24);
  return diffD > 0 ? `${diffD}d ago` : `in ${-diffD}d`;
}

export function isoAtTime(dateISO: string, hhmm: string): string {
  return new Date(`${dateISO}T${hhmm}:00`).toISOString();
}
