import type { CityData } from "@/types";
import { todayISO } from "@/lib/dates";
import { daysBack, activeSessions, issuesOpen } from "./selectors";
import { computeLostHours } from "./lostHours";
import { buildEOD } from "./reports";

export interface CopilotResult {
  kind: "data" | "recommendation" | "help";
  answer: string;
  links?: { label: string; to: string }[];
}

interface Rule {
  test: (q: string) => boolean;
  run: (data: CityData, q: string) => CopilotResult;
}

function norm(q: string): string {
  return q.trim().toLowerCase();
}

const rules: Rule[] = [
  {
    test: (q) => /lost.*(hour|time)/.test(q) && /week/.test(q),
    run: (data) => {
      const week = daysBack(7);
      const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
      const totals = new Map<string, number>();
      for (const d of week) {
        const lost = computeLostHours(data, d);
        for (const g of lost.breakdown) {
          for (const issue of g.issues) {
            if (issue.businessId) totals.set(issue.businessId, (totals.get(issue.businessId) ?? 0) + (issue.lostHours ?? 0));
          }
        }
      }
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (ranked.length === 0) return { kind: "data", answer: "No lost hours recorded in the last 7 days." };
      const lines = ranked.map(([id, h]) => `${bizMap.get(id)?.name ?? "Unknown"} — ${h.toFixed(1)}h`).join(", ");
      return { kind: "data", answer: `Businesses with the most lost hours this week: ${lines}.`, links: [{ label: "Open Analytics", to: "/analytics" }] };
    },
  },
  {
    test: (q) => /working tomorrow|tomorrow.*work/.test(q),
    run: (data) => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const assignments = data.assignments.filter((a) => a.date === tomorrow && a.status !== "cancelled");
      const foMap = new Map(data.fos.map((f) => [f.id, f]));
      const foIds = [...new Set(assignments.map((a) => a.foId))];
      if (foIds.length === 0) return { kind: "data", answer: "No assignments planned for tomorrow yet.", links: [{ label: "Plan tomorrow", to: "/today" }] };
      return { kind: "data", answer: `Working tomorrow: ${foIds.map((id) => foMap.get(id)?.name ?? "?").join(", ")} across ${assignments.length} visits.` };
    },
  },
  {
    test: (q) => /active session/.test(q),
    run: (data) => {
      const sessions = activeSessions(data);
      const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
      if (sessions.length === 0) return { kind: "data", answer: "No sessions are currently active." };
      return {
        kind: "data",
        answer: `${sessions.length} active session${sessions.length === 1 ? "" : "s"}: ${sessions.map((s) => bizMap.get(s.businessId)?.name ?? "?").join(", ")}.`,
        links: [{ label: "Open Session Center", to: "/sessions" }],
      };
    },
  },
  {
    test: (q) => /why.*unsuccessful|why.*fail|unsuccessful/.test(q),
    run: (data, q) => {
      const bizMap = data.businesses.filter((b) => q.includes(b.name.toLowerCase()));
      const biz = bizMap[0];
      if (!biz) return { kind: "help", answer: "Name a specific business, e.g. \"Why was Urban Grocer unsuccessful?\"" };
      const bad = data.assignments.filter((a) => a.businessId === biz.id && (a.status === "rejected" || a.status === "no_show"));
      if (bad.length === 0) return { kind: "data", answer: `${biz.name} has no unsuccessful visits on record.` };
      return {
        kind: "data",
        answer: `${biz.name} had ${bad.length} unsuccessful visit${bad.length === 1 ? "" : "s"}: ${bad.map((a) => a.status.replace("_", " ")).join(", ")}.`,
        links: [{ label: "Open Business 360", to: `/businesses/${biz.id}` }],
      };
    },
  },
  {
    test: (q) => /recording hours.*today|today.*recording hours|how many hours/.test(q),
    run: (data) => {
      const eod = buildEOD(data, todayISO(), data.settings.recordingHoursTargetPerDay);
      return { kind: "data", answer: `${eod.recordingHours.toFixed(1)}h recorded today of a ${eod.targetHours}h target (${eod.achievementPct}%).` };
    },
  },
  {
    test: (q) => /most delays|delayed the most/.test(q),
    run: (data) => {
      const foMap = new Map(data.fos.map((f) => [f.id, f]));
      const counts = new Map<string, number>();
      for (const a of data.assignments) {
        if (!a.actualArrivalAt) continue;
        const delay = (new Date(a.actualArrivalAt).getTime() - new Date(a.plannedStart).getTime()) / 60000;
        if (delay >= 15) counts.set(a.foId, (counts.get(a.foId) ?? 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) return { kind: "data", answer: "No FO has recorded delays." };
      return { kind: "data", answer: `${foMap.get(ranked[0][0])?.name ?? "?"} has the most delays (${ranked[0][1]}).`, links: [{ label: "Open Field Officers", to: "/field-officers" }] };
    },
  },
  {
    test: (q) => /fix first|what should i (do|fix)/.test(q),
    run: (data) => {
      const open = issuesOpen(data).sort((a) => (a.severity === "critical" ? -1 : 1));
      if (open.length === 0) return { kind: "recommendation", answer: "No open issues. Focus on tomorrow's plan quality." };
      const top = open[0];
      return { kind: "recommendation", answer: `Fix first: ${top.title} (${top.severity}). ${top.description}`, links: [{ label: "Open issue", to: `/issues/${top.id}` }] };
    },
  },
  {
    test: (q) => /repeated rejection|repeat.*reject/.test(q),
    run: (data) => {
      const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
      const counts = new Map<string, number>();
      for (const a of data.assignments) if (a.status === "rejected") counts.set(a.businessId, (counts.get(a.businessId) ?? 0) + 1);
      const repeated = [...counts.entries()].filter(([, n]) => n >= 2);
      if (repeated.length === 0) return { kind: "data", answer: "No businesses with repeated rejections." };
      return { kind: "data", answer: repeated.map(([id, n]) => `${bizMap.get(id)?.name ?? "?"} (${n}×)`).join(", ") };
    },
  },
  {
    test: (q) => /eod|end of day/.test(q),
    run: (data) => {
      const eod = buildEOD(data, todayISO(), data.settings.recordingHoursTargetPerDay);
      return { kind: "data", answer: eod.narrative, links: [{ label: "Open EOD report", to: "/reports?tab=eod" }] };
    },
  },
  {
    test: (q) => /critical issue/.test(q),
    run: (data) => {
      const critical = issuesOpen(data).filter((i) => i.severity === "critical");
      if (critical.length === 0) return { kind: "data", answer: "No open critical issues." };
      return { kind: "data", answer: `${critical.length} open critical issue${critical.length === 1 ? "" : "s"}: ${critical.map((i) => i.title).join("; ")}.`, links: [{ label: "Open Issues", to: "/issues?severity=critical" }] };
    },
  },
];

export function runCopilotQuery(data: CityData, question: string): CopilotResult {
  const q = norm(question);
  if (!q) return { kind: "help", answer: "Ask about businesses, FOs, sessions, issues, or today's performance." };
  for (const rule of rules) {
    if (rule.test(q)) return rule.run(data, q);
  }
  return {
    kind: "help",
    answer:
      "I can only answer from your local data. Try: \"Which businesses lost the most hours this week?\", \"Show active sessions\", \"Give me today's EOD\", or \"Show all open critical issues\".",
  };
}

export const COPILOT_EXAMPLES = [
  "Which businesses lost the most hours this week?",
  "Who is working tomorrow?",
  "Show active sessions.",
  "How many recording hours did we collect today?",
  "Which FO had the most delays?",
  "What should I fix first?",
  "Show businesses with repeated rejection.",
  "Give me today's EOD.",
  "Show all open critical issues.",
];
