import { useCity } from "@/store/city";
import { nowISO } from "@/lib/dates";
import { autoQualityReview } from "./quality";
import { categoryGroup, categoryLabel, ISSUE_TYPE_BY_GROUP } from "./rigTaxonomy";
import { estimateIncidentLostHours } from "./rigGuardian";
import type { Assignment, DamageCategory, DiscoveryStage, IncidentEvidenceFile, RepairTestChecklist, Severity } from "@/types";

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
