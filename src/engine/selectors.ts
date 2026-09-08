import type { CityData, Assignment, Session, Issue } from "@/types";

export function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

export function assignmentsForDate(data: CityData, date: string): Assignment[] {
  return data.assignments.filter((a) => a.date === date);
}

export function sessionsForDate(data: CityData, date: string): Session[] {
  return data.sessions.filter((s) => s.date === date);
}

export function activeSessions(data: CityData): Session[] {
  return data.sessions.filter((s) => s.status === "active");
}

export function issuesOpen(data: CityData): Issue[] {
  return data.issues.filter((i) => i.status === "open" || i.status === "in_progress");
}

export function issuesForDate(data: CityData, date: string): Issue[] {
  return data.issues.filter((i) => i.createdAt.slice(0, 10) === date);
}

export function recordedHoursForDate(data: CityData, date: string): number {
  return sessionsForDate(data, date).reduce((sum, s) => {
    if (s.status === "completed" && s.endedAt) {
      return sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3_600_000;
    }
    if (s.status === "active") {
      return sum + (Date.now() - new Date(s.startedAt).getTime()) / 3_600_000;
    }
    return sum;
  }, 0);
}

export function plannedHoursForDate(data: CityData, date: string): number {
  return assignmentsForDate(data, date)
    .filter((a) => a.status !== "cancelled")
    .reduce((sum, a) => sum + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);
}

export function daysBack(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
