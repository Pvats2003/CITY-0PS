import { useMemo } from "react";
import { GitCompare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Business } from "@/types";
import { deterministicBusinessImportId, type ImportPlan } from "@/engine/businessImport";

// ---------------------------------------------------------------------------
// Phase F.5 — Source vs Production reconciliation: a READ-ONLY view comparing
// the currently-uploaded source spreadsheet against the Business Master
// (existingBusinesses), using Business Code identity only (never name,
// phone, coordinates, or Maps URL — see businessImport.ts's
// deterministicBusinessImportId()). Renders nothing that can be clicked to
// write — no buttons, no onChange, no store action imported here at all.
//
// Does NOT assume every existing business originated from this spreadsheet:
// a production business is only ever counted as "from this source" when its
// id literally equals deterministicBusinessImportId(code) for a Business
// Code present in the CURRENTLY uploaded file — everything else (a
// Manager-created business, or one imported from a different source file
// entirely) stays in its own, clearly separate bucket.
// ---------------------------------------------------------------------------

interface Props {
  existingBusinesses: Business[];
  plan: ImportPlan; // the UNRESOLVED plan from planBusinessImport()
  resolvedPlan: ImportPlan; // plan + applyReviewResolutions(resolutions)
}

function SummaryTile({ label, value, tone, testId }: { label: string; value: number; tone: "success" | "warning" | "neutral" | "critical"; testId: string }) {
  const toneClass = tone === "success" ? "bg-success-bg text-success" : tone === "warning" ? "bg-warning-bg text-warning" : tone === "critical" ? "bg-critical-bg text-critical" : "bg-surface-2 text-muted";
  return (
    <div className={`rounded-md px-3 py-2 ${toneClass}`} data-testid={testId}>
      <div className="text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function ImportReconciliation({ existingBusinesses, plan, resolvedPlan }: Props) {
  const importIdsInSource = useMemo(() => {
    const set = new Set<string>();
    for (const r of plan.rows) if (r.businessCode) set.add(deterministicBusinessImportId(r.businessCode));
    return set;
  }, [plan]);

  const existingFromSource = useMemo(() => existingBusinesses.filter((b) => importIdsInSource.has(b.id)), [existingBusinesses, importIdsInSource]);
  const existingNotFromSource = useMemo(() => existingBusinesses.filter((b) => !importIdsInSource.has(b.id)), [existingBusinesses, importIdsInSource]);

  const alreadyImportedRows = useMemo(() => plan.rows.filter((r) => !!r.existingBusinessId), [plan]);
  const notYetImportedRows = useMemo(() => plan.rows.filter((r) => !r.existingBusinessId), [plan]);
  const sourceRowsUnresolved = useMemo(() => resolvedPlan.rows.filter((r) => r.decision === "duplicate_review" || r.decision === "needs_review"), [resolvedPlan]);
  const sourceRowsExcluded = useMemo(() => resolvedPlan.rows.filter((r) => r.decision === "excluded"), [resolvedPlan]);
  const sourceRowsInvalid = useMemo(() => resolvedPlan.rows.filter((r) => r.decision === "invalid"), [resolvedPlan]);

  return (
    <div className="space-y-5" data-testid="biz-reconciliation-panel">
      <p className="text-xs text-muted">
        Read-only. Compares this uploaded file against the Business Master using Business Code identity only — never name, phone, coordinates, or Maps
        URL. Nothing on this tab writes anything.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
        <SummaryTile label="Imported (matches an existing business)" value={alreadyImportedRows.length} tone="success" testId="reconciliation-imported" />
        <SummaryTile label="Not yet imported" value={notYetImportedRows.length} tone="warning" testId="reconciliation-not-imported" />
        <SummaryTile label="Existing, not from this source" value={existingNotFromSource.length} tone="neutral" testId="reconciliation-existing-foreign" />
        <SummaryTile label="New from current source" value={notYetImportedRows.length} tone="warning" testId="reconciliation-new-from-source" />
        <SummaryTile label="Source rows unresolved" value={sourceRowsUnresolved.length} tone="warning" testId="reconciliation-unresolved" />
        <SummaryTile label="Source rows excluded" value={sourceRowsExcluded.length} tone="neutral" testId="reconciliation-excluded" />
        {sourceRowsInvalid.length > 0 && <SummaryTile label="Source rows invalid" value={sourceRowsInvalid.length} tone="critical" testId="reconciliation-invalid" />}
      </div>

      {existingNotFromSource.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitCompare className="size-4" /> Businesses NOT from this source ({existingNotFromSource.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1 max-h-60 overflow-y-auto">
            <p className="text-xs text-muted mb-1">
              Already in the Business Master before this file was ever uploaded — created manually, or imported from a different source. This file's
              import will never touch these.
            </p>
            {existingNotFromSource.map((b) => (
              <div key={b.id} className="rounded-md border border-border px-3 py-1.5 text-sm" data-testid="reconciliation-foreign-business-row" data-business-id={b.id}>
                {b.name} <span className="text-muted text-xs">· {b.id}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {existingFromSource.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitCompare className="size-4" /> Businesses already imported from this source ({existingFromSource.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1 max-h-60 overflow-y-auto">
            {existingFromSource.map((b) => (
              <div key={b.id} className="rounded-md border border-border px-3 py-1.5 text-sm" data-testid="reconciliation-imported-business-row" data-business-id={b.id}>
                {b.name} <span className="text-muted text-xs">· {b.id}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
