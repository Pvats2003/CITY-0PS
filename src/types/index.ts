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
  /** The user's own pasted Google Maps link for this business (any normal
   * google.com/maps, maps.google.com, or maps.app.goo.gl share URL) — the
   * production-usable location field, since nothing in the app ever lets a
   * Manager set lat/lng directly (those are demo-data-only coordinates).
   * See lib/googleMaps.ts for validation and the display-link fallback. */
  googleMapsUrl?: string;
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
  /** Links this FO record to a login account (see src/auth). Optional —
   * an FO can exist in the roster before being invited to log in. */
  email?: string;
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

/** A Manager decision, set only via reviewAssignment() in
 * engine/workflows.ts — never inferred, never set by AI QA. "pending" is
 * the default (including for every assignment that predates this field).
 * See engine/execution.ts's deriveExecutionStage: READY_FOR_REVIEW is a
 * derived stage (evidence complete, session ended), but the final
 * APPROVED/RECHECK_REQUIRED transition is this field, a real Manager act. */
export type AssignmentReviewStatus = "pending" | "approved" | "recheck_requested";

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
  /** FO tapped "I'm on my way" — purely informational (Command Center
   * status, activity trail); does not gate anything downstream. */
  enRouteAt?: string;
  /** Set once the FO taps "Start Installation" (only unlocked after a
   * passing RIG_PRECHECK evidence exists) — see Phase 8/10 of the
   * evidence-driven execution flow. */
  installationStartedAt?: string;
  reviewStatus?: AssignmentReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
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

/** Where an EvidenceFile's binary currently stands. "local_only"/"uploading"
 * are transient — retried automatically by data/mediaOutbox.ts on every
 * reconnect, never a terminal failure state the app gives up on.
 * "upload_failed" is shown to the user but is ALSO still retried (same
 * indefinite-retry philosophy as data/outbox.ts) rather than abandoned.
 * Undefined (on records that predate this field) is treated as ready/no
 * media pending, matching the legacy shape's meaning. */
export type MediaUploadStatus = "local_only" | "uploading" | "uploaded" | "upload_failed";

export interface EvidenceFile {
  id: string;
  name: string;
  type: string; // mime
  sizeBytes: number;
  /** Transient object URL (URL.createObjectURL), valid only in the browser
   * tab/session that captured it — never resolves for another device or
   * after that tab's Document unloads. Kept only as an immediate local
   * preview before/while the real upload is in flight; once uploadStatus
   * is "uploaded", `downloadUrl` is the permanent reference and every
   * viewer must prefer it over this field. */
  localUrl: string;
  capturedAt: string;
  /** Undefined only on records created before this field existed. */
  uploadStatus?: MediaUploadStatus;
  /** Deterministic Firebase Storage object path this file uploads to —
   * see data/mediaStorage.ts's evidenceStoragePath(). Stable per file id,
   * so a retried upload overwrites the same object rather than creating a
   * duplicate. */
  storagePath?: string;
  /** Persistent HTTPS download URL, set once uploadStatus is "uploaded" —
   * the one reference that resolves from any device/session. */
  downloadUrl?: string;
}

/** What step of execution this evidence record proves. ARRIVAL/LOCATION/
 * RIG_PRECHECK/INSTALLATION/CABLE_SETUP/FINAL_SETUP happen before a Session
 * exists (see engine/execution.ts's deriveExecutionStage) — sessionId is
 * only ever set once one does. RIG_DAMAGE accompanies a precheck failure
 * (see reportRigIncident in engine/workflows.ts). OTHER preserves the
 * pre-existing SessionDetail.tsx manager-upload behavior unchanged. */
export type EvidenceType =
  | "ARRIVAL"
  | "LOCATION"
  | "RIG_PRECHECK"
  | "RIG_DAMAGE"
  | "INSTALLATION"
  | "CABLE_SETUP"
  | "FINAL_SETUP"
  | "SESSION_START"
  | "SESSION_END"
  | "ISSUE"
  | "OTHER";

/** pending/submitted/verified are the pre-existing states (unchanged
 * meaning). approved/rejected/recheck_requested are set ONLY by a Manager
 * (never by the FO, never automatically) — see requestRecheck/reviewEvidence
 * in engine/workflows.ts. A rejected or recheck_requested record is never
 * deleted or overwritten: the FO's replacement is a NEW Evidence record of
 * the same type+assignmentId (append-only history — see Phase 15). */
export type EvidenceStatus = "pending" | "submitted" | "verified" | "approved" | "rejected" | "recheck_requested";

export interface Evidence {
  id: string;
  /** Optional only for pre-existing records created before this field
   * existed (none in this codebase's demo data, but real deployed data
   * could predate it) — every new Evidence record sets it. */
  assignmentId?: string;
  sessionId?: string;
  businessId: string;
  foId: string;
  collectorId?: string;
  rigId?: string;
  type: EvidenceType;
  startedAt: string;
  endedAt?: string;
  capturedAt?: string;
  lat?: number;
  lng?: number;
  /** GPS accuracy radius in meters, as reported by the device. */
  locationAccuracy?: number;
  /** Only set on type "LOCATION" — the haversine distance between this
   * capture and the business's own recorded coordinates. See
   * engine/execution.ts's LOCATION_MATCH_THRESHOLD_METERS for the
   * deterministic verified/mismatch cutoff. */
  distanceFromExpectedMeters?: number;
  files: EvidenceFile[];
  notes?: string;
  /** Free-form, type-specific facts (e.g. which precheck items passed) —
   * never used for anything security- or logic-critical, purely descriptive. */
  metadata?: Record<string, unknown>;
  /** Set when this record is the FO's replacement submission after a
   * Manager's recheck request — the earlier record is never deleted or
   * overwritten (append-only history, spec Phase 15); this just makes the
   * "Evidence #1 -> Evidence #2" relationship explicit rather than
   * implicit-by-matching-type. */
  replacesEvidenceId?: string;
  status: EvidenceStatus;
  /** Set only by a Manager action (approve/reject/request recheck) —
   * never by the FO or by AI QA. */
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
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
  | "rig_status_override"
  | "en_route"
  | "location_verified"
  | "precheck_started"
  | "precheck_passed"
  | "precheck_failed"
  | "installation_started"
  | "installation_completed"
  | "installation_verified"
  | "evidence_rejected"
  | "recheck_requested"
  | "evidence_replaced"
  | "assignment_completed";

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

/** DRAFT/REVIEW: nothing here is live yet — draftAssignments is the only
 * place these assignments exist (see draftAssignments below), never written
 * to the shared `assignments` array. APPROVED/ACTIVE/COMPLETED/CANCELLED:
 * the plan has real Assignment records (assignmentIds) that FOs can see.
 * The product principle this encodes: AI can populate/edit a DRAFT: only a
 * Manager action (approvePlan) can cross the draft -> approved boundary. */
export type PlanStatus = "draft" | "review" | "approved" | "active" | "completed" | "cancelled";

export interface AssignmentRecommendation {
  /** Matches an id in this plan's draftAssignments. */
  assignmentId: string;
  confidence: "high" | "medium" | "low";
  why: string[];
  risk?: string;
}

export interface DailyPlan {
  id: string;
  date: string;
  status: PlanStatus;
  /** The editable proposal while status is "draft"/"review" — real-shaped
   * Assignment objects (with real ids already assigned) that have NOT been
   * pushed into CityData.assignments. Carried forward into assignmentIds
   * verbatim at approval time (see approvePlan in store/city.ts), so an
   * assignment's id never changes across the draft -> approved boundary. */
  draftAssignments?: Assignment[];
  /** Deterministic AI reasoning per draft assignment — advisory only, never
   * consulted by approvePlan itself. */
  recommendations?: AssignmentRecommendation[];
  /** ids (from draftAssignments) that still match the original AI proposal
   * unedited — everything else in draftAssignments was added, removed, or
   * hand-edited by the Manager. Used only for the Plan Summary's
   * accepted/edited/rejected counters, never for gating anything. */
  aiSuggestedIds?: string[];
  /** Populated once APPROVED — the real, live Assignment ids an FO can see. */
  assignmentIds: string[];
  score: number;
  scoreBreakdown: { label: string; delta: number }[];
  conflicts: PlanConflict[];
  createdBy?: string;
  createdAt: string;
  updatedAt?: string;
  /** Set only by approvePlan — the one Manager action that activates a plan. */
  approvedBy?: string;
  approvedAt?: string;
  publishedAt?: string;
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
