import type { Assignment, Business, CityData, Evidence, EvidenceType, Session } from "@/types";

// ---------------------------------------------------------------------------
// Evidence-driven execution — deterministic, explainable, exactly like Rig
// Guardian's health score: every derived value here is a transparent
// function of already-known data (evidence records, assignment timestamps,
// session state), never a live model call and never duplicated state that
// could drift out of sync with the records it's computed from.
// ---------------------------------------------------------------------------

/** Deployable/testable threshold for "at the right place" — configurable in
 * one place, not hardcoded inline. A GPS fix inside this radius of the
 * business's own recorded coordinates counts as LOCATION_VERIFIED; anything
 * further is a LOCATION MISMATCH shown to both the FO and the Manager. */
export const LOCATION_MATCH_THRESHOLD_METERS = 150;

/** Haversine great-circle distance in meters — the standard, deterministic
 * formula for "distance between two lat/lng points," not an approximation
 * that degrades at city scale. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export interface LocationCheck {
  distanceMeters: number | null;
  verified: boolean;
  message: string;
}

/** The app calculates this — the FO never self-declares "verified" (spec
 * Phase 3). Returns distanceMeters: null when the business has no recorded
 * coordinates to compare against (nothing to verify against, not a failure). */
export function checkLocation(business: Business | undefined, lat: number, lng: number): LocationCheck {
  if (!business?.lat || !business?.lng) {
    return { distanceMeters: null, verified: true, message: "No recorded business coordinates to verify against." };
  }
  const distanceMeters = haversineMeters(business.lat, business.lng, lat, lng);
  const verified = distanceMeters <= LOCATION_MATCH_THRESHOLD_METERS;
  const distanceLabel = distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${distanceMeters}m`;
  return {
    distanceMeters,
    verified,
    message: verified ? `${distanceLabel} from expected location` : `${distanceLabel} from expected location — outside the ${LOCATION_MATCH_THRESHOLD_METERS}m threshold`,
  };
}

// ---------------------------------------------------------------------------
// Execution stage — derived, not stored. The one exception is the final
// review decision (Assignment.reviewStatus), which is a genuine Manager act
// that cannot be inferred from evidence (see types/index.ts).
// ---------------------------------------------------------------------------

export type ExecutionStage =
  | "assigned"
  | "en_route"
  | "arrived"
  | "location_verified"
  | "precheck"
  | "rig_ready"
  | "installation"
  | "installation_verified"
  | "session"
  | "completion"
  | "evidence_complete"
  | "ready_for_review"
  | "approved"
  | "recheck_required";

export const EXECUTION_STAGE_LABELS: Record<ExecutionStage, string> = {
  assigned: "Assigned",
  en_route: "En route",
  arrived: "Arrival",
  location_verified: "Location verified",
  precheck: "Rig precheck",
  rig_ready: "Rig ready",
  installation: "Installation",
  installation_verified: "Installation verified",
  session: "Session",
  completion: "Completion",
  evidence_complete: "Evidence complete",
  ready_for_review: "Ready for review",
  approved: "Approved",
  recheck_required: "Recheck required",
};

export function latestOfType(evidence: Evidence[], assignmentId: string, type: EvidenceType): Evidence | undefined {
  return evidence
    .filter((e) => e.assignmentId === assignmentId && e.type === type)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

/** True only for a precheck evidence record that actually passed — a
 * rejected/recheck_requested precheck (or a failed one that produced an
 * Issue) never silently unlocks installation. */
function precheckPassed(evidence: Evidence[], assignmentId: string): boolean {
  const latest = latestOfType(evidence, assignmentId, "RIG_PRECHECK");
  if (!latest) return false;
  return latest.metadata?.passed === true && latest.status !== "rejected" && latest.status !== "recheck_requested";
}

/** The single source of truth for "what stage is this assignment at" —
 * every gate in the FO execution UI (what's unlocked, what's next) reads
 * from this instead of maintaining its own parallel logic. */
export function deriveExecutionStage(assignment: Assignment, evidence: Evidence[], session: Session | undefined): ExecutionStage {
  if (assignment.reviewStatus === "approved") return "approved";
  if (assignment.reviewStatus === "recheck_requested") return "recheck_required";

  const hasLocation = !!latestOfType(evidence, assignment.id, "LOCATION");
  const hasInstallation = !!latestOfType(evidence, assignment.id, "INSTALLATION");
  const installationVerifiedEvidence = latestOfType(evidence, assignment.id, "FINAL_SETUP");
  const hasSessionEndEvidence = !!latestOfType(evidence, assignment.id, "SESSION_END");

  if (session?.status === "completed" || assignment.status === "completed") {
    const completeness = evidenceCompleteness(assignment, evidence);
    // All 9 slots present -> nothing left for the FO to do, it's the
    // Manager's turn. Anything missing -> still "completion": the FO can
    // see exactly what's outstanding (evidenceCompleteness) and add it.
    return completeness.missing.length === 0 ? "ready_for_review" : "completion";
  }
  if (hasSessionEndEvidence) return "completion";
  if (session?.status === "active") return "session";
  if (hasInstallation && installationVerifiedEvidence) return "installation_verified";
  if (assignment.installationStartedAt || hasInstallation) return "installation";
  if (precheckPassed(evidence, assignment.id)) return "rig_ready";
  if (latestOfType(evidence, assignment.id, "RIG_PRECHECK")) return "precheck"; // submitted but not yet passed/failed resolved
  if (hasLocation) return "location_verified";
  if (assignment.actualArrivalAt) return "arrived";
  if (assignment.enRouteAt) return "en_route";
  return "assigned";
}

// ---------------------------------------------------------------------------
// Evidence completeness — the 9 canonical slots an assignment needs before
// it can reach EVIDENCE_COMPLETE, always shown to the FO so nothing is a
// surprise (spec Phase 13).
// ---------------------------------------------------------------------------

export interface EvidenceSlot {
  key: string;
  label: string;
  present: boolean;
}

export interface EvidenceCompleteness {
  slots: EvidenceSlot[];
  completeCount: number;
  totalCount: number;
  missing: string[];
}

export function evidenceCompleteness(assignment: Assignment, evidence: Evidence[]): EvidenceCompleteness {
  const forAssignment = evidence.filter((e) => e.assignmentId === assignment.id && e.status !== "rejected");
  const has = (type: EvidenceType) => forAssignment.some((e) => e.type === type);

  const slots: EvidenceSlot[] = [
    { key: "arrival", label: "Arrival", present: !!assignment.actualArrivalAt },
    { key: "location", label: "Location", present: has("LOCATION") },
    { key: "precheck", label: "Rig precheck", present: precheckPassed(evidence, assignment.id) },
    { key: "precheck_photos", label: "Precheck photos", present: forAssignment.some((e) => e.type === "RIG_PRECHECK" && e.files.length > 0) },
    { key: "installation", label: "Installation", present: has("INSTALLATION") },
    { key: "cable_evidence", label: "Cable evidence", present: has("CABLE_SETUP") },
    { key: "final_setup", label: "Final setup", present: has("FINAL_SETUP") },
    { key: "session_completion", label: "Session completion", present: has("SESSION_END") },
    { key: "completion_photo", label: "Completion photo", present: forAssignment.some((e) => e.type === "SESSION_END" && e.files.length > 0) },
  ];

  return {
    slots,
    completeCount: slots.filter((s) => s.present).length,
    totalCount: slots.length,
    missing: slots.filter((s) => !s.present).map((s) => s.label),
  };
}

// ---------------------------------------------------------------------------
// Precheck / installation checklists — fixed, shown to the FO one screen at
// a time (spec Phase 5/8). Items marked critical: a failure blocks
// installation AND auto-creates an Issue (see submitPrecheck in
// engine/workflows.ts) rather than just a soft warning.
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  key: string;
  label: string;
  critical: boolean;
}

export const PRECHECK_ITEMS: ChecklistItem[] = [
  { key: "body_frame", label: "Body/frame OK", critical: true },
  { key: "wheels_stand", label: "Wheels/stand OK", critical: false },
  { key: "camera_sensor", label: "Camera/sensor OK", critical: true },
  { key: "cables_intact", label: "Cables intact", critical: true },
  { key: "connectors_secure", label: "Connectors secure", critical: true },
  { key: "power_available", label: "Power available", critical: true },
  { key: "power_cable_ok", label: "Power cable OK", critical: true },
  { key: "components_present", label: "Required components present", critical: false },
  { key: "no_visible_damage", label: "No visible damage", critical: true },
  { key: "area_suitable", label: "Installation area suitable", critical: false },
  { key: "safe_to_install", label: "Safe to install", critical: true },
];

export const INSTALLATION_ITEMS: ChecklistItem[] = [
  { key: "rig_installed", label: "Rig physically installed", critical: true },
  { key: "camera_positioned", label: "Camera/sensor positioned", critical: true },
  { key: "cables_connected", label: "Cables connected", critical: true },
  { key: "power_connected", label: "Power connected", critical: true },
  { key: "device_powered", label: "Device powered", critical: true },
  { key: "area_safe", label: "Installation area safe", critical: false },
];

// ---------------------------------------------------------------------------
// AI QA — advisory only (spec Phase 18). Deterministic heuristics over the
// metadata this app actually has (file size, count, capture time, GPS) —
// never a claim about image content this codebase has no way to verify. AI
// QA never writes to an Evidence record's status; it only produces text a
// Manager reads before deciding (see components/forms/EvidenceReviewPanel).
// ---------------------------------------------------------------------------

export interface EvidenceQAFinding {
  message: string;
  confidence: number; // 0-100
  recommendation: string;
}

const TINY_FILE_BYTES = 20_000;

export function runEvidenceQA(evidence: Evidence, siblingEvidence: Evidence[]): EvidenceQAFinding[] {
  const findings: EvidenceQAFinding[] = [];

  if (["ARRIVAL", "RIG_PRECHECK", "INSTALLATION", "CABLE_SETUP", "FINAL_SETUP"].includes(evidence.type) && evidence.files.length === 0) {
    findings.push({
      message: `No photo attached to this ${evidence.type.replace(/_/g, " ").toLowerCase()} evidence.`,
      confidence: 100,
      recommendation: "Request a photo for this step.",
    });
  }

  for (const f of evidence.files) {
    if (f.type.startsWith("image/") && f.sizeBytes > 0 && f.sizeBytes < TINY_FILE_BYTES) {
      findings.push({
        message: `"${f.name}" is unusually small (${Math.round(f.sizeBytes / 1024)}KB) for a photo — may be blurry, corrupt, or a placeholder.`,
        confidence: 65,
        recommendation: "Request a retake at full quality.",
      });
    }
  }

  const sameAssignmentSameType = siblingEvidence.filter((e) => e.id !== evidence.id && e.assignmentId === evidence.assignmentId && e.type === evidence.type);
  for (const f of evidence.files) {
    const dup = sameAssignmentSameType.some((sib) => sib.files.some((sf) => sf.sizeBytes === f.sizeBytes && sf.name === f.name));
    if (dup) {
      findings.push({
        message: `"${f.name}" matches a file already submitted for this step — possible duplicate rather than a new capture.`,
        confidence: 55,
        recommendation: "Confirm this is a fresh photo, not a resubmission of the same file.",
      });
    }
  }

  if (evidence.type === "LOCATION" && evidence.distanceFromExpectedMeters != null && evidence.distanceFromExpectedMeters > LOCATION_MATCH_THRESHOLD_METERS) {
    findings.push({
      message: `Capture location is ${evidence.distanceFromExpectedMeters}m from the business's recorded coordinates.`,
      confidence: 90,
      recommendation: "Confirm the FO is at the correct business before proceeding.",
    });
  }

  return findings;
}

const RIG_QA_LOOKBACK_DAYS = 7;

export interface RigEvidenceSignal extends EvidenceQAFinding {
  evidenceId: string;
  evidenceType: EvidenceType;
  capturedAt: string;
}

/** Rig Guardian's evidence-signal feed (spec Phase 22) — the same
 * deterministic runEvidenceQA findings the Manager sees in evidence review,
 * surfaced per rig so a pattern of flagged captures is visible on the Fleet
 * page too. Advisory only: it never changes computeRigHealth's score, since
 * a real safety event (a failed precheck) already reaches the score through
 * reportRigIncident — this is a second, softer signal shown alongside it,
 * not a duplicate path into the same number. */
export function recentEvidenceSignalsForRig(data: CityData, rigId: string, days = RIG_QA_LOOKBACK_DAYS): RigEvidenceSignal[] {
  const start = Date.now() - days * 86_400_000;
  const rigEvidence = data.evidence.filter((e) => e.rigId === rigId && e.status !== "rejected" && new Date(e.createdAt).getTime() >= start);
  const signals: RigEvidenceSignal[] = [];
  for (const e of rigEvidence) {
    for (const finding of runEvidenceQA(e, data.evidence)) {
      signals.push({ ...finding, evidenceId: e.id, evidenceType: e.type, capturedAt: e.capturedAt ?? e.createdAt });
    }
  }
  return signals.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());
}

/** City-wide execution snapshot for the Manager Command Center (spec
 * Phase 21) — counts derived the same way deriveExecutionStage does, never
 * a separate parallel tally. */
export interface CityExecutionSummary {
  total: number;
  byStage: Partial<Record<ExecutionStage, number>>;
  evidenceCompletePct: number;
  locationMismatches: number;
  precheckFailures: number;
}

export function buildCityExecutionSummary(data: CityData, date: string): CityExecutionSummary {
  const todays = data.assignments.filter((a) => a.date === date && a.status !== "cancelled");
  const byStage: Partial<Record<ExecutionStage, number>> = {};
  let completenessSum = 0;
  let locationMismatches = 0;
  let precheckFailures = 0;

  for (const a of todays) {
    const session = data.sessions.find((s) => s.id === a.sessionId);
    const stage = deriveExecutionStage(a, data.evidence, session);
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    const completeness = evidenceCompleteness(a, data.evidence);
    completenessSum += completeness.totalCount > 0 ? completeness.completeCount / completeness.totalCount : 0;

    const location = latestOfType(data.evidence, a.id, "LOCATION");
    if (location && location.distanceFromExpectedMeters != null && location.distanceFromExpectedMeters > LOCATION_MATCH_THRESHOLD_METERS) locationMismatches += 1;
    const precheck = latestOfType(data.evidence, a.id, "RIG_PRECHECK");
    if (precheck && precheck.metadata?.passed === false) precheckFailures += 1;
  }

  return {
    total: todays.length,
    byStage,
    evidenceCompletePct: todays.length > 0 ? Math.round((completenessSum / todays.length) * 100) : 0,
    locationMismatches,
    precheckFailures,
  };
}
