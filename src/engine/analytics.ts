import type { CityData } from "@/types";
import { daysBack, plannedHoursForDate, recordedHoursForDate } from "./selectors";
import { computeLostHours } from "./lostHours";
import { cityTargetHoursForDate } from "./insights";
import { fmtDate } from "@/lib/dates";

export interface TrendPoint {
  date: string;
  label: string;
  planned: number;
  actual: number;
  target: number;
  lost: number;
}

export function buildTrend(data: CityData, days: number): TrendPoint[] {
  return daysBack(days).map((date) => {
    const lost = computeLostHours(data, date);
    return {
      date,
      label: fmtDate(date, "MMM d"),
      planned: Math.round(plannedHoursForDate(data, date) * 10) / 10,
      actual: Math.round(recordedHoursForDate(data, date) * 10) / 10,
      // Not a fixed constant — that day's own target (rigs deployed per
      // business that day × 10h, summed across the city). See insights.ts.
      target: cityTargetHoursForDate(data, date),
      lost: lost.totalLost,
    };
  });
}

export interface LossSlice {
  label: string;
  hours: number;
}

export function buildLossBreakdown(data: CityData, days: number): LossSlice[] {
  const totals = new Map<string, number>();
  for (const date of daysBack(days)) {
    const lost = computeLostHours(data, date);
    for (const g of lost.breakdown) {
      totals.set(g.label, (totals.get(g.label) ?? 0) + g.hours);
    }
  }
  return [...totals.entries()]
    .map(([label, hours]) => ({ label, hours: Math.round(hours * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours);
}

export interface BusinessRank {
  id: string;
  name: string;
  reliability: number;
  recordingHours: number;
  visits: number;
}

export function buildBusinessRanking(data: CityData): BusinessRank[] {
  return data.businesses
    .map((b) => {
      const assignments = data.assignments.filter((a) => a.businessId === b.id && ["completed", "rejected", "no_show"].includes(a.status));
      const rejected = assignments.filter((a) => a.status === "rejected" || a.status === "no_show").length;
      const sessions = data.sessions.filter((s) => s.businessId === b.id && s.status === "completed" && s.endedAt);
      const hours = sessions.reduce((sum, s) => sum + (new Date(s.endedAt!).getTime() - new Date(s.startedAt).getTime()) / 3_600_000, 0);
      return {
        id: b.id,
        name: b.name,
        reliability: assignments.length ? Math.round(((assignments.length - rejected) / assignments.length) * 100) : 100,
        recordingHours: Math.round(hours * 10) / 10,
        visits: assignments.length,
      };
    })
    .filter((b) => b.visits > 0)
    .sort((a, b) => b.reliability - a.reliability);
}

export interface FORank {
  id: string;
  name: string;
  onTimePct: number;
  visits: number;
  recordingHours: number;
}

export function buildFORanking(data: CityData): FORank[] {
  return data.fos
    .map((f) => {
      const assignments = data.assignments.filter((a) => a.foId === f.id);
      const arrived = assignments.filter((a) => a.actualArrivalAt);
      const onTime = arrived.filter((a) => (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000 < 15);
      const sessions = data.sessions.filter((s) => s.foId === f.id && s.status === "completed" && s.endedAt);
      const hours = sessions.reduce((sum, s) => sum + (new Date(s.endedAt!).getTime() - new Date(s.startedAt).getTime()) / 3_600_000, 0);
      return {
        id: f.id,
        name: f.name,
        onTimePct: arrived.length ? Math.round((onTime.length / arrived.length) * 100) : 100,
        visits: assignments.filter((a) => a.status === "completed").length,
        recordingHours: Math.round(hours * 10) / 10,
      };
    })
    .filter((f) => f.visits > 0)
    .sort((a, b) => b.visits - a.visits);
}

export interface QualitySlice {
  verdict: string;
  count: number;
}

export function buildQualityDistribution(data: CityData): QualitySlice[] {
  const pass = data.qualityReviews.filter((q) => q.verdict === "pass").length;
  const warn = data.qualityReviews.filter((q) => q.verdict === "warn").length;
  const fail = data.qualityReviews.filter((q) => q.verdict === "fail").length;
  return [
    { verdict: "Pass", count: pass },
    { verdict: "Warn", count: warn },
    { verdict: "Fail", count: fail },
  ].filter((s) => s.count > 0);
}
