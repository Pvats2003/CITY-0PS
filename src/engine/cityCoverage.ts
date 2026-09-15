import type { Assignment, Business, CityData, Issue } from "@/types";
import { resolveBusinessCoordinates } from "@/lib/googleMaps";
import { businessRigCount, businessTargetHours } from "./insights";
import { recordedHoursForBusinessDate } from "./selectors";
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

export interface CityBusinessStatusResult {
  status: CityBusinessStatus;
  /** Only ever set when directly supported by the fields inspected below —
   * never a generic filler string. */
  reason?: string;
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

  if (business.active === false) return { ...base, status: "unavailable", reason: "Business marked inactive" };
  if (business.unavailableDates?.includes(date)) return { ...base, status: "unavailable", reason: "Business marked unavailable today" };
  if (assignmentsToday.length === 0) return { ...base, status: "unassigned", reason: "No assignment scheduled today" };

  const nonCancelled = assignmentsToday.filter((a) => a.status !== "cancelled");
  if (nonCancelled.length === 0) return { ...base, status: "unassigned", reason: "Today's assignment was cancelled" };

  const rejectedOrNoShow = nonCancelled.filter(isRejectedOrNoShow);
  const stillActive = nonCancelled.filter((a) => !isRejectedOrNoShow(a));

  if (rejectedOrNoShow.length === nonCancelled.length) {
    const allRejected = rejectedOrNoShow.every((a) => a.status === "rejected");
    const allNoShow = rejectedOrNoShow.every((a) => a.status === "no_show");
    return {
      ...base,
      status: "unavailable",
      reason: allRejected ? "Today's assignment was rejected by the business" : allNoShow ? "FO recorded a no-show for today's visit" : "All of today's assignments were rejected or no-show",
    };
  }
  if (rejectedOrNoShow.length > 0) {
    return { ...base, status: "at_risk", reason: `${rejectedOrNoShow.length} of ${nonCancelled.length} assignments rejected or no-show today` };
  }

  if (stillActive.some((a) => a.reviewStatus === "recheck_requested")) {
    return { ...base, status: "at_risk", reason: "Manager requested a recheck on today's evidence" };
  }

  const openRiskIssue = data.issues.find(
    (i) => i.businessId === business.id && (i.status === "open" || i.status === "in_progress") && AT_RISK_ISSUE_TYPES.has(i.type),
  );
  if (openRiskIssue) {
    return { ...base, status: "at_risk", reason: AT_RISK_ISSUE_REASON[openRiskIssue.type] ?? "Open operational issue" };
  }

  const allCompleted = stillActive.length > 0 && stillActive.every((a) => a.status === "completed");
  if (allCompleted) {
    if (base.targetHours > 0 && base.recordedHours < base.targetHours) {
      return { ...base, status: "at_risk", reason: `Recorded ${base.recordedHours.toFixed(1)}h of ${base.targetHours}h target` };
    }
    return { ...base, status: "completed", reason: base.targetHours > 0 ? `${base.recordedHours.toFixed(1)}h of ${base.targetHours}h target recorded` : undefined };
  }

  return { ...base, status: "assigned" };
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
// Phase C — Recovery Radar groundwork ONLY. Identifies businesses a
// Manager may want to look at; makes no recommendation, reassigns
// nothing, and mutates no Assignment. Every candidate is just an "at_risk"
// or "unavailable" business from deriveBusinessStatus() above, so it
// carries no fact this module doesn't already compute and explain.
// ---------------------------------------------------------------------------

export type CityRecoverySeverity = "critical" | "warning";

export interface CityRecoveryCandidate {
  businessId: string;
  status: CityBusinessStatus;
  reason: string;
  severity: CityRecoverySeverity;
  targetHours: number;
  recordedHours: number;
  /** max(targetHours - recordedHours, 0) — never negative, never implies a
   * business that exceeded its target is somehow still "at risk". */
  remainingHoursAtRisk: number;
}

/** Businesses whose derived status is "unavailable" (nothing recording
 * today) or "at_risk" (a real shortfall/open issue/recheck/partial
 * rejection) — sorted worst-first by remaining hours at risk. This is
 * groundwork only: it surfaces candidates for a Manager to review, never
 * triggers or suggests an automatic reassignment. */
export function identifyBusinessesNeedingAttention(data: CityData, date: string): CityRecoveryCandidate[] {
  const out: CityRecoveryCandidate[] = [];
  for (const business of data.businesses) {
    const result = deriveBusinessStatus(business, data, date);
    if (result.status !== "at_risk" && result.status !== "unavailable") continue;
    const remainingHoursAtRisk = Math.max(result.targetHours - result.recordedHours, 0);
    out.push({
      businessId: business.id,
      status: result.status,
      reason: result.reason ?? CITY_STATUS_META[result.status].label,
      severity: result.status === "unavailable" ? "critical" : remainingHoursAtRisk >= result.targetHours / 2 && result.targetHours > 0 ? "critical" : "warning",
      targetHours: result.targetHours,
      recordedHours: result.recordedHours,
      remainingHoursAtRisk,
    });
  }
  return out.sort((a, b) => b.remainingHoursAtRisk - a.remainingHoursAtRisk);
}

// ---------------------------------------------------------------------------
// Phase C — backup-candidate preparation ONLY. A pure ranking helper with
// no wiring into any UI yet (Phase D/G's job) and no reassignment action.
// Eligibility is evaluated in strict order: distance never promotes an
// otherwise-ineligible business, and any dimension without real supporting
// data is simply omitted rather than guessed.
// ---------------------------------------------------------------------------

export interface CityBackupCandidate {
  businessId: string;
  /** Straight-line Haversine distance in meters from the reference point —
   * see engine/execution.ts's haversineMeters. Never driving distance. */
  distanceMeters: number;
  /** True facts this candidate satisfies, in eligibility-order — a UI can
   * render these directly (e.g. "✓ Valid coordinates") without inventing
   * a composite score. */
  eligible: boolean;
  /** Populated only when eligible === false — why distance alone couldn't
   * make this business a viable backup. */
  ineligibleReason?: string;
}

/** Ranks candidate businesses near a reference point (typically an FO's
 * last-known location, or the at-risk business's own coordinates) by
 * straight-line distance, AFTER filtering to businesses that are
 * operationally eligible right now (status "unassigned" or "completed" —
 * i.e. not already carrying today's own at-risk/unavailable assignment,
 * and not the business being replaced). No opaque composite "backup
 * score" is computed: eligibility is a plain boolean plus a reason, and
 * ranking among eligible candidates is distance alone, since no other
 * dimension (task suitability, verification/trust, worker capacity) has a
 * real field to support it in the live schema today — see this feature's
 * Phase 0 discovery. Extending eligibility/ranking with a genuinely
 * data-backed dimension is Phase D's job, not this one's. */
export function rankBackupCandidates(
  data: CityData,
  date: string,
  referencePoint: { lat: number; lng: number },
  excludeBusinessId: string,
): CityBackupCandidate[] {
  const candidates: CityBackupCandidate[] = [];
  for (const { business, lat, lng } of mappableBusinesses(data.businesses)) {
    if (business.id === excludeBusinessId) continue;
    const status = deriveBusinessStatus(business, data, date);
    const eligible = status.status === "unassigned" || status.status === "completed";
    candidates.push({
      businessId: business.id,
      distanceMeters: haversineMeters(referencePoint.lat, referencePoint.lng, lat, lng),
      eligible,
      ineligibleReason: eligible ? undefined : `Not operationally eligible today (${CITY_STATUS_META[status.status].label.toLowerCase()})`,
    });
  }
  return candidates.filter((c) => c.eligible).sort((a, b) => a.distanceMeters - b.distanceMeters);
}
