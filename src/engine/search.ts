import type { CityData, Status } from "@/types";
import { fmtDate } from "@/lib/dates";
import { buildRigSummary } from "./rigGuardian";
import { readinessToStatus } from "./rigTaxonomy";

export interface SearchResult {
  kind: "business" | "fo" | "collector" | "rig" | "session" | "issue";
  id: string;
  title: string;
  subtitle: string;
  metric?: string;
  status: Status;
  to: string;
}

function statusForBusiness(active: boolean): Status {
  return active ? "healthy" : "offline";
}

export function buildSearchIndex(data: CityData): SearchResult[] {
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));

  const results: SearchResult[] = [];

  for (const b of data.businesses) {
    const sessions = data.sessions.filter((s) => s.businessId === b.id);
    results.push({
      kind: "business",
      id: b.id,
      title: b.name,
      subtitle: `${b.category} · ${b.area}`,
      metric: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      status: statusForBusiness(b.active),
      to: `/businesses/${b.id}`,
    });
  }

  for (const f of data.fos) {
    const assignments = data.assignments.filter((a) => a.foId === f.id);
    results.push({
      kind: "fo",
      id: f.id,
      title: f.name,
      subtitle: f.homeArea ? `Field Officer · ${f.homeArea}` : "Field Officer",
      metric: `${assignments.length} visits`,
      status: f.active ? "healthy" : "offline",
      to: `/field-officers/${f.id}`,
    });
  }

  for (const c of data.collectors) {
    results.push({
      kind: "collector",
      id: c.id,
      title: c.name,
      subtitle: c.businessId ? `Collector · ${bizMap.get(c.businessId)?.name ?? ""}` : "Collector",
      status: c.active ? "healthy" : "offline",
      to: `/businesses/${c.businessId ?? ""}`,
    });
  }

  for (const r of data.rigs) {
    const summary = buildRigSummary(data, r);
    results.push({
      kind: "rig",
      id: r.id,
      title: r.code,
      subtitle: r.model,
      metric: `${summary.score}/100 health`,
      status: readinessToStatus(summary.readiness),
      to: `/fleet/${r.id}`,
    });
  }

  for (const s of data.sessions) {
    const biz = bizMap.get(s.businessId);
    const fo = foMap.get(s.foId);
    results.push({
      kind: "session",
      id: s.id,
      title: `${biz?.name ?? "Session"} — ${fmtDate(s.date, "MMM d")}`,
      subtitle: fo ? `FO ${fo.name}` : "Session",
      status: s.status === "active" ? "active" : s.status,
      to: `/sessions/${s.id}`,
    });
  }

  for (const i of data.issues) {
    const biz = i.businessId ? bizMap.get(i.businessId) : undefined;
    results.push({
      kind: "issue",
      id: i.id,
      title: i.title,
      subtitle: biz ? biz.name : "Issue",
      status: i.status === "resolved" ? "completed" : i.status === "cancelled" ? "cancelled" : i.severity === "critical" ? "critical" : "warning",
      to: `/issues/${i.id}`,
    });
  }

  return results;
}

export function searchQuery(index: SearchResult[], query: string, limit = 30): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return index.slice(0, limit);
  return index
    .filter((r) => r.title.toLowerCase().includes(q) || r.subtitle.toLowerCase().includes(q))
    .slice(0, limit);
}
