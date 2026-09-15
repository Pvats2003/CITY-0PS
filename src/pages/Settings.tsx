import { useMemo, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
  Download,
  Upload,
  Sparkles,
  Trash2,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  PlusCircle,
  Cpu,
  UserRound,
  LogOut,
} from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useCity } from "@/store/city";
import { generateDemoData } from "@/lib/demo/generate";
import { isFirebaseConfigured } from "@/auth/config";
import { useAuth } from "@/auth/AuthContext";
import { validateBackup, mergeCityData } from "@/lib/backup";
import { downloadCSV, downloadJSON } from "@/lib/csv";
import { fmtDate } from "@/lib/dates";
import type { CityData, Rig } from "@/types";
import { RigFormDialog } from "@/components/forms/RigFormDialog";
import { parseLeadSpreadsheet } from "@/lib/xlsxParse";
import { planBusinessImport, applyReviewResolutions, emptyReviewResolutions, type ImportPlan, type ReviewResolutions } from "@/engine/businessImport";
import { BusinessDataQuality } from "@/components/import/BusinessDataQuality";
import { ImportPreflight } from "@/components/import/ImportPreflight";

const ROLE_LABEL: Record<string, string> = {
  MANAGER: "Manager",
  FIELD_OFFICER: "Field Officer",
};

export default function Settings() {
  const data = useCity();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "general";
  const updateSettings = useCity((s) => s.updateSettings);
  const loadData = useCity((s) => s.loadData);
  const clearAllData = useCity((s) => s.clearAllData);
  const updateBusiness = useCity((s) => s.updateBusiness);
  const importCreateBusiness = useCity((s) => s.importCreateBusiness);
  const logActivity = useCity((s) => s.logActivity);
  const { user, logout, isDemoMode } = useAuth();

  const fileInput = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<{ data: CityData; counts: Record<string, number> } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Business Lead Import (spreadsheet -> Business records) — a separate flow
  // from the JSON backup import above: it targets only the businesses
  // collection, is Manager-confirmed row-by-row via a preview, and is
  // idempotent on re-import. See src/engine/businessImport.ts.
  const bizImportInput = useRef<HTMLInputElement>(null);
  const [bizImportPlan, setBizImportPlan] = useState<ImportPlan | null>(null);
  const [bizImportFileName, setBizImportFileName] = useState<string>("");
  const [bizImportError, setBizImportError] = useState<string | null>(null);
  const [bizImportBusy, setBizImportBusy] = useState(false);
  const [bizImportResult, setBizImportResult] = useState<{ created: number; updated: number } | null>(null);
  // Data Quality review resolutions for the currently-open plan — session-
  // only state (see the "Review-state architecture" note above
  // confirmBizImport() for why this is never persisted to Firestore).
  const [bizImportTab, setBizImportTab] = useState<"summary" | "quality" | "preflight">("summary");
  const [bizImportResolutions, setBizImportResolutions] = useState<ReviewResolutions>(emptyReviewResolutions());
  const resolvedBizImportPlan = useMemo(
    () => (bizImportPlan ? applyReviewResolutions(bizImportPlan, bizImportResolutions) : null),
    [bizImportPlan, bizImportResolutions],
  );
  const [resetOpen, setResetOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [rigDialogOpen, setRigDialogOpen] = useState(false);
  const [rigTarget, setRigTarget] = useState<Rig | undefined>();

  function setTab(t: string) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("tab", t);
      return next;
    });
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function exportBackup() {
    downloadJSON(`city-ops-backup-${fmtDate(new Date(), "yyyy-MM-dd")}.json`, data);
    showToast("Backup exported.");
  }

  function onImportFile(file: File) {
    setImportError(null);
    setImportPreview(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const result = validateBackup(parsed);
        if (!result.valid || !result.data || !result.counts) {
          setImportError(result.error ?? "Import failed. The file could not be validated.");
          return;
        }
        setImportPreview({ data: result.data, counts: result.counts });
      } catch {
        setImportError("Import failed. The file is not valid JSON. No existing data was changed.");
      }
    };
    reader.readAsText(file);
  }

  function confirmImport(mode: "replace" | "merge") {
    if (!importPreview) return;
    if (mode === "replace") {
      loadData(importPreview.data);
    } else {
      loadData(mergeCityData(data, importPreview.data));
    }
    setImportPreview(null);
    showToast(`Backup ${mode === "replace" ? "restored" : "merged"} successfully.`);
  }

  function resetDemo() {
    loadData(generateDemoData(Date.now() % 100000));
    setResetOpen(false);
    showToast("Demo data reset.");
  }

  function clearAll() {
    clearAllData();
    setClearOpen(false);
    setClearConfirmText("");
  }

  async function onBizImportFile(file: File) {
    setBizImportError(null);
    setBizImportResult(null);
    setBizImportPlan(null);
    setBizImportResolutions(emptyReviewResolutions());
    setBizImportTab("summary");
    setBizImportFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await parseLeadSpreadsheet(buf);
      if (!parsed.hasRequiredHeaders) {
        setBizImportError("This file doesn't look like a lead spreadsheet — it's missing a \"Business Code\" and/or \"Business Name\" column. No data was read.");
        return;
      }
      if (parsed.rows.length === 0) {
        setBizImportError("No data rows were found in this file.");
        return;
      }
      // Preview only — planBusinessImport() is pure and performs zero writes.
      setBizImportPlan(planBusinessImport(data.businesses, parsed.rows));
    } catch {
      setBizImportError("This file could not be read as a spreadsheet. No data was changed.");
    }
  }

  function cancelBizImport() {
    setBizImportPlan(null);
    setBizImportFileName("");
    setBizImportResolutions(emptyReviewResolutions());
  }

  // Review-state architecture: bizImportResolutions lives only in this
  // component's React state, for the duration of one upload-review-confirm
  // session. It is deliberately NOT written to Firestore or any other
  // persistent store — see Settings.tsx's Data Quality section and the
  // Phase F.2 report for the full rationale (no new collection needed: a
  // resolution's only job is to influence the ONE import it's part of, and
  // once that import is confirmed, the outcome is already durably recorded
  // as real Business fields — there is nothing left for a stored "review
  // record" to do). If the Manager navigates away mid-review, they re-upload
  // and re-resolve — an accepted tradeoff for a periodic bulk-import tool.
  function confirmBizImport() {
    if (!resolvedBizImportPlan) return;
    setBizImportBusy(true);
    for (const business of resolvedBizImportPlan.creates) importCreateBusiness(business);
    for (const { id, patch } of resolvedBizImportPlan.updates) updateBusiness(id, patch);
    const created = resolvedBizImportPlan.creates.length;
    const updated = resolvedBizImportPlan.updates.length;
    logActivity({
      type: "note",
      entityKind: "business",
      entityId: "business-import",
      summary: `Business lead import from ${bizImportFileName}: ${created} created, ${updated} updated, ${resolvedBizImportPlan.counts.duplicateReview} flagged as duplicates, ${resolvedBizImportPlan.counts.needsReview} needed review, ${resolvedBizImportPlan.counts.excluded} excluded by Manager, ${resolvedBizImportPlan.counts.invalid} rejected.`,
      detail: `${resolvedBizImportPlan.sourceRowCount} rows read.`,
    });
    setBizImportBusy(false);
    setBizImportResult({ created, updated });
    setBizImportPlan(null);
    setBizImportResolutions(emptyReviewResolutions());
    showToast(`Imported ${created} new and updated ${updated} existing businesses.`);
  }

  const exportBusinessesCsv = () =>
    downloadCSV(
      "businesses.csv",
      data.businesses.map((b) => ({
        name: b.name,
        category: b.category,
        area: b.area,
        active: b.active,
        capacityHoursPerDay: b.capacityHoursPerDay,
        contactName: b.contactName ?? "",
        contactPhone: b.contactPhone ?? "",
        googleMapsUrl: b.googleMapsUrl ?? "",
      })),
    );

  const exportSessionsCsv = () =>
    downloadCSV(
      "sessions.csv",
      data.sessions.map((s) => ({
        date: s.date,
        business: data.businesses.find((b) => b.id === s.businessId)?.name ?? "",
        fo: data.fos.find((f) => f.id === s.foId)?.name ?? "",
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? "",
        plannedDurationMin: s.plannedDurationMin,
      })),
    );

  const exportIssuesCsv = () =>
    downloadCSV(
      "issues.csv",
      data.issues.map((i) => ({
        title: i.title,
        type: i.type,
        severity: i.severity,
        status: i.status,
        business: data.businesses.find((b) => b.id === i.businessId)?.name ?? "",
        createdAt: i.createdAt,
        lostHours: i.lostHours ?? 0,
      })),
    );

  return (
    <div className="pb-10">
      <PageHeader title="Settings" subtitle="City configuration, defaults, and data management." />

      <div className="px-4 md:px-6 pt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="fleet">Fleet</TabsTrigger>
            <TabsTrigger value="data">Import / Export</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="px-4 md:px-6 pt-5 max-w-2xl space-y-5">
        {tab === "general" && (
          <>
          {user && (
            <Card>
              <CardHeader>
                <CardTitle>Account</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                    <UserRound className="size-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{user.displayName || user.email}</div>
                    <div className="text-xs text-muted">
                      {ROLE_LABEL[user.role] ?? user.role}
                      {isDemoMode ? " · Demo mode" : ""}
                    </div>
                  </div>
                </div>
                <Button variant="secondary" onClick={() => logout()}>
                  <LogOut className="size-4" /> Sign out
                </Button>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>City defaults</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="space-y-1.5">
                <Label>City name</Label>
                <Input value={data.settings.cityName} onChange={(e) => updateSettings({ cityName: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Working hours start</Label>
                  <Input type="time" value={data.settings.workingHoursStart} onChange={(e) => updateSettings({ workingHoursStart: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Working hours end</Label>
                  <Input type="time" value={data.settings.workingHoursEnd} onChange={(e) => updateSettings({ workingHoursEnd: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Default session duration (min)</Label>
                <Input
                  type="number"
                  value={data.settings.defaultSessionDurationMin}
                  onChange={(e) => updateSettings({ defaultSessionDurationMin: Number(e.target.value) })}
                />
              </div>
              {/* Recording hours target is no longer a manual setting — it's
                  derived automatically as (rigs deployed per business) × 10h
                  and can't drift out of sync with the fleet the way a
                  hand-set constant could. See engine/insights.ts. */}
              <div className="space-y-1.5">
                <Label>Theme</Label>
                <Select value={data.settings.theme} onValueChange={(v) => updateSettings({ theme: v as typeof data.settings.theme })}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          </>
        )}

        {tab === "fleet" && (
          <Card>
            <CardHeader>
              <CardTitle>Rig fleet</CardTitle>
              <Button size="sm" variant="secondary" onClick={() => { setRigTarget(undefined); setRigDialogOpen(true); }}>
                <PlusCircle className="size-4" /> Add Rig
              </Button>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <p className="text-sm text-muted">
                Rig health, readiness, incident history, and repairs now live in Fleet — a dedicated command center for the fleet.
              </p>
              <Button asChild size="sm" variant="secondary">
                <Link to="/fleet">
                  <Cpu className="size-4" /> Open Fleet ({data.rigs.length} rig{data.rigs.length === 1 ? "" : "s"})
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {tab === "data" && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Backup</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <p className="text-sm text-muted">Export your entire city to one JSON file, or restore from a previous backup. Nothing leaves this device.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={exportBackup}>
                    <Download className="size-4" /> Export Backup
                  </Button>
                  <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                    <Upload className="size-4" /> Import Backup
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/json"
                    hidden
                    onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
                  />
                </div>
                {importError && (
                  <div className="flex items-start gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2.5 text-sm">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5 text-critical" />
                    <span>{importError}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Export CSV</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={exportBusinessesCsv}>
                  <FileSpreadsheet className="size-4" /> Businesses
                </Button>
                <Button variant="secondary" size="sm" onClick={exportSessionsCsv}>
                  <FileSpreadsheet className="size-4" /> Sessions
                </Button>
                <Button variant="secondary" size="sm" onClick={exportIssuesCsv}>
                  <FileSpreadsheet className="size-4" /> Issues
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Import Businesses</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <p className="text-sm text-muted">
                  Import businesses from a lead spreadsheet (.xlsx). Every row is previewed — nothing is written until you confirm. Re-importing the same file updates
                  matching businesses in place without creating duplicates.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => bizImportInput.current?.click()} disabled={bizImportBusy} data-testid="biz-import-button">
                    <Upload className="size-4" /> Import Businesses
                  </Button>
                  <input
                    ref={bizImportInput}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    hidden
                    data-testid="biz-import-file-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onBizImportFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
                {bizImportError && (
                  <div className="flex items-start gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2.5 text-sm" data-testid="biz-import-error">
                    <AlertTriangle className="size-4 shrink-0 mt-0.5 text-critical" />
                    <span>{bizImportError}</span>
                  </div>
                )}
                {bizImportResult && (
                  <div className="flex items-start gap-2 rounded-md border border-success/25 bg-success-bg px-3 py-2.5 text-sm" data-testid="biz-import-result">
                    <CheckCircle2 className="size-4 shrink-0 mt-0.5 text-success" />
                    <span>
                      Created {bizImportResult.created}, updated {bizImportResult.updated}.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {!isFirebaseConfigured() && (
              <Card>
                <CardHeader>
                  <CardTitle>Demo data</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-sm text-muted">Regenerate a fresh, realistic demo city — useful for exploring the product without real data.</p>
                  <Button variant="secondary" onClick={() => setResetOpen(true)}>
                    <Sparkles className="size-4" /> Reset Demo Data
                  </Button>
                </CardContent>
              </Card>
            )}

            <Card className="border-critical/25">
              <CardHeader>
                <CardTitle className="text-critical">Danger zone</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <p className="text-sm text-muted">Permanently erase every business, FO, rig, session, issue, and setting on this device. This cannot be undone.</p>
                <Button variant="destructive" onClick={() => setClearOpen(true)}>
                  <Trash2 className="size-4" /> Clear All Data
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* import preview dialog */}
      <Dialog open={!!importPreview} onOpenChange={(v) => !v && setImportPreview(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import backup</DialogTitle>
            <DialogDescription>Review what will be imported before applying it.</DialogDescription>
          </DialogHeader>
          {importPreview && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(importPreview.counts).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5">
                  <span className="text-muted">{k}</span>
                  <span className="tabular-nums font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter className="flex-wrap">
            <Button variant="ghost" onClick={() => setImportPreview(null)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => confirmImport("merge")}>
              Merge with existing
            </Button>
            <Button variant="destructive" onClick={() => confirmImport("replace")}>
              Replace everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* business lead import preview dialog — zero writes happen until Confirm Import */}
      <Dialog open={!!bizImportPlan} onOpenChange={(v) => !v && cancelBizImport()}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import businesses from {bizImportFileName}</DialogTitle>
            <DialogDescription>Review every row before anything is written. Nothing is imported until you confirm.</DialogDescription>
          </DialogHeader>
          {bizImportPlan && resolvedBizImportPlan && (
            <>
              <Tabs value={bizImportTab} onValueChange={(v) => setBizImportTab(v as "summary" | "quality" | "preflight")}>
                <TabsList>
                  <TabsTrigger value="summary" data-testid="biz-import-tab-summary">
                    Summary
                  </TabsTrigger>
                  <TabsTrigger value="quality" data-testid="biz-import-tab-quality">
                    Business Data Quality
                  </TabsTrigger>
                  <TabsTrigger value="preflight" data-testid="biz-import-tab-preflight">
                    Import Preflight
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {bizImportTab === "summary" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                    <div className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5">
                      <span className="text-muted">Rows detected</span>
                      <span className="tabular-nums font-medium" data-testid="biz-import-count-total">{resolvedBizImportPlan.counts.total}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-success-bg px-3 py-1.5">
                      <span className="text-success">New businesses</span>
                      <span className="tabular-nums font-medium text-success" data-testid="biz-import-count-ready">{resolvedBizImportPlan.counts.ready}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-info-bg px-3 py-1.5">
                      <span className="text-info">Existing (update)</span>
                      <span className="tabular-nums font-medium text-info" data-testid="biz-import-count-update">{resolvedBizImportPlan.counts.update}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-warning-bg px-3 py-1.5">
                      <span className="text-warning">Duplicates</span>
                      <span className="tabular-nums font-medium text-warning" data-testid="biz-import-count-duplicate">{resolvedBizImportPlan.counts.duplicateReview}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-warning-bg px-3 py-1.5">
                      <span className="text-warning">Needs review</span>
                      <span className="tabular-nums font-medium text-warning" data-testid="biz-import-count-review">{resolvedBizImportPlan.counts.needsReview}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md bg-critical-bg px-3 py-1.5">
                      <span className="text-critical">Invalid</span>
                      <span className="tabular-nums font-medium text-critical" data-testid="biz-import-count-invalid">{resolvedBizImportPlan.counts.invalid}</span>
                    </div>
                    {resolvedBizImportPlan.counts.excluded > 0 && (
                      <div className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-1.5">
                        <span className="text-muted">Excluded by you</span>
                        <span className="tabular-nums font-medium" data-testid="biz-import-count-excluded">{resolvedBizImportPlan.counts.excluded}</span>
                      </div>
                    )}
                  </div>

                  <div className="max-h-80 overflow-y-auto rounded-md border border-border divide-y divide-border" data-testid="biz-import-row-list">
                    {resolvedBizImportPlan.rows.map((r) => (
                      <div key={r.rowNumber} className="px-3 py-2 text-sm" data-testid="biz-import-row" data-decision={r.decision}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">
                            {r.businessName ?? "(no name)"} <span className="text-muted font-normal">· {r.businessCode ?? "no code"}</span>
                          </span>
                          <Badge
                            variant={
                              r.decision === "create" || r.decision === "update"
                                ? "success"
                                : r.decision === "invalid"
                                  ? "critical"
                                  : r.decision === "excluded"
                                    ? "neutral"
                                    : "warning"
                            }
                          >
                            {r.decision === "create"
                              ? "Ready"
                              : r.decision === "update"
                                ? "Update"
                                : r.decision === "duplicate_review"
                                  ? "Duplicate"
                                  : r.decision === "invalid"
                                    ? "Invalid"
                                    : r.decision === "excluded"
                                      ? "Excluded"
                                      : "Needs review"}
                          </Badge>
                        </div>
                        {r.reasons.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted list-disc list-inside">
                            {r.reasons.map((reason, i) => (
                              <li key={i}>{reason}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {bizImportTab === "quality" && (
                <BusinessDataQuality
                  existingBusinesses={data.businesses}
                  plan={bizImportPlan}
                  resolvedPlan={resolvedBizImportPlan}
                  resolutions={bizImportResolutions}
                  onChange={setBizImportResolutions}
                />
              )}

              {bizImportTab === "preflight" && <ImportPreflight plan={bizImportPlan} resolvedPlan={resolvedBizImportPlan} resolutions={bizImportResolutions} />}
            </>
          )}
          {resolvedBizImportPlan && (
            <div className="text-sm text-muted px-0.5" data-testid="biz-import-confirmation-summary">
              <strong className="text-foreground tabular-nums">{resolvedBizImportPlan.counts.ready}</strong> businesses will be created.{" "}
              <strong className="text-foreground tabular-nums">{resolvedBizImportPlan.counts.update}</strong> existing businesses will be updated.{" "}
              <strong className="text-foreground tabular-nums">
                {resolvedBizImportPlan.counts.total - resolvedBizImportPlan.counts.ready - resolvedBizImportPlan.counts.update}
              </strong>{" "}
              rows will NOT be imported because they remain unresolved.
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={cancelBizImport}>
              Cancel
            </Button>
            <Button
              onClick={confirmBizImport}
              disabled={bizImportBusy || !resolvedBizImportPlan || (resolvedBizImportPlan.counts.ready === 0 && resolvedBizImportPlan.counts.update === 0)}
              data-testid="biz-import-confirm"
            >
              Confirm Import ({(resolvedBizImportPlan?.counts.ready ?? 0) + (resolvedBizImportPlan?.counts.update ?? 0)} rows)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* reset demo confirm */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset demo data?</DialogTitle>
            <DialogDescription>This replaces all current data with a freshly generated demo city. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={resetDemo}>Reset</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* clear all confirm */}
      <Dialog open={clearOpen} onOpenChange={(v) => { setClearOpen(v); if (!v) setClearConfirmText(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear all data?</DialogTitle>
            <DialogDescription>Type DELETE to confirm. This permanently erases everything on this device and cannot be undone.</DialogDescription>
          </DialogHeader>
          <Input value={clearConfirmText} onChange={(e) => setClearConfirmText(e.target.value)} placeholder="DELETE" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={clearConfirmText !== "DELETE"} onClick={clearAll}>
              <Trash2 className="size-4" /> Clear everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RigFormDialog open={rigDialogOpen} onOpenChange={setRigDialogOpen} rig={rigTarget} />

      {toast && (
        <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-md border border-success/25 bg-success-bg text-success px-4 py-2.5 text-sm shadow-lg z-50">
          <CheckCircle2 className="size-4" /> {toast}
        </div>
      )}
    </div>
  );
}
