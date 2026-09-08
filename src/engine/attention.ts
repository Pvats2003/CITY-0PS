import type { CityData, Severity } from "@/types";
import { assignmentsForDate } from "./selectors";

export interface AttentionAction {
  label: string;
  to: string;
}

export interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  reason: string;
  entityLabel: string;
  at: string;
  actions: AttentionAction[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, attention: 2, opportunity: 3 };

export function buildAttentionFeed(data: CityData, date: string): AttentionItem[] {
  const items: AttentionItem[] = [];
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));
  const now = Date.now();
  const assignments = assignmentsForDate(data, date);

  // 1) open issues -> direct attention items
  for (const issue of data.issues.filter((i) => i.status === "open" || i.status === "in_progress")) {
    const biz = issue.businessId ? bizMap.get(issue.businessId) : undefined;
    const fo = issue.foId ? foMap.get(issue.foId) : undefined;
    items.push({
      id: `issue-${issue.id}`,
      severity: issue.severity,
      title: issue.title,
      reason: issue.description,
      entityLabel: biz?.name ?? fo?.name ?? "City",
      at: issue.createdAt,
      actions: [
        { label: "View issue", to: `/issues/${issue.id}` },
        ...(biz ? [{ label: "View business", to: `/businesses/${biz.id}` }] : []),
        ...(fo ? [{ label: "Contact FO", to: `/field-officers/${fo.id}` }] : []),
      ],
    });
  }

  // 2) assignments running behind schedule right now
  for (const a of assignments) {
    if (a.status === "in_progress") {
      const plannedEndMs = new Date(a.plannedEnd).getTime();
      const overrun = Math.round((now - plannedEndMs) / 60000);
      if (overrun > 20) {
        const biz = bizMap.get(a.businessId);
        items.push({
          id: `overrun-${a.id}`,
          severity: overrun > 60 ? "critical" : "warning",
          title: `${biz?.name ?? "Business"} is running ${overrun} min behind schedule`,
          reason: `Session was planned to end at ${new Date(a.plannedEnd).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} but is still active.`,
          entityLabel: biz?.name ?? "Business",
          at: a.plannedEnd,
          actions: [
            { label: "View session", to: a.sessionId ? `/sessions/${a.sessionId}` : `/today` },
            { label: "Reschedule", to: `/today` },
          ],
        });
      }
    }
    if (a.status === "planned") {
      const plannedStartMs = new Date(a.plannedStart).getTime();
      const lateBy = Math.round((now - plannedStartMs) / 60000);
      if (lateBy > 15) {
        const biz = bizMap.get(a.businessId);
        const fo = foMap.get(a.foId);
        items.push({
          id: `notcheckedin-${a.id}`,
          severity: lateBy > 45 ? "critical" : "warning",
          title: `${fo?.name ?? "FO"} has not checked in for the ${new Date(a.plannedStart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} visit`,
          reason: `${biz?.name ?? "Business"} visit was planned to start ${lateBy} minutes ago with no arrival recorded.`,
          entityLabel: biz?.name ?? "Business",
          at: a.plannedStart,
          actions: [
            { label: "View", to: `/today` },
            ...(fo ? [{ label: "Contact FO", to: `/field-officers/${fo.id}` }] : []),
            { label: "Reschedule", to: `/today` },
          ],
        });
      }
    }
  }

  // 3) low battery / device concerns on active sessions
  for (const s of data.sessions.filter((s) => s.status === "active")) {
    const rig = s.rigId ? rigMap.get(s.rigId) : undefined;
    const biz = bizMap.get(s.businessId);
    if (s.batteryPct < 30) {
      items.push({
        id: `battery-${s.id}`,
        severity: s.batteryPct < 15 ? "critical" : "warning",
        title: `Rig ${rig?.code ?? ""} battery below expected level (${s.batteryPct}%)`,
        reason: `Active session at ${biz?.name ?? "business"} is running low on battery.`,
        entityLabel: rig?.code ?? "Rig",
        at: s.startedAt,
        actions: [{ label: "View rig", to: rig ? `/sessions/${s.id}` : "/sessions" }],
      });
    }
    if (s.signal === "intermittent") {
      items.push({
        id: `signal-${s.id}`,
        severity: "attention",
        title: `Signal intermittent at ${biz?.name ?? "business"}`,
        reason: "Network/signal quality has been unstable during this session.",
        entityLabel: biz?.name ?? "Business",
        at: s.startedAt,
        actions: [{ label: "View session", to: `/sessions/${s.id}` }],
      });
    }
  }

  // 4) unusually low duration on recently completed sessions
  for (const s of data.sessions.filter((s) => s.date === date && s.status === "completed" && s.endedAt)) {
    const actualMin = (new Date(s.endedAt!).getTime() - new Date(s.startedAt).getTime()) / 60000;
    const pct = (actualMin / s.plannedDurationMin) * 100;
    if (pct < 75) {
      const biz = bizMap.get(s.businessId);
      items.push({
        id: `lowdur-${s.id}`,
        severity: "attention",
        title: `Session at ${biz?.name ?? "business"} has unusually low recording duration`,
        reason: `Recorded ${Math.round(actualMin)}m of a planned ${s.plannedDurationMin}m (${Math.round(pct)}%).`,
        entityLabel: biz?.name ?? "Business",
        at: s.endedAt!,
        actions: [{ label: "Inspect session", to: `/sessions/${s.id}` }],
      });
    }
  }

  // 5) opportunities — reliable businesses with spare capacity and no visit tomorrow
  const tomorrow = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);
  const tomorrowBizIds = new Set(assignmentsForDate(data, tomorrow).map((a) => a.businessId));
  for (const biz of data.businesses.filter((b) => b.active && !tomorrowBizIds.has(b.id))) {
    const bizSessions = data.sessions.filter((s) => s.businessId === biz.id && s.status === "completed");
    const bizIssues = data.issues.filter((i) => i.businessId === biz.id);
    if (bizSessions.length >= 2 && bizIssues.length === 0) {
      items.push({
        id: `opportunity-${biz.id}`,
        severity: "opportunity",
        title: `${biz.name} has capacity for an additional session tomorrow`,
        reason: `${bizSessions.length} clean sessions on record with no issues. Not currently scheduled tomorrow.`,
        entityLabel: biz.name,
        at: new Date().toISOString(),
        actions: [{ label: "Plan tomorrow", to: "/today?tab=planner" }],
      });
      if (items.filter((i) => i.severity === "opportunity").length >= 3) break;
    }
  }

  return items.sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
}
