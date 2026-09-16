import { useMemo } from "react";
import { ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Business } from "@/types";
import { buildFinalImportPlan, type FinalPlanRow, type ImportReasonCode } from "@/engine/importPreflight";
import type { ImportPlan, ReviewResolutions } from "@/engine/businessImport";

interface Props {
  plan: ImportPlan;
  resolvedPlan: ImportPlan;
  resolutions: ReviewResolutions;
}

const REASON_LABEL: Record<ImportReasonCode, string> = {
  INVALID_ROW: "Invalid row",
  CATEGORY_REVIEW_REQUIRED: "Category review required",
  DUPLICATE_REVIEW_REQUIRED: "Duplicate review required",
  COORDINATE_REVIEW_REQUIRED: "Coordinate review required",
  LOCATION_MISSING: "No location signal (informational)",
  SHORT_MAPS_LINK_UNRESOLVED: "Maps link is present but coordinates could not be derived from the URL (informational)",
};

function SummaryTile({ label, value, tone, testId }: { label: string; value: number; tone: "success" | "warning" | "critical" | "neutral"; testId: string }) {
  const toneClass = tone === "success" ? "bg-success-bg text-success" : tone === "warning" ? "bg-warning-bg text-warning" : tone === "critical" ? "bg-critical-bg text-critical" : "bg-surface-2 text-muted";
  return (
    <div className={`rounded-md px-3 py-2 ${toneClass}`} data-testid={testId}>
      <div className="text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function fieldList(fields: Partial<Business>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`)
    .join(", ");
}

export function ImportPreflight({ plan, resolvedPlan, resolutions }: Props) {
  const finalPlan = useMemo(() => buildFinalImportPlan(plan, resolvedPlan, resolutions), [plan, resolvedPlan, resolutions]);
  const { summary } = finalPlan;

  return (
    <div className="space-y-5" data-testid="biz-preflight-panel">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
        <SummaryTile label="Ready" value={summary.ready} tone="success" testId="preflight-summary-ready" />
        <SummaryTile label="Blocked" value={summary.blocked} tone="warning" testId="preflight-summary-blocked" />
        <SummaryTile label="New businesses" value={summary.create} tone="success" testId="preflight-summary-create" />
        <SummaryTile label="Updates" value={summary.update} tone="success" testId="preflight-summary-update" />
        <SummaryTile label="Duplicate reviews" value={summary.duplicateReview} tone="warning" testId="preflight-summary-duplicate" />
        <SummaryTile label="Category reviews" value={summary.categoryReview} tone="warning" testId="preflight-summary-category" />
        <SummaryTile label="Coordinate reviews" value={summary.coordinateReview} tone="warning" testId="preflight-summary-coordinate" />
        <SummaryTile label="Missing location" value={summary.locationMissing} tone="neutral" testId="preflight-summary-location" />
        <SummaryTile label="Short links" value={summary.shortLink} tone="neutral" testId="preflight-summary-shortlink" />
        <SummaryTile label="Invalid" value={summary.invalid} tone="critical" testId="preflight-summary-invalid" />
      </div>

      <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm" data-testid="preflight-confirmation-line">
        <ClipboardCheck className="size-4 shrink-0 mt-0.5 text-muted" />
        <span>
          <strong className="tabular-nums">{summary.create}</strong> businesses will be created. <strong className="tabular-nums">{summary.update}</strong> existing businesses will be updated.{" "}
          <strong className="tabular-nums">{summary.blocked}</strong> rows will NOT be imported because they remain unresolved.
        </span>
      </div>

      {finalPlan.blockedRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Blocked rows ({finalPlan.blockedRows.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 max-h-80 overflow-y-auto space-y-2">
            {finalPlan.blockedRows.map((r) => (
              <BlockedRowCard key={r.rowNumber} row={r} />
            ))}
          </CardContent>
        </Card>
      )}

      {finalPlan.readyRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Write preview — {finalPlan.readyRows.length} rows</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 max-h-80 overflow-y-auto space-y-2">
            {finalPlan.readyRows.map((r) => (
              <div key={r.rowNumber} className="rounded-md border border-border px-3 py-2 text-sm space-y-1" data-testid="preflight-write-row" data-operation={r.operation}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">
                    {r.businessName} <span className="text-muted font-normal">· {r.businessCode}</span>
                  </span>
                  <Badge variant={r.operation === "CREATE" ? "success" : "info"}>{r.operation}</Badge>
                </div>
                {r.writePreview && (
                  <>
                    <div className="text-xs text-muted break-all" data-testid="preflight-fields-written">
                      <span className="font-medium text-foreground">Fields written:</span> {fieldList(r.writePreview.fieldsWritten)}
                      {r.operation === "CREATE" && ", id=" + r.businessId}
                    </div>
                    {r.operation === "UPDATE" && (
                      <div className="text-xs text-muted" data-testid="preflight-fields-preserved">
                        <span className="font-medium text-foreground">Fields preserved (never touched):</span> {r.writePreview.fieldsPreserved.join(", ")}
                      </div>
                    )}
                    {r.locationSource === "google_geocoding" && (
                      <div className="text-xs text-muted" data-testid="preflight-location-provenance">
                        <span className="font-medium text-foreground">Location provenance:</span> coordinates accepted from an assisted Google Geocoding candidate (Manager-approved, never auto-accepted).
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BlockedRowCard({ row }: { row: FinalPlanRow }) {
  return (
    <div className="rounded-md border border-border px-3 py-2 text-sm space-y-1" data-testid="preflight-blocked-row" data-row={row.rowNumber}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">
          {row.businessName ?? "(no name)"} <span className="text-muted font-normal">· {row.businessCode ?? "no code"}</span>
        </span>
        <span className="text-xs text-muted">
          {row.city ?? "—"} · {row.rawCategory ?? "no category"} · {row.contactPhone ?? "no phone"}
        </span>
      </div>
      <ul className="space-y-0.5 text-xs text-muted list-disc list-inside" data-testid="preflight-blocked-reasons">
        {row.excluded ? (
          <li data-reason-code="EXCLUDED_BY_MANAGER">Excluded — a Manager chose to keep a different row from this duplicate cluster instead.</li>
        ) : row.reasonCodes.length > 0 ? (
          row.reasonCodes.map((code) => (
            <li key={code} data-reason-code={code}>
              {REASON_LABEL[code]}
            </li>
          ))
        ) : (
          <li data-reason-code="EXCLUDED_BY_MANAGER">Excluded — a Manager chose to keep a different row from this duplicate cluster instead.</li>
        )}
      </ul>
      <div className="text-xs text-muted flex flex-wrap gap-x-3">
        {row.duplicateDecision && <span data-testid="preflight-duplicate-decision">duplicate decision: {row.duplicateDecision}</span>}
        {row.coordinateDecision && <span data-testid="preflight-coordinate-decision">coordinate decision: {row.coordinateDecision}</span>}
        <span data-testid="preflight-maps-link-status">maps link: {row.mapsLinkStatus}</span>
      </div>
    </div>
  );
}
