import { useMemo, useState } from "react";
import { AlertTriangle, MapPinOff, MapPin, Users, Tag, CheckCircle2, Ban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Business } from "@/types";
import {
  categoryVocabulary,
  type DuplicateCluster,
  type ImportPlan,
  type ImportRowResult,
  type ReviewResolutions,
} from "@/engine/businessImport";

/** Manager-only Data Quality review for one uploaded lead spreadsheet.
 * Purely a resolution UI over the plan applyReviewResolutions() already
 * computed — never writes to Firestore itself (see Settings.tsx: writes
 * only ever happen from confirmBizImport(), after this UI's resolutions
 * have already been folded into the plan the Confirm button uses). */

interface Props {
  existingBusinesses: Business[];
  plan: ImportPlan; // the UNRESOLVED plan from planBusinessImport()
  resolvedPlan: ImportPlan; // plan + applyReviewResolutions(resolutions)
  resolutions: ReviewResolutions;
  onChange: (next: ReviewResolutions) => void;
}

function rowByNumber(plan: ImportPlan, rowNumber: number): ImportRowResult | undefined {
  return plan.rows.find((r) => r.rowNumber === rowNumber);
}

/** A row's only location signal is an unresolvable maps.app.goo.gl / goo.gl
 * short link — informational only, never blocks import (see
 * businessImport.ts: coordinate-lessness has never gated a create/update). */
function isShortLinkOnly(r: ImportRowResult): boolean {
  if (r.mappedFields.lat != null && r.mappedFields.lng != null) return false;
  const url = r.mappedFields.googleMapsUrl;
  return !!url && /goo\.gl|maps\.app/.test(url);
}

/** A row with NO usable coordinate AND no stored Maps link at all — either
 * the source cell was empty, or it held a URL the strict validator doesn't
 * recognize (see isGoogleMapsUrl in src/lib/googleMaps.ts — a value like
 * that is never stored as googleMapsUrl, so it's indistinguishable here from
 * "no link" without reading `reasons`). Distinct from isShortLinkOnly, whose
 * rows DO carry a stored, recognized-but-unresolvable short link — both are
 * informational-only (never block import), but the Manager needs to know
 * WHICH case they're looking at, so they stay two separate sections. */
function isMissingLocation(r: ImportRowResult): boolean {
  if (r.mappedFields.lat != null && r.mappedFields.lng != null) return false;
  return !r.mappedFields.googleMapsUrl;
}

type DqFilter = "all" | "duplicate" | "category" | "coordinate" | "location" | "shortlink" | "ready" | "excluded";
type DqSort = "code" | "name" | "reviewType" | "clusterSize" | "locationAvailability";

const DQ_FILTERS: { value: DqFilter; label: string }[] = [
  { value: "all", label: "All unresolved" },
  { value: "duplicate", label: "Duplicate review" },
  { value: "category", label: "Category review" },
  { value: "coordinate", label: "Coordinate review" },
  { value: "location", label: "Missing location" },
  { value: "shortlink", label: "Short Maps links" },
  { value: "ready", label: "Ready after resolution" },
  { value: "excluded", label: "Excluded by Manager" },
];

/** Business Code / Name sort applies uniformly; "Review type" and "Cluster
 * size" only have meaning for the duplicate-cluster list (sorted
 * separately, see sortClusters) — for a flat, single-type row list they're
 * a deliberate no-op (every row already shares the same type, and clusters
 * don't apply), not a fabricated ordering. */
function sortRows<T extends { businessCode?: string; businessName?: string }>(rows: T[], sort: DqSort, locationScore?: (r: T) => number): T[] {
  if (sort === "code") return [...rows].sort((a, b) => (a.businessCode ?? "").localeCompare(b.businessCode ?? ""));
  if (sort === "name") return [...rows].sort((a, b) => (a.businessName ?? "").localeCompare(b.businessName ?? ""));
  if (sort === "locationAvailability" && locationScore) return [...rows].sort((a, b) => locationScore(b) - locationScore(a));
  return rows;
}

/** 2 = has a usable coordinate, 1 = has a Maps link (even if unresolved), 0 = no location signal at all. */
function locationScoreOf(r: ImportRowResult): number {
  if (r.mappedFields.lat != null && r.mappedFields.lng != null) return 2;
  if (r.mappedFields.googleMapsUrl) return 1;
  return 0;
}

/** Clusters aren't single rows, so "Business Code"/"Name" sort uses the
 * cluster's first (lowest row number) member as a representative — the
 * cluster itself doesn't otherwise change. "Cluster size" is the one sort
 * that's actually meaningful here; the rest fall back to the plan's own
 * deterministic cluster order. */
function sortClusters(plan: ImportPlan, clusters: DuplicateCluster[], sort: DqSort): DuplicateCluster[] {
  if (sort === "clusterSize") return [...clusters].sort((a, b) => b.rowNumbers.length - a.rowNumbers.length);
  if (sort === "code" || sort === "name") {
    return [...clusters].sort((a, b) => {
      const ra = rowByNumber(plan, a.rowNumbers[0]);
      const rb = rowByNumber(plan, b.rowNumbers[0]);
      const va = sort === "code" ? (ra?.businessCode ?? "") : (ra?.businessName ?? "");
      const vb = sort === "code" ? (rb?.businessCode ?? "") : (rb?.businessName ?? "");
      return va.localeCompare(vb);
    });
  }
  return clusters;
}

export function BusinessDataQuality({ existingBusinesses, plan, resolvedPlan, resolutions, onChange }: Props) {
  const [manualCoordDraft, setManualCoordDraft] = useState<Record<number, { lat: string; lng: string }>>({});
  // Filter/sort are pure view state — which section(s) render and in what
  // order — never resolution state, so toggling them can never change the
  // final plan (see [Q] in tests/f5-data-quality-completion.regression.mjs).
  const [dqFilter, setDqFilter] = useState<DqFilter>("all");
  const [dqSort, setDqSort] = useState<DqSort>("code");

  const vocabulary = useMemo(() => categoryVocabulary(existingBusinesses, plan), [existingBusinesses, plan]);

  // Primary-bucket framing: both the summary tile and this review list only
  // count/show a row under "missing category" / "location review" while its
  // CURRENT decision is needs_review for that specific reason — a row
  // that's ALSO duplicate-flagged is counted once, under Duplicate/identity
  // review, never both (see the Phase F.2 report's "Import coverage
  // analysis" for why double-counting the tiles would misrepresent how many
  // rows need each kind of attention). That row's "Category is missing" /
  // coordinate-conflict reason still shows in its Duplicate review card —
  // and, since Phase F.5, so does a real action control for it right there
  // (see the inline category/coordinate controls inside the cluster member
  // rows below): resolving the duplicate alone was never enough to reach
  // Ready if the category was ALSO unresolved, and until F.5 there was no
  // way to resolve that second blocker at all for such a row — a genuine
  // gap, now closed, without touching these primary-bucket tile counts.
  const missingCategoryRows = useMemo(() => resolvedPlan.rows.filter((r) => r.blockers.missingCategory && r.decision === "needs_review"), [resolvedPlan]);
  const stillMissingCategory = missingCategoryRows.length;

  const coordConflictRows = useMemo(() => resolvedPlan.rows.filter((r) => r.blockers.coordinateConflict && r.decision === "needs_review"), [resolvedPlan]);
  const stillLocationConflict = coordConflictRows.length;

  const duplicateRows = useMemo(() => plan.rows.filter((r) => r.blockers.duplicateClusterId), [plan]);
  const stillDuplicateReview = resolvedPlan.rows.filter((r) => r.decision === "duplicate_review").length;

  const shortLinkRows = useMemo(() => plan.rows.filter(isShortLinkOnly), [plan]);
  const missingLocationRows = useMemo(() => plan.rows.filter(isMissingLocation), [plan]);

  const readyCount = resolvedPlan.counts.ready + resolvedPlan.counts.update;

  // Rows that WERE blocked in the original strict plan and are now Ready —
  // i.e. an explicit Manager resolution actually moved them, not a row that
  // was always going to import cleanly. Read-only: nothing here writes.
  const readyAfterResolutionRows = useMemo(
    () =>
      resolvedPlan.rows.filter((r) => {
        if (r.decision !== "create" && r.decision !== "update") return false;
        const original = rowByNumber(plan, r.rowNumber);
        return !!original && (original.blockers.missingCategory || !!original.blockers.coordinateConflict || !!original.blockers.duplicateClusterId);
      }),
    [plan, resolvedPlan],
  );
  // Rows a Manager explicitly chose NOT to keep via a "keep only" duplicate
  // resolution — never silently dropped, always visible here.
  const excludedRows = useMemo(() => resolvedPlan.rows.filter((r) => r.decision === "excluded"), [resolvedPlan]);

  const showSection = (key: Exclude<DqFilter, "all">) => dqFilter === "all" || dqFilter === key;

  function setCategory(rowNumber: number, category: string) {
    onChange({ ...resolutions, categories: { ...resolutions.categories, [rowNumber]: category } });
  }
  function setCoordConflict(rowNumber: number, choice: "spreadsheet" | "maps_link" | "needs_further_review") {
    onChange({ ...resolutions, coordinateConflicts: { ...resolutions.coordinateConflicts, [rowNumber]: choice } });
  }
  function setCluster(clusterId: string, action: "keep_all" | "keep_only" | "needs_further_review", keepRowNumbers?: number[]) {
    onChange({ ...resolutions, duplicateClusters: { ...resolutions.duplicateClusters, [clusterId]: { action, keepRowNumbers } } });
  }
  function saveManualCoord(rowNumber: number) {
    const draft = manualCoordDraft[rowNumber];
    if (!draft) return;
    const lat = Number(draft.lat);
    const lng = Number(draft.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    onChange({ ...resolutions, manualCoordinates: { ...resolutions.manualCoordinates, [rowNumber]: { lat, lng } } });
  }

  return (
    <div className="space-y-5" data-testid="biz-dq-panel">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
        <SummaryTile label="Ready" value={readyCount} tone="success" testId="biz-dq-summary-ready" />
        <SummaryTile label="Missing category" value={stillMissingCategory} tone="warning" testId="biz-dq-summary-category" />
        <SummaryTile label="Duplicate / identity review" value={stillDuplicateReview} tone="warning" testId="biz-dq-summary-duplicate" />
        <SummaryTile label="Location review" value={stillLocationConflict} tone="warning" testId="biz-dq-summary-location" />
        <SummaryTile label="Short map link" value={shortLinkRows.length} tone="neutral" testId="biz-dq-summary-shortlink" secondary />
      </div>
      <p className="text-xs text-muted">
        The first four are the primary import buckets (they sum to every row in the file). "Short map link" is a secondary, non-blocking signal — those
        businesses import fine, they just won't have a map coordinate yet.
      </p>

      <div className="flex flex-wrap items-center gap-2" data-testid="biz-dq-filter-bar">
        {DQ_FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={dqFilter === f.value ? "default" : "secondary"}
            onClick={() => setDqFilter(f.value)}
            data-testid={`biz-dq-filter-${f.value}`}
          >
            {f.label}
          </Button>
        ))}
        <Select value={dqSort} onValueChange={(v) => setDqSort(v as DqSort)}>
          <SelectTrigger className="h-8 w-44 ml-auto" data-testid="biz-dq-sort-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="code">Business Code</SelectItem>
            <SelectItem value="name">Business Name</SelectItem>
            <SelectItem value="reviewType">Review type</SelectItem>
            <SelectItem value="clusterSize">Cluster size</SelectItem>
            <SelectItem value="locationAvailability">Location availability</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {showSection("category") && missingCategoryRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Tag className="size-4" /> Category review ({missingCategoryRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2 max-h-72 overflow-y-auto">
            {sortRows(missingCategoryRows, dqSort, locationScoreOf).map((r) => (
              <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm space-y-1.5" data-testid="biz-dq-category-row" data-row={r.rowNumber}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">
                    {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                  </span>
                  {resolutions.categories[r.rowNumber] && (
                    <Badge variant="success" data-testid="biz-dq-category-assigned">
                      {resolutions.categories[r.rowNumber]}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {r.mappedFields.address || "No address"} · {r.mappedFields.contactPhone || "No phone"}
                </div>
                <div className="flex items-center gap-2">
                  <Select value={resolutions.categories[r.rowNumber] ?? ""} onValueChange={(v) => setCategory(r.rowNumber, v)}>
                    <SelectTrigger className="h-8 w-56" data-testid="biz-dq-category-select">
                      <SelectValue placeholder="Assign category…" />
                    </SelectTrigger>
                    <SelectContent>
                      {vocabulary.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {showSection("duplicate") && plan.duplicateClusters.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="size-4" /> Duplicate / identity review ({duplicateRows.length} rows in {plan.duplicateClusters.length} clusters)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3 max-h-96 overflow-y-auto">
            {sortClusters(plan, plan.duplicateClusters, dqSort).map((cluster) => {
              const resolution = resolutions.duplicateClusters[cluster.id];
              const members = cluster.rowNumbers.map((rn) => rowByNumber(plan, rn)!).filter(Boolean);
              return (
                <div key={cluster.id} className="rounded-md border border-border px-3 py-2.5 text-sm space-y-2" data-testid="biz-dq-cluster" data-cluster={cluster.id} data-conclusive={cluster.conclusive}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{cluster.conclusive ? "Likely duplicate" : "Possible duplicate"}</span>
                    <span className="text-xs text-muted">Matched on: {cluster.matchingSignals.join(", ")}</span>
                  </div>
                  <div className="space-y-1.5">
                    {members.map((m) => (
                      <div key={m.rowNumber} className="rounded bg-surface-2 px-2 py-1.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {m.businessName} <span className="text-muted font-normal">· {m.businessCode}</span>
                            </div>
                            <div className="text-xs text-muted truncate">
                              {m.mappedFields.contactPhone || "no phone"} · {m.mappedFields.category || "no category"} · row {m.rowNumber}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={resolution?.action === "keep_only" && resolution.keepRowNumbers?.includes(m.rowNumber) ? "default" : "secondary"}
                            onClick={() => setCluster(cluster.id, "keep_only", [m.rowNumber])}
                            data-testid="biz-dq-cluster-keep-only"
                          >
                            Keep only this
                          </Button>
                        </div>
                        {/* A member can ALSO be missing a category or have an
                            unresolved coordinate conflict — its decision is
                            "duplicate_review" (the duplicate flag always
                            wins in the strict importer), so it never appears
                            in the primary Category/Coordinate review cards
                            above. Resolve it right here instead — this is
                            the only place such a row's second blocker can
                            ever be cleared; without it, resolving the
                            duplicate alone would never be enough to reach
                            Ready. */}
                        {m.blockers.missingCategory && (
                          <div className="flex items-center gap-2 pl-0.5">
                            <span className="text-xs text-muted shrink-0">Also missing a category:</span>
                            <Select value={resolutions.categories[m.rowNumber] ?? ""} onValueChange={(v) => setCategory(m.rowNumber, v)}>
                              <SelectTrigger className="h-7 w-48" data-testid="biz-dq-cluster-category-select">
                                <SelectValue placeholder="Assign category…" />
                              </SelectTrigger>
                              <SelectContent>
                                {vocabulary.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {c}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {m.blockers.coordinateConflict && (
                          <div className="flex flex-wrap items-center gap-2 pl-0.5">
                            <span className="text-xs text-muted shrink-0">Also has a coordinate conflict:</span>
                            <Button size="sm" variant={resolutions.coordinateConflicts[m.rowNumber] === "spreadsheet" ? "default" : "secondary"} onClick={() => setCoordConflict(m.rowNumber, "spreadsheet")} data-testid="biz-dq-cluster-coord-spreadsheet">
                              Use spreadsheet
                            </Button>
                            <Button size="sm" variant={resolutions.coordinateConflicts[m.rowNumber] === "maps_link" ? "default" : "secondary"} onClick={() => setCoordConflict(m.rowNumber, "maps_link")} data-testid="biz-dq-cluster-coord-mapslink">
                              Use Maps Link
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={resolution?.action === "keep_all" ? "default" : "ghost"} onClick={() => setCluster(cluster.id, "keep_all")} data-testid="biz-dq-cluster-keep-all">
                      Keep both / all
                    </Button>
                    <Button
                      size="sm"
                      variant={!resolution || resolution.action === "needs_further_review" ? "default" : "ghost"}
                      onClick={() => setCluster(cluster.id, "needs_further_review")}
                      data-testid="biz-dq-cluster-needs-review"
                    >
                      Needs further review
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {showSection("coordinate") && coordConflictRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4" /> Location conflict review ({coordConflictRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {sortRows(coordConflictRows, dqSort, locationScoreOf).map((r) => {
              const conflict = r.blockers.coordinateConflict!;
              const choice = resolutions.coordinateConflicts[r.rowNumber];
              return (
                <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2.5 text-sm space-y-2" data-testid="biz-dq-coord-row" data-row={r.rowNumber}>
                  <div className="font-medium">
                    {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                  </div>
                  <div className="text-xs text-muted">
                    Spreadsheet: {conflict.spreadsheetLat}, {conflict.spreadsheetLng} · Maps Link: {conflict.mapsLat}, {conflict.mapsLng} · {conflict.distanceMeters}m apart
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={choice === "spreadsheet" ? "default" : "secondary"} onClick={() => setCoordConflict(r.rowNumber, "spreadsheet")} data-testid="biz-dq-coord-spreadsheet">
                      Use spreadsheet coordinates
                    </Button>
                    <Button size="sm" variant={choice === "maps_link" ? "default" : "secondary"} onClick={() => setCoordConflict(r.rowNumber, "maps_link")} data-testid="biz-dq-coord-mapslink">
                      Use Maps Link coordinates
                    </Button>
                    <Button size="sm" variant={!choice || choice === "needs_further_review" ? "default" : "ghost"} onClick={() => setCoordConflict(r.rowNumber, "needs_further_review")} data-testid="biz-dq-coord-defer">
                      Needs further review
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {showSection("location") && missingLocationRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin className="size-4" /> Missing location ({missingLocationRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <p className="text-xs text-muted">
              These businesses have no coordinates AND no recognizable Maps Link at all (the source cell was either empty or held a link format this
              app doesn't recognize) — informational only, never blocks import; they just won't have a map marker in City Coverage yet. This app never
              geocodes automatically — enter coordinates by hand only if you already know them.
            </p>
            <div className="max-h-72 overflow-y-auto space-y-2">
              {sortRows(missingLocationRows, dqSort, locationScoreOf).map((r) => {
                const saved = resolutions.manualCoordinates[r.rowNumber];
                const draft = manualCoordDraft[r.rowNumber] ?? { lat: "", lng: "" };
                const unrecognizedLinkReason = r.reasons.find((x) => x.includes("Maps Link"));
                return (
                  <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm space-y-1.5" data-testid="biz-dq-location-row" data-row={r.rowNumber}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">
                        {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                      </span>
                      {saved && (
                        <Badge variant="success" data-testid="biz-dq-location-saved">
                          {saved.lat}, {saved.lng}
                        </Badge>
                      )}
                    </div>
                    {unrecognizedLinkReason ? <div className="text-xs text-muted">{unrecognizedLinkReason}</div> : <div className="text-xs text-muted">No Maps Link in the source row.</div>}
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 w-28"
                        placeholder="Latitude"
                        value={draft.lat}
                        onChange={(e) => setManualCoordDraft((s) => ({ ...s, [r.rowNumber]: { ...draft, lat: e.target.value } }))}
                        data-testid="biz-dq-location-lat"
                      />
                      <Input
                        className="h-8 w-28"
                        placeholder="Longitude"
                        value={draft.lng}
                        onChange={(e) => setManualCoordDraft((s) => ({ ...s, [r.rowNumber]: { ...draft, lng: e.target.value } }))}
                        data-testid="biz-dq-location-lng"
                      />
                      <Button size="sm" variant="secondary" onClick={() => saveManualCoord(r.rowNumber)} data-testid="biz-dq-location-save">
                        Save
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {showSection("shortlink") && shortLinkRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPinOff className="size-4" /> Short map link ({shortLinkRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            <p className="text-xs text-muted">
              These businesses' only location signal is a shortened Google Maps link (maps.app.goo.gl), which this app never follows or resolves
              automatically — no geocoding, no network call, no API key. They import fine without a coordinate; if you want one to appear on City
              Coverage, open the link yourself and enter what it resolves to.
            </p>
            <div className="max-h-72 overflow-y-auto space-y-2">
              {sortRows(shortLinkRows, dqSort, locationScoreOf).map((r) => {
                const saved = resolutions.manualCoordinates[r.rowNumber];
                const draft = manualCoordDraft[r.rowNumber] ?? { lat: "", lng: "" };
                return (
                  <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm space-y-1.5" data-testid="biz-dq-shortlink-row" data-row={r.rowNumber}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">
                        {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                      </span>
                      {saved && (
                        <Badge variant="success" data-testid="biz-dq-shortlink-saved">
                          {saved.lat}, {saved.lng}
                        </Badge>
                      )}
                    </div>
                    {r.mappedFields.googleMapsUrl && (
                      <a href={r.mappedFields.googleMapsUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline break-all">
                        {r.mappedFields.googleMapsUrl}
                      </a>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 w-28"
                        placeholder="Latitude"
                        value={draft.lat}
                        onChange={(e) => setManualCoordDraft((s) => ({ ...s, [r.rowNumber]: { ...draft, lat: e.target.value } }))}
                        data-testid="biz-dq-shortlink-lat"
                      />
                      <Input
                        className="h-8 w-28"
                        placeholder="Longitude"
                        value={draft.lng}
                        onChange={(e) => setManualCoordDraft((s) => ({ ...s, [r.rowNumber]: { ...draft, lng: e.target.value } }))}
                        data-testid="biz-dq-shortlink-lng"
                      />
                      <Button size="sm" variant="secondary" onClick={() => saveManualCoord(r.rowNumber)} data-testid="biz-dq-shortlink-save">
                        Save
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {dqFilter === "ready" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4" /> Ready after resolution ({readyAfterResolutionRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2 max-h-96 overflow-y-auto">
            {readyAfterResolutionRows.length === 0 && <p className="text-xs text-muted">No row has been moved to Ready by a resolution yet.</p>}
            {sortRows(readyAfterResolutionRows, dqSort, locationScoreOf).map((r) => (
              <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm flex items-center justify-between gap-2" data-testid="biz-dq-ready-row" data-row={r.rowNumber}>
                <span className="font-medium truncate">
                  {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                </span>
                <Badge variant="success">{r.decision === "update" ? "Update" : "Create"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {dqFilter === "excluded" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Ban className="size-4" /> Excluded by Manager ({excludedRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2 max-h-96 overflow-y-auto">
            {excludedRows.length === 0 && <p className="text-xs text-muted">No row has been excluded.</p>}
            {sortRows(excludedRows, dqSort, locationScoreOf).map((r) => (
              <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm" data-testid="biz-dq-excluded-row" data-row={r.rowNumber}>
                <span className="font-medium truncate">
                  {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                </span>
                <p className="text-xs text-muted mt-1">A Manager chose to keep a different row from this row's duplicate cluster instead. Never deleted or merged — re-resolve the cluster to bring it back.</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone, testId, secondary }: { label: string; value: number; tone: "success" | "warning" | "neutral"; testId: string; secondary?: boolean }) {
  const toneClass = tone === "success" ? "bg-success-bg text-success" : tone === "warning" ? "bg-warning-bg text-warning" : "bg-surface-2 text-muted";
  return (
    <div className={`rounded-md px-3 py-2 ${toneClass} ${secondary ? "border border-dashed border-current/30" : ""}`} data-testid={testId}>
      <div className="text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
