import type { CityData } from "@/types";
import { assignmentsForDate, plannedHoursForDate, recordedHoursForDate } from "./selectors";
import { computeLostHours } from "./lostHours";
import { computeCityHealth } from "./health";

export interface SODReport {
  date: string;
  businessesPlanned: { id: string; name: string; time: string; foName: string; priority: string }[];
  fosAssigned: { id: string; name: string; visitCount: number }[];
  rigsAllocated: { id: string; code: string; count: number }[];
  expectedHours: number;
  targetHours: number;
  risks: string[];
  actions: string[];
}

export function buildSOD(data: CityData, date: string, targetHours: number): SODReport {
  const assignments = assignmentsForDate(data, date).filter((a) => a.status !== "cancelled");
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));

  const businessesPlanned = assignments
    .map((a) => ({
      id: a.businessId,
      name: bizMap.get(a.businessId)?.name ?? "Unknown",
      time: a.plannedStart,
      foName: foMap.get(a.foId)?.name ?? "Unassigned",
      priority: a.priority,
    }))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const foCounts = new Map<string, number>();
  for (const a of assignments) foCounts.set(a.foId, (foCounts.get(a.foId) ?? 0) + 1);
  const fosAssigned = [...foCounts.entries()].map(([id, count]) => ({ id, name: foMap.get(id)?.name ?? "?", visitCount: count }));

  const rigCounts = new Map<string, number>();
  for (const a of assignments) if (a.rigId) rigCounts.set(a.rigId, (rigCounts.get(a.rigId) ?? 0) + 1);
  const rigsAllocated = [...rigCounts.entries()].map(([id, count]) => ({ id, code: rigMap.get(id)?.code ?? "?", count }));

  const expectedHours = plannedHoursForDate(data, date);

  const risks: string[] = [];
  const criticalRigs = data.rigs.filter((r) => assignments.some((a) => a.rigId === r.id) && (r.condition === "critical" || r.condition === "warning"));
  for (const r of criticalRigs) risks.push(`Rig ${r.code} is in ${r.condition} condition and assigned today.`);
  if (expectedHours < targetHours) risks.push(`Planned hours (${expectedHours.toFixed(1)}h) are below the ${targetHours}h target.`);
  const unassigned = data.businesses.filter((b) => b.active).length - new Set(assignments.map((a) => a.businessId)).size;
  if (unassigned > 0) risks.push(`${unassigned} active business${unassigned === 1 ? "" : "es"} have no visit planned today.`);

  const actions: string[] = [];
  if (fosAssigned.length > 0) actions.push(`Confirm check-in for all ${fosAssigned.length} FOs before their first visit.`);
  if (criticalRigs.length > 0) actions.push(`Inspect ${criticalRigs.map((r) => r.code).join(", ")} before deployment.`);
  if (risks.length === 0) actions.push("No blocking risks identified — proceed as planned.");

  return { date, businessesPlanned, fosAssigned, rigsAllocated, expectedHours: Math.round(expectedHours * 10) / 10, targetHours, risks, actions };
}

export interface MODReport {
  date: string;
  plannedHours: number;
  actualHours: number;
  completedVisits: number;
  totalPlannedVisits: number;
  activeSessions: number;
  delays: number;
  openIssues: number;
  projectedEODHours: number;
  projectedAchievementPct: number;
}

export function buildMOD(data: CityData, date: string, targetHours: number): MODReport {
  const assignments = assignmentsForDate(data, date).filter((a) => a.status !== "cancelled");
  const completed = assignments.filter((a) => a.status === "completed");
  const active = assignments.filter((a) => a.status === "in_progress");
  const delays = assignments.filter((a) => {
    if (!a.actualArrivalAt) return false;
    return (new Date(a.actualArrivalAt).getTime() - new Date(a.plannedStart).getTime()) / 60000 >= 15;
  }).length;
  const openIssues = data.issues.filter((i) => i.createdAt.slice(0, 10) === date && (i.status === "open" || i.status === "in_progress")).length;

  const actualHours = recordedHoursForDate(data, date);
  const plannedHours = plannedHoursForDate(data, date);
  const remainingPlanned = assignments
    .filter((a) => a.status === "planned")
    .reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);
  const inProgressRemaining = active.reduce((s, a) => {
    const remain = (new Date(a.plannedEnd).getTime() - Date.now()) / 3_600_000;
    return s + Math.max(0, remain);
  }, 0);
  const projectedEODHours = Math.round((actualHours + remainingPlanned + inProgressRemaining) * 10) / 10;

  return {
    date,
    plannedHours: Math.round(plannedHours * 10) / 10,
    actualHours: Math.round(actualHours * 10) / 10,
    completedVisits: completed.length,
    totalPlannedVisits: assignments.length,
    activeSessions: active.length,
    delays,
    openIssues,
    projectedEODHours,
    projectedAchievementPct: targetHours > 0 ? Math.round((projectedEODHours / targetHours) * 100) : 100,
  };
}

export interface EODReport {
  date: string;
  businessesCompleted: number;
  businessesPlanned: number;
  recordingHours: number;
  targetHours: number;
  achievementPct: number;
  qualityPassRate: number;
  issueCount: number;
  lostHours: ReturnType<typeof computeLostHours>;
  healthScore: number;
  foPerformance: { id: string; name: string; visits: number; onTimePct: number }[];
  narrative: string;
}

export function buildEOD(data: CityData, date: string, targetHours: number): EODReport {
  const assignments = assignmentsForDate(data, date).filter((a) => a.status !== "cancelled");
  const completed = assignments.filter((a) => a.status === "completed");
  const recordingHours = recordedHoursForDate(data, date);
  const lostHours = computeLostHours(data, date);
  const health = computeCityHealth(data, date, targetHours);

  const sessionIds = data.sessions.filter((s) => s.date === date).map((s) => s.id);
  const reviews = data.qualityReviews.filter((q) => sessionIds.includes(q.sessionId));
  const qualityPassRate = reviews.length ? Math.round((reviews.filter((r) => r.verdict === "pass").length / reviews.length) * 100) : 100;

  const foIds = new Set(assignments.map((a) => a.foId));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const foPerformance = [...foIds].map((foId) => {
    const foAssignments = assignments.filter((a) => a.foId === foId);
    const arrived = foAssignments.filter((a) => a.actualArrivalAt);
    const onTime = arrived.filter((a) => (new Date(a.actualArrivalAt!).getTime() - new Date(a.plannedStart).getTime()) / 60000 < 15);
    return {
      id: foId,
      name: foMap.get(foId)?.name ?? "?",
      visits: foAssignments.filter((a) => a.status === "completed").length,
      onTimePct: arrived.length ? Math.round((onTime.length / arrived.length) * 100) : 100,
    };
  });

  const narrative = buildEODNarrative(data, date, targetHours, {
    recordingHours,
    achievementPct: targetHours > 0 ? Math.round((recordingHours / targetHours) * 100) : 100,
    lostHours,
    foPerformance,
  });

  return {
    date,
    businessesCompleted: completed.length,
    businessesPlanned: assignments.length,
    recordingHours: Math.round(recordingHours * 10) / 10,
    targetHours,
    achievementPct: targetHours > 0 ? Math.round((recordingHours / targetHours) * 100) : 100,
    qualityPassRate,
    issueCount: data.issues.filter((i) => i.createdAt.slice(0, 10) === date).length,
    lostHours,
    healthScore: health.score,
    foPerformance,
    narrative,
  };
}

function buildEODNarrative(
  data: CityData,
  date: string,
  targetHours: number,
  ctx: { recordingHours: number; achievementPct: number; lostHours: ReturnType<typeof computeLostHours>; foPerformance: { name: string; visits: number; onTimePct: number }[] },
): string {
  const assignments = assignmentsForDate(data, date);
  if (assignments.length === 0) return "Insufficient historical data.";

  const sentences: string[] = [];
  sentences.push(`Today the city achieved ${ctx.achievementPct}% of planned recording hours (${ctx.recordingHours.toFixed(1)}h of ${targetHours}h target).`);

  if (ctx.lostHours.topCause) {
    sentences.push(`Primary loss: ${ctx.lostHours.topCause.label.toLowerCase()} (−${ctx.lostHours.topCause.hours.toFixed(1)}h).`);
  }

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const bizStats = new Map<string, { completed: number; rejected: number; delayed: number }>();
  for (const a of assignments) {
    const s = bizStats.get(a.businessId) ?? { completed: 0, rejected: 0, delayed: 0 };
    if (a.status === "completed") s.completed += 1;
    if (a.status === "rejected") s.rejected += 1;
    if (a.actualArrivalAt && (new Date(a.actualArrivalAt).getTime() - new Date(a.plannedStart).getTime()) / 60000 >= 15) s.delayed += 1;
    bizStats.set(a.businessId, s);
  }
  const reliable = [...bizStats.entries()].find(([, s]) => s.completed > 0 && s.delayed === 0 && s.rejected === 0);
  if (reliable) sentences.push(`${bizMap.get(reliable[0])?.name ?? "A business"} remains highly reliable.`);
  const problematic = [...bizStats.entries()].find(([, s]) => s.delayed > 0 || s.rejected > 0);
  if (problematic) {
    const biz = bizMap.get(problematic[0]);
    sentences.push(`${biz?.name ?? "A business"} showed ${problematic[1].delayed > 0 ? "repeated delays" : "a rejected visit"} today.`);
  }

  const best = [...ctx.foPerformance].sort((a, b) => b.onTimePct - a.onTimePct)[0];
  if (best && best.visits > 0) sentences.push(`${best.name} completed assigned visits with ${best.onTimePct}% on-time arrival.`);

  if (problematic) {
    sentences.push(`Tomorrow's plan should shift ${bizMap.get(problematic[0])?.name ?? "the affected business"} to a less congested window.`);
  }

  return sentences.join(" ");
}

export interface TomorrowRecommendation {
  id: string;
  description: string;
  reasoning: string;
  patch?: { assignmentId?: string; businessId?: string; foId?: string; time?: string };
}

export function buildTomorrowRecommendations(data: CityData, date: string): TomorrowRecommendation[] {
  const assignments = assignmentsForDate(data, date);
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const recs: TomorrowRecommendation[] = [];

  for (const a of assignments) {
    if (a.actualArrivalAt) {
      const delay = (new Date(a.actualArrivalAt).getTime() - new Date(a.plannedStart).getTime()) / 60000;
      if (delay >= 20) {
        recs.push({
          id: `shift-${a.id}`,
          description: `Move ${bizMap.get(a.businessId)?.name ?? "visit"} to a later window (after 3 PM).`,
          reasoning: `Arrival was ${Math.round(delay)} minutes late today; the current window appears congested.`,
          patch: { businessId: a.businessId, time: "15:00" },
        });
      }
    }
    if (a.status === "rejected") {
      recs.push({
        id: `reassign-${a.id}`,
        description: `Reschedule ${bizMap.get(a.businessId)?.name ?? "visit"} and confirm availability before assigning an FO.`,
        reasoning: "Visit was rejected today — confirm the business is ready before re-planning.",
        patch: { businessId: a.businessId },
      });
    }
  }

  const rigIssues = data.issues.filter((i) => i.createdAt.slice(0, 10) === date && ["rig_failure", "battery", "storage"].includes(i.type));
  for (const issue of rigIssues) {
    const altRig = data.rigs.find((r) => r.id !== issue.rigId && r.active && r.condition === "healthy");
    if (altRig) {
      recs.push({
        id: `rig-${issue.id}`,
        description: `Use rig ${altRig.code} instead of the one involved in today's issue.`,
        reasoning: issue.description,
      });
    }
  }

  // FO workload imbalance
  const foLoad = new Map<string, number>();
  for (const a of assignments) foLoad.set(a.foId, (foLoad.get(a.foId) ?? 0) + 1);
  const loads = [...foLoad.entries()];
  if (loads.length >= 2) {
    loads.sort((a, b) => b[1] - a[1]);
    const [busiest] = loads;
    const idle = data.fos.find((f) => f.active && !foLoad.has(f.id));
    if (idle && busiest[1] >= 3) {
      recs.push({
        id: `balance-${busiest[0]}`,
        description: `Assign ${idle.name} to share load with ${foMap.get(busiest[0])?.name ?? "the busiest FO"} tomorrow.`,
        reasoning: `${foMap.get(busiest[0])?.name ?? "That FO"} carried ${busiest[1]} visits today while ${idle.name} had none.`,
      });
    }
  }

  return recs.slice(0, 6);
}
