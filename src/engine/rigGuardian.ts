import type { CityData, DamageGroup, Rig, RigIncident, RigReadinessStatus, Severity } from "@/types";
import { todayISO } from "@/lib/dates";
import { overlaps } from "./selectors";
import { DAMAGE_GROUP_LABELS, categoryLabel } from "./rigTaxonomy";
import { recentEvidenceSignalsForRig, type RigEvidenceSignal } from "./execution";

// ---------------------------------------------------------------------------
// Rig Guardian — deterministic, explainable rig health & readiness engine.
//
// Nothing here is machine learning. Every score is a transparent sum of
// named deductions/bonuses over the rig's own recorded incident/repair
// history (spec: "Operational health score based on recorded history").
// All thresholds live in RIG_SCORE_CONFIG so the logic is centralized and
// tunable in one place.
// ---------------------------------------------------------------------------

export const RIG_SCORE_CONFIG = {
  lookbackDays: 30,
  repeatWindowDays: 14,
  recentIncident: -5, // per warning-severity incident within lookbackDays
  attentionIncident: -2, // per attention-severity incident within lookbackDays
  criticalIncident: -20, // per critical-severity incident within lookbackDays
  repeatedIncidentSameGroup: -10, // per incident beyond the 1st in the same damage group within repeatWindowDays
  repairRequired: -20, // flat, if an incident is currently on the repair track
  inspectionOverdue: -10, // flat, from needsInspection()
  repeatedFailureAfterRepair: -15, // per incident within repeatWindowDays after a repair on this rig
  longHealthyStreakBonus: 5, // flat, no incidents in lookbackDays and rig has service history
  successfulInspectionBonus: 5, // flat, inspected within lookbackDays with zero incidents since
  inspectionSessionThreshold: 15, // sessions since inspection that trigger a request
  inspectionDaysThreshold: 30, // days since inspection that trigger a request
  repeatIncidentThreshold: 3, // same-group incidents within repeatWindowDays to flag a pattern
} as const;

const REPAIR_TRACK_STATUSES = new Set<RigIncident["status"]>(["triage", "inspection", "repair", "testing"]);
const OPEN_STATUSES = new Set<RigIncident["status"]>(["open", "triage", "inspection", "repair", "testing"]);

export interface ScoreDelta {
  label: string;
  delta: number;
}

export interface RigCategoryScore {
  key: "physical" | "electronics" | "recording" | "power" | "reliability";
  label: string;
  value: number;
}

export interface RigHealth {
  score: number;
  breakdown: ScoreDelta[];
  categories: RigCategoryScore[];
}

function daysAgo(n: number): number {
  return Date.now() - n * 86_400_000;
}

function incidentsForRig(data: CityData, rigId: string): RigIncident[] {
  return data.rigIncidents.filter((i) => i.rigId === rigId);
}

/** Deterministic health score (0-100) for one rig, built entirely from its
 * own incident/repair/inspection history. See RIG_SCORE_CONFIG for weights. */
export function computeRigHealth(data: CityData, rig: Rig): RigHealth {
  const cfg = RIG_SCORE_CONFIG;
  const incidents = incidentsForRig(data, rig.id);
  const lookbackStart = daysAgo(cfg.lookbackDays);
  const repeatStart = daysAgo(cfg.repeatWindowDays);
  const recent = incidents.filter((i) => new Date(i.discoveredAt).getTime() >= lookbackStart);

  const breakdown: ScoreDelta[] = [];

  const warn = recent.filter((i) => i.severity === "warning");
  const crit = recent.filter((i) => i.severity === "critical");
  const att = recent.filter((i) => i.severity === "attention");
  if (crit.length) breakdown.push({ label: `${crit.length} critical incident${crit.length === 1 ? "" : "s"}`, delta: cfg.criticalIncident * crit.length });
  if (warn.length) breakdown.push({ label: `${warn.length} recent incident${warn.length === 1 ? "" : "s"}`, delta: cfg.recentIncident * warn.length });
  if (att.length) breakdown.push({ label: `${att.length} minor incident${att.length === 1 ? "" : "s"}`, delta: cfg.attentionIncident * att.length });

  const repeatWindow = incidents.filter((i) => new Date(i.discoveredAt).getTime() >= repeatStart);
  const byGroup = new Map<DamageGroup, RigIncident[]>();
  for (const i of repeatWindow) byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i]);
  let repeatedPenaltyCount = 0;
  for (const list of byGroup.values()) if (list.length >= 2) repeatedPenaltyCount += list.length - 1;
  if (repeatedPenaltyCount > 0) {
    breakdown.push({ label: "Repeated incidents in the same area", delta: cfg.repeatedIncidentSameGroup * repeatedPenaltyCount });
  }

  const activeRepairTrack = incidents.some((i) => REPAIR_TRACK_STATUSES.has(i.status));
  if (activeRepairTrack) breakdown.push({ label: "Repair required", delta: cfg.repairRequired });

  const inspection = needsInspection(data, rig);
  if (inspection.required) breakdown.push({ label: "Inspection overdue", delta: cfg.inspectionOverdue });

  const repairs = data.repairRecords.filter((r) => r.rigId === rig.id);
  let afterRepairCount = 0;
  for (const repair of repairs) {
    const repairTime = new Date(repair.repairedAt).getTime();
    afterRepairCount += incidents.filter((i) => {
      const t = new Date(i.discoveredAt).getTime();
      return t > repairTime && t <= repairTime + cfg.repeatWindowDays * 86_400_000;
    }).length;
  }
  if (afterRepairCount > 0) {
    breakdown.push({ label: "Repeated failure after repair", delta: cfg.repeatedFailureAfterRepair * afterRepairCount });
  }

  const lastIncidentTime = incidents.length ? Math.max(...incidents.map((i) => new Date(i.discoveredAt).getTime())) : null;
  const rigAgeMs = Date.now() - new Date(rig.createdAt).getTime();
  if ((lastIncidentTime === null || lastIncidentTime < lookbackStart) && rigAgeMs > cfg.lookbackDays * 86_400_000) {
    breakdown.push({ label: "Long healthy operating period", delta: cfg.longHealthyStreakBonus });
  }
  if (rig.lastInspectionAt) {
    const daysSinceInspection = (Date.now() - new Date(rig.lastInspectionAt).getTime()) / 86_400_000;
    const incidentsSinceInspection = incidents.filter((i) => new Date(i.discoveredAt).getTime() > new Date(rig.lastInspectionAt!).getTime()).length;
    if (daysSinceInspection <= cfg.lookbackDays && incidentsSinceInspection === 0) {
      breakdown.push({ label: "Successful inspection", delta: cfg.successfulInspectionBonus });
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(100 + breakdown.reduce((s, d) => s + d.delta, 0))));

  function groupScore(groups: DamageGroup[]): number {
    let deduction = 0;
    for (const i of recent) {
      if (!groups.includes(i.group)) continue;
      deduction += i.severity === "critical" ? 30 : i.severity === "warning" ? 15 : 6;
    }
    return Math.max(0, Math.min(100, 100 - deduction));
  }

  const physical = groupScore(["physical"]);
  const power = groupScore(["electrical"]);
  const electronics = groupScore(["camera"]);
  const recording = groupScore(["storage", "recording"]);
  let reliabilityDeduction = 100 - groupScore(["other"]);
  if (activeRepairTrack) reliabilityDeduction += 20;
  if (inspection.required) reliabilityDeduction += 10;
  reliabilityDeduction += repeatedPenaltyCount * 10;
  const reliability = Math.max(0, Math.min(100, 100 - reliabilityDeduction));

  const categories: RigCategoryScore[] = [
    { key: "physical", label: "Physical", value: physical },
    { key: "electronics", label: "Electronics", value: electronics },
    { key: "recording", label: "Recording", value: recording },
    { key: "power", label: "Power", value: power },
    { key: "reliability", label: "Reliability", value: reliability },
  ];

  return { score, breakdown, categories };
}

function worstDeltaReason(breakdown: ScoreDelta[]): string {
  const negatives = [...breakdown].filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta);
  if (negatives.length === 0) return "Operating within normal parameters.";
  return `${negatives[0].label}.`;
}

export interface RigReadiness {
  status: RigReadinessStatus;
  reason: string;
  overridden: boolean;
}

/** Combines manual overrides, lifecycle status, unresolved critical
 * incidents, and the health score into one readiness verdict. Order of
 * precedence matches spec #4. */
export function deriveRigReadiness(data: CityData, rig: Rig, health: RigHealth): RigReadiness {
  if (rig.deploymentStatus === "retired") {
    return { status: "do_not_deploy", reason: "Rig has been retired.", overridden: false };
  }
  if (rig.deploymentStatus === "repair") {
    return { status: "in_repair", reason: "Rig is currently in repair.", overridden: false };
  }
  if (rig.deploymentStatus === "inspection") {
    return { status: "inspection_required", reason: "Rig is pulled for inspection.", overridden: false };
  }
  if (rig.statusOverride) {
    return { status: rig.statusOverride, reason: rig.statusOverrideReason || "Manually set by operator.", overridden: true };
  }
  const criticalOpen = incidentsForRig(data, rig.id).find((i) => i.severity === "critical" && OPEN_STATUSES.has(i.status));
  if (criticalOpen) {
    return { status: "do_not_deploy", reason: `${categoryLabel(criticalOpen.category)} reported.`, overridden: false };
  }
  if (health.score >= 80) return { status: "healthy", reason: "Healthy operating history.", overridden: false };
  if (health.score >= 60) return { status: "watch", reason: worstDeltaReason(health.breakdown), overridden: false };
  if (health.score >= 40) return { status: "inspection_required", reason: worstDeltaReason(health.breakdown), overridden: false };
  return { status: "do_not_deploy", reason: worstDeltaReason(health.breakdown), overridden: false };
}

export function isDeployable(status: RigReadinessStatus): boolean {
  return status !== "do_not_deploy" && status !== "in_repair";
}

export function countsAsReadyCapacity(status: RigReadinessStatus): boolean {
  return status === "healthy";
}

export interface InspectionCheck {
  required: boolean;
  reasons: string[];
}

export function needsInspection(data: CityData, rig: Rig): InspectionCheck {
  const cfg = RIG_SCORE_CONFIG;
  const reasons: string[] = [];
  if (rig.inspectionRequestedAt) reasons.push("Inspection manually requested.");

  const sessions = data.sessions.filter(
    (s) => s.rigId === rig.id && (!rig.lastInspectionAt || new Date(s.startedAt).getTime() > new Date(rig.lastInspectionAt).getTime()),
  );
  if (sessions.length > cfg.inspectionSessionThreshold) {
    reasons.push(`${sessions.length} sessions since last inspection (threshold ${cfg.inspectionSessionThreshold}).`);
  }

  const referenceDate = rig.lastInspectionAt ?? rig.createdAt;
  const daysSince = (Date.now() - new Date(referenceDate).getTime()) / 86_400_000;
  if (daysSince > cfg.inspectionDaysThreshold) {
    reasons.push(`${Math.round(daysSince)} days since last inspection.`);
  }

  const recentIncidents = data.rigIncidents.filter((i) => i.rigId === rig.id && new Date(i.discoveredAt).getTime() >= daysAgo(7));
  if (recentIncidents.length >= 2) reasons.push(`${recentIncidents.length} incidents in the last 7 days.`);

  const criticalOpen = data.rigIncidents.some((i) => i.rigId === rig.id && i.severity === "critical" && OPEN_STATUSES.has(i.status));
  if (criticalOpen) reasons.push("Critical incident on record.");

  return { required: reasons.length > 0, reasons };
}

export interface FailurePattern {
  message: string;
  recommendation: string;
  severity: Severity;
}

/** Detects repeating failure patterns per spec #10 — same-group clusters on
 * one rig, and outlier incident frequency vs. the fleet (only when enough
 * fleet history exists to make the comparison honest). */
export function detectRepeatedFailures(data: CityData, rig: Rig): FailurePattern[] {
  const cfg = RIG_SCORE_CONFIG;
  const patterns: FailurePattern[] = [];
  const incidents = incidentsForRig(data, rig.id);
  const repeatStart = daysAgo(cfg.repeatWindowDays);

  const byGroup = new Map<DamageGroup, RigIncident[]>();
  for (const i of incidents) {
    if (new Date(i.discoveredAt).getTime() < repeatStart) continue;
    byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i]);
  }
  for (const [group, list] of byGroup) {
    if (list.length >= cfg.repeatIncidentThreshold) {
      const label = DAMAGE_GROUP_LABELS[group].toLowerCase();
      patterns.push({
        message: `${list.length} ${label} incidents on ${rig.code} in ${cfg.repeatWindowDays} days.`,
        recommendation: group === "physical" ? "Inspect or replace the cable/connector assembly." : `Inspect ${label} components before next deployment.`,
        severity: "critical",
      });
    }
  }

  const lookbackStart = daysAgo(cfg.lookbackDays);
  const rigCount30d = incidents.filter((i) => new Date(i.discoveredAt).getTime() >= lookbackStart).length;
  const fleetRigsWithHistory = data.rigs.filter((r) => data.rigIncidents.some((i) => i.rigId === r.id));
  if (fleetRigsWithHistory.length >= 3) {
    const fleetAvg =
      fleetRigsWithHistory.reduce((sum, r) => sum + data.rigIncidents.filter((i) => i.rigId === r.id && new Date(i.discoveredAt).getTime() >= lookbackStart).length, 0) /
      fleetRigsWithHistory.length;
    if (rigCount30d >= 3 && fleetAvg > 0 && rigCount30d > fleetAvg * 2) {
      patterns.push({
        message: `${rig.code} has ${rigCount30d} incidents in the last ${cfg.lookbackDays} days, compared with a city average of ${fleetAvg.toFixed(1)}.`,
        recommendation: "Send for full inspection.",
        severity: "critical",
      });
    }
  }

  return patterns;
}

export function computeRigLostHours(data: CityData, rigId?: string, todayDate?: string): { today: number; week: number; month: number } {
  const date = todayDate ?? todayISO();
  const incidents = rigId ? data.rigIncidents.filter((i) => i.rigId === rigId) : data.rigIncidents;
  const sumOf = (list: RigIncident[]) => Math.round(list.reduce((s, i) => s + (i.lostHours ?? 0), 0) * 100) / 100;
  return {
    today: sumOf(incidents.filter((i) => i.discoveredAt.slice(0, 10) === date)),
    week: sumOf(incidents.filter((i) => new Date(i.discoveredAt).getTime() >= daysAgo(7))),
    month: sumOf(incidents.filter((i) => new Date(i.discoveredAt).getTime() >= daysAgo(30))),
  };
}

/** Best-effort estimate for how much recording time an incident cost,
 * shown editable in the report form — never silently invented beyond a
 * sane category default. */
export function estimateIncidentLostHours(
  data: CityData,
  params: { assignmentId?: string; severity: Severity; discoveredAt: string },
): number {
  const base = { critical: 1, warning: 0.4, attention: 0.15, opportunity: 0 }[params.severity];
  if (!params.assignmentId || params.severity !== "critical") return base;
  const assignment = data.assignments.find((a) => a.id === params.assignmentId);
  if (!assignment) return base;
  const remainMs = new Date(assignment.plannedEnd).getTime() - new Date(params.discoveredAt).getTime();
  if (remainMs <= 0) return base;
  return Math.max(base, Math.round((remainMs / 3_600_000) * 100) / 100);
}

export interface RigSummary {
  rig: Rig;
  score: number;
  scoreBreakdown: ScoreDelta[];
  categories: RigCategoryScore[];
  readiness: RigReadinessStatus;
  readinessReason: string;
  overridden: boolean;
  deployable: boolean;
  incidentCount30d: number;
  openIncidents: RigIncident[];
  criticalOpenIncident?: RigIncident;
  repairCount: number;
  lostHours: { today: number; week: number; month: number };
  sessionsSinceInspection: number;
  hoursSinceInspection: number;
  inspection: InspectionCheck;
  repeatedFailures: FailurePattern[];
  /** Advisory-only AI QA findings from recent evidence captured on this rig
   * (spec Phase 22) — never factored into `score`; a real safety event
   * already reaches the score via reportRigIncident on precheck failure.
   * This is a softer, separate signal for the Manager to notice a pattern. */
  evidenceSignals: RigEvidenceSignal[];
}

export function buildRigSummary(data: CityData, rig: Rig): RigSummary {
  const health = computeRigHealth(data, rig);
  const readiness = deriveRigReadiness(data, rig, health);
  const incidents = incidentsForRig(data, rig.id);
  const incidentCount30d = incidents.filter((i) => new Date(i.discoveredAt).getTime() >= daysAgo(RIG_SCORE_CONFIG.lookbackDays)).length;
  const openIncidents = incidents.filter((i) => OPEN_STATUSES.has(i.status)).sort((a, b) => new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime());
  const criticalOpenIncident = openIncidents.find((i) => i.severity === "critical");
  const repairCount = data.repairRecords.filter((r) => r.rigId === rig.id).length;
  const lostHours = computeRigLostHours(data, rig.id);
  const rigSessions = data.sessions.filter((s) => s.rigId === rig.id);
  const sinceInspection = rigSessions.filter((s) => !rig.lastInspectionAt || new Date(s.startedAt).getTime() > new Date(rig.lastInspectionAt).getTime());
  const hoursSinceInspection =
    Math.round(
      sinceInspection.reduce((sum, s) => (s.endedAt ? sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3_600_000 : sum), 0) * 10,
    ) / 10;

  return {
    rig,
    score: health.score,
    scoreBreakdown: health.breakdown,
    categories: health.categories,
    readiness: readiness.status,
    readinessReason: readiness.reason,
    overridden: readiness.overridden,
    deployable: isDeployable(readiness.status),
    incidentCount30d,
    openIncidents,
    criticalOpenIncident,
    repairCount,
    lostHours,
    sessionsSinceInspection: sinceInspection.length,
    hoursSinceInspection,
    inspection: needsInspection(data, rig),
    repeatedFailures: detectRepeatedFailures(data, rig),
    evidenceSignals: recentEvidenceSignalsForRig(data, rig.id),
  };
}

export function buildFleetRanking(data: CityData): RigSummary[] {
  return data.rigs
    .filter((r) => r.deploymentStatus !== "retired")
    .map((r) => buildRigSummary(data, r))
    .sort((a, b) => b.score - a.score);
}

/** Rough deployment demand for a date: the plan's own distinct-FO count if
 * a plan already exists, else the size of the active FO roster as a stand-in
 * for "how many rigs could plausibly be needed." */
export function computeRequiredRigs(data: CityData, date: string): number {
  const assignments = data.assignments.filter((a) => a.date === date && a.status !== "cancelled");
  if (assignments.length > 0) return new Set(assignments.map((a) => a.foId)).size;
  return data.fos.filter((f) => f.active).length;
}

export interface FleetReadiness {
  date: string;
  total: number;
  healthy: number;
  watch: number;
  inspectionRequired: number;
  doNotDeploy: number;
  inRepair: number;
  standby: number;
  retired: number;
  requiredToday: number;
  readyCount: number;
  buffer: number;
  status: "ready" | "at_risk";
  statusMessage: string;
}

export function buildFleetReadiness(data: CityData, date: string, summaries?: RigSummary[]): FleetReadiness {
  const list = summaries ?? data.rigs.map((r) => buildRigSummary(data, r));
  const nonRetired = list.filter((s) => s.rig.deploymentStatus !== "retired");
  const healthy = nonRetired.filter((s) => s.readiness === "healthy").length;
  const watch = nonRetired.filter((s) => s.readiness === "watch").length;
  const inspectionRequired = nonRetired.filter((s) => s.readiness === "inspection_required").length;
  const inRepair = nonRetired.filter((s) => s.readiness === "in_repair").length;
  const doNotDeployOnly = nonRetired.filter((s) => s.readiness === "do_not_deploy").length;
  const standby = nonRetired.filter((s) => s.rig.deploymentStatus === "standby" && isDeployable(s.readiness)).length;
  const retired = list.length - nonRetired.length;
  const requiredToday = computeRequiredRigs(data, date);
  const readyCount = healthy;
  const buffer = readyCount - requiredToday;
  const status: FleetReadiness["status"] = readyCount >= requiredToday ? "ready" : "at_risk";
  const statusMessage =
    status === "ready"
      ? "CITY HAS HEALTHY RIG CAPACITY"
      : `${requiredToday} rig${requiredToday === 1 ? "" : "s"} required, only ${readyCount} deployment-ready.`;

  return {
    date,
    total: nonRetired.length,
    healthy,
    watch,
    inspectionRequired,
    doNotDeploy: doNotDeployOnly + inRepair,
    inRepair,
    standby,
    retired,
    requiredToday,
    readyCount,
    buffer,
    status,
    statusMessage,
  };
}

export interface FailureAnalysisSlice {
  group: DamageGroup;
  label: string;
  count: number;
  pct: number;
  lostHours: number;
}

export interface FailureAnalysis {
  breakdown: FailureAnalysisSlice[];
  totalIncidents: number;
  biggest?: FailureAnalysisSlice;
  recommendedAction?: string;
}

const RECOMMENDATION_BY_GROUP: Record<DamageGroup, string> = {
  physical: "Inspect all active rig cables and connectors before tomorrow.",
  electrical: "Check battery and charging equipment across the fleet.",
  camera: "Inspect camera mounts and connections across the fleet.",
  storage: "Audit storage cards and clear or replace failing ones.",
  recording: "Run a recording test on all deployed rigs before tomorrow.",
  other: "Review recent incident reports for a common cause.",
};

export function buildCityFailureAnalysis(data: CityData, days = 30): FailureAnalysis {
  const start = daysAgo(days);
  const incidents = data.rigIncidents.filter((i) => new Date(i.discoveredAt).getTime() >= start);
  const total = incidents.length;
  const counts = new Map<DamageGroup, number>();
  const lost = new Map<DamageGroup, number>();
  for (const i of incidents) {
    counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    lost.set(i.group, (lost.get(i.group) ?? 0) + (i.lostHours ?? 0));
  }
  const breakdown = [...counts.entries()]
    .map(([group, count]) => ({
      group,
      label: DAMAGE_GROUP_LABELS[group],
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
      lostHours: Math.round((lost.get(group) ?? 0) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  const biggest = breakdown[0];
  return {
    breakdown,
    totalIncidents: total,
    biggest,
    recommendedAction: biggest ? RECOMMENDATION_BY_GROUP[biggest.group] : undefined,
  };
}

export interface FailureRateMetrics {
  incidentsPerRig: number;
  incidentsPer100Sessions: number;
  damageRatePct: number;
  repeatFailureRatePct: number;
  avgDowntimeHours: number | null;
  avgRepairTurnaroundHours: number | null;
}

export function computeFailureRateMetrics(data: CityData, days = 30): FailureRateMetrics {
  const start = daysAgo(days);
  const incidents = data.rigIncidents.filter((i) => new Date(i.discoveredAt).getTime() >= start);
  const sessions = data.sessions.filter((s) => new Date(s.startedAt).getTime() >= start);
  const rigsCount = data.rigs.filter((r) => r.deploymentStatus !== "retired").length || 1;

  const byRig = new Map<string, number>();
  for (const i of incidents) byRig.set(i.rigId, (byRig.get(i.rigId) ?? 0) + 1);
  const rigsWithHistory = byRig.size;
  const repeatOffenders = [...byRig.values()].filter((c) => c >= 2).length;

  const sessionsWithIncident = new Set(incidents.filter((i) => i.sessionId).map((i) => i.sessionId)).size;

  const resolved = data.rigIncidents.filter((i) => i.status === "resolved" && i.resolvedAt);
  const repairs = data.repairRecords;

  return {
    incidentsPerRig: Math.round((incidents.length / rigsCount) * 10) / 10,
    incidentsPer100Sessions: sessions.length ? Math.round((incidents.length / sessions.length) * 1000) / 10 : 0,
    damageRatePct: sessions.length ? Math.round((sessionsWithIncident / sessions.length) * 1000) / 10 : 0,
    repeatFailureRatePct: rigsWithHistory ? Math.round((repeatOffenders / rigsWithHistory) * 1000) / 10 : 0,
    avgDowntimeHours: resolved.length
      ? Math.round((resolved.reduce((s, i) => s + (new Date(i.resolvedAt!).getTime() - new Date(i.discoveredAt).getTime()) / 3_600_000, 0) / resolved.length) * 10) / 10
      : null,
    avgRepairTurnaroundHours: repairs.length
      ? Math.round((repairs.reduce((s, r) => s + (new Date(r.repairedAt).getTime() - new Date(r.createdAt).getTime()) / 3_600_000, 0) / repairs.length) * 10) / 10
      : null,
  };
}

export interface RigReplacement {
  rig: Rig;
  reasons: string[];
}

/** Health-ranked, availability-checked replacement for a rig that has
 * become unsafe/unavailable for a given time window. */
export function proposeRigReplacement(data: CityData, date: string, unsafeRigId: string, plannedStart: string, plannedEnd: string): RigReplacement | null {
  const busy = new Set(
    data.assignments
      .filter((a) => a.date === date && a.status !== "cancelled" && a.rigId && a.rigId !== unsafeRigId && overlaps(a.plannedStart, a.plannedEnd, plannedStart, plannedEnd))
      .map((a) => a.rigId),
  );
  const candidates = data.rigs
    .filter((r) => r.id !== unsafeRigId && r.deploymentStatus !== "retired" && !busy.has(r.id))
    .map((r) => buildRigSummary(data, r))
    .filter((s) => s.deployable)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return null;
  return {
    rig: best.rig,
    reasons: [best.readiness === "healthy" ? "Healthy" : `${best.score}/100 health`, "Available", "Compatible", "No scheduling conflict"],
  };
}

export interface RetirementAssessment {
  recommend: boolean;
  label: string;
  reasons: string[];
}

export function assessRetirement(data: CityData, rig: Rig, summary?: RigSummary): RetirementAssessment {
  const s = summary ?? buildRigSummary(data, rig);
  const incidents90 = data.rigIncidents.filter((i) => i.rigId === rig.id && new Date(i.discoveredAt).getTime() >= daysAgo(90)).length;
  const repairs = data.repairRecords.filter((r) => r.rigId === rig.id).length;
  const reasons: string[] = [];
  let recommend = false;

  if (incidents90 >= 4 && repairs >= 2 && s.score < 50) {
    recommend = true;
    reasons.push(`${incidents90} incidents and ${repairs} repairs in the last 90 days.`);
    reasons.push(`Health score remains low (${s.score}/100) even after repair.`);
  } else if (s.repeatedFailures.length > 0 && repairs >= 1) {
    reasons.push("Repeated failures continue after a repair — worth a closer look.");
  } else {
    reasons.push("No pattern of repeated failure after repair yet.");
  }

  return { recommend, label: recommend ? "REVIEW FOR RETIREMENT" : "Monitor", reasons };
}
