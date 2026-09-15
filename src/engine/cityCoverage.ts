import type { Assignment, Business, CityData, Issue } from "@/types";
import { resolveBusinessCoordinates } from "@/lib/googleMaps";
import { businessRigCount, businessTargetHours } from "./insights";
import { recordedHoursForBusinessDate, overlaps } from "./selectors";
import { haversineMeters } from "./execution";

// ---------------------------------------------------------------------------
// City Coverage — Phase B: pure derivation of map-ready geography from
// existing collections. Nothing here is persisted; every function is a
// deterministic read of already-known data, exactly like engine/insights.ts
// and engine/attention.ts. See src/lib/googleMaps.ts's
// resolveBusinessCoordinates for the coordinate precedence (Business.lat/lng,
// then a literal-coordinate googleMapsUrl) and its no-fabrication guarantee.
// ---------------------------------------------------------------------------

/** A business with a real, resolved coordinate pair. */
export interface MappableBusiness {
  business: Business;
  lat: number;
  lng: number;
  coordSource: "business" | "maps_url";
}

/** Every business with a resolvable coordinate pair — the sole feed for
 * City Coverage's map. A business without one (no lat/lng, no
 * googleMapsUrl, or a googleMapsUrl that doesn't literally carry
 * coordinates — e.g. a maps.app.goo.gl short link or a place-name search)
 * is simply omitted, never given a fabricated marker. Callers that need
 * the omitted count should compare `businesses.length` against this
 * array's length. */
export function mappableBusinesses(businesses: Business[]): MappableBusiness[] {
  const out: MappableBusiness[] = [];
  for (const business of businesses) {
    const coords = resolveBusinessCoordinates(business);
    if (coords) out.push({ business, lat: coords.lat, lng: coords.lng, coordSource: coords.source });
  }
  return out;
}

/** An FO's most recently recorded real-world position — derived from the
 * latest Evidence record that actually carries lat/lng (set only on
 * location-capturing evidence, at the moment an FO checked in — see
 * engine/workflows.ts's checkInAssignment). This is a single point-in-time
 * fact read from the FO's own evidence history, never a live GPS stream:
 * every caller must display it alongside capturedAt, never imply the FO is
 * there right now. */
export interface FoLastKnownLocation {
  foId: string;
  lat: number;
  lng: number;
  capturedAt: string;
  businessId?: string;
}

/** True for a finite, in-range (|lat|<=90, |lng|<=180) coordinate pair —
 * the same validation discipline as googleMaps.ts's URL parser, applied
 * here to Evidence-sourced coordinates before they're ever rendered as a
 * marker. A malformed or out-of-range value is treated exactly like a
 * missing one: no marker, never a best-effort guess. */
function isValidCoordinate(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Human-readable age of a last-known-location timestamp — "captured N
 * min/hr/day ago", never "live" or "current". Takes `nowMs` as an
 * argument (default Date.now()) so it stays pure and testable rather than
 * reading the clock implicitly. */
export function formatLocationAge(capturedAtIso: string, nowMs: number = Date.now()): string {
  const ageMs = Math.max(nowMs - new Date(capturedAtIso).getTime(), 0);
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "captured just now";
  if (minutes < 60) return `captured ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `captured ${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `captured ${days} day${days === 1 ? "" : "s"} ago`;
}

export function foLastKnownLocations(data: CityData): FoLastKnownLocation[] {
  const latestByFo = new Map<string, FoLastKnownLocation>();
  for (const evidence of data.evidence) {
    if (!isValidCoordinate(evidence.lat, evidence.lng)) continue;
    const capturedAt = evidence.capturedAt ?? evidence.startedAt;
    if (!capturedAt) continue;
    const existing = latestByFo.get(evidence.foId);
    // Strictly the LATEST valid record wins — an earlier evidence row
    // appearing later in the array (any ordering) must never override a
    // genuinely newer one already found.
    if (!existing || new Date(capturedAt).getTime() > new Date(existing.capturedAt).getTime()) {
      latestByFo.set(evidence.foId, { foId: evidence.foId, lat: evidence.lat as number, lng: evidence.lng as number, capturedAt, businessId: evidence.businessId });
    }
  }
  return [...latestByFo.values()];
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/** Plain equirectangular projection of lat/lng points into an SVG
 * viewBox — appropriate at city scale (a few km across), where the
 * curvature a Mercator-style projection corrects for is negligible, and
 * far simpler than pulling in a mapping library for it. Pads the bounding
 * box so edge markers aren't clipped, and falls back to centering every
 * point when the input's lat/lng span is (near) zero — a single-business
 * city, or every business sharing one coordinate — rather than dividing
 * by zero. Screen y grows downward while latitude grows northward, so the
 * y axis is flipped. */
export function projectPoints(points: { lat: number; lng: number }[], width: number, height: number, paddingPx = 24): ProjectedPoint[] {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  const innerW = Math.max(width - paddingPx * 2, 1);
  const innerH = Math.max(height - paddingPx * 2, 1);
  return points.map((p) => ({
    x: latSpan === 0 && lngSpan === 0 ? width / 2 : paddingPx + ((p.lng - minLng) / (lngSpan || 1)) * innerW,
    y: latSpan === 0 && lngSpan === 0 ? height / 2 : paddingPx + (1 - (p.lat - minLat) / (latSpan || 1)) * innerH,
  }));
}

// ---------------------------------------------------------------------------
// Phase C — business operational status. A pure, deterministic read of
// Assignment/Issue state for one business on one date: never persisted,
// never mutates an assignment, never merges or collapses the underlying
// per-rig Assignment records (see assignmentIds on the result — the exact
// records a Manager can still drill into). Every status/reason below is
// traced to a real field on Assignment, Issue, or Business; nothing here
// reads a spreadsheet-only concept (Outcome, Risk Score, Workers
// Declared/Photographed, Suggested Category) because those were never
// imported into the live schema (see types/index.ts's Business).
// ---------------------------------------------------------------------------

export type CityBusinessStatus = "assigned" | "at_risk" | "completed" | "unavailable" | "unassigned" | "unknown";

/** Machine-readable reason code, one per deriveBusinessStatus() branch —
 * lets Phase D's severity model and Recovery Radar switch on a stable
 * code instead of parsing the human-readable `reason` string. "on_track"
 * covers assigned/completed-at-or-above-target/unassigned: nothing here
 * needs Manager attention. */
export type CityBusinessStatusCause =
  | "inactive"
  | "unavailable_date"
  | "no_assignment"
  | "assignment_cancelled"
  | "rejected"
  | "no_show"
  | "rejected_or_no_show_mixed"
  | "partial_rejected_or_no_show"
  | "recheck_requested"
  | "operational_issue"
  | "hours_shortfall"
  | "on_track";

export interface CityBusinessStatusResult {
  status: CityBusinessStatus;
  /** Only ever set when directly supported by the fields inspected below —
   * never a generic filler string. */
  reason?: string;
  /** Stable machine-readable code for the same fact `reason` describes in
   * prose — see CityBusinessStatusCause. */
  cause: CityBusinessStatusCause;
  /** businessRigCount(data, businessId, date) — distinct rigs deployed via
   * a non-cancelled assignment, the same count Business 360 shows. */
  rigCount: number;
  /** businessTargetHours(data, businessId, date) — rigCount × the
   * authoritative RECORDING_HOURS_PER_RIG_PER_DAY constant, never a
   * separately hardcoded number. */
  targetHours: number;
  /** recordedHoursForBusinessDate(data, businessId, date) — actual
   * completed/in-progress session duration, the same figure Business 360's
   * "Recording Completed" shows. */
  recordedHours: number;
  /** The real Assignment ids this status was computed from — never merged,
   * never mutated. A Manager drilling into this business still sees each
   * one independently. */
  assignmentIds: string[];
  /** The specific assignment(s) that directly caused an at_risk/
   * unavailable status (the rejected/no-show ones, the one flagged for
   * recheck, or — for a plain hours shortfall on completed work — every
   * completed assignment, since all of them together produced the
   * shortfall). Empty for assigned/completed/unassigned/on_track — there
   * is no single assignment-level "cause" for a healthy or simply
   * unscheduled business. */
  affectedAssignmentIds: string[];
}

const AT_RISK_ISSUE_TYPES = new Set<Issue["type"]>(["rig_failure", "recording_failure", "damage", "missing_evidence"]);
const AT_RISK_ISSUE_REASON: Partial<Record<Issue["type"], string>> = {
  rig_failure: "Open rig failure issue",
  recording_failure: "Open recording failure issue",
  damage: "Open equipment damage issue",
  missing_evidence: "Missing evidence reported",
};

function isRejectedOrNoShow(a: Assignment): boolean {
  return a.status === "rejected" || a.status === "no_show";
}

/** The single source of truth for a business's City Coverage marker
 * status. Precedence (first match wins), each step naming the exact field
 * it reads:
 *
 *  1. UNAVAILABLE — Business.active === false.
 *  2. UNAVAILABLE — Business.unavailableDates includes this date.
 *  3. UNASSIGNED  — zero Assignment records for this business on this
 *     date.
 *  4. UNASSIGNED  — every one of today's assignments has
 *     Assignment.status === "cancelled".
 *  5. UNAVAILABLE — every remaining (non-cancelled) assignment today has
 *     status "rejected" or "no_show" — nothing is happening here today.
 *  6. AT_RISK — SOME but not all of today's non-cancelled assignments are
 *     "rejected"/"no_show" — a partial, real-time production loss; the
 *     other rig(s)/assignment(s) at this business are unaffected and stay
 *     independently tracked (see assignmentIds).
 *  7. AT_RISK — any remaining active assignment has
 *     Assignment.reviewStatus === "recheck_requested".
 *  8. AT_RISK — an open (status "open"/"in_progress") Issue for this
 *     business whose type is rig_failure/recording_failure/damage/
 *     missing_evidence.
 *  9. Once every remaining active assignment is "completed":
 *       AT_RISK   if recordedHoursForBusinessDate < businessTargetHours
 *       COMPLETED otherwise
 *  10. ASSIGNED — at least one remaining assignment is still
 *      planned/confirmed/in_progress.
 *
 * "unknown" exists in the type for forward-compatibility (a caller that
 * adds a new business-level fact later without touching this precedence)
 * but the branches above are exhaustive — this function never returns it
 * today. */
export function deriveBusinessStatus(business: Business, data: CityData, date: string): CityBusinessStatusResult {
  const assignmentsToday = data.assignments.filter((a) => a.businessId === business.id && a.date === date);
  const base = {
    rigCount: businessRigCount(data, business.id, date),
    targetHours: businessTargetHours(data, business.id, date),
    recordedHours: recordedHoursForBusinessDate(data, business.id, date),
    assignmentIds: assignmentsToday.map((a) => a.id),
  };

  if (business.active === false) return { ...base, status: "unavailable", cause: "inactive", reason: "Business marked inactive", affectedAssignmentIds: [] };
  if (business.unavailableDates?.includes(date)) return { ...base, status: "unavailable", cause: "unavailable_date", reason: "Business marked unavailable today", affectedAssignmentIds: [] };
  if (assignmentsToday.length === 0) return { ...base, status: "unassigned", cause: "no_assignment", reason: "No assignment scheduled today", affectedAssignmentIds: [] };

  const nonCancelled = assignmentsToday.filter((a) => a.status !== "cancelled");
  if (nonCancelled.length === 0) return { ...base, status: "unassigned", cause: "assignment_cancelled", reason: "Today's assignment was cancelled", affectedAssignmentIds: [] };

  const rejectedOrNoShow = nonCancelled.filter(isRejectedOrNoShow);
  const stillActive = nonCancelled.filter((a) => !isRejectedOrNoShow(a));

  if (rejectedOrNoShow.length === nonCancelled.length) {
    const allRejected = rejectedOrNoShow.every((a) => a.status === "rejected");
    const allNoShow = rejectedOrNoShow.every((a) => a.status === "no_show");
    return {
      ...base,
      status: "unavailable",
      cause: allRejected ? "rejected" : allNoShow ? "no_show" : "rejected_or_no_show_mixed",
      reason: allRejected ? "Today's assignment was rejected by the business" : allNoShow ? "FO recorded a no-show for today's visit" : "All of today's assignments were rejected or no-show",
      affectedAssignmentIds: rejectedOrNoShow.map((a) => a.id),
    };
  }
  if (rejectedOrNoShow.length > 0) {
    return {
      ...base,
      status: "at_risk",
      cause: "partial_rejected_or_no_show",
      reason: `${rejectedOrNoShow.length} of ${nonCancelled.length} assignments rejected or no-show today`,
      affectedAssignmentIds: rejectedOrNoShow.map((a) => a.id),
    };
  }

  const recheckAssignments = stillActive.filter((a) => a.reviewStatus === "recheck_requested");
  if (recheckAssignments.length > 0) {
    return { ...base, status: "at_risk", cause: "recheck_requested", reason: "Manager requested a recheck on today's evidence", affectedAssignmentIds: recheckAssignments.map((a) => a.id) };
  }

  const openRiskIssue = data.issues.find(
    (i) => i.businessId === business.id && (i.status === "open" || i.status === "in_progress") && AT_RISK_ISSUE_TYPES.has(i.type),
  );
  if (openRiskIssue) {
    const affected = openRiskIssue.assignmentId && stillActive.some((a) => a.id === openRiskIssue.assignmentId) ? [openRiskIssue.assignmentId] : [];
    return { ...base, status: "at_risk", cause: "operational_issue", reason: AT_RISK_ISSUE_REASON[openRiskIssue.type] ?? "Open operational issue", affectedAssignmentIds: affected };
  }

  const allCompleted = stillActive.length > 0 && stillActive.every((a) => a.status === "completed");
  if (allCompleted) {
    if (base.targetHours > 0 && base.recordedHours < base.targetHours) {
      return {
        ...base,
        status: "at_risk",
        cause: "hours_shortfall",
        reason: `Recorded ${base.recordedHours.toFixed(1)}h of ${base.targetHours}h target`,
        affectedAssignmentIds: stillActive.map((a) => a.id),
      };
    }
    return {
      ...base,
      status: "completed",
      cause: "on_track",
      reason: base.targetHours > 0 ? `${base.recordedHours.toFixed(1)}h of ${base.targetHours}h target recorded` : undefined,
      affectedAssignmentIds: [],
    };
  }

  // At least one assignment is still planned/confirmed/in_progress — work
  // is genuinely in progress, NOT yet judged against the hours target.
  // This is the guard against the false-positive the hours-shortfall
  // branch above must never produce: an active, unfinished visit is
  // "assigned", never prematurely "at_risk" for being under target.
  return { ...base, status: "assigned", cause: "on_track", affectedAssignmentIds: [] };
}

/** All businesses mapped to their derived status for one date — the
 * per-render feed for City Coverage's marker coloring and legend counts. */
export function cityBusinessStatuses(data: CityData, date: string): Map<string, CityBusinessStatusResult> {
  return new Map(data.businesses.map((b) => [b.id, deriveBusinessStatus(b, data, date)]));
}

/** Single deterministic status -> visual mapping, reusing the same
 * semantic Tailwind tokens (success/warning/critical/info/neutral/muted-2)
 * every other status indicator in the app already uses — see
 * components/status.tsx's STATUS_META. Color is never the only signal:
 * every consumer must also render `label` (legend, marker accessible
 * name) alongside it. */
export const CITY_STATUS_META: Record<CityBusinessStatus, { label: string; dot: string; badgeClass: string }> = {
  assigned: { label: "Assigned", dot: "bg-info", badgeClass: "bg-info-bg text-info border-info/20" },
  at_risk: { label: "At Risk", dot: "bg-warning", badgeClass: "bg-warning-bg text-warning border-warning/20" },
  completed: { label: "Completed", dot: "bg-success", badgeClass: "bg-success-bg text-success border-success/20" },
  unavailable: { label: "Unavailable", dot: "bg-critical", badgeClass: "bg-critical-bg text-critical border-critical/20" },
  unassigned: { label: "Unassigned", dot: "bg-neutral", badgeClass: "bg-neutral-bg text-neutral border-neutral/20" },
  unknown: { label: "Unknown", dot: "bg-muted-2", badgeClass: "bg-surface-2 text-muted border-border" },
};

// ---------------------------------------------------------------------------
// Phase D — Recovery Radar. Identifies businesses a Manager may want to
// look at, with rig-level detail and a deterministic three-tier severity —
// still makes no recommendation, reassigns nothing, and mutates no
// Assignment. Every item is derived entirely from deriveBusinessStatus()
// above, so it carries no fact this module doesn't already compute and
// explain (DETECT + EXPLAIN only — RECOMMEND is rankBackupCandidates()
// below, and ACT stays the existing Manager assignment workflow's job).
// ---------------------------------------------------------------------------

export type CityRecoverySeverity = "critical" | "high" | "medium";

/** Deterministic severity, switched on the machine-readable `cause` from
 * deriveBusinessStatus() — never a numeric/opaque score.
 *
 *  CRITICAL — the business is "unavailable": inactive, marked unavailable
 *    today, or every one of today's assignments was rejected/no-show.
 *    Nothing is recording here today; there is no partial credit.
 *  HIGH — a real operational failure with a specific cause: SOME (not
 *    all) assignments rejected/no-show, an open rig/recording-failure/
 *    damage/missing-evidence issue, or a completed business whose
 *    shortfall is at least half its target.
 *  MEDIUM — the more recoverable cases: a recheck request, or a
 *    completed business whose shortfall is under half its target. */
function deriveRecoverySeverity(result: CityBusinessStatusResult, remainingHoursAtRisk: number): CityRecoverySeverity {
  switch (result.cause) {
    case "inactive":
    case "unavailable_date":
    case "rejected":
    case "no_show":
    case "rejected_or_no_show_mixed":
      return "critical";
    case "partial_rejected_or_no_show":
    case "operational_issue":
      return "high";
    case "hours_shortfall":
      return result.targetHours > 0 && remainingHoursAtRisk >= result.targetHours / 2 ? "high" : "medium";
    case "recheck_requested":
      return "medium";
    default:
      return "medium";
  }
}

export interface CityRecoveryItem {
  businessId: string;
  status: CityBusinessStatus;
  cause: CityBusinessStatusCause;
  severity: CityRecoverySeverity;
  reason: string;
  rigCount: number;
  targetHours: number;
  recordedHours: number;
  /** max(targetHours - recordedHours, 0) — never negative, never implies a
   * business that met or exceeded its target is somehow still at risk. */
  remainingHoursAtRisk: number;
  /** Every real Assignment id for this business today — never merged,
   * never mutated. */
  assignmentIds: string[];
  /** The specific assignment(s) directly responsible for this recovery
   * item — see CityBusinessStatusResult.affectedAssignmentIds. */
  affectedAssignmentIds: string[];
  /** Distinct rigs among affectedAssignmentIds — "2 of 3 rigs affected",
   * never a re-count of the whole business when only some of it failed. */
  affectedRigCount: number;
  /** The FO on the affected assignment(s), when every affected assignment
   * shares exactly one FO (the common single-visit case) — undefined when
   * there are no affected assignments or they don't agree on an FO, so a
   * caller never guesses which FO a backup recommendation should route
   * through. */
  foId?: string;
}

/** Businesses whose derived status is "unavailable" or "at_risk" — sorted
 * worst-first (severity, then remaining hours at risk). DETECT + EXPLAIN
 * only: surfaces items for a Manager to review, never triggers or
 * suggests an automatic reassignment. An in-progress business (still
 * planned/confirmed/in_progress) never appears here — see
 * deriveBusinessStatus()'s own guard against judging unfinished work
 * against its hours target. */
export function identifyBusinessesNeedingAttention(data: CityData, date: string): CityRecoveryItem[] {
  const assignmentById = new Map(data.assignments.map((a) => [a.id, a]));
  const out: CityRecoveryItem[] = [];
  for (const business of data.businesses) {
    const result = deriveBusinessStatus(business, data, date);
    if (result.status !== "at_risk" && result.status !== "unavailable") continue;
    const remainingHoursAtRisk = Math.max(result.targetHours - result.recordedHours, 0);
    const affectedAssignments = result.affectedAssignmentIds.map((id) => assignmentById.get(id)).filter((a): a is Assignment => !!a);
    const affectedRigIds = new Set(affectedAssignments.filter((a) => a.rigId).map((a) => a.rigId));
    const affectedFoIds = new Set(affectedAssignments.map((a) => a.foId));
    out.push({
      businessId: business.id,
      status: result.status,
      cause: result.cause,
      severity: deriveRecoverySeverity(result, remainingHoursAtRisk),
      reason: result.reason ?? CITY_STATUS_META[result.status].label,
      rigCount: result.rigCount,
      targetHours: result.targetHours,
      recordedHours: result.recordedHours,
      remainingHoursAtRisk,
      assignmentIds: result.assignmentIds,
      affectedAssignmentIds: result.affectedAssignmentIds,
      affectedRigCount: affectedRigIds.size,
      foId: affectedFoIds.size === 1 ? [...affectedFoIds][0] : undefined,
    });
  }
  const SEVERITY_RANK: Record<CityRecoverySeverity, number> = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.remainingHoursAtRisk - a.remainingHoursAtRisk);
}

// ---------------------------------------------------------------------------
// Phase D — backup-candidate engine. A pure ranking helper: no wiring into
// any mutation, no reassignment action. Eligibility is evaluated in strict
// order (coordinates -> operational state -> no FO conflict) and ALWAYS
// takes priority over distance — a nearby ineligible business can never
// outrank a farther eligible one, because ineligible candidates are
// filtered out entirely before the distance sort ever runs. Any dimension
// without real supporting data in the live schema (task suitability,
// verification/trust, worker capacity) is omitted, never guessed.
// ---------------------------------------------------------------------------

export interface CityBackupEligibilityCheck {
  label: string;
  passed: boolean;
}

export interface CityBackupCandidate {
  businessId: string;
  /** Straight-line Haversine distance in meters from the reference point —
   * see engine/execution.ts's haversineMeters. Never driving distance. */
  distanceMeters: number;
  eligible: boolean;
  /** Every check this candidate was evaluated against, in eligibility
   * order, each with a plain pass/fail — a UI renders these directly
   * (e.g. "✓ Active", "✗ No conflicting assignment") without inventing a
   * composite score. */
  checks: CityBackupEligibilityCheck[];
  /** Populated only when eligible === false — the first failing check's
   * label, for a compact one-line explanation. */
  ineligibleReason?: string;
}

/** The visit-level time window and owning FO a backup is being sought
 * for — normally derived from the recovery item's own affected (or all)
 * assignments; see findBackupCandidates() below, which builds this for
 * you from a CityRecoveryItem. Passed explicitly here so this function
 * stays a pure, independently-testable unit. */
export interface CityBackupReferenceContext {
  foId: string;
  date: string;
  plannedStart: string;
  plannedEnd: string;
}

/** Ranks candidate businesses near a reference point (typically an FO's
 * last-known location, or the at-risk business's own coordinates) by
 * straight-line distance, AFTER filtering to businesses that are
 * operationally eligible right now. Eligibility, in order:
 *
 *  1. Valid coordinates (via mappableBusinesses — no marker, no candidate).
 *  2. Business.active !== false.
 *  3. Not marked unavailable today (Business.unavailableDates).
 *  4. Today's derived status is "unassigned" or "completed" — i.e. not
 *     already carrying its own at-risk/unavailable assignment, and not
 *     the business being replaced.
 *  5. No conflicting assignment: the reference FO has no OTHER assignment
 *     on `referenceContext.date` whose time window overlaps
 *     [plannedStart, plannedEnd) at this candidate business — reusing
 *     selectors.ts's overlaps(), the exact same function
 *     engine/planner.ts's detectConflicts() uses for FO double-booking.
 *
 * No opaque composite "backup score" is computed: eligibility is a plain
 * checklist, and ranking among eligible candidates is distance alone,
 * since no other dimension (task suitability, verification/trust, worker
 * capacity) has a real field to support it in the live schema today — see
 * this feature's Phase 0 discovery. */
export function rankBackupCandidates(
  data: CityData,
  referenceContext: CityBackupReferenceContext,
  referencePoint: { lat: number; lng: number },
  excludeBusinessId: string,
): CityBackupCandidate[] {
  const foAssignmentsOnDate = data.assignments.filter((a) => a.foId === referenceContext.foId && a.date === referenceContext.date && a.status !== "cancelled");

  const candidates: CityBackupCandidate[] = [];
  for (const { business, lat, lng } of mappableBusinesses(data.businesses)) {
    if (business.id === excludeBusinessId) continue;
    const status = deriveBusinessStatus(business, data, referenceContext.date);
    const operationallyEligible = status.status === "unassigned" || status.status === "completed";

    const conflicting = foAssignmentsOnDate.find(
      (a) => a.businessId === business.id && overlaps(a.plannedStart, a.plannedEnd, referenceContext.plannedStart, referenceContext.plannedEnd),
    );
    const noConflict = !conflicting;

    const checks: CityBackupEligibilityCheck[] = [
      { label: "Active", passed: business.active !== false },
      { label: "Available today", passed: !business.unavailableDates?.includes(referenceContext.date) },
      { label: `Not already ${status.status === "at_risk" ? "at risk" : status.status} today`, passed: operationallyEligible },
      { label: "No conflicting assignment", passed: noConflict },
    ];
    const firstFailed = checks.find((c) => !c.passed);

    candidates.push({
      businessId: business.id,
      distanceMeters: haversineMeters(referencePoint.lat, referencePoint.lng, lat, lng),
      eligible: !firstFailed,
      checks,
      ineligibleReason: firstFailed?.label && !firstFailed.passed ? `Not eligible: ${firstFailed.label.replace(/^Not already/, "already")}` : undefined,
    });
  }
  return candidates.filter((c) => c.eligible).sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Convenience wrapper: builds the reference context and point from a
 * CityRecoveryItem (using its own assignments for the time window/FO, and
 * — when available — that FO's last-known location as the distance
 * reference point, falling back to the failing business's own
 * coordinates when the FO has none) and calls rankBackupCandidates(). Read-
 * only, like every function in this module: computes a ranked list for
 * display, performs no write of any kind. */
export function findBackupCandidatesForRecoveryItem(data: CityData, item: CityRecoveryItem, date: string): { candidates: CityBackupCandidate[]; referencePoint: { lat: number; lng: number } | undefined; referencePointSource: "fo_last_known" | "business" | undefined } {
  const business = data.businesses.find((b) => b.id === item.businessId);
  const sourceAssignments = data.assignments.filter((a) => item.assignmentIds.includes(a.id));
  if (!business || sourceAssignments.length === 0 || !item.foId) {
    return { candidates: [], referencePoint: undefined, referencePointSource: undefined };
  }

  const plannedStart = sourceAssignments.reduce((min, a) => (a.plannedStart < min ? a.plannedStart : min), sourceAssignments[0].plannedStart);
  const plannedEnd = sourceAssignments.reduce((max, a) => (a.plannedEnd > max ? a.plannedEnd : max), sourceAssignments[0].plannedEnd);
  const referenceContext: CityBackupReferenceContext = { foId: item.foId, date, plannedStart, plannedEnd };

  const foLocation = foLastKnownLocations(data).find((f) => f.foId === item.foId);
  const businessCoords = resolveBusinessCoordinates(business);
  const referencePoint = foLocation ? { lat: foLocation.lat, lng: foLocation.lng } : businessCoords ? { lat: businessCoords.lat, lng: businessCoords.lng } : undefined;
  const referencePointSource: "fo_last_known" | "business" | undefined = foLocation ? "fo_last_known" : businessCoords ? "business" : undefined;

  if (!referencePoint) return { candidates: [], referencePoint: undefined, referencePointSource: undefined };
  return { candidates: rankBackupCandidates(data, referenceContext, referencePoint, item.businessId), referencePoint, referencePointSource };
}
