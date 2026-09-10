import { useCity } from "@/store/city";
import { nowISO } from "@/lib/dates";
import { autoQualityReview } from "./quality";
import { categoryGroup, categoryLabel, ISSUE_TYPE_BY_GROUP } from "./rigTaxonomy";
import { estimateIncidentLostHours } from "./rigGuardian";
import { checkLocation, PRECHECK_ITEMS, type ChecklistItem } from "./execution";
import { takePendingFile } from "@/lib/pendingFileBlobs";
import { enqueueMediaUpload, drainMediaOutbox } from "@/data/mediaOutbox";
import type {
  Assignment,
  AssignmentReviewStatus,
  DamageCategory,
  DiscoveryStage,
  Evidence,
  EvidenceFile,
  EvidenceType,
  IncidentEvidenceFile,
  RepairTestChecklist,
  Severity,
} from "@/types";

/** Marks an FO as arrived at a visit without starting the recording yet. */
export function checkInAssignment(assignment: Assignment) {
  const { updateAssignment, logActivity } = useCity.getState();
  const now = nowISO();
  updateAssignment(assignment.id, { actualArrivalAt: assignment.actualArrivalAt ?? now, status: "confirmed" });
  logActivity({
    type: "fo_arrived",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    summary: "FO arrived",
  });
}

/** Starts a session for a planned/confirmed assignment: marks FO arrived (if
 * not already), begins recording, and logs the activity trail. */
export function startSessionForAssignment(
  assignment: Assignment,
  checklist?: Partial<NonNullable<import("@/types").Session["checklistSetup"]>>,
) {
  const { addSession, updateAssignment, logActivity } = useCity.getState();
  const rig = useCity.getState().rigs.find((r) => r.id === assignment.rigId);
  const now = nowISO();
  const durationMin = (new Date(assignment.plannedEnd).getTime() - new Date(assignment.plannedStart).getTime()) / 60000;

  const session = addSession({
    assignmentId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    collectorId: assignment.collectorId,
    rigId: assignment.rigId,
    date: assignment.date,
    startedAt: now,
    plannedDurationMin: durationMin,
    status: "active",
    batteryPct: rig?.batteryPct ?? 90,
    storagePct: rig?.storagePct ?? 20,
    signal: "healthy",
    checklistSetup: {
      confirmedBusiness: true,
      scannedRig: true,
      checkedBattery: true,
      checkedStorage: true,
      confirmedCollector: true,
      capturedEvidence: false,
      ...checklist,
    },
  });

  updateAssignment(assignment.id, {
    status: "in_progress",
    actualArrivalAt: assignment.actualArrivalAt ?? now,
    actualStart: now,
    sessionId: session.id,
  });

  if (!assignment.actualArrivalAt) {
    logActivity({
      type: "fo_arrived",
      entityKind: "assignment",
      entityId: assignment.id,
      businessId: assignment.businessId,
      foId: assignment.foId,
      summary: "FO arrived",
    });
  }
  logActivity({
    type: "session_started",
    entityKind: "session",
    entityId: session.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    rigId: assignment.rigId,
    sessionId: session.id,
    summary: "Session started",
  });

  return session;
}

/** Ends an active session, auto-flags quality, and completes the assignment. */
export function completeSession(sessionId: string) {
  const { sessions, updateSession, updateAssignment, addQualityReview, logActivity, assignments } = useCity.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const now = nowISO();

  updateSession(sessionId, { status: "completed", endedAt: now });
  const updated = { ...session, endedAt: now, status: "completed" as const };

  const assignment = assignments.find((a) => a.id === session.assignmentId);
  if (assignment) {
    updateAssignment(assignment.id, { status: "completed", actualEnd: now });
  }

  const { verdict, flags } = autoQualityReview(updated);
  const review = addQualityReview({
    sessionId,
    businessId: session.businessId,
    foId: session.foId,
    verdict,
    flags,
    reviewedAt: verdict === "pass" ? now : undefined,
  });

  logActivity({
    type: "session_ended",
    entityKind: "session",
    entityId: sessionId,
    businessId: session.businessId,
    foId: session.foId,
    rigId: session.rigId,
    sessionId,
    summary: "Session ended",
  });
  logActivity({
    type: verdict === "pass" ? "qa_passed" : verdict === "warn" ? "qa_warned" : "qa_failed",
    entityKind: "quality",
    entityId: sessionId,
    businessId: session.businessId,
    foId: session.foId,
    sessionId,
    summary: `QA ${verdict === "pass" ? "passed" : verdict === "warn" ? "flagged a warning" : "failed"}`,
  });

  return review;
}

// ---------------------------------------------------------------------------
// Evidence-driven execution workflows
//
// Every function here does exactly one state transition and logs exactly
// the activity event that describes it (spec Phase 23) — never a silent
// mutation. None of these decide anything on the FO's behalf beyond what
// they explicitly submitted (no auto-pass, no auto-approve); the one
// exception, submitPrecheck's automatic Issue creation on a failed
// critical item, reuses reportRigIncident() verbatim rather than
// duplicating issue-creation logic.
// ---------------------------------------------------------------------------

const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  ARRIVAL: "Arrival",
  LOCATION: "Location",
  RIG_PRECHECK: "Rig precheck",
  RIG_DAMAGE: "Rig damage",
  INSTALLATION: "Installation",
  CABLE_SETUP: "Cable setup",
  FINAL_SETUP: "Final setup",
  SESSION_START: "Session start",
  SESSION_END: "Session end",
  ISSUE: "Issue",
  OTHER: "Other",
};

function captureEvidence(params: {
  assignment: Assignment;
  type: EvidenceType;
  files: EvidenceFile[];
  notes?: string;
  lat?: number;
  lng?: number;
  locationAccuracy?: number;
  distanceFromExpectedMeters?: number;
  metadata?: Record<string, unknown>;
  replacesEvidenceId?: string;
}): Evidence {
  const { addEvidence, logActivity } = useCity.getState();
  const now = nowISO();
  const evidence = addEvidence({
    assignmentId: params.assignment.id,
    sessionId: params.assignment.sessionId,
    businessId: params.assignment.businessId,
    foId: params.assignment.foId,
    rigId: params.assignment.rigId,
    type: params.type,
    startedAt: now,
    capturedAt: now,
    lat: params.lat,
    lng: params.lng,
    locationAccuracy: params.locationAccuracy,
    distanceFromExpectedMeters: params.distanceFromExpectedMeters,
    files: params.files,
    notes: params.notes,
    metadata: params.metadata,
    replacesEvidenceId: params.replacesEvidenceId,
    status: "submitted",
  });
  logActivity({
    type: params.replacesEvidenceId ? "evidence_replaced" : "evidence_added",
    entityKind: "assignment",
    entityId: params.assignment.id,
    businessId: params.assignment.businessId,
    foId: params.assignment.foId,
    rigId: params.assignment.rigId,
    summary: `${EVIDENCE_TYPE_LABEL[params.type]} evidence captured`,
  });

  // Queue each photo's real binary for Storage upload — the raw File was
  // stashed by whichever capture UI built `params.files` (PhotoCapture in
  // FOExecution.tsx), since by this point only its metadata + a transient
  // localUrl remain. Firestore sync of this evidence record is deferred
  // (see syncEngine.ts) until every file here finishes uploading — an FO
  // can never legally update evidence after creating it (append-only), so
  // the record must reach Firestore already in its final state.
  for (const file of evidence.files) {
    const raw = takePendingFile(file.id);
    if (!raw) continue;
    void enqueueMediaUpload({
      foId: params.assignment.foId,
      assignmentId: params.assignment.id,
      evidenceId: evidence.id,
      fileId: file.id,
      fileName: file.name,
      mimeType: file.type,
      blob: raw,
    }).then(() => drainMediaOutbox());
  }

  return evidence;
}

/** FO taps "I'm on my way" — informational only, never gates anything. */
export function markEnRoute(assignment: Assignment) {
  const { updateAssignment, logActivity } = useCity.getState();
  updateAssignment(assignment.id, { enRouteAt: assignment.enRouteAt ?? nowISO() });
  logActivity({
    type: "en_route",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    summary: "FO en route",
  });
}

/** The app calculates verification — the FO never self-declares "arrived
 * and verified" (spec Phase 3). Creates a LOCATION evidence record with
 * the computed distance always attached, whether inside or outside the
 * threshold — a mismatch is evidence too, not a rejected submission. */
export function captureLocationEvidence(
  assignment: Assignment,
  business: import("@/types").Business | undefined,
  lat: number,
  lng: number,
  accuracy?: number,
) {
  const { logActivity } = useCity.getState();
  const check = checkLocation(business, lat, lng);
  const evidence = captureEvidence({
    assignment,
    type: "LOCATION",
    files: [],
    lat,
    lng,
    locationAccuracy: accuracy,
    distanceFromExpectedMeters: check.distanceMeters ?? undefined,
    metadata: { verified: check.verified, message: check.message },
  });
  logActivity({
    type: "location_verified",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    summary: check.verified ? `Location verified — ${check.message}` : `Location mismatch — ${check.message}`,
  });
  return evidence;
}

/** ARRIVAL / INSTALLATION / CABLE_SETUP / FINAL_SETUP / SESSION_END photo
 * capture — the same shape for every "take a photo at this step" action,
 * reusing the file-input + object-URL pattern already established in
 * SessionDetail.tsx rather than inventing a second one. */
export function captureStepEvidence(assignment: Assignment, type: EvidenceType, files: EvidenceFile[], notes?: string, replacesEvidenceId?: string) {
  return captureEvidence({ assignment, type, files, notes, replacesEvidenceId });
}

export interface PrecheckResult {
  evidence: Evidence;
  passed: boolean;
  failedCritical: ChecklistItem[];
}

/** Evaluates the precheck checklist deterministically (every CRITICAL item
 * must be checked to pass — spec Phase 5/6) and creates exactly one
 * RIG_PRECHECK evidence record either way. A failure on any critical item
 * automatically creates an Issue + RigIncident via the EXISTING
 * reportRigIncident() — never a second, parallel issue-creation path — and
 * the installation step stays locked (see deriveExecutionStage, which
 * reads this evidence's metadata.passed, not a separate flag). */
export function submitPrecheck(
  assignment: Assignment,
  checklist: Record<string, boolean>,
  files: EvidenceFile[],
  failureDescription?: string,
): PrecheckResult {
  const { logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === assignment.rigId);
  const failedCritical = PRECHECK_ITEMS.filter((item) => item.critical && !checklist[item.key]);
  const passed = failedCritical.length === 0;

  logActivity({
    type: "precheck_started",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    rigId: assignment.rigId,
    summary: "Rig precheck started",
  });

  const evidence = captureEvidence({
    assignment,
    type: "RIG_PRECHECK",
    files,
    notes: passed ? undefined : failureDescription,
    metadata: { passed, checklist, failedItems: failedCritical.map((i) => i.key) },
  });

  if (passed) {
    logActivity({
      type: "precheck_passed",
      entityKind: "assignment",
      entityId: assignment.id,
      businessId: assignment.businessId,
      foId: assignment.foId,
      rigId: assignment.rigId,
      summary: `${rig?.code ?? "Rig"} precheck passed`,
    });
  } else {
    logActivity({
      type: "precheck_failed",
      entityKind: "assignment",
      entityId: assignment.id,
      businessId: assignment.businessId,
      foId: assignment.foId,
      rigId: assignment.rigId,
      summary: `${rig?.code ?? "Rig"} precheck failed: ${failedCritical.map((i) => i.label).join(", ")}`,
    });
    if (assignment.rigId) {
      reportRigIncident({
        rigId: assignment.rigId,
        category: "unknown_technical",
        severity: "critical",
        discoveryStage: "preflight",
        description: failureDescription || `Precheck failed: ${failedCritical.map((i) => i.label).join(", ")}`,
        assignmentId: assignment.id,
        businessId: assignment.businessId,
        foId: assignment.foId,
      });
    }
  }

  return { evidence, passed, failedCritical };
}

/** Records installationStartedAt — only meaningful to call once a passing
 * RIG_PRECHECK evidence exists (the FO Cockpit UI enforces this by not
 * showing the button before deriveExecutionStage says "rig_ready"; this
 * function itself doesn't re-check, matching every other workflow function
 * here, which trust the UI gate rather than duplicating it). */
export function startInstallation(assignment: Assignment) {
  const { updateAssignment, logActivity } = useCity.getState();
  updateAssignment(assignment.id, { installationStartedAt: assignment.installationStartedAt ?? nowISO() });
  logActivity({
    type: "installation_started",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    rigId: assignment.rigId,
    summary: "Installation started",
  });
}

export function completeInstallationVerification(assignment: Assignment) {
  const { logActivity } = useCity.getState();
  logActivity({
    type: "installation_verified",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    rigId: assignment.rigId,
    summary: "Installation verified",
  });
}

/** The single Manager decision that crosses READY_FOR_REVIEW ->
 * APPROVED/RECHECK_REQUIRED (spec Phase 2/16/17/26) — never inferred, never
 * settable by AI QA. Approving also marks the assignment status
 * "completed" if it wasn't already (the review is the last step). */
export function reviewAssignment(assignment: Assignment, decision: AssignmentReviewStatus, reviewedBy: string, note?: string) {
  const { updateAssignment, logActivity } = useCity.getState();
  const now = nowISO();
  updateAssignment(assignment.id, { reviewStatus: decision, reviewedBy, reviewedAt: now, reviewNote: note });
  logActivity({
    type: decision === "approved" ? "assignment_completed" : "recheck_requested",
    entityKind: "assignment",
    entityId: assignment.id,
    businessId: assignment.businessId,
    foId: assignment.foId,
    summary: decision === "approved" ? "Manager approved assignment" : `Manager requested recheck${note ? `: ${note}` : ""}`,
    detail: note,
  });
}

/** Manager rejects or requests a recheck on ONE specific evidence record —
 * the record itself is never deleted or overwritten (append-only, spec
 * Phase 15); the FO's replacement submission is a new Evidence with
 * replacesEvidenceId set (see captureStepEvidence). */
export function reviewEvidence(evidence: Evidence, decision: "approved" | "rejected" | "recheck_requested", reviewedBy: string, note?: string) {
  const { updateEvidence, logActivity } = useCity.getState();
  const now = nowISO();
  updateEvidence(evidence.id, { status: decision, reviewedBy, reviewedAt: now, reviewNote: note });
  if (decision !== "approved") {
    logActivity({
      type: decision === "rejected" ? "evidence_rejected" : "recheck_requested",
      entityKind: "assignment",
      entityId: evidence.assignmentId ?? evidence.id,
      businessId: evidence.businessId,
      foId: evidence.foId,
      rigId: evidence.rigId,
      summary: `${EVIDENCE_TYPE_LABEL[evidence.type]} evidence ${decision === "rejected" ? "rejected" : "recheck requested"}${note ? `: ${note}` : ""}`,
      detail: note,
    });
  }
}

// ---------------------------------------------------------------------------
// Rig Guardian workflows
// ---------------------------------------------------------------------------

/** Reports a rig incident: creates the structured RigIncident (taxonomy,
 * discovery stage, evidence) and a companion generic Issue so the existing
 * Action Inbox / Issue Center / lost-hours engine pick it up unchanged. */
export function reportRigIncident(params: {
  rigId: string;
  category: DamageCategory;
  severity: Severity;
  discoveryStage: DiscoveryStage;
  description: string;
  sessionId?: string;
  assignmentId?: string;
  businessId?: string;
  foId?: string;
  evidence?: IncidentEvidenceFile[];
  lostHours?: number;
}) {
  const { addRigIncident, addIssue, updateRigIncident, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === params.rigId);
  const now = nowISO();
  const group = categoryGroup(params.category);
  const lostHours = params.lostHours ?? estimateIncidentLostHours(useCity.getState(), { assignmentId: params.assignmentId, severity: params.severity, discoveredAt: now });

  const incident = addRigIncident({
    rigId: params.rigId,
    sessionId: params.sessionId,
    assignmentId: params.assignmentId,
    businessId: params.businessId,
    foId: params.foId,
    category: params.category,
    group,
    severity: params.severity,
    discoveredAt: now,
    discoveryStage: params.discoveryStage,
    description: params.description,
    evidence: params.evidence ?? [],
    status: "open",
    lostHours,
  });

  const issue = addIssue({
    type: ISSUE_TYPE_BY_GROUP[group],
    severity: params.severity,
    title: `${rig?.code ?? "Rig"}: ${categoryLabel(params.category)}`,
    description: params.description || categoryLabel(params.category),
    businessId: params.businessId,
    foId: params.foId,
    rigId: params.rigId,
    sessionId: params.sessionId,
    assignmentId: params.assignmentId,
    owner: "You",
    status: "open",
    lostHours,
  });

  updateRigIncident(incident.id, { linkedIssueId: issue.id });

  logActivity({
    type: "rig_incident_reported",
    entityKind: "rig_incident",
    entityId: incident.id,
    rigId: params.rigId,
    businessId: params.businessId,
    foId: params.foId,
    sessionId: params.sessionId,
    issueId: issue.id,
    summary: `${rig?.code ?? "Rig"}: ${categoryLabel(params.category)} (discovered at ${params.discoveryStage.replace("_", " ")})`,
    detail: params.description,
  });

  return incident;
}

/** Advances a rig incident through the repair lifecycle, keeping the rig's
 * deploymentStatus in sync so Fleet/Planner reflect it immediately. */
export function advanceRigIncidentStatus(incidentId: string, status: "triage" | "inspection" | "repair" | "testing" | "cancelled") {
  const { rigIncidents, updateRigIncident, updateRig, logActivity } = useCity.getState();
  const incident = rigIncidents.find((i) => i.id === incidentId);
  if (!incident) return;
  updateRigIncident(incidentId, { status });
  if (status === "inspection") updateRig(incident.rigId, { deploymentStatus: "inspection" });
  if (status === "repair") updateRig(incident.rigId, { deploymentStatus: "repair" });
  logActivity({
    type: "rig_incident_status_changed",
    entityKind: "rig_incident",
    entityId: incidentId,
    rigId: incident.rigId,
    summary: `Incident moved to ${status}`,
  });
}

/** Records the repair performed. Puts the incident into "testing" — only a
 * passing post-repair test (runPostRepairTest) returns the rig to service. */
export function saveRepairRecord(params: {
  rigId: string;
  incidentId: string;
  diagnosis: string;
  repairAction: string;
  parts?: string;
  beforeEvidence?: IncidentEvidenceFile[];
  afterEvidence?: IncidentEvidenceFile[];
  notes?: string;
}) {
  const { addRepairRecord, updateRigIncident, updateRig, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === params.rigId);
  const record = addRepairRecord({
    rigId: params.rigId,
    incidentId: params.incidentId,
    diagnosis: params.diagnosis,
    repairAction: params.repairAction,
    parts: params.parts,
    beforeEvidence: params.beforeEvidence ?? [],
    afterEvidence: params.afterEvidence ?? [],
    notes: params.notes,
    repairedAt: nowISO(),
  });
  updateRigIncident(params.incidentId, { status: "testing", repairRecordId: record.id, correctiveAction: params.repairAction });
  updateRig(params.rigId, { deploymentStatus: "repair" });
  logActivity({
    type: "rig_repair_logged",
    entityKind: "repair",
    entityId: record.id,
    rigId: params.rigId,
    summary: `Repair logged for ${rig?.code ?? "rig"}: ${params.repairAction}`,
    detail: params.diagnosis,
  });
  return record;
}

/** Only a PASS automatically returns the rig to READY — a FAIL sends it
 * back for further repair. Never auto-passes. */
export function runPostRepairTest(repairRecordId: string, checklist: RepairTestChecklist, result: "pass" | "fail") {
  const { repairRecords, updateRepairRecord, rigIncidents, updateRigIncident, updateRig, logActivity, resolveIssue } = useCity.getState();
  const record = repairRecords.find((r) => r.id === repairRecordId);
  if (!record) return;
  updateRepairRecord(repairRecordId, { testChecklist: checklist, testResult: result });

  if (result === "pass") {
    const now = nowISO();
    updateRigIncident(record.incidentId, { status: "resolved", resolvedAt: now });
    const incident = rigIncidents.find((i) => i.id === record.incidentId);
    if (incident?.linkedIssueId) resolveIssue(incident.linkedIssueId, `Repaired: ${record.repairAction}`);
    updateRig(record.rigId, { deploymentStatus: "active", statusOverride: undefined, statusOverrideReason: undefined });
    logActivity({ type: "rig_repair_test_passed", entityKind: "repair", entityId: record.id, rigId: record.rigId, summary: "Post-repair test passed — rig returned to service" });
  } else {
    updateRigIncident(record.incidentId, { status: "repair" });
    logActivity({ type: "rig_repair_test_failed", entityKind: "repair", entityId: record.id, rigId: record.rigId, summary: "Post-repair test failed — rig sent back for further repair" });
  }
}

export function requestRigInspection(rigId: string, reason?: string) {
  const { updateRig, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === rigId);
  updateRig(rigId, { inspectionRequestedAt: nowISO() });
  logActivity({
    type: "rig_inspection_requested",
    entityKind: "rig",
    entityId: rigId,
    rigId,
    summary: `Inspection requested for ${rig?.code ?? "rig"}`,
    detail: reason,
  });
}

export function completeRigInspection(rigId: string, passed: boolean, notes?: string) {
  const { updateRig, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === rigId);
  const now = nowISO();
  updateRig(rigId, {
    lastInspectionAt: now,
    inspectionRequestedAt: undefined,
    deploymentStatus: passed ? "active" : "inspection",
  });
  if (!passed) {
    reportRigIncident({
      rigId,
      category: "unknown_technical",
      severity: "warning",
      discoveryStage: "maintenance",
      description: notes || "Failed scheduled inspection.",
    });
  }
  logActivity({
    type: "rig_inspection_completed",
    entityKind: "rig",
    entityId: rigId,
    rigId,
    summary: `${rig?.code ?? "Rig"} inspection ${passed ? "passed" : "failed"}`,
    detail: notes,
  });
}

export function setRigStatusOverride(rigId: string, status: import("@/types").RigReadinessStatus | undefined, reason?: string) {
  const { updateRig, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === rigId);
  updateRig(rigId, { statusOverride: status, statusOverrideReason: status ? reason : undefined });
  logActivity({
    type: "rig_status_override",
    entityKind: "rig",
    entityId: rigId,
    rigId,
    summary: status ? `${rig?.code ?? "Rig"} manually set to ${status.replace(/_/g, " ")}` : `Manual override cleared for ${rig?.code ?? "rig"}`,
    detail: reason,
  });
}

export function retireRig(rigId: string, reason?: string) {
  const { updateRig, logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === rigId);
  updateRig(rigId, { deploymentStatus: "retired", active: false, retiredAt: nowISO() });
  logActivity({ type: "rig_retired", entityKind: "rig", entityId: rigId, rigId, summary: `${rig?.code ?? "Rig"} retired`, detail: reason });
}

export function logRigPreflightPassed(rigId: string) {
  const { logActivity, rigs } = useCity.getState();
  const rig = rigs.find((r) => r.id === rigId);
  logActivity({
    type: "rig_preflight_passed",
    entityKind: "rig",
    entityId: rigId,
    rigId,
    summary: `${rig?.code ?? "Rig"} passed preflight`,
  });
}
