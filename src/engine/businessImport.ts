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
//
// planBusinessImport() itself (Phase F) is intentionally left unchanged in
// behavior by everything below (Phase F.2): it stays strict, deterministic,
// and self-contained. The Data Quality review layer — duplicateClusters on
// its output, and the separate applyReviewResolutions() function — only ever
// ADDS annotations or promotes a row after an explicit, recorded Manager
// decision. It never loosens what planBusinessImport() itself flags.
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

/** "excluded" is reachable only via applyReviewResolutions() — a Manager
 * explicitly chose to keep a DIFFERENT row from this one's duplicate
 * cluster. planBusinessImport() itself never produces this decision. */
export type ImportRowDecision = "create" | "update" | "duplicate_review" | "invalid" | "needs_review" | "excluded";

/** Why a row is blocked, as data — never re-derived from the human-readable
 * `reasons` strings — so a review UI can offer a targeted resolution per
 * blocker. All three can be present on the same row simultaneously; a row
 * only reaches "create"/"update" once every blocker present on it has been
 * explicitly resolved. */
export interface ImportRowBlockers {
  missingCategory: boolean;
  coordinateConflict?: {
    spreadsheetLat: number;
    spreadsheetLng: number;
    mapsLat: number;
    mapsLng: number;
    distanceMeters: number;
  };
  /** Set when this row is part of a DuplicateCluster (see ImportPlan). */
  duplicateClusterId?: string;
}

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
  blockers: ImportRowBlockers;
}

/** A group of two or more rows in ONE file that the strict importer flagged
 * as possibly the same real-world business (by Business Code, name, phone,
 * Maps Link, or coordinates — see planBusinessImport()). Never auto-merged;
 * exists purely so a review UI can show "possible duplicate of" with the
 * exact evidence, and let a Manager decide. */
export interface DuplicateCluster {
  /** Stable within one parsed file: the cluster's row numbers, joined. */
  id: string;
  rowNumbers: number[];
  /** Which signal(s) connected these rows — e.g. ["Business Name", "Contact Phone"]. */
  matchingSignals: string[];
  /** True ONLY for an exactly-2-row cluster where BOTH the business name AND
   * the contact phone match — the one case strong enough to call an
   * outright "duplicate" rather than merely a "possible duplicate". Even
   * then, nothing is ever auto-merged — this only changes the review UI's
   * wording, never its behavior. */
  conclusive: boolean;
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
    excluded: number; // decision === "excluded" (only reachable post-resolution)
  };
  /** Fully-formed Business records ready to write for every "create" row. */
  creates: Business[];
  /** Importer-owned-field patches ready to write for every "update" row. */
  updates: { id: string; patch: Partial<Business> }[];
  duplicateClusters: DuplicateCluster[];
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

/** Shared by planBusinessImport() (a fresh create) and
 * applyReviewResolutions() (a create that only became eligible after a
 * Manager resolution) — one place that knows the exact shape of a newly
 * imported Business, so the two can never drift apart. */
function buildImportedBusiness(mappedFields: Partial<Business>, id: string, createdAt: string): Business {
  return {
    id,
    name: mappedFields.name!,
    category: mappedFields.category!,
    area: mappedFields.area ?? "",
    address: mappedFields.address ?? "",
    active: true,
    capacityHoursPerDay: DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY,
    createdAt,
    ...(mappedFields.contactName != null ? { contactName: mappedFields.contactName } : {}),
    ...(mappedFields.contactPhone != null ? { contactPhone: mappedFields.contactPhone } : {}),
    ...(mappedFields.googleMapsUrl != null ? { googleMapsUrl: mappedFields.googleMapsUrl } : {}),
    ...(mappedFields.lat != null ? { lat: mappedFields.lat } : {}),
    ...(mappedFields.lng != null ? { lng: mappedFields.lng } : {}),
  };
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
    const blockers: ImportRowBlockers = { missingCategory: false };

    if (isBlank(raw.businessCode)) {
      rows.push({ rowNumber: raw.rowNumber, businessName: raw.businessName, decision: "invalid", reasons: ["Missing Business Code — cannot establish a stable import identity."], mappedFields, blockers });
      continue;
    }
    if (isBlank(raw.businessName)) {
      rows.push({ rowNumber: raw.rowNumber, businessCode: raw.businessCode, decision: "invalid", reasons: ["Missing Business Name."], mappedFields, blockers });
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
      blockers.missingCategory = true;
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
            blockers,
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
            blockers.coordinateConflict = { spreadsheetLat: lat, spreadsheetLng: lng, mapsLat: fromMaps.lat, mapsLng: fromMaps.lng, distanceMeters: distance };
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
      blockers,
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

  // Duplicate CLUSTERS: a read-only annotation pass over the exact same
  // groups above, connecting rows into components (union-find) so a review
  // UI can show one "possible duplicate of" card per real-world cluster
  // instead of one alert per signal type. Never changes any row's decision
  // — every row this touches was already flagged duplicate_review above.
  const duplicateClusters = buildDuplicateClusters(candidateRows, codeGroups, nameGroups, phoneGroups, mapsUrlGroups, coordGroups);
  for (const cluster of duplicateClusters) {
    for (const rowNumber of cluster.rowNumbers) {
      const r = rows.find((x) => x.rowNumber === rowNumber);
      if (r) r.blockers.duplicateClusterId = cluster.id;
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
      creates.push(buildImportedBusiness(r.mappedFields, deterministicBusinessImportId(r.businessCode!), now));
    }
  }

  const counts = {
    total: rows.length,
    ready: rows.filter((r) => r.decision === "create").length,
    update: rows.filter((r) => r.decision === "update").length,
    duplicateReview: rows.filter((r) => r.decision === "duplicate_review").length,
    invalid: rows.filter((r) => r.decision === "invalid").length,
    needsReview: rows.filter((r) => r.decision === "needs_review").length,
    excluded: 0,
  };

  return { sourceRowCount: rawRows.length, rows, counts, creates, updates, duplicateClusters };
}

/** Connected-components over the same five signal groups
 * planBusinessImport() already built (Business Code/Name/Phone/Maps
 * Link/Coordinates), so a row that was flagged duplicate_review via two
 * different signals (e.g. shares a phone with one row and a name with
 * another) surfaces as ONE cluster, not two overlapping alerts. Purely a
 * read-only annotation — the row-level decisions above are already final by
 * the time this runs. */
function buildDuplicateClusters(
  candidateRows: ImportRowResult[],
  codeGroups: Map<string, ImportRowResult[]>,
  nameGroups: Map<string, ImportRowResult[]>,
  phoneGroups: Map<string, ImportRowResult[]>,
  mapsUrlGroups: Map<string, ImportRowResult[]>,
  coordGroups: Map<string, ImportRowResult[]>,
): DuplicateCluster[] {
  const parent = new Map<number, number>();
  function find(x: number): number {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const r of candidateRows) parent.set(r.rowNumber, r.rowNumber);

  const labelsByRow = new Map<number, Set<string>>();
  function addLabel(rowNumber: number, label: string) {
    (labelsByRow.get(rowNumber) ?? labelsByRow.set(rowNumber, new Set()).get(rowNumber)!).add(label);
  }
  function processGroup(groups: Map<string, ImportRowResult[]>, label: string, requireDistinctIds: boolean) {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      if (requireDistinctIds) {
        const distinctIds = new Set(group.map((r) => deterministicBusinessImportId(r.businessCode!)));
        if (distinctIds.size < 2) continue;
      }
      for (let i = 1; i < group.length; i++) union(group[0].rowNumber, group[i].rowNumber);
      for (const r of group) addLabel(r.rowNumber, label);
    }
  }
  processGroup(codeGroups, "Business Code", false);
  processGroup(nameGroups, "Business Name", true);
  processGroup(phoneGroups, "Contact Phone", true);
  processGroup(mapsUrlGroups, "Maps Link", true);
  processGroup(coordGroups, "Coordinates", true);

  const componentRows = new Map<number, number[]>();
  for (const r of candidateRows) {
    if (!labelsByRow.has(r.rowNumber)) continue; // touched no signal at all
    const root = find(r.rowNumber);
    (componentRows.get(root) ?? componentRows.set(root, []).get(root)!).push(r.rowNumber);
  }

  const clusters: DuplicateCluster[] = [];
  for (const rowNumbers of componentRows.values()) {
    if (rowNumbers.length < 2) continue;
    rowNumbers.sort((a, b) => a - b);
    const signals = new Set<string>();
    for (const rn of rowNumbers) for (const l of labelsByRow.get(rn) ?? []) signals.add(l);
    const matchingSignals = [...signals].sort();
    const conclusive = rowNumbers.length === 2 && signals.has("Business Name") && signals.has("Contact Phone");
    clusters.push({ id: rowNumbers.join("-"), rowNumbers, matchingSignals, conclusive });
  }
  return clusters;
}

/** A Manager's explicit decision about one duplicate cluster. "keep_only"
 * means every OTHER row in the cluster is excluded from this import (never
 * deleted, never merged — just not written this time); a Manager can
 * revisit by re-uploading and choosing differently. */
export interface DuplicateClusterResolution {
  action: "keep_all" | "keep_only" | "needs_further_review";
  /** Required when action === "keep_only": which row number(s) in the
   * cluster to import; every other member becomes "excluded". */
  keepRowNumbers?: number[];
}

/** Every Manager decision made in the Data Quality review UI, keyed by
 * rowNumber (or clusterId for duplicates). Lives only in the current Import
 * Businesses session's React state — see the "Review-state architecture"
 * note in src/pages/Settings.tsx for why this is deliberately NOT persisted
 * to Firestore. */
export interface ReviewResolutions {
  /** rowNumber -> Manager-assigned category (must be one of the existing
   * vocabulary offered by the UI — see categoryVocabulary() below; this
   * function does not itself validate that, the UI enforces it via a
   * closed Select rather than free text). */
  categories: Record<number, string>;
  /** rowNumber -> which coordinate source to trust. */
  coordinateConflicts: Record<number, "spreadsheet" | "maps_link" | "needs_further_review">;
  /** clusterId -> resolution. */
  duplicateClusters: Record<string, DuplicateClusterResolution>;
  /** rowNumber -> coordinates a Manager explicitly accepted for this row —
   * either typed in by hand after opening the row's Maps Link themselves
   * (e.g. to resolve a maps.app.goo.gl short link this importer will never
   * auto-resolve — see COORD_MISMATCH_... comment and DEPLOYMENT notes), or
   * accepted from an assisted Google Geocoding candidate (Phase F.5.3 — see
   * src/lib/locationResolver.ts; a candidate is never auto-accepted, only
   * ever applied here after an explicit Manager click). `source` defaults
   * to "manual" when omitted, so every pre-F.5.3 caller/fixture that
   * constructs `{ lat, lng }` without it keeps working unchanged. Never
   * fetched/geocoded/derived from following a redirect on this app's own
   * initiative either way — always a human-approved value. Applied
   * whenever present; unlike the three resolutions above, this isn't
   * gating anything (a business without coordinates already imports fine,
   * just unmapped) — it's a pure enhancement. */
  manualCoordinates: Record<number, { lat: number; lng: number; source?: "manual" | "google_geocoding" }>;
}

export function emptyReviewResolutions(): ReviewResolutions {
  return { categories: {}, coordinateConflicts: {}, duplicateClusters: {}, manualCoordinates: {} };
}

/** The category values a Manager can assign from — deliberately closed
 * (never free text) so a review resolution can only ever pick a value that
 * is ALREADY in real use, never invent a new taxonomy entry. Sourced from
 * both the existing production businesses and the OTHER rows in this same
 * plan that already carry a real category — i.e. "the vocabulary this
 * application (and this import) already uses", per spec. */
export function categoryVocabulary(existingBusinesses: Business[], plan: ImportPlan): string[] {
  const set = new Set<string>();
  for (const b of existingBusinesses) if (b.category.trim()) set.add(b.category.trim());
  for (const r of plan.rows) if (r.mappedFields.category) set.add(r.mappedFields.category);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Applies a Manager's explicit Data Quality resolutions on top of an
 * UNCHANGED plan from planBusinessImport(). Pure — makes no Firestore/store
 * call. A row is only ever promoted out of review when EVERY blocker it
 * carries has an explicit resolution; anything left unresolved (including
 * every ambiguous duplicate a Manager hasn't looked at yet) stays exactly
 * where the strict importer put it. Never invents a category, never
 * resolves a coordinate conflict on its own, never merges a duplicate. */
export function applyReviewResolutions(plan: ImportPlan, resolutions: ReviewResolutions): ImportPlan {
  const clustersById = new Map(plan.duplicateClusters.map((c) => [c.id, c]));
  const rows: ImportRowResult[] = plan.rows.map((r) => ({ ...r, reasons: [...r.reasons], mappedFields: { ...r.mappedFields } }));

  for (const r of rows) {
    if (r.decision === "invalid") continue; // never resolvable

    // Manual coordinates: pure enhancement, applied whenever present,
    // regardless of any other blocker — never gates anything.
    const manual = resolutions.manualCoordinates[r.rowNumber];
    if (manual && r.mappedFields.lat == null && r.mappedFields.lng == null) {
      r.mappedFields.lat = manual.lat;
      r.mappedFields.lng = manual.lng;
      r.reasons.push(
        manual.source === "google_geocoding"
          ? `Coordinates accepted by a Manager from an assisted Google Geocoding candidate (${manual.lat}, ${manual.lng}) — never auto-accepted.`
          : `Coordinates entered manually by a Manager after opening the Maps Link (${manual.lat}, ${manual.lng}) — never fetched or geocoded automatically.`,
      );
    }

    let categoryBlocked = r.blockers.missingCategory;
    if (categoryBlocked) {
      const assigned = resolutions.categories[r.rowNumber]?.trim();
      if (assigned) {
        r.mappedFields.category = assigned;
        r.reasons.push(`Category explicitly assigned by a Manager: "${assigned}".`);
        categoryBlocked = false;
      }
    }

    let coordBlocked = !!r.blockers.coordinateConflict;
    if (coordBlocked) {
      const choice = resolutions.coordinateConflicts[r.rowNumber];
      const conflict = r.blockers.coordinateConflict!;
      if (choice === "spreadsheet") {
        r.mappedFields.lat = conflict.spreadsheetLat;
        r.mappedFields.lng = conflict.spreadsheetLng;
        r.reasons.push("Coordinate conflict resolved by a Manager: spreadsheet Latitude/Longitude chosen.");
        coordBlocked = false;
      } else if (choice === "maps_link") {
        r.mappedFields.lat = conflict.mapsLat;
        r.mappedFields.lng = conflict.mapsLng;
        r.reasons.push("Coordinate conflict resolved by a Manager: Maps Link coordinates chosen.");
        coordBlocked = false;
      }
    }

    let duplicateBlocked = false;
    let duplicateExcluded = false;
    if (r.blockers.duplicateClusterId) {
      const cluster = clustersById.get(r.blockers.duplicateClusterId);
      const resolution = resolutions.duplicateClusters[r.blockers.duplicateClusterId];
      if (!cluster || !resolution || resolution.action === "needs_further_review") {
        duplicateBlocked = true;
      } else if (resolution.action === "keep_all") {
        duplicateBlocked = false;
      } else if (resolution.action === "keep_only") {
        const keep = new Set(resolution.keepRowNumbers ?? []);
        if (keep.has(r.rowNumber)) {
          duplicateBlocked = false;
        } else {
          duplicateBlocked = true;
          duplicateExcluded = true;
        }
      }
    }

    if (duplicateExcluded) {
      r.decision = "excluded";
      r.reasons.push("Excluded: a Manager chose to keep a different row from this duplicate cluster instead.");
      continue;
    }
    if (!categoryBlocked && !coordBlocked && !duplicateBlocked) {
      r.decision = r.existingBusinessId ? "update" : "create";
    }
    // else: leave decision exactly as planBusinessImport() set it
    // (needs_review / duplicate_review) — still blocked.
  }

  const creates: Business[] = [];
  const updates: { id: string; patch: Partial<Business> }[] = [];
  const now = new Date().toISOString();
  for (const r of rows) {
    if (r.decision === "create") creates.push(buildImportedBusiness(r.mappedFields, deterministicBusinessImportId(r.businessCode!), now));
    else if (r.decision === "update") updates.push({ id: r.existingBusinessId!, patch: r.mappedFields });
  }

  const counts = {
    total: rows.length,
    ready: rows.filter((r) => r.decision === "create").length,
    update: rows.filter((r) => r.decision === "update").length,
    duplicateReview: rows.filter((r) => r.decision === "duplicate_review").length,
    invalid: rows.filter((r) => r.decision === "invalid").length,
    needsReview: rows.filter((r) => r.decision === "needs_review").length,
    excluded: rows.filter((r) => r.decision === "excluded").length,
  };

  return { sourceRowCount: plan.sourceRowCount, rows, counts, creates, updates, duplicateClusters: plan.duplicateClusters };
}
