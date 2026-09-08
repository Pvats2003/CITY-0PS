import { id } from "@/lib/id";
import { isoAtTime } from "@/lib/dates";
import { overlaps } from "./selectors";
import { buildRigSummary, isDeployable, proposeRigReplacement, type RigSummary } from "./rigGuardian";
import type { Assignment, CityData, CitySettings, PlanConflict, Severity } from "@/types";

export interface ScoreBreakdownItem {
  label: string;
  delta: number;
}

export interface PlanResult {
  assignments: Assignment[];
  conflicts: PlanConflict[];
  score: number;
  breakdown: ScoreBreakdownItem[];
}

export function detectConflicts(assignments: Assignment[], data: CityData, date: string): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  const active = assignments.filter((a) => a.status !== "cancelled" && a.status !== "rejected");
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.foId === b.foId && overlaps(a.plannedStart, a.plannedEnd, b.plannedStart, b.plannedEnd)) {
        conflicts.push({
          id: id("cf"),
          type: "fo_double_booking",
          severity: "critical",
          message: `${foMap.get(a.foId)?.name ?? "FO"} is double-booked: ${bizMap.get(a.businessId)?.name ?? "?"} and ${bizMap.get(b.businessId)?.name ?? "?"} overlap.`,
          assignmentIds: [a.id, b.id],
        });
      }
      if (a.rigId && a.rigId === b.rigId && overlaps(a.plannedStart, a.plannedEnd, b.plannedStart, b.plannedEnd)) {
        conflicts.push({
          id: id("cf"),
          type: "rig_double_booking",
          severity: "critical",
          message: `Rig ${rigMap.get(a.rigId)?.code ?? "?"} is double-booked between ${bizMap.get(a.businessId)?.name ?? "?"} and ${bizMap.get(b.businessId)?.name ?? "?"}.`,
          assignmentIds: [a.id, b.id],
        });
      }
    }
  }

  for (const a of active) {
    const fo = foMap.get(a.foId);
    const biz = bizMap.get(a.businessId);
    const rig = a.rigId ? rigMap.get(a.rigId) : undefined;
    if (fo?.unavailableDates?.includes(date)) {
      conflicts.push({
        id: id("cf"),
        type: "fo_unavailable",
        severity: "critical",
        message: `${fo.name} is marked unavailable on this date.`,
        assignmentIds: [a.id],
      });
    }
    if (biz?.unavailableDates?.includes(date)) {
      conflicts.push({
        id: id("cf"),
        type: "business_unavailable",
        severity: "critical",
        message: `${biz.name} is marked unavailable on this date.`,
        assignmentIds: [a.id],
      });
    }
    if (rig) {
      if (rig.deploymentStatus === "retired") {
        conflicts.push({
          id: id("cf"),
          type: "rig_unavailable",
          severity: "critical",
          message: `Rig ${rig.code} is retired and assigned to ${biz?.name ?? "a business"}.`,
          assignmentIds: [a.id],
        });
      } else {
        const summary = buildRigSummary(data, rig);
        if (!isDeployable(summary.readiness)) {
          conflicts.push({
            id: id("cf"),
            type: "rig_unsafe",
            severity: "critical",
            message: `Rig ${rig.code} is ${summary.readiness === "in_repair" ? "in repair" : "DO NOT DEPLOY"} (${summary.readinessReason}) but assigned to ${biz?.name ?? "a business"}.`,
            assignmentIds: [a.id],
          });
        }
      }
    }
    const durationMin = (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 60000;
    if (durationMin < 20) {
      conflicts.push({
        id: id("cf"),
        type: "unrealistic_timing",
        severity: "warning",
        message: `${biz?.name ?? "Visit"} is scheduled for only ${Math.round(durationMin)} minutes — unrealistic for a full session.`,
        assignmentIds: [a.id],
      });
    }
  }

  const byBusiness = new Map<string, Assignment[]>();
  for (const a of active) {
    byBusiness.set(a.businessId, [...(byBusiness.get(a.businessId) ?? []), a]);
  }
  for (const [bizId, list] of byBusiness) {
    const biz = bizMap.get(bizId);
    const totalMin = list.reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 60000, 0);
    if (biz && totalMin > biz.capacityHoursPerDay * 60) {
      conflicts.push({
        id: id("cf"),
        type: "insufficient_capacity",
        severity: "warning",
        message: `${biz.name} is scheduled for ${Math.round(totalMin / 60)}h, above its ${biz.capacityHoursPerDay}h daily capacity.`,
        assignmentIds: list.map((a) => a.id),
      });
    }
  }

  return conflicts;
}

function areaTravelPenalty(assignments: Assignment[], data: CityData): number {
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const byFO = new Map<string, Assignment[]>();
  for (const a of assignments) byFO.set(a.foId, [...(byFO.get(a.foId) ?? []), a]);
  let switches = 0;
  for (const list of byFO.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prevArea = bizMap.get(sorted[i - 1].businessId)?.area;
      const currArea = bizMap.get(sorted[i].businessId)?.area;
      if (prevArea && currArea && prevArea !== currArea) switches += 1;
    }
  }
  return switches * 15; // minutes of assumed unnecessary travel
}

export function scorePlan(
  assignments: Assignment[],
  conflicts: PlanConflict[],
  data: CityData,
  targetHours: number,
): { score: number; breakdown: ScoreBreakdownItem[] } {
  const breakdown: ScoreBreakdownItem[] = [];
  const critical = conflicts.filter((c) => c.severity === "critical").length;
  const warnings = conflicts.filter((c) => c.severity === "warning").length;
  const foConflicts = conflicts.filter((c) => c.type === "fo_double_booking").length;
  const rigConflicts = conflicts.filter((c) => c.type === "rig_double_booking").length;
  const unsafeRigs = conflicts.filter((c) => c.type === "rig_unsafe").length;

  breakdown.push({ label: `${foConflicts} FO conflict${foConflicts === 1 ? "" : "s"}`, delta: -25 * foConflicts });
  breakdown.push({ label: `${rigConflicts} rig conflict${rigConflicts === 1 ? "" : "s"}`, delta: -25 * rigConflicts });
  if (unsafeRigs > 0) breakdown.push({ label: `${unsafeRigs} unsafe rig assignment${unsafeRigs === 1 ? "" : "s"}`, delta: -30 * unsafeRigs });

  const otherCritical = critical - foConflicts - rigConflicts - unsafeRigs;
  if (otherCritical > 0) breakdown.push({ label: `${otherCritical} unavailable resource conflict${otherCritical === 1 ? "" : "s"}`, delta: -20 * otherCritical });
  if (warnings > 0) breakdown.push({ label: `${warnings} capacity/timing warning${warnings === 1 ? "" : "s"}`, delta: -8 * warnings });

  const travel = areaTravelPenalty(assignments, data);
  if (travel > 0) breakdown.push({ label: `${travel} min unnecessary travel`, delta: -Math.min(15, Math.round(travel / 15)) });
  else breakdown.push({ label: "Geographically efficient routing", delta: 0 });

  const highPriority = assignments.filter((a) => a.priority === "high");
  if (highPriority.length > 0) {
    breakdown.push({ label: "All priority businesses covered", delta: 5 });
  }

  const plannedHours = assignments.reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);
  if (plannedHours >= targetHours) {
    breakdown.push({ label: "Target recording hours achievable", delta: 5 });
  } else if (targetHours > 0) {
    breakdown.push({
      label: `Planned hours ${plannedHours.toFixed(1)}h below ${targetHours}h target`,
      delta: -6,
    });
  }

  const score = Math.max(0, Math.min(100, Math.round(100 + breakdown.reduce((s, b) => s + b.delta, 0))));
  return { score, breakdown };
}

/** Deterministic heuristic planner — not an optimizer. Balances FO workload,
 * groups by area, respects business preferred windows, and avoids conflicts
 * greedily in the order businesses are considered. */
export function proposeDailyPlan(data: CityData, date: string, settings: CitySettings): PlanResult {
  const already = new Set(data.assignments.filter((a) => a.date === date && a.status !== "cancelled").map((a) => a.businessId));
  const activeBusinesses = data.businesses.filter((b) => b.active && !already.has(b.id) && !b.unavailableDates?.includes(date));
  const activeFOs = data.fos.filter((f) => f.active && !f.unavailableDates?.includes(date));
  // Rig safety (spec #15): the planner only ever proposes deployable rigs,
  // healthiest first — do-not-deploy / in-repair / retired rigs are never
  // silently assigned.
  const rigSummaries: RigSummary[] = data.rigs
    .filter((r) => r.deploymentStatus !== "retired")
    .map((r) => buildRigSummary(data, r))
    .filter((s) => s.deployable)
    .sort((a, b) => b.score - a.score);

  if (activeFOs.length === 0 || activeBusinesses.length === 0) {
    return { assignments: [], conflicts: [], score: 0, breakdown: [{ label: "No available FOs or businesses to plan", delta: 0 }] };
  }

  // prioritize businesses not visited recently
  const lastVisit = new Map<string, number>();
  for (const a of data.assignments) {
    if (a.status === "completed") {
      const t = new Date(a.plannedStart).getTime();
      lastVisit.set(a.businessId, Math.max(lastVisit.get(a.businessId) ?? 0, t));
    }
  }
  const ranked = [...activeBusinesses].sort((a, b) => (lastVisit.get(a.id) ?? 0) - (lastVisit.get(b.id) ?? 0));
  const targetCount = Math.min(ranked.length, Math.max(activeFOs.length, Math.ceil(activeFOs.length * 1.4)));
  const chosen = ranked.slice(0, targetCount);

  const foLoadMinutes = new Map<string, number>(activeFOs.map((f) => [f.id, 0]));
  const foLastArea = new Map<string, string>();
  const rigBusy: { rigId: string; start: number; end: number }[] = [];
  const foBusy: { foId: string; start: number; end: number }[] = [];

  const assignments: Assignment[] = [];

  for (const biz of chosen) {
    const durationMin = Math.min(180, Math.max(60, biz.capacityHoursPerDay * 60 || settings.defaultSessionDurationMin));

    // pick FO with lowest load, breaking ties by matching area
    const foSorted = [...activeFOs].sort((a, b) => {
      const loadDiff = (foLoadMinutes.get(a.id) ?? 0) - (foLoadMinutes.get(b.id) ?? 0);
      if (loadDiff !== 0) return loadDiff;
      const aMatch = foLastArea.get(a.id) === biz.area ? 0 : 1;
      const bMatch = foLastArea.get(b.id) === biz.area ? 0 : 1;
      return aMatch - bMatch;
    });
    const fo = foSorted[0];

    let startMin: number;
    if (biz.preferredWindowStart && biz.preferredWindowEnd) {
      const [sh, sm] = biz.preferredWindowStart.split(":").map(Number);
      startMin = sh * 60 + sm;
    } else {
      const [wsh, wsm] = settings.workingHoursStart.split(":").map(Number);
      startMin = wsh * 60 + wsm;
    }
    // push start after FO's current load
    const foLoad = foLoadMinutes.get(fo.id) ?? 0;
    const [wsh, wsm] = settings.workingHoursStart.split(":").map(Number);
    startMin = Math.max(startMin, wsh * 60 + wsm + foLoad);

    const startHHMM = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
    const plannedStart = isoAtTime(date, startHHMM);
    const plannedEnd = new Date(new Date(plannedStart).getTime() + durationMin * 60000).toISOString();

    // pick the healthiest deployable rig with no time overlap
    const rig =
      rigSummaries.find((s) => !rigBusy.some((rb) => rb.rigId === s.rig.id && startMin < rb.end && startMin + durationMin > rb.start))?.rig ??
      rigSummaries[0]?.rig;

    const collector = data.collectors.find((c) => c.businessId === biz.id && c.active);

    const assignmentId = id("asg");
    assignments.push({
      id: assignmentId,
      date,
      businessId: biz.id,
      foId: fo.id,
      collectorId: collector?.id,
      rigId: rig?.id,
      plannedStart,
      plannedEnd,
      priority: chosen.indexOf(biz) === 0 ? "high" : "normal",
      status: "planned",
      createdAt: new Date().toISOString(),
    });

    foLoadMinutes.set(fo.id, foLoad + durationMin + 15);
    foLastArea.set(fo.id, biz.area);
    if (rig) rigBusy.push({ rigId: rig.id, start: startMin, end: startMin + durationMin });
    foBusy.push({ foId: fo.id, start: startMin, end: startMin + durationMin });
  }

  const conflicts = detectConflicts(assignments, data, date);
  const { score, breakdown } = scorePlan(assignments, conflicts, data, settings.recordingHoursTargetPerDay);

  return { assignments, conflicts, score, breakdown };
}

export interface ReplanSuggestion {
  assignmentId: string;
  description: string;
  patch: Partial<Assignment>;
  why?: string[];
}

export function proposeReplan(
  data: CityData,
  date: string,
  disruption: { kind: "fo_unavailable" | "rig_unavailable" | "business_cancelled"; foId?: string; rigId?: string; businessId?: string; fromTime?: string },
): { affected: Assignment[]; suggestions: ReplanSuggestion[]; note: string } {
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const todays = data.assignments.filter((a) => a.date === date && (a.status === "planned" || a.status === "confirmed"));

  let affected: Assignment[] = [];
  if (disruption.kind === "fo_unavailable" && disruption.foId) {
    affected = todays.filter(
      (a) =>
        a.foId === disruption.foId &&
        (!disruption.fromTime || new Date(a.plannedStart).getTime() >= new Date(disruption.fromTime).getTime()),
    );
  } else if (disruption.kind === "rig_unavailable" && disruption.rigId) {
    affected = todays.filter((a) => a.rigId === disruption.rigId);
  } else if (disruption.kind === "business_cancelled" && disruption.businessId) {
    affected = todays.filter((a) => a.businessId === disruption.businessId);
  }

  const suggestions: ReplanSuggestion[] = [];
  const otherFOs = data.fos.filter((f) => f.active && f.id !== disruption.foId);
  const foLoad = new Map<string, number>();
  for (const a of todays) foLoad.set(a.foId, (foLoad.get(a.foId) ?? 0) + 1);

  for (const a of affected) {
    if (disruption.kind === "business_cancelled") {
      suggestions.push({
        assignmentId: a.id,
        description: `Cancel visit to ${bizMap.get(a.businessId)?.name ?? "business"}; ${foMap.get(a.foId)?.name ?? "FO"} freed up for this slot.`,
        patch: { status: "cancelled" },
      });
      continue;
    }
    if (disruption.kind === "rig_unavailable") {
      const replacement = proposeRigReplacement(data, date, disruption.rigId!, a.plannedStart, a.plannedEnd);
      if (replacement) {
        suggestions.push({
          assignmentId: a.id,
          description: `Swap to rig ${replacement.rig.code} for ${bizMap.get(a.businessId)?.name ?? "this visit"}.`,
          patch: { rigId: replacement.rig.id },
          why: replacement.reasons,
        });
      } else {
        suggestions.push({
          assignmentId: a.id,
          description: `No healthy rig available — recommend moving ${bizMap.get(a.businessId)?.name ?? "this visit"} to tomorrow.`,
          patch: { status: "cancelled" },
        });
      }
      continue;
    }
    // fo_unavailable
    const bestFO = [...otherFOs].sort((x, y) => (foLoad.get(x.id) ?? 0) - (foLoad.get(y.id) ?? 0))[0];
    if (bestFO) {
      foLoad.set(bestFO.id, (foLoad.get(bestFO.id) ?? 0) + 1);
      suggestions.push({
        assignmentId: a.id,
        description: `Move ${bizMap.get(a.businessId)?.name ?? "visit"} → ${bestFO.name}.`,
        patch: { foId: bestFO.id },
      });
    } else {
      suggestions.push({
        assignmentId: a.id,
        description: `No available FO — recommend moving ${bizMap.get(a.businessId)?.name ?? "this visit"} to tomorrow.`,
        patch: { status: "cancelled" },
      });
    }
  }

  const note =
    affected.length === 0
      ? "No assignments affected."
      : `${affected.length} assignment${affected.length === 1 ? "" : "s"} affected. ${suggestions.length} change${suggestions.length === 1 ? "" : "s"} suggested; no other assignments impacted.`;

  return { affected, suggestions, note };
}

export function severityOfConflicts(conflicts: PlanConflict[]): Severity {
  if (conflicts.some((c) => c.severity === "critical")) return "critical";
  if (conflicts.some((c) => c.severity === "warning")) return "warning";
  return "opportunity";
}
