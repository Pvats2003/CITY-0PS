import type { Business } from "@/types";
import { isGoogleMapsUrl, parseCoordinatesFromMapsUrl } from "@/lib/googleMaps";
import { haversineMeters } from "./execution";

// ---------------------------------------------------------------------------
// Business Lead Import — pure planning engine.
//
// Turns raw spreadsheet rows into a reviewable, auditable import plan. Never
// writes anything itself (see the store's importCreateBusiness/updateBusiness
// actions for the write path, and src/pages/Settings.tsx for the Manager-only
// UI that gates a real write behind explicit confirmation).
//
// Deliberately narrow field mapping: only columns that map onto a genuine
// production Business field are ever read. The source spreadsheet also
// carries operational/lead-qualification columns (Data Captain, DC Code,
// Submitted At, Workers Declared, Workers Photographed, Hard Tasks, Outcome,
// Status, Risk Score, Suggested Category) that this module never touches —
// those describe the lead-capture process, not the business entity, and the
// production Business model has no field for any of them.
// ---------------------------------------------------------------------------

/** The exact source spreadsheet columns this importer reads. Any other
 * column in the file (Data Captain, DC Code, Submitted At, Workers Declared,
 * Workers Photographed, Hard Tasks, Outcome, Status, Risk Score, Suggested
 * Category) is intentionally never read here — see file header. */
export interface RawLeadRow {
  rowNumber: number;
  businessCode?: string;
  businessName?: string;
  contactPhone?: string;
  city?: string;
  category?: string;
  address?: string;
  /** Raw "Maps Link" cell text (a URL, when present). */
  mapsLink?: string;
  /** Raw "Latitude" cell text, before validation. */
  latitude?: string;
  /** Raw "Longitude" cell text, before validation. */
  longitude?: string;
  contactName?: string;
}

/** Business fields this importer is allowed to set — on create AND on a
 * later re-import update. These describe the business entity itself, which
 * the spreadsheet is the (re-importable) source of truth for. */
export const IMPORTER_OWNED_FIELDS = [
  "name",
  "category",
  "area",
  "address",
  "contactName",
  "contactPhone",
  "googleMapsUrl",
  "lat",
  "lng",
] as const satisfies readonly (keyof Business)[];

/** Business fields the importer NEVER sets on an update, and sets only to a
 * safe, existing-convention default at creation time. These are operational
 * fields a Manager owns from the moment a business exists in the product —
 * a re-import must never silently revert a Manager's own edits to them. */
export const MANAGER_OWNED_FIELDS = [
  "id",
  "createdAt",
  "active",
  "capacityHoursPerDay",
  "notes",
  "preferredWindowStart",
  "preferredWindowEnd",
  "unavailableDates",
  "firstVisitAt",
] as const satisfies readonly (keyof Business)[];

/** Matches BusinessFormDialog's own default for a manually-created business
 * (src/components/forms/BusinessFormDialog.tsx) — the existing product
 * convention for "no capacity figure supplied yet", reused rather than
 * invented. The source spreadsheet's Workers Declared / Workers Photographed
 * / Hard Tasks columns are never used to derive this — they describe a lead
 * qualification claim, not measured task capacity. */
export const DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY = 3;

/** Above this straight-line distance between the spreadsheet's own
 * Latitude/Longitude columns and the coordinates literally embedded in its
 * Maps Link column, the two sources are treated as genuinely disagreeing
 * (not just independent GPS-capture noise around the same real-world point)
 * and the row is flagged for Manager review rather than silently resolved
 * either way. 100m is roughly a business premises' own footprint — comfortably
 * wider than the sub-15m noise the real source file's matching rows show,
 * narrow enough to still catch a genuine wrong-location entry. */
export const COORD_MISMATCH_TOLERANCE_METERS = 100;

/** Values that mean "not captured" in the Latitude/Longitude columns — never
 * "invalid data", just "no direct reading". Distinct from a present-but-
 * out-of-range value, which is rejected outright (see planBusinessImport). */
function isBlankCoordCell(raw: string | undefined): boolean {
  if (raw == null) return true;
  const s = raw.trim();
  return s === "" || s.toUpperCase() === "NA" || s.toUpperCase() === "N/A";
}

function isBlank(raw: string | undefined): boolean {
  return raw == null || raw.trim() === "";
}

/** Deterministic, human-traceable import identity: re-importing the same
 * spreadsheet must resolve to the same Business.id every time, and the id
 * itself should be auditable back to its source row. Namespaced under
 * "biz_import_" — distinct by construction from a manually-created
 * business's random `id("biz")` (see src/lib/id.ts), so an import update can
 * never collide with, or silently claim, a business a Manager created by
 * hand, no matter how similar its name or phone number looks. */
export function deterministicBusinessImportId(businessCode: string): string {
  const slug = businessCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `biz_import_${slug || "unknown"}`;
}

export type ImportRowDecision = "create" | "update" | "duplicate_review" | "invalid" | "needs_review";

export interface ImportRowResult {
  rowNumber: number;
  businessCode?: string;
  businessName?: string;
  decision: ImportRowDecision;
  /** Human-readable explanations — always non-empty for anything other than
   * a clean "create". A row can carry multiple reasons. */
  reasons: string[];
  /** The exact Business fields this row would write, once mapped. Present
   * even for a flagged row, so a Manager reviewing the preview can see what
   * WOULD happen if the flag is resolved in favor of importing it. */
  mappedFields: Partial<Business>;
  /** Set when this row matches an existing (already-imported) business by
   * deterministic id — meaning this row is an update, not a create. */
  existingBusinessId?: string;
}

export interface ImportPlan {
  sourceRowCount: number;
  rows: ImportRowResult[];
  counts: {
    total: number;
    ready: number; // decision === "create"
    update: number; // decision === "update"
    duplicateReview: number; // decision === "duplicate_review"
    invalid: number; // decision === "invalid"
    needsReview: number; // decision === "needs_review"
  };
  /** Fully-formed Business records ready to write for every "create" row. */
  creates: Business[];
  /** Importer-owned-field patches ready to write for every "update" row. */
  updates: { id: string; patch: Partial<Business> }[];
}

function normalizedNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Phone numbers this short/this generic aren't a real dedup signal — the
 * source file contains literal "0" placeholders used by more than one row,
 * which would otherwise falsely flag every pair of otherwise-unrelated
 * businesses that share a missing-phone placeholder as duplicates. */
function isMeaningfulPhone(phone: string | undefined): phone is string {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7;
}

/** Builds the full, reviewable import plan for one parsed spreadsheet
 * against the businesses that already exist in production. Pure — makes no
 * Firestore/store call and mutates nothing; see src/pages/Settings.tsx for
 * how a Manager-confirmed plan is actually applied. */
export function planBusinessImport(existingBusinesses: Business[], rawRows: RawLeadRow[]): ImportPlan {
  const existingById = new Map(existingBusinesses.map((b) => [b.id, b]));
  const rows: ImportRowResult[] = [];

  for (const raw of rawRows) {
    const reasons: string[] = [];
    let decision: ImportRowDecision = "create";
    const mappedFields: Partial<Business> = {};

    if (isBlank(raw.businessCode)) {
      rows.push({ rowNumber: raw.rowNumber, businessName: raw.businessName, decision: "invalid", reasons: ["Missing Business Code — cannot establish a stable import identity."], mappedFields });
      continue;
    }
    if (isBlank(raw.businessName)) {
      rows.push({ rowNumber: raw.rowNumber, businessCode: raw.businessCode, decision: "invalid", reasons: ["Missing Business Name."], mappedFields });
      continue;
    }

    const businessCode = raw.businessCode!.trim();
    const businessName = raw.businessName!.trim();
    mappedFields.name = businessName;

    // Category: verbatim from the Category column only. Suggested Category
    // is never read here, let alone substituted — see spec: Category must
    // have an explicit, documented rule, and it is exactly this one.
    if (isBlank(raw.category) || raw.category!.trim().toUpperCase() === "NA" || raw.category!.trim().toUpperCase() === "N/A") {
      reasons.push("Category is missing in the source row — not imported without one (Suggested Category is never substituted automatically).");
      decision = "needs_review";
    } else {
      mappedFields.category = raw.category!.trim();
    }

    if (!isBlank(raw.city)) mappedFields.area = raw.city!.trim();
    else {
      reasons.push("City column is empty — Business.area left unset.");
    }
    if (!isBlank(raw.address)) mappedFields.address = raw.address!.trim();
    if (!isBlank(raw.contactName)) mappedFields.contactName = raw.contactName!.trim();
    if (!isBlank(raw.contactPhone)) mappedFields.contactPhone = raw.contactPhone!.trim();

    // Maps Link -> googleMapsUrl, only when it actually validates as a
    // Google Maps URL (src/lib/googleMaps.ts's own existing validator —
    // this also accepts maps.app.goo.gl short links, which the importer
    // stores verbatim for a human to open, exactly like the rest of the
    // product; it never tries to resolve one to a coordinate, per the
    // project's established no-geocoding policy).
    const mapsLink = raw.mapsLink?.trim();
    if (mapsLink && isGoogleMapsUrl(mapsLink)) {
      mappedFields.googleMapsUrl = mapsLink;
    } else if (mapsLink) {
      reasons.push("Maps Link did not parse as a recognizable Google Maps URL — not imported.");
    }

    // Latitude/Longitude columns: only ever a direct field mapping — never
    // a computed/geocoded value. "NA" (or blank) means not captured, not
    // invalid; a present-but-out-of-range or non-numeric value is a genuine
    // data error and rejects the row outright.
    const latBlank = isBlankCoordCell(raw.latitude);
    const lngBlank = isBlankCoordCell(raw.longitude);
    if (!latBlank || !lngBlank) {
      if (latBlank || lngBlank) {
        reasons.push("Only one of Latitude/Longitude is present — coordinates not imported.");
      } else {
        const lat = Number(raw.latitude);
        const lng = Number(raw.longitude);
        const valid = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        if (!valid) {
          rows.push({
            rowNumber: raw.rowNumber,
            businessCode,
            businessName,
            decision: "invalid",
            reasons: [`Latitude/Longitude ("${raw.latitude}", "${raw.longitude}") is not a valid coordinate pair.`],
            mappedFields,
          });
          continue;
        }
        mappedFields.lat = lat;
        mappedFields.lng = lng;

        // Cross-check against the Maps Link's own embedded coordinates, when
        // it has any — reuses the exact literal-coordinate parser City
        // Coverage itself relies on (src/lib/googleMaps.ts), never a
        // geocoding call.
        const fromMaps = mapsLink ? parseCoordinatesFromMapsUrl(mapsLink) : undefined;
        if (fromMaps) {
          const distance = haversineMeters(lat, lng, fromMaps.lat, fromMaps.lng);
          if (distance > COORD_MISMATCH_TOLERANCE_METERS) {
            reasons.push(
              `Latitude/Longitude columns and the Maps Link's own coordinates disagree by ~${distance}m (further apart than the ${COORD_MISMATCH_TOLERANCE_METERS}m tolerance) — flagged rather than silently choosing one.`,
            );
            decision = "needs_review";
          }
        }
      }
    }

    const importId = deterministicBusinessImportId(businessCode);
    const existing = existingById.get(importId);

    rows.push({
      rowNumber: raw.rowNumber,
      businessCode,
      businessName,
      decision,
      reasons,
      mappedFields,
      existingBusinessId: existing?.id,
    });
  }

  // Duplicate detection pass: a business name, phone, Maps URL, or
  // coordinate pair that's shared by more than one row-not-already-rejected
  // (or shared with an existing business this import didn't itself create)
  // is never auto-merged — always flagged for a Manager to resolve by hand.
  const codeGroups = new Map<string, ImportRowResult[]>();
  const nameGroups = new Map<string, ImportRowResult[]>();
  const phoneGroups = new Map<string, ImportRowResult[]>();
  const mapsUrlGroups = new Map<string, ImportRowResult[]>();
  const coordGroups = new Map<string, ImportRowResult[]>();

  const candidateRows = rows.filter((r) => r.decision !== "invalid");
  for (const r of candidateRows) {
    if (r.businessCode) {
      const key = r.businessCode.trim().toUpperCase();
      (codeGroups.get(key) ?? codeGroups.set(key, []).get(key)!).push(r);
    }
    if (r.businessName) {
      const key = normalizedNameKey(r.businessName);
      (nameGroups.get(key) ?? nameGroups.set(key, []).get(key)!).push(r);
    }
    if (isMeaningfulPhone(r.mappedFields.contactPhone)) {
      const key = r.mappedFields.contactPhone!.replace(/\D/g, "");
      (phoneGroups.get(key) ?? phoneGroups.set(key, []).get(key)!).push(r);
    }
    if (r.mappedFields.googleMapsUrl) {
      (mapsUrlGroups.get(r.mappedFields.googleMapsUrl) ?? mapsUrlGroups.set(r.mappedFields.googleMapsUrl, []).get(r.mappedFields.googleMapsUrl)!).push(r);
    }
    if (r.mappedFields.lat != null && r.mappedFields.lng != null) {
      const key = `${r.mappedFields.lat.toFixed(5)},${r.mappedFields.lng.toFixed(5)}`;
      (coordGroups.get(key) ?? coordGroups.set(key, []).get(key)!).push(r);
    }
  }

  function flagGroupDuplicates(groups: Map<string, ImportRowResult[]>, label: string) {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Rows in this batch that are actually the SAME business identity
      // (same Business Code -> same deterministic id) are a legitimate
      // update, not a duplicate — only flag when the rows disagree on
      // identity while agreeing on this signal.
      const distinctIds = new Set(group.map((r) => deterministicBusinessImportId(r.businessCode!)));
      if (distinctIds.size < 2) continue;
      for (const r of group) {
        if (r.decision === "invalid") continue;
        r.decision = "duplicate_review";
        r.reasons.push(`${label} is shared with another row/business in this import (rows: ${group.map((g) => g.rowNumber).join(", ")}) — never auto-merged.`);
      }
    }
  }
  // Duplicate Business Code within the same file: unlike the signals below,
  // this is never a legitimate "two rows, same import identity, treat as an
  // update" case — it's the SAME identity claimed by more than one row in
  // one file, which would otherwise silently produce two create writes
  // racing for one Firestore document id. Always flagged, never merged.
  for (const group of codeGroups.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      if (r.decision === "invalid") continue;
      r.decision = "duplicate_review";
      r.reasons.push(`Business Code "${r.businessCode}" appears on more than one row in this file (rows: ${group.map((g) => g.rowNumber).join(", ")}) — never silently collapsed into one write.`);
    }
  }
  flagGroupDuplicates(nameGroups, "Business Name");
  flagGroupDuplicates(phoneGroups, "Contact Phone");
  flagGroupDuplicates(mapsUrlGroups, "Maps Link");
  flagGroupDuplicates(coordGroups, "Coordinates");

  // Also flag against businesses that already exist but were NOT created by
  // this importer (a different deterministic id / an organically-created
  // record) — same "never silently merge" rule.
  for (const r of candidateRows) {
    if (r.decision === "invalid" || r.existingBusinessId) continue;
    const importId = deterministicBusinessImportId(r.businessCode!);
    const collision = existingBusinesses.find((b) => {
      if (b.id === importId) return false;
      if (r.businessName && normalizedNameKey(b.name) === normalizedNameKey(r.businessName)) return true;
      if (isMeaningfulPhone(r.mappedFields.contactPhone) && isMeaningfulPhone(b.contactPhone) && b.contactPhone!.replace(/\D/g, "") === r.mappedFields.contactPhone!.replace(/\D/g, "")) return true;
      return false;
    });
    if (collision) {
      r.decision = "duplicate_review";
      r.reasons.push(`Matches an existing business not created by this importer ("${collision.name}", id ${collision.id}) — never auto-merged.`);
    }
  }

  // Resolve final create/update decisions.
  const creates: Business[] = [];
  const updates: { id: string; patch: Partial<Business> }[] = [];
  const now = new Date().toISOString();
  for (const r of rows) {
    if (r.decision !== "create") continue;
    if (r.existingBusinessId) {
      r.decision = "update";
      updates.push({ id: r.existingBusinessId, patch: r.mappedFields });
    } else {
      const id = deterministicBusinessImportId(r.businessCode!);
      const business: Business = {
        id,
        name: r.mappedFields.name!,
        category: r.mappedFields.category!,
        area: r.mappedFields.area ?? "",
        address: r.mappedFields.address ?? "",
        active: true,
        capacityHoursPerDay: DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY,
        createdAt: now,
        ...(r.mappedFields.contactName != null ? { contactName: r.mappedFields.contactName } : {}),
        ...(r.mappedFields.contactPhone != null ? { contactPhone: r.mappedFields.contactPhone } : {}),
        ...(r.mappedFields.googleMapsUrl != null ? { googleMapsUrl: r.mappedFields.googleMapsUrl } : {}),
        ...(r.mappedFields.lat != null ? { lat: r.mappedFields.lat } : {}),
        ...(r.mappedFields.lng != null ? { lng: r.mappedFields.lng } : {}),
      };
      creates.push(business);
    }
  }

  const counts = {
    total: rows.length,
    ready: rows.filter((r) => r.decision === "create").length,
    update: rows.filter((r) => r.decision === "update").length,
    duplicateReview: rows.filter((r) => r.decision === "duplicate_review").length,
    invalid: rows.filter((r) => r.decision === "invalid").length,
    needsReview: rows.filter((r) => r.decision === "needs_review").length,
  };

  return { sourceRowCount: rawRows.length, rows, counts, creates, updates };
}
