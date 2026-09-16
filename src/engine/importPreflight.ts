import type { Business } from "@/types";
import { parseCoordinatesFromMapsUrl } from "@/lib/googleMaps";
import {
  IMPORTER_OWNED_FIELDS,
  MANAGER_OWNED_FIELDS,
  DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY,
  deterministicBusinessImportId,
  type ImportPlan,
  type ReviewResolutions,
} from "./businessImport";

// ---------------------------------------------------------------------------
// Phase F.3 — Import Preflight: a read-only, machine-readable final-plan
// layer over the resolved plan (planBusinessImport() + applyReviewResolutions(),
// both from businessImport.ts and both untouched by this file). Never writes
// anything; never changes a row's decision. Its only job is to answer, in a
// stable, structured way, the 12 questions a Manager needs answered before
// confirming a real import — see src/pages/Settings.tsx / ImportPreflight.tsx
// for where this gets rendered and where the actual write still happens
// (confirmBizImport(), unchanged from Phase F/F.2).
//
// IMPORTANT (per explicit product decision on this phase): a missing or
// unresolved coordinate NEVER blocks a row from being ready — that has been
// the importer's behavior since Phase F, verified across 146 regression
// checks (business-import + business-data-quality). LOCATION_MISSING and
// SHORT_MAPS_LINK_UNRESOLVED below are informational reason codes only —
// they can appear on a row that is still READY.
// ---------------------------------------------------------------------------

export type ImportReasonCode =
  | "INVALID_ROW"
  | "CATEGORY_REVIEW_REQUIRED"
  | "DUPLICATE_REVIEW_REQUIRED"
  | "COORDINATE_REVIEW_REQUIRED"
  | "LOCATION_MISSING"
  | "SHORT_MAPS_LINK_UNRESOLVED";

/** Where a ready row's lat/lng will actually come from once written — never
 * invented, always traceable to one of these real sources. Undefined when
 * the row has no resolvable coordinate at all (see LOCATION_MISSING /
 * SHORT_MAPS_LINK_UNRESOLVED). "google_geocoding" (Phase F.5.3) is a Manager
 * -accepted assisted-resolution candidate — distinct from "manual" (typed
 * in by hand) purely for auditability; both are equally a human-approved
 * value, never fetched/geocoded on this app's own initiative. */
export type LocationSource = "spreadsheet" | "maps" | "manual" | "google_geocoding";

export interface FinalPlanRow {
  rowNumber: number;
  businessCode?: string;
  /** The deterministic id this row's business already has (existing
   * businesses only — deterministicBusinessImportId(businessCode)) — always
   * present once a Business Code exists, whether ready or not. */
  businessId?: string;
  businessName?: string;
  city?: string;
  category?: string;
  contactPhone?: string;
  /** true once the row's decision is "create" or "update" — i.e. it WILL be
   * written on Confirm. Never true while any blocking reason code applies. */
  ready: boolean;
  operation: "CREATE" | "UPDATE" | null;
  /** Every applicable reason, never collapsed into one generic label — a row
   * can carry more than one at once (e.g. missing category AND a duplicate
   * match). Blocking codes (everything except LOCATION_MISSING and
   * SHORT_MAPS_LINK_UNRESOLVED) are exactly why `ready` is false. */
  reasonCodes: ImportReasonCode[];
  duplicateDecision?: "keep_all" | "keep_only_this" | "keep_only_other" | "needs_further_review";
  coordinateDecision?: "spreadsheet" | "maps_link" | "needs_further_review";
  locationSource?: LocationSource;
  /** The category that WOULD be written — resolved value if a Manager
   * assigned one, otherwise the raw spreadsheet value (undefined if never
   * set, i.e. still genuinely missing). Kept separate from the raw value so
   * a reviewer can see both at once. */
  resolvedCategory?: string;
  rawCategory?: string;
  mapsLinkStatus: "none" | "resolved_literal_coords" | "short_or_unresolved";
  /** true only for a row a Manager explicitly excluded via a "keep only"
   * duplicate-cluster resolution (decision === "excluded" in the resolved
   * plan) — a resolved, deliberate choice, distinct from a row that is
   * still blocked and awaiting review (which always carries a reason
   * code). Lets the UI say "Excluded by Manager" instead of misleadingly
   * showing no reason at all, or an unrelated informational-only code. */
  excluded: boolean;
  /** Present only when ready — the exact Business fields this row will
   * write (create) or patch (update) once confirmed. */
  writePreview?: {
    operation: "CREATE" | "UPDATE";
    fieldsWritten: Partial<Business>;
    /** Present only for UPDATE: the Manager-owned fields on the existing
     * record this write will never touch, listed by name so it's visible
     * without reading source — per the Phase F.1 contract, unchanged. */
    fieldsPreserved: readonly string[];
  };
}

export interface FinalImportPlan {
  rows: FinalPlanRow[];
  readyRows: FinalPlanRow[];
  blockedRows: FinalPlanRow[];
  createRows: FinalPlanRow[];
  updateRows: FinalPlanRow[];
  duplicateRows: FinalPlanRow[];
  categoryReviewRows: FinalPlanRow[];
  coordinateReviewRows: FinalPlanRow[];
  locationMissingRows: FinalPlanRow[];
  shortLinkRows: FinalPlanRow[];
  invalidRows: FinalPlanRow[];
  summary: {
    total: number;
    ready: number;
    blocked: number;
    create: number;
    update: number;
    duplicateReview: number;
    categoryReview: number;
    coordinateReview: number;
    locationMissing: number;
    shortLink: number;
    invalid: number;
  };
}

function mapsLinkStatusOf(mappedFields: Partial<Business>): FinalPlanRow["mapsLinkStatus"] {
  if (!mappedFields.googleMapsUrl) return "none";
  return parseCoordinatesFromMapsUrl(mappedFields.googleMapsUrl) ? "resolved_literal_coords" : "short_or_unresolved";
}

/** Builds the deterministic, machine-readable final plan a Manager reviews
 * immediately before confirming. Pure — reads `plan` (the original strict
 * plan, for blocker/cluster metadata) and `resolvedPlan` (plan +
 * applyReviewResolutions(resolutions), for the actual decision each row
 * lands on) plus the resolutions themselves (to report which explicit
 * choice was made, not just its effect). Makes no Firestore call and
 * mutates nothing. */
export function buildFinalImportPlan(plan: ImportPlan, resolvedPlan: ImportPlan, resolutions: ReviewResolutions): FinalImportPlan {
  const existingByRowNumber = new Map(plan.rows.map((r) => [r.rowNumber, r]));

  const rows: FinalPlanRow[] = resolvedPlan.rows.map((r) => {
    const original = existingByRowNumber.get(r.rowNumber) ?? r;
    const reasonCodes: ImportReasonCode[] = [];

    if (r.decision === "invalid") {
      reasonCodes.push("INVALID_ROW");
    } else {
      const categoryStillMissing = original.blockers.missingCategory && !resolutions.categories[r.rowNumber]?.trim();
      if (categoryStillMissing) reasonCodes.push("CATEGORY_REVIEW_REQUIRED");

      if (original.blockers.duplicateClusterId) {
        const clusterResolution = resolutions.duplicateClusters[original.blockers.duplicateClusterId];
        const stillNeedsReview = !clusterResolution || clusterResolution.action === "needs_further_review";
        // A "keep_only" resolution that excluded THIS row is a resolved
        // decision (the row is "excluded", not "still needs review") — no
        // DUPLICATE_REVIEW_REQUIRED code in that case, even though it will
        // never become ready either; see duplicateDecision below.
        if (stillNeedsReview) reasonCodes.push("DUPLICATE_REVIEW_REQUIRED");
      }

      const coordConflict = original.blockers.coordinateConflict;
      if (coordConflict) {
        const choice = resolutions.coordinateConflicts[r.rowNumber];
        if (!choice || choice === "needs_further_review") reasonCodes.push("COORDINATE_REVIEW_REQUIRED");
      }

      // Informational only (never gates `ready` — see file header).
      const status = mapsLinkStatusOf(r.mappedFields);
      const hasCoord = r.mappedFields.lat != null && r.mappedFields.lng != null;
      if (!hasCoord) {
        if (status === "none") reasonCodes.push("LOCATION_MISSING");
        else if (status === "short_or_unresolved") reasonCodes.push("SHORT_MAPS_LINK_UNRESOLVED");
      }
    }

    let duplicateDecision: FinalPlanRow["duplicateDecision"];
    if (original.blockers.duplicateClusterId) {
      const resolution = resolutions.duplicateClusters[original.blockers.duplicateClusterId];
      if (!resolution || resolution.action === "needs_further_review") duplicateDecision = "needs_further_review";
      else if (resolution.action === "keep_all") duplicateDecision = "keep_all";
      else if (resolution.action === "keep_only") {
        const kept = resolution.keepRowNumbers?.includes(r.rowNumber);
        duplicateDecision = kept ? "keep_only_this" : "keep_only_other";
      }
    }

    const coordinateDecision = original.blockers.coordinateConflict ? (resolutions.coordinateConflicts[r.rowNumber] ?? "needs_further_review") : undefined;

    const manual = resolutions.manualCoordinates[r.rowNumber];
    let locationSource: LocationSource | undefined;
    if (manual) locationSource = manual.source === "google_geocoding" ? "google_geocoding" : "manual";
    else if (coordinateDecision === "maps_link") locationSource = "maps";
    else if (r.mappedFields.lat != null && r.mappedFields.lng != null) locationSource = "spreadsheet";
    else if (mapsLinkStatusOf(r.mappedFields) === "resolved_literal_coords") locationSource = "maps";

    const ready = r.decision === "create" || r.decision === "update";
    const operation = r.decision === "create" ? "CREATE" : r.decision === "update" ? "UPDATE" : null;

    let writePreview: FinalPlanRow["writePreview"];
    if (ready && operation) {
      const fieldsWritten: Partial<Business> = {};
      for (const f of IMPORTER_OWNED_FIELDS) {
        const v = r.mappedFields[f];
        if (v !== undefined) (fieldsWritten as Record<string, unknown>)[f] = v;
      }
      if (operation === "CREATE") {
        fieldsWritten.active = true;
        fieldsWritten.capacityHoursPerDay = DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY;
      }
      writePreview = {
        operation,
        fieldsWritten,
        fieldsPreserved: operation === "UPDATE" ? MANAGER_OWNED_FIELDS : [],
      };
    }

    return {
      rowNumber: r.rowNumber,
      businessCode: r.businessCode,
      businessId: r.businessCode ? deterministicBusinessImportId(r.businessCode) : undefined,
      businessName: r.businessName,
      city: r.mappedFields.area,
      category: r.mappedFields.category,
      contactPhone: r.mappedFields.contactPhone,
      ready,
      operation,
      reasonCodes,
      duplicateDecision,
      coordinateDecision,
      locationSource,
      resolvedCategory: r.mappedFields.category,
      rawCategory: original.mappedFields.category,
      mapsLinkStatus: mapsLinkStatusOf(r.mappedFields),
      excluded: r.decision === "excluded",
      writePreview,
    };
  });

  const readyRows = rows.filter((r) => r.ready);
  const blockedRows = rows.filter((r) => !r.ready);
  const createRows = rows.filter((r) => r.operation === "CREATE");
  const updateRows = rows.filter((r) => r.operation === "UPDATE");
  const duplicateRows = rows.filter((r) => r.reasonCodes.includes("DUPLICATE_REVIEW_REQUIRED"));
  const categoryReviewRows = rows.filter((r) => r.reasonCodes.includes("CATEGORY_REVIEW_REQUIRED"));
  const coordinateReviewRows = rows.filter((r) => r.reasonCodes.includes("COORDINATE_REVIEW_REQUIRED"));
  const locationMissingRows = rows.filter((r) => r.reasonCodes.includes("LOCATION_MISSING"));
  const shortLinkRows = rows.filter((r) => r.reasonCodes.includes("SHORT_MAPS_LINK_UNRESOLVED"));
  const invalidRows = rows.filter((r) => r.reasonCodes.includes("INVALID_ROW"));

  return {
    rows,
    readyRows,
    blockedRows,
    createRows,
    updateRows,
    duplicateRows,
    categoryReviewRows,
    coordinateReviewRows,
    locationMissingRows,
    shortLinkRows,
    invalidRows,
    summary: {
      total: rows.length,
      ready: readyRows.length,
      blocked: blockedRows.length,
      create: createRows.length,
      update: updateRows.length,
      duplicateReview: duplicateRows.length,
      categoryReview: categoryReviewRows.length,
      coordinateReview: coordinateReviewRows.length,
      locationMissing: locationMissingRows.length,
      shortLink: shortLinkRows.length,
      invalid: invalidRows.length,
    },
  };
}

