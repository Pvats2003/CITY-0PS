import { useCity } from "@/store/city";
import { nowISO } from "@/lib/dates";
import { autoQualityReview } from "./quality";
import type { Assignment } from "@/types";

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
