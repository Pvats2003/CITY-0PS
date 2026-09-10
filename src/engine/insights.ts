import type { CityData, Business, FieldOfficer, Rig, Session, Issue, Assignment } from "@/types";
import { daysBack } from "./selectors";
import { buildRigSummary } from "./rigGuardian";

/** Each rig deployed at a business is expected to record this many hours a
 * day — the one constant in the target formula. Everything else scales
 * with how many rigs are actually there; there is no fixed per-business
 * target (see businessTargetHours below). */
export const RECORDING_HOURS_PER_RIG_PER_DAY = 10;

/** Distinct rigs deployed at a business, across the given assignments — the
 * "number of rigs" half of the target formula. Rigs aren't permanently
 * owned by a business (see types/index.ts's Rig — no businessId field), so
 * "deployed at a business" means assigned there via an Assignment record; a
 * cancelled assignment never deployed a rig there, so it doesn't count. */
export function businessRigIdsFromAssignments(assignments: Assignment[], businessId: string): Set<string> {
  return new Set(
    assignments
      .filter((a): a is typeof a & { rigId: string } => a.businessId === businessId && a.status !== "cancelled" && !!a.rigId)
      .map((a) => a.rigId),
  );
}

/** DAILY_TARGET_HOURS for one business = (distinct rigs deployed there,
 * across the given assignments) × 10. Not a fixed constant, and not
 * duplicated/stored anywhere — a business with zero rigs assigned has a 0h
 * target; one with 3 has 30h. Takes a raw assignment list (rather than
 * CityData + date) so it works equally for already-committed assignments
 * (businessTargetHours/cityTargetHoursForDate below) and for a Manager's
 * in-progress, not-yet-saved Planner draft. */
export function businessTargetHoursFromAssignments(assignments: Assignment[], businessId: string): number {
  return businessRigIdsFromAssignments(assignments, businessId).size * RECORDING_HOURS_PER_RIG_PER_DAY;
}

/** City-wide target = the sum of every business's own target across the
 * given assignments, never a flat constant. */
export function cityTargetHoursFromAssignments(assignments: Assignment[]): number {
  const businessIds = new Set(assignments.filter((a) => a.status !== "cancelled").map((a) => a.businessId));
  let total = 0;
  for (const businessId of businessIds) total += businessTargetHoursFromAssignments(assignments, businessId);
  return total;
}

/** businessTargetHoursFromAssignments scoped to one committed date — the
 * form every non-Planner caller wants (Command Center, Business 360,
 * SOD/MOD/EOD reports, City Health): replaces the old fixed
 * settings.recordingHoursTargetPerDay everywhere it was read as a citywide
 * or per-business "recording hours / target" figure. */
export function businessTargetHours(data: CityData, businessId: string, date: string): number {
  return businessTargetHoursFromAssignments(
    data.assignments.filter((a) => a.date === date),
    businessId,
  );
}

export function cityTargetHoursForDate(data: CityData, date: string): number {
  return cityTargetHoursFromAssignments(data.assignments.filter((a) => a.date === date));
}

/** How many distinct rigs a business has deployed on a given date — the
 * number Business 360 shows next to its target, so a Manager can see the
 * two numbers agree (rigs × 10 = target) rather than trusting the target
 * blindly. */
export function businessRigCount(data: CityData, businessId: string, date: string): number {
  return businessRigIdsFromAssignments(
    data.assignments.filter((a) => a.date === date),
    businessId,
  ).size;
}

export interface BusinessStats {
  totalVisits: number;
  successfulVisits: number;
  rejectedVisits: number;
  noShowVisits: number;
  totalRecordingHours: number;
  avgRecordingHours: number;
  targetAchievementPct: number;
  qaPassRate: number;
  issueCount: number;
  cancellationCount: number;
  avgDelayMin: number;
  reliabilityScore: number;
  lastVisitAt?: string;
  nextPlannedAt?: string;
  bestWindow?: string;
}

export function computeBusinessStats(data: CityData, business: Business): BusinessStats {
  const assignments = data.assignments.filter((a) => a.businessId === business.id);
  const sessions = data.sessions.filter((s) => s.businessId === business.id);
  const completed = assignments.filter((a) => a.status === "completed");
  const rejected = assignments.filter((a) => a.status === "rejected");
  const noShow = assignments.filter((a) => a.status === "no_show");
  const cancelled = assignments.filter((a) => a.status === "cancelled");
  const issues = data.issues.filter((i) => i.businessId === business.id);
  const reviews = data.qualityReviews.filter((q) => q.businessId === business.id);

  const recordingHours = sessions.reduce((sum, s) => {
    if (s.status === "completed" && s.endedAt) {
      return sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3_600_000;
    }
    return sum;
  }, 0);

  const targetHours = completed.reduce((sum, a) => sum + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);

  const delays = assignments
    .filter((a) => a.actualArrivalAt)
    .map((a) => (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000);
  const avgDelayMin = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;

  const qaPassRate = reviews.length ? (reviews.filter((r) => r.verdict === "pass").length / reviews.length) * 100 : 100;

  const past = assignments.filter((a) => ["completed", "rejected", "no_show"].includes(a.status));
  const reliabilityScore = past.length
    ? Math.round(((past.length - rejected.length - noShow.length) / past.length) * 100)
    : 100;

  const sorted = [...assignments].sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime());
  const now = Date.now();
  const lastVisit = [...sorted].reverse().find((a) => new Date(a.plannedStart).getTime() <= now && a.status !== "planned");
  const nextPlanned = sorted.find((a) => new Date(a.plannedStart).getTime() > now && a.status === "planned");

  // best observed window: bucket completed sessions by start hour, favor buckets with good achievement
  const hourBuckets = new Map<number, { count: number; goodCount: number }>();
  for (const s of sessions) {
    if (s.status !== "completed" || !s.endedAt) continue;
    const hour = new Date(s.startedAt).getHours();
    const actualMin = (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000;
    const good = actualMin / s.plannedDurationMin >= 0.85;
    const bucket = hourBuckets.get(hour) ?? { count: 0, goodCount: 0 };
    bucket.count += 1;
    if (good) bucket.goodCount += 1;
    hourBuckets.set(hour, bucket);
  }
  let bestWindow: string | undefined;
  let bestScore = -1;
  for (const [hour, b] of hourBuckets) {
    const score = b.goodCount / b.count;
    if (score > bestScore && b.count >= 1) {
      bestScore = score;
      bestWindow = `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}–${(hour + 3) % 12 === 0 ? 12 : (hour + 3) % 12}:00 ${hour + 3 < 12 ? "AM" : "PM"}`;
    }
  }

  return {
    totalVisits: assignments.length,
    successfulVisits: completed.length,
    rejectedVisits: rejected.length,
    noShowVisits: noShow.length,
    totalRecordingHours: Math.round(recordingHours * 10) / 10,
    avgRecordingHours: completed.length ? Math.round((recordingHours / completed.length) * 10) / 10 : 0,
    targetAchievementPct: targetHours > 0 ? Math.round((recordingHours / targetHours) * 100) : 100,
    qaPassRate: Math.round(qaPassRate),
    issueCount: issues.length,
    cancellationCount: cancelled.length,
    avgDelayMin: Math.round(avgDelayMin),
    reliabilityScore,
    lastVisitAt: lastVisit?.plannedStart,
    nextPlannedAt: nextPlanned?.plannedStart,
    bestWindow,
  };
}

export function businessInsightText(stats: BusinessStats): string {
  if (stats.totalVisits < 2) return "Insufficient historical data.";

  if (stats.reliabilityScore >= 85 && stats.qaPassRate >= 80 && stats.issueCount <= 1) {
    const parts = [
      "Strong candidate for repeat collection.",
      `${stats.successfulVisits} successful visit${stats.successfulVisits === 1 ? "" : "s"}.`,
      `${stats.totalRecordingHours.toFixed(1)} usable recording hours.`,
    ];
    if (stats.issueCount === 0) parts.push("No major quality issues.");
    if (stats.bestWindow) parts.push(`Best observed window: ${stats.bestWindow}.`);
    return parts.join(" ");
  }

  if (stats.rejectedVisits + stats.noShowVisits >= 1 || stats.reliabilityScore < 75) {
    const parts = ["At risk."];
    if (stats.rejectedVisits > 0) parts.push(`${stats.rejectedVisits} of the last ${stats.totalVisits} visits were rejected.`);
    if (stats.avgDelayMin > 15) parts.push(`Average arrival delay is ${stats.avgDelayMin} minutes.`);
    if (stats.bestWindow) parts.push(`Recommendation: shift future visits toward ${stats.bestWindow}.`);
    else parts.push("Recommendation: review scheduling window with the assigned FO.");
    return parts.join(" ");
  }

  return `Steady performer. ${stats.successfulVisits} successful visits, ${stats.targetAchievementPct}% of target recording hours achieved.`;
}

export interface FOStats {
  attendancePct: number;
  onTimePct: number;
  visitsCompleted: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  avgDelayMin: number;
  issueCount: number;
  successfulVisits: number;
  recordingHoursManaged: number;
}

export function computeFOStats(data: CityData, fo: FieldOfficer): FOStats {
  const assignments = data.assignments.filter((a) => a.foId === fo.id);
  const past = assignments.filter((a) => ["completed", "rejected", "no_show"].includes(a.status));
  const noShow = assignments.filter((a) => a.status === "no_show");
  const completed = assignments.filter((a) => a.status === "completed");
  const arrived = assignments.filter((a) => a.actualArrivalAt);
  const onTime = arrived.filter((a) => (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000 < 15);
  const sessions = data.sessions.filter((s) => s.foId === fo.id);
  const issues = data.issues.filter((i) => i.foId === fo.id);
  const delays = arrived.map((a) => (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000);
  const recordingHours = sessions.reduce((sum, s) => {
    if (s.status === "completed" && s.endedAt) return sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3_600_000;
    if (s.status === "active") return sum + (Date.now() - new Date(s.startedAt).getTime()) / 3_600_000;
    return sum;
  }, 0);

  return {
    attendancePct: past.length ? Math.round(((past.length - noShow.length) / past.length) * 100) : 100,
    onTimePct: arrived.length ? Math.round((onTime.length / arrived.length) * 100) : 100,
    visitsCompleted: completed.length,
    sessionsStarted: sessions.length,
    sessionsCompleted: sessions.filter((s) => s.status === "completed").length,
    avgDelayMin: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
    issueCount: issues.length,
    successfulVisits: completed.length,
    recordingHoursManaged: Math.round(recordingHours * 10) / 10,
  };
}

export function foInsightText(stats: FOStats): string {
  if (stats.visitsCompleted + stats.issueCount === 0) return "Insufficient historical data.";
  const parts: string[] = [];
  if (stats.attendancePct >= 95 && stats.onTimePct >= 85) parts.push("Excellent attendance.");
  else if (stats.attendancePct < 80) parts.push("Attendance needs attention.");
  else parts.push("Solid attendance.");

  const openIssues = stats.issueCount;
  if (openIssues >= 3) parts.push(`${openIssues} recurring issues on record.`);
  else if (openIssues > 0) parts.push(`${openIssues} unresolved issue${openIssues === 1 ? "" : "s"} on record.`);

  if (stats.avgDelayMin > 15) parts.push(`Average arrival delay is ${stats.avgDelayMin} minutes — worth a conversation.`);

  return parts.join(" ");
}

export function rigInsightText(data: CityData, rig: Rig): string {
  const sessions = data.sessions.filter((s) => s.rigId === rig.id);
  const summary = buildRigSummary(data, rig);
  const parts: string[] = [];
  if (sessions.length >= 8) parts.push("High utilization.");
  if (summary.readiness === "do_not_deploy") parts.push("Needs immediate inspection.");
  else if (summary.readiness === "in_repair") parts.push("Currently in repair.");
  else if (summary.readiness === "inspection_required") parts.push("Inspection recommended soon.");
  if (summary.repeatedFailures.length > 0) parts.push(summary.repeatedFailures[0].message);
  if (sessions.length === 0 && parts.length === 0) return "Insufficient historical data.";
  if (parts.length === 0) parts.push("Operating normally.");
  return parts.join(" ");
}

export function sessionInsightText(session: Session): string {
  if (session.status === "active") {
    const elapsedMin = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
    if (elapsedMin > session.plannedDurationMin * 1.15) return "Running longer than planned.";
    return "On track.";
  }
  if (session.status === "completed" && session.endedAt) {
    const actualMin = (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000;
    const pct = (actualMin / session.plannedDurationMin) * 100;
    if (pct < 75) return "Below expected duration.";
    if (pct > 115) return "Ran over planned duration.";
    return "Matched planned duration.";
  }
  return "No data.";
}

export function issueInsightText(data: CityData, issue: Issue): string {
  const week = new Set(daysBack(7));
  const similar = data.issues.filter(
    (i) => i.type === issue.type && (issue.businessId ? i.businessId === issue.businessId : true) && week.has(i.createdAt.slice(0, 10)),
  );
  if (similar.length >= 3) return `${similar.length}${similar.length === 3 ? "rd" : "th"} similar issue this week.`;
  if (similar.length === 2) return "Second similar issue this week.";
  return "Isolated incident.";
}
