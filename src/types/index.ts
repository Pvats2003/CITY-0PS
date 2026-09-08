// ---------------------------------------------------------------------------
// CITY OPS OS — core data model
// Local-first. No server. IDs are string nanoids. Dates are ISO 8601 strings.
// ---------------------------------------------------------------------------

export type Status =
  | "healthy"
  | "warning"
  | "critical"
  | "active"
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "offline"
  | "unknown";

export type Severity = "critical" | "warning" | "attention" | "opportunity";

export type EntityKind =
  | "business"
  | "fo"
  | "collector"
  | "rig"
  | "rig_incident"
  | "repair"
  | "assignment"
  | "session"
  | "issue"
  | "quality"
  | "plan"
  | "report";

// --------------------------------- Business ---------------------------------

export interface Business {
  id: string;
  name: string;
  category: string;
  area: string;
  address: string;
  lat?: number;
  lng?: number;
  contactName?: string;
  contactPhone?: string;
  preferredWindowStart?: string; // "HH:mm"
  preferredWindowEnd?: string; // "HH:mm"
  capacityHoursPerDay: number;
  notes?: string;
  active: boolean;
  createdAt: string;
  firstVisitAt?: string;
  unavailableDates?: string[]; // ISO date strings, business closed/unavailable
}

// ------------------------------ Field Officer -------------------------------

export interface FieldOfficer {
  id: string;
  name: string;
  phone?: string;
  photoUrl?: string;
  homeArea?: string;
  active: boolean;
  createdAt: string;
  unavailableDates?: string[];
}

// -------------------------------- Collector ---------------------------------

export interface Collector {
  id: string;
  name: string;
  businessId?: string; // usually attached to a business's staff
  phone?: string;
  active: boolean;
  createdAt: string;
}

// ----------------------------------- Rig -------------------------------------

/** Lifecycle bucket the rig is currently assigned to. Distinct from
 * readiness (below), which is a computed, deterministic health judgment. */
export type RigDeploymentStatus = "active" | "standby" | "inspection" | "repair" | "retired";

/** Computed, never stored as ground truth except via manual override —
 * see engine/rigGuardian.ts `deriveRigReadiness`. */
export type RigReadinessStatus = "healthy" | "watch" | "inspection_required" | "do_not_deploy" | "in_repair";

export interface Rig {
  id: string;
  code: string; // e.g. "R-04"
  model: string;
  active: boolean; // legacy simple flag; false only once retired
  batteryPct: number; // last known
  storagePct: number; // used %
  deploymentStatus: RigDeploymentStatus;
  /** Manual override of the computed readiness status (e.g. operator marks
   * a rig unsafe ahead of a formal incident, or clears a stale computed
   * status). Always shown with its reason — never silent. */
  statusOverride?: RigReadinessStatus;
  statusOverrideReason?: string;
  lastInspectionAt?: string;
  /** Set by "Create Inspection Task" — forces inspection_required until an
   * inspection is logged (clears lastInspectionAt forward). */
  inspectionRequestedAt?: string;
  lastServiceAt?: string;
  createdAt: string;
  notes?: string;
  retiredAt?: string;
}

// ------------------------------- Rig Guardian ----------------------------------

/** Fine-grained damage taxonomy (spec: "replace generic 'technical issue'
 * wherever practical"). Grouped under DamageGroup for scoring/analysis. */
export type DamageCategory =
  // physical
  | "wire_broken"
  | "cable_frayed"
  | "connector_damaged"
  | "connector_loose"
  | "mount_damaged"
  | "casing_damaged"
  | "camera_physical_damage"
  // electrical
  | "power_failure"
  | "charging_failure"
  | "battery_issue"
  | "overheating"
  // camera
  | "camera_not_detected"
  | "camera_dropout"
  | "image_problem"
  | "lens_obstruction"
  // storage
  | "storage_full"
  | "memory_card_problem"
  | "storage_corruption"
  // recording
  | "recording_wont_start"
  | "recording_stopped"
  | "incomplete_recording"
  | "audio_failure"
  // other
  | "unknown_technical"
  | "accidental_damage"
  | "water_damage"
  | "missing_component";

export type DamageGroup = "physical" | "electrical" | "camera" | "storage" | "recording" | "other";

export type DiscoveryStage = "preflight" | "setup" | "during_recording" | "post_session" | "qa" | "maintenance" | "other";

export type RigIncidentStatus = "open" | "triage" | "inspection" | "repair" | "testing" | "resolved" | "cancelled";

export interface IncidentEvidenceFile {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  localUrl: string;
  capturedAt: string;
}

export interface RigIncident {
  id: string;
  rigId: string;
  sessionId?: string;
  assignmentId?: string;
  businessId?: string;
  foId?: string;
  category: DamageCategory;
  group: DamageGroup;
  severity: Severity;
  discoveredAt: string;
  discoveryStage: DiscoveryStage;
  description: string;
  evidence: IncidentEvidenceFile[];
  status: RigIncidentStatus;
  rootCause?: string;
  correctiveAction?: string;
  /** Companion entry in the generic Issue list so the existing Action
   * Inbox / Issue Center / lost-hours engine pick this up automatically. */
  linkedIssueId?: string;
  repairRecordId?: string;
  lostHours?: number;
  createdAt: string;
  resolvedAt?: string;
}

export interface RepairTestChecklist {
  power: boolean;
  cameras: boolean;
  cables: boolean;
  connectors: boolean;
  storage: boolean;
  recording: boolean;
  battery: boolean;
}

export interface RepairRecord {
  id: string;
  rigId: string;
  incidentId: string;
  diagnosis: string;
  repairAction: string;
  parts?: string;
  beforeEvidence: IncidentEvidenceFile[];
  afterEvidence: IncidentEvidenceFile[];
  testChecklist?: RepairTestChecklist;
  testResult?: "pass" | "fail";
  repairedAt: string;
  notes?: string;
  createdAt: string;
}

// -------------------------------- Assignment ----------------------------------

export type AssignmentStatus =
  | "planned"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "rejected"
  | "cancelled"
  | "no_show";

export interface Assignment {
  id: string;
  date: string; // ISO date "yyyy-MM-dd"
  businessId: string;
  foId: string;
  collectorId?: string;
  rigId?: string;
  plannedStart: string; // ISO datetime
  plannedEnd: string; // ISO datetime
  actualArrivalAt?: string;
  actualStart?: string;
  actualEnd?: string;
  priority: "high" | "normal" | "low";
  status: AssignmentStatus;
  sessionId?: string;
  planId?: string;
  notes?: string;
  travelBufferMin?: number;
  createdAt: string;
}

// ---------------------------------- Session -----------------------------------

export type SessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface SessionTelemetryPoint {
  at: string;
  batteryPct: number;
  storagePct: number;
  signal: "healthy" | "intermittent" | "offline";
}

export interface Session {
  id: string;
  assignmentId: string;
  businessId: string;
  foId: string;
  collectorId?: string;
  rigId?: string;
  date: string;
  startedAt: string;
  endedAt?: string;
  plannedDurationMin: number;
  status: SessionStatus;
  batteryPct: number;
  storagePct: number;
  signal: "healthy" | "intermittent" | "offline";
  telemetry?: SessionTelemetryPoint[];
  checklistSetup?: {
    confirmedBusiness: boolean;
    scannedRig: boolean;
    checkedBattery: boolean;
    checkedStorage: boolean;
    confirmedCollector: boolean;
    capturedEvidence: boolean;
  };
  notes?: string;
  createdAt: string;
}

// ---------------------------------- Evidence -----------------------------------

export interface EvidenceFile {
  id: string;
  name: string;
  type: string; // mime
  sizeBytes: number;
  localUrl: string; // object URL (session only, not persisted binary)
  capturedAt: string;
}

export interface Evidence {
  id: string;
  sessionId: string;
  businessId: string;
  foId: string;
  collectorId?: string;
  rigId?: string;
  startedAt: string;
  endedAt?: string;
  lat?: number;
  lng?: number;
  files: EvidenceFile[];
  notes?: string;
  status: "pending" | "submitted" | "verified";
  createdAt: string;
}

// ----------------------------------- Issue --------------------------------------

export type IssueType =
  | "business_rejection"
  | "fo_no_show"
  | "late_arrival"
  | "rig_failure"
  | "battery"
  | "storage"
  | "network"
  | "recording_failure"
  | "quality"
  | "damage"
  | "missing_evidence"
  | "scheduling"
  | "other";

export type IssueStatus = "open" | "in_progress" | "resolved" | "cancelled";

export interface Issue {
  id: string;
  type: IssueType;
  severity: Severity;
  title: string;
  description: string;
  businessId?: string;
  foId?: string;
  rigId?: string;
  sessionId?: string;
  assignmentId?: string;
  owner?: string; // who owns resolving it (usually "You" / FO name)
  rootCause?: string;
  action?: string;
  status: IssueStatus;
  lostHours?: number;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

// ------------------------------- Quality Review ----------------------------------

export type QualityVerdict = "pending" | "pass" | "warn" | "fail";

export interface QualityFlag {
  code: string;
  label: string;
  detail: string;
}

export interface QualityReview {
  id: string;
  sessionId: string;
  businessId: string;
  foId: string;
  verdict: QualityVerdict;
  flags: QualityFlag[];
  reviewedAt?: string;
  correctiveActionId?: string;
  notes?: string;
  createdAt: string;
}

export type CorrectiveActionType =
  | "recapture"
  | "fo_followup"
  | "business_followup"
  | "rig_inspection"
  | "collector_retraining";

export interface CorrectiveAction {
  id: string;
  qualityReviewId: string;
  type: CorrectiveActionType;
  notes?: string;
  status: "open" | "done";
  createdAt: string;
  doneAt?: string;
}

// ------------------------------- Activity Event -----------------------------------

export type ActivityEventType =
  | "assignment_created"
  | "fo_arrived"
  | "rig_scanned"
  | "session_started"
  | "battery_warning"
  | "storage_warning"
  | "signal_warning"
  | "session_ended"
  | "evidence_added"
  | "qa_passed"
  | "qa_warned"
  | "qa_failed"
  | "issue_reported"
  | "issue_resolved"
  | "business_rejected"
  | "plan_published"
  | "plan_changed"
  | "day_started"
  | "day_ended"
  | "note"
  | "rig_preflight_passed"
  | "rig_incident_reported"
  | "rig_incident_status_changed"
  | "rig_incident_resolved"
  | "rig_repair_logged"
  | "rig_repair_test_passed"
  | "rig_repair_test_failed"
  | "rig_inspection_completed"
  | "rig_inspection_requested"
  | "rig_retired"
  | "rig_status_override";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  at: string;
  entityKind: EntityKind;
  entityId: string;
  businessId?: string;
  foId?: string;
  rigId?: string;
  sessionId?: string;
  issueId?: string;
  summary: string;
  detail?: string;
}

// ---------------------------------- Daily Plan -------------------------------------

export interface PlanConflict {
  id: string;
  type:
    | "fo_double_booking"
    | "rig_double_booking"
    | "fo_unavailable"
    | "rig_unavailable"
    | "rig_unsafe"
    | "business_unavailable"
    | "insufficient_capacity"
    | "unrealistic_timing";
  severity: Severity;
  message: string;
  assignmentIds: string[];
}

export interface DailyPlan {
  id: string;
  date: string;
  assignmentIds: string[];
  score: number;
  scoreBreakdown: { label: string; delta: number }[];
  conflicts: PlanConflict[];
  publishedAt?: string;
  createdAt: string;
}

// --------------------------------- Daily Report --------------------------------------

export type ReportKind = "sod" | "mod" | "eod";

export interface DailyReport {
  id: string;
  date: string;
  kind: ReportKind;
  generatedAt: string;
  data: Record<string, unknown>;
  narrative?: string;
}

// ------------------------------------ Settings -------------------------------------------

export interface CitySettings {
  cityName: string;
  workingHoursStart: string; // "HH:mm"
  workingHoursEnd: string;
  defaultSessionDurationMin: number;
  recordingHoursTargetPerDay: number;
  theme: "light" | "dark" | "system";
  onboarded: boolean;
}

// ----------------------------------- Root store shape -------------------------------------

export interface CityData {
  version: number;
  settings: CitySettings;
  businesses: Business[];
  fos: FieldOfficer[];
  collectors: Collector[];
  rigs: Rig[];
  assignments: Assignment[];
  sessions: Session[];
  evidence: Evidence[];
  issues: Issue[];
  qualityReviews: QualityReview[];
  correctiveActions: CorrectiveAction[];
  rigIncidents: RigIncident[];
  repairRecords: RepairRecord[];
  activity: ActivityEvent[];
  plans: DailyPlan[];
  reports: DailyReport[];
}
