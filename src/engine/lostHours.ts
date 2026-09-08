import type { CityData, Issue, IssueType } from "@/types";
import { issuesForDate, sessionsForDate } from "./selectors";

export type LossCategory = "fo_delay" | "business_rejection" | "rig_issue" | "quality" | "other";

export interface LossBreakdownItem {
  category: LossCategory;
  label: string;
  hours: number;
  issues: Issue[];
}

export interface LostHoursResult {
  totalLost: number;
  recovered: number;
  breakdown: LossBreakdownItem[];
  topCause: LossBreakdownItem | null;
}

const CATEGORY_BY_TYPE: Record<IssueType, LossCategory> = {
  late_arrival: "fo_delay",
  fo_no_show: "fo_delay",
  business_rejection: "business_rejection",
  rig_failure: "rig_issue",
  battery: "rig_issue",
  storage: "rig_issue",
  network: "rig_issue",
  damage: "rig_issue",
  recording_failure: "quality",
  quality: "quality",
  missing_evidence: "quality",
  scheduling: "other",
  other: "other",
};

const LABELS: Record<LossCategory, string> = {
  fo_delay: "FO delay / no-show",
  business_rejection: "Business rejection",
  rig_issue: "Rig / device issue",
  quality: "Session quality failure",
  other: "Other",
};

export function computeLostHours(data: CityData, date: string): LostHoursResult {
  const issues = issuesForDate(data, date).filter((i) => (i.lostHours ?? 0) > 0);
  const groups = new Map<LossCategory, LossBreakdownItem>();

  for (const cat of Object.keys(LABELS) as LossCategory[]) {
    groups.set(cat, { category: cat, label: LABELS[cat], hours: 0, issues: [] });
  }

  for (const issue of issues) {
    const cat = CATEGORY_BY_TYPE[issue.type];
    const g = groups.get(cat)!;
    g.hours += issue.lostHours ?? 0;
    g.issues.push(issue);
  }

  // Session quality shortfall not already covered by a logged issue.
  const sessions = sessionsForDate(data, date);
  const qualityGroup = groups.get("quality")!;
  for (const s of sessions) {
    const qr = data.qualityReviews.find((q) => q.sessionId === s.id);
    if (qr?.verdict === "fail" && s.endedAt) {
      const actualMin = (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000;
      const shortfallHours = Math.max(0, (s.plannedDurationMin - actualMin) / 60);
      const alreadyCounted = issues.some((i) => i.sessionId === s.id);
      if (shortfallHours > 0.05 && !alreadyCounted) {
        qualityGroup.hours += Math.round(shortfallHours * 100) / 100;
      }
    }
  }

  const breakdown = Array.from(groups.values())
    .map((g) => ({ ...g, hours: Math.round(g.hours * 100) / 100 }))
    .filter((g) => g.hours > 0)
    .sort((a, b) => b.hours - a.hours);

  const totalLost = Math.round(breakdown.reduce((sum, g) => sum + g.hours, 0) * 100) / 100;

  const recovered = Math.round(
    sessions.reduce((sum, s) => {
      if (s.status !== "completed" || !s.endedAt) return sum;
      const actualMin = (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60000;
      const overage = actualMin - s.plannedDurationMin;
      return overage > 0 ? sum + overage / 60 : sum;
    }, 0) * 100,
  ) / 100;

  return {
    totalLost,
    recovered,
    breakdown,
    topCause: breakdown[0] ?? null,
  };
}
