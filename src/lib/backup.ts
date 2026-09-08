import type { CityData } from "@/types";
import { emptyCityData } from "@/store/city";

const REQUIRED_ARRAYS: (keyof CityData)[] = [
  "businesses",
  "fos",
  "collectors",
  "rigs",
  "assignments",
  "sessions",
  "evidence",
  "issues",
  "qualityReviews",
  "correctiveActions",
  "activity",
  "plans",
  "reports",
];

export interface ValidationResult {
  valid: boolean;
  error?: string;
  data?: CityData;
  counts?: Record<string, number>;
}

export function validateBackup(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, error: "The file does not contain a valid JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.settings || typeof obj.settings !== "object") {
    return { valid: false, error: "The backup file is missing the `settings` field. No existing data was changed." };
  }
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(obj[key])) {
      return { valid: false, error: `The backup file is missing the \`${key}\` field. No existing data was changed.` };
    }
  }
  const counts: Record<string, number> = {};
  for (const key of REQUIRED_ARRAYS) counts[key] = (obj[key] as unknown[]).length;

  const merged: CityData = { ...emptyCityData(), ...(obj as unknown as CityData) };
  return { valid: true, data: merged, counts };
}

function upsertById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const map = new Map(existing.map((x) => [x.id, x]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}

export function mergeCityData(existing: CityData, incoming: CityData): CityData {
  return {
    version: incoming.version ?? existing.version,
    settings: existing.settings,
    businesses: upsertById(existing.businesses, incoming.businesses),
    fos: upsertById(existing.fos, incoming.fos),
    collectors: upsertById(existing.collectors, incoming.collectors),
    rigs: upsertById(existing.rigs, incoming.rigs),
    assignments: upsertById(existing.assignments, incoming.assignments),
    sessions: upsertById(existing.sessions, incoming.sessions),
    evidence: upsertById(existing.evidence, incoming.evidence),
    issues: upsertById(existing.issues, incoming.issues),
    qualityReviews: upsertById(existing.qualityReviews, incoming.qualityReviews),
    correctiveActions: upsertById(existing.correctiveActions, incoming.correctiveActions),
    activity: upsertById(existing.activity, incoming.activity),
    plans: upsertById(existing.plans, incoming.plans),
    reports: upsertById(existing.reports, incoming.reports),
  };
}
