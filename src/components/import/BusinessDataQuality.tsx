import { useMemo, useState } from "react";
import { AlertTriangle, MapPinOff, Users, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Business } from "@/types";
import {
  categoryVocabulary,
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

export function BusinessDataQuality({ existingBusinesses, plan, resolvedPlan, resolutions, onChange }: Props) {
  const [manualCoordDraft, setManualCoordDraft] = useState<Record<number, { lat: string; lng: string }>>({});

  const vocabulary = useMemo(() => categoryVocabulary(existingBusinesses, plan), [existingBusinesses, plan]);

  // Primary-bucket framing throughout: both the summary tile and the
  // review list below only count/show a row under "missing category" /
  // "location review" while its CURRENT decision is needs_review for that
  // specific reason — a row that's ALSO duplicate-flagged is counted once,
  // under Duplicate/identity review, never both (see the Phase F.2 report's
  // "Import coverage analysis" for why double-counting would misrepresent
  // how many rows actually need each kind of attention). Such a row's
  // "Category is missing" reason still shows in its Duplicate review card's
  // reason list — resolving the duplicate alone won't promote it, and its
  // still-missing category is visible there, just without a dedicated
  // action button in two places at once.
  const missingCategoryRows = useMemo(() => resolvedPlan.rows.filter((r) => r.blockers.missingCategory && r.decision === "needs_review"), [resolvedPlan]);
  const stillMissingCategory = missingCategoryRows.length;

  const coordConflictRows = useMemo(() => resolvedPlan.rows.filter((r) => r.blockers.coordinateConflict && r.decision === "needs_review"), [resolvedPlan]);
  const stillLocationConflict = coordConflictRows.length;

  const duplicateRows = useMemo(() => plan.rows.filter((r) => r.blockers.duplicateClusterId), [plan]);
  const stillDuplicateReview = resolvedPlan.rows.filter((r) => r.decision === "duplicate_review").length;

  const shortLinkRows = useMemo(() => plan.rows.filter(isShortLinkOnly), [plan]);

  const readyCount = resolvedPlan.counts.ready + resolvedPlan.counts.update;

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

      {missingCategoryRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Tag className="size-4" /> Category review ({missingCategoryRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2 max-h-72 overflow-y-auto">
            {missingCategoryRows.map((r) => (
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

      {plan.duplicateClusters.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="size-4" /> Duplicate / identity review ({duplicateRows.length} rows in {plan.duplicateClusters.length} clusters)
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3 max-h-96 overflow-y-auto">
            {plan.duplicateClusters.map((cluster) => {
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
                      <div key={m.rowNumber} className="flex items-center justify-between gap-2 rounded bg-surface-2 px-2 py-1.5">
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

      {coordConflictRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4" /> Location conflict review ({coordConflictRows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {coordConflictRows.map((r) => {
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

      {shortLinkRows.length > 0 && (
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
              {shortLinkRows.map((r) => {
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
