import type { CityData } from "@/types";
import { assignmentsForDate, issuesForDate, recordedHoursForDate } from "./selectors";

export interface ScoreDelta {
  label: string;
  delta: number;
}

export interface CategoryScore {
  key: "execution" | "recording" | "attendance" | "quality" | "businessReliability" | "deviceHealth";
  label: string;
  value: number; // 0-100
}

export interface CityHealth {
  score: number; // 0-100, clamped
  deltas: ScoreDelta[];
  categories: CategoryScore[];
}

const RIG_HEALTH_POINTS: Record<string, number> = {
  healthy: 100,
  warning: 60,
  critical: 20,
  offline: 0,
};

export function computeCityHealth(data: CityData, date: string, target: number): CityHealth {
  const assignments = assignmentsForDate(data, date);
  const resolved = assignments.filter((a) => ["completed", "rejected", "no_show"].includes(a.status));
  const completed = assignments.filter((a) => a.status === "completed");
  const rejected = assignments.filter((a) => a.status === "rejected");
  const noShow = assignments.filter((a) => a.status === "no_show");
  const arrived = assignments.filter((a) => a.actualArrivalAt);
  const onTime = arrived.filter((a) => {
    const delayMin = (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000;
    return delayMin < 15;
  });
  const late = arrived.filter((a) => {
    const delayMin = (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000;
    return delayMin >= 15;
  });

  const issues = issuesForDate(data, date);
  const deviceIssues = issues.filter((i) => ["rig_failure", "battery", "storage", "network", "damage"].includes(i.type));
  const openCritical = issues.filter((i) => i.severity === "critical" && (i.status === "open" || i.status === "in_progress"));

  const sessionIdsToday = data.sessions.filter((s) => s.date === date).map((s) => s.id);
  const reviews = data.qualityReviews.filter((q) => sessionIdsToday.includes(q.sessionId));
  const pass = reviews.filter((r) => r.verdict === "pass");
  const warn = reviews.filter((r) => r.verdict === "warn");
  const fail = reviews.filter((r) => r.verdict === "fail");

  const achieved = recordedHoursForDate(data, date);
  const achievementPct = target > 0 ? (achieved / target) * 100 : 100;

  // ---- additive, explainable overall score ----
  const deltas: ScoreDelta[] = [];
  if (achievementPct >= 100) deltas.push({ label: "Recording target achieved", delta: 8 });
  else if (achievementPct >= 85) deltas.push({ label: "Strong recording utilization", delta: 4 });
  else if (achievementPct >= 70) deltas.push({ label: "Recording below target", delta: -4 });
  else if (resolved.length + arrived.length > 0) deltas.push({ label: "Recording significantly below target", delta: -10 });

  if (onTime.length > 0) {
    deltas.push({
      label: `${onTime.length} on-time visit${onTime.length === 1 ? "" : "s"}`,
      delta: Math.min(onTime.length, 12),
    });
  }
  if (late.length > 0) {
    deltas.push({
      label: `${late.length} delayed FO arrival${late.length === 1 ? "" : "s"}`,
      delta: -3 * late.length,
    });
  }
  if (noShow.length > 0) {
    deltas.push({ label: `${noShow.length} FO no-show${noShow.length === 1 ? "" : "s"}`, delta: -8 * noShow.length });
  }
  if (rejected.length > 0) {
    deltas.push({
      label: `${rejected.length} business rejection${rejected.length === 1 ? "" : "s"}`,
      delta: -6 * rejected.length,
    });
  }
  if (deviceIssues.length > 0) {
    deltas.push({
      label: `${deviceIssues.length} device issue${deviceIssues.length === 1 ? "" : "s"}`,
      delta: -5 * deviceIssues.length,
    });
  }
  if (fail.length > 0) {
    deltas.push({ label: `${fail.length} failed QA review${fail.length === 1 ? "" : "s"}`, delta: -4 * fail.length });
  }
  if (warn.length > 0) {
    deltas.push({ label: `${warn.length} QA warning${warn.length === 1 ? "" : "s"}`, delta: -1 * warn.length });
  }
  if (openCritical.length > 0) {
    deltas.push({
      label: `${openCritical.length} unresolved critical issue${openCritical.length === 1 ? "" : "s"}`,
      delta: -3 * openCritical.length,
    });
  }

  const rawScore = 100 + deltas.reduce((s, d) => s + d.delta, 0);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ---- category bars (independent ratio-based, also deterministic) ----
  const executionPct = resolved.length > 0 ? (completed.length / resolved.length) * 100 : 100;
  const attendancePct = arrived.length > 0 ? (onTime.length / arrived.length) * 100 : 100;
  const qualityPct = reviews.length > 0 ? ((pass.length * 100 + warn.length * 50) / reviews.length) : 100;
  const plannedTotal = assignments.length;
  const businessReliabilityPct = plannedTotal > 0 ? ((plannedTotal - rejected.length) / plannedTotal) * 100 : 100;
  const activeRigs = data.rigs.filter((r) => r.active || r.condition !== "offline");
  const deviceHealthPct =
    activeRigs.length > 0
      ? activeRigs.reduce((sum, r) => sum + (RIG_HEALTH_POINTS[r.condition] ?? 50), 0) / activeRigs.length
      : 100;

  const categories: CategoryScore[] = [
    { key: "execution", label: "Execution", value: Math.round(executionPct) },
    { key: "recording", label: "Recording", value: Math.round(Math.min(100, achievementPct)) },
    { key: "attendance", label: "Attendance", value: Math.round(attendancePct) },
    { key: "quality", label: "Quality", value: Math.round(qualityPct) },
    { key: "businessReliability", label: "Business Reliability", value: Math.round(businessReliabilityPct) },
    { key: "deviceHealth", label: "Device Health", value: Math.round(deviceHealthPct) },
  ];

  return { score, deltas, categories };
}

export function healthStatus(score: number): "healthy" | "warning" | "critical" {
  if (score >= 80) return "healthy";
  if (score >= 60) return "warning";
  return "critical";
}
