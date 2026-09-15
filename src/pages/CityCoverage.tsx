import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, Store, Users, AlertTriangle, ShieldCheck, Radar } from "lucide-react";
import { useCity } from "@/store/city";
import { PageHeader } from "@/components/shared/PageHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { SEVERITY_META } from "@/components/status";
import { cn } from "@/lib/utils";
import { todayISO, fmtDateTime } from "@/lib/dates";
import {
  mappableBusinesses,
  foLastKnownLocations,
  projectPoints,
  cityBusinessStatuses,
  CITY_STATUS_META,
  formatLocationAge,
  identifyBusinessesNeedingAttention,
  findBackupCandidatesForRecoveryItem,
  type CityBusinessStatus,
  type CityRecoverySeverity,
  type CityRecoveryItem,
} from "@/engine/cityCoverage";
import type { Severity } from "@/types";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 420;
const STATUS_FILTERS: Array<CityBusinessStatus | "all"> = ["all", "assigned", "at_risk", "completed", "unavailable", "unassigned"];
const RECOVERY_SEVERITY_FILTERS: Array<CityRecoverySeverity | "all"> = ["all", "critical", "high", "medium"];

const STATUS_BADGE_VARIANT: Record<CityBusinessStatus, "success" | "warning" | "critical" | "info" | "neutral" | "default"> = {
  assigned: "info",
  at_risk: "warning",
  completed: "success",
  unavailable: "critical",
  unassigned: "neutral",
  unknown: "default",
};

/** Recovery Radar's three severities reuse the existing app-wide
 * Severity vocabulary's colors/emoji (components/status.tsx's
 * SEVERITY_META) rather than inventing new ones — only the label text is
 * overridden (CRITICAL/HIGH/MEDIUM) to match this feature's own severity
 * names; "warning"/"attention" remain purely internal color-token names,
 * never shown to a Manager. */
const RECOVERY_SEVERITY_TO_APP_SEVERITY: Record<CityRecoverySeverity, Severity> = { critical: "critical", high: "warning", medium: "attention" };
const RECOVERY_SEVERITY_META: Record<CityRecoverySeverity, { label: string; emoji: string; badgeClass: string; textClass: string }> = {
  critical: { ...SEVERITY_META[RECOVERY_SEVERITY_TO_APP_SEVERITY.critical], label: "Critical" },
  high: { ...SEVERITY_META[RECOVERY_SEVERITY_TO_APP_SEVERITY.high], label: "High" },
  medium: { ...SEVERITY_META[RECOVERY_SEVERITY_TO_APP_SEVERITY.medium], label: "Medium" },
};

/** "1.8 km straight-line" / "450m straight-line" — always explicitly
 * labeled straight-line, never phrased in a way that could be read as
 * driving distance/time. */
function formatStraightLineDistance(meters: number): string {
  const label = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters}m`;
  return `${label} straight-line`;
}

type Selection = { kind: "business"; id: string } | { kind: "fo"; id: string } | null;

/** Manager-only operational map — Phase C ("operational layers"): business
 * markers carry a transparent, evidence-backed status (see
 * engine/cityCoverage.ts's deriveBusinessStatus — every status/reason is
 * traced to a real Assignment/Issue/Business field, never a spreadsheet-
 * only concept), and FOs get their own, visually distinct marker sourced
 * ONLY from their latest valid location Evidence — always labeled "last
 * known location" with a captured-at age, never "live". No marker is ever
 * fabricated: a business without resolvable coordinates, or an FO with no
 * valid location evidence, simply has no marker.
 *
 * No assignment is ever read-written here — every value shown is a pure
 * read via useCity(); there is no mutation path on this page at all. */
export default function CityCoverage() {
  const data = useCity();
  const navigate = useNavigate();
  const today = todayISO();

  const [statusFilter, setStatusFilter] = useState<CityBusinessStatus | "all">("all");
  const [showBusinesses, setShowBusinesses] = useState(true);
  const [showFos, setShowFos] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [recoverySeverityFilter, setRecoverySeverityFilter] = useState<CityRecoverySeverity | "all">("all");
  const [backupReviewItem, setBackupReviewItem] = useState<CityRecoveryItem | null>(null);

  const statuses = useMemo(() => cityBusinessStatuses(data, today), [data, today]);
  const allMappable = useMemo(() => mappableBusinesses(data.businesses), [data.businesses]);
  const missingLocationCount = data.businesses.length - allMappable.length;

  const visibleBusinesses = useMemo(() => {
    if (!showBusinesses) return [];
    return allMappable.filter((m) => statusFilter === "all" || statuses.get(m.business.id)?.status === statusFilter);
  }, [allMappable, statusFilter, statuses, showBusinesses]);

  const allFoLocations = useMemo(() => foLastKnownLocations(data), [data]);
  const visibleFoLocations = showFos ? allFoLocations : [];
  const foById = useMemo(() => new Map(data.fos.map((f) => [f.id, f])), [data.fos]);
  const bizById = useMemo(() => new Map(data.businesses.map((b) => [b.id, b])), [data.businesses]);

  const points = useMemo(
    () =>
      projectPoints(
        [...visibleBusinesses.map((m) => ({ lat: m.lat, lng: m.lng })), ...visibleFoLocations.map((f) => ({ lat: f.lat, lng: f.lng }))],
        VIEW_WIDTH,
        VIEW_HEIGHT,
      ),
    [visibleBusinesses, visibleFoLocations],
  );
  const businessPoints = points.slice(0, visibleBusinesses.length);
  const foPoints = points.slice(visibleBusinesses.length);

  const statusCounts = useMemo(() => {
    const counts: Record<CityBusinessStatus, number> = { assigned: 0, at_risk: 0, completed: 0, unavailable: 0, unassigned: 0, unknown: 0 };
    for (const result of statuses.values()) counts[result.status]++;
    return counts;
  }, [statuses]);
  // "Backup ready" = operationally eligible to be considered as a backup
  // right now — the exact same condition rankBackupCandidates() itself
  // uses (status "unassigned" or "completed"), never a fabricated status.
  const backupReadyCount = statusCounts.unassigned + statusCounts.completed;

  // DETECT + EXPLAIN only, from real Assignment/Issue/Business state — see
  // engine/cityCoverage.ts's deriveBusinessStatus()/
  // identifyBusinessesNeedingAttention(). Never mutates anything; the
  // Manager reviews and acts through the existing assignment workflow.
  const recoveryItems = useMemo(() => identifyBusinessesNeedingAttention(data, today), [data, today]);
  const filteredRecoveryItems = useMemo(
    () => recoveryItems.filter((item) => recoverySeverityFilter === "all" || item.severity === recoverySeverityFilter),
    [recoveryItems, recoverySeverityFilter],
  );
  // Ranked backups precomputed per recovery item, purely for display (the
  // card's "Recommended backup" preview and the Review Backup dialog) —
  // read-only, like everything else on this page.
  const recoveryBackups = useMemo(() => {
    const map = new Map<string, ReturnType<typeof findBackupCandidatesForRecoveryItem>>();
    for (const item of recoveryItems) map.set(item.businessId, findBackupCandidatesForRecoveryItem(data, item, today));
    return map;
  }, [recoveryItems, data, today]);

  const selectedBusiness = selection?.kind === "business" ? bizById.get(selection.id) : undefined;
  const selectedBusinessStatus = selectedBusiness ? statuses.get(selectedBusiness.id) : undefined;
  const selectedFoLocation = selection?.kind === "fo" ? allFoLocations.find((f) => f.foId === selection.id) : undefined;
  const selectedFo = selectedFoLocation ? foById.get(selectedFoLocation.foId) : undefined;
  const selectedFoBusiness = selectedFoLocation?.businessId ? bizById.get(selectedFoLocation.businessId) : undefined;

  return (
    <div className="pb-10">
      <PageHeader title="City Coverage" subtitle="Manager-only operational map of businesses and field officers' last known locations." />

      <div className="px-4 md:px-6 pt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Businesses" value={data.businesses.length} icon={Store} />
        <KpiCard label="On Map" value={allMappable.length} icon={MapPin} tone="success" />
        <KpiCard label="Missing Location" value={missingLocationCount} icon={MapPin} tone={missingLocationCount > 0 ? "warning" : "default"} />
        <KpiCard label="Recovery Required" value={recoveryItems.length} icon={AlertTriangle} tone={recoveryItems.length > 0 ? "warning" : "default"} />
        <KpiCard label="Backup Ready" value={backupReadyCount} icon={ShieldCheck} tone={backupReadyCount > 0 ? "success" : "default"} />
        <KpiCard label="FOs Located" value={allFoLocations.length} icon={Users} sub={`of ${data.fos.length} field officer${data.fos.length === 1 ? "" : "s"}`} />
      </div>

      <div className="px-4 md:px-6 pt-5 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as CityBusinessStatus | "all")}>
          <TabsList>
            {STATUS_FILTERS.map((s) => (
              <TabsTrigger key={s} value={s}>
                {s === "all" ? "All" : CITY_STATUS_META[s].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-4 text-xs">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch checked={showBusinesses} onCheckedChange={setShowBusinesses} data-testid="toggle-businesses-layer" />
            Businesses
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch checked={showFos} onCheckedChange={setShowFos} data-testid="toggle-fo-layer" />
            Field Officers
          </label>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card>
          {visibleBusinesses.length === 0 && visibleFoLocations.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="Nothing to show on the map"
              description="Adjust the filters above, or add a location to a business to place it on the map. City Coverage never invents a marker for a business or field officer that doesn't have one."
            />
          ) : (
            <div className="p-4">
              <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="w-full h-auto rounded-md bg-surface-2 border border-border" role="img" aria-label="City Coverage map">
                {visibleBusinesses.map((m, i) => {
                  const p = businessPoints[i];
                  const status = statuses.get(m.business.id);
                  const meta = CITY_STATUS_META[status?.status ?? "unknown"];
                  const isSelected = selection?.kind === "business" && selection.id === m.business.id;
                  return (
                    <g
                      key={m.business.id}
                      data-testid="city-coverage-business-marker"
                      data-business-id={m.business.id}
                      data-coord-source={m.coordSource}
                      data-status={status?.status}
                      role="button"
                      tabIndex={0}
                      aria-label={`${m.business.name} — ${meta.label}`}
                      onClick={() => setSelection({ kind: "business", id: m.business.id })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelection({ kind: "business", id: m.business.id });
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      <title>{`${m.business.name} — ${meta.label}`}</title>
                      <circle cx={p.x} cy={p.y} r={isSelected ? 8 : 6} className={cn(meta.dot.replace("bg-", "fill-"), "stroke-surface")} strokeWidth={isSelected ? 2.5 : 1.5} />
                    </g>
                  );
                })}
                {visibleFoLocations.map((f, i) => {
                  const p = foPoints[i];
                  const fo = foById.get(f.foId);
                  const isSelected = selection?.kind === "fo" && selection.id === f.foId;
                  const half = isSelected ? 7 : 5;
                  return (
                    <g
                      key={f.foId}
                      data-testid="city-coverage-fo-marker"
                      data-fo-id={f.foId}
                      role="button"
                      tabIndex={0}
                      aria-label={`${fo?.name ?? "Field Officer"} — last known location`}
                      onClick={() => setSelection({ kind: "fo", id: f.foId })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelection({ kind: "fo", id: f.foId });
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      <title>{`${fo?.name ?? "Field Officer"} — last known location`}</title>
                      {/* A rotated square (diamond), never a circle — keeps FO
                          markers unambiguously distinct from business
                          markers by shape, not color alone. */}
                      <rect x={p.x - half} y={p.y - half} width={half * 2} height={half * 2} transform={`rotate(45 ${p.x} ${p.y})`} className="fill-primary stroke-surface" strokeWidth={isSelected ? 2.5 : 1.5} />
                    </g>
                  );
                })}
              </svg>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-muted" data-testid="city-coverage-legend">
                {(Object.keys(CITY_STATUS_META) as CityBusinessStatus[])
                  .filter((s) => s !== "unknown")
                  .map((s) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className={cn("inline-block size-2.5 rounded-full", CITY_STATUS_META[s].dot)} />
                      {CITY_STATUS_META[s].label}
                    </span>
                  ))}
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 bg-primary" style={{ transform: "rotate(45deg)" }} />
                  Field Officer (last known location)
                </span>
              </div>
              <div className="text-xs text-muted mt-2">
                {visibleBusinesses.length} business{visibleBusinesses.length === 1 ? "" : "es"} · {visibleFoLocations.length} field officer{visibleFoLocations.length === 1 ? "" : "s"} shown — straight-line
                positions only, not a routed street map.
              </div>
            </div>
          )}
        </Card>

        <Card>
          <div className="p-4">
            {!selection && <div className="text-sm text-muted">Select a marker to see details.</div>}

            {selectedBusiness && selectedBusinessStatus && (
              <div className="space-y-3" data-testid="city-coverage-business-detail">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold">{selectedBusiness.name}</div>
                  <Badge variant={STATUS_BADGE_VARIANT[selectedBusinessStatus.status]}>{CITY_STATUS_META[selectedBusinessStatus.status].label}</Badge>
                </div>
                {(selectedBusiness.area || selectedBusiness.address) && (
                  <div className="text-xs text-muted">{[selectedBusiness.area, selectedBusiness.address].filter(Boolean).join(" · ")}</div>
                )}
                {selectedBusiness.category && <div className="text-xs text-muted">{selectedBusiness.category}</div>}
                {selectedBusinessStatus.reason && <div className="text-xs">{selectedBusinessStatus.reason}</div>}
                <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border">
                  <div>
                    <div className="text-muted">Rigs today</div>
                    <div className="font-medium tabular-nums">{selectedBusinessStatus.rigCount}</div>
                  </div>
                  <div>
                    <div className="text-muted">Assignments today</div>
                    <div className="font-medium tabular-nums">{selectedBusinessStatus.assignmentIds.length}</div>
                  </div>
                  {selectedBusinessStatus.targetHours > 0 && (
                    <>
                      <div>
                        <div className="text-muted">Target hours</div>
                        <div className="font-medium tabular-nums">{selectedBusinessStatus.targetHours}h</div>
                      </div>
                      <div>
                        <div className="text-muted">Recorded</div>
                        <div className="font-medium tabular-nums">{selectedBusinessStatus.recordedHours.toFixed(1)}h</div>
                      </div>
                    </>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => navigate(`/businesses/${selectedBusiness.id}`)}>
                  Open Business 360
                </Button>
              </div>
            )}

            {selectedFo && selectedFoLocation && (
              <div className="space-y-3" data-testid="city-coverage-fo-detail">
                <div className="text-sm font-semibold">{selectedFo.name}</div>
                <div>
                  <div className="text-xs font-medium text-muted">Last known location</div>
                  <div className="text-xs mt-0.5">
                    {fmtDateTime(selectedFoLocation.capturedAt)} · {formatLocationAge(selectedFoLocation.capturedAt)}
                  </div>
                </div>
                {selectedFoBusiness && <div className="text-xs text-muted">Recorded near {selectedFoBusiness.name}</div>}
                <Button size="sm" variant="secondary" onClick={() => navigate(`/field-officers/${selectedFo.id}`)}>
                  Open FO profile
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="px-4 md:px-6 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-2">
            <Radar className="size-4 text-muted-2" />
            <h2 className="text-sm font-semibold">Recovery Radar</h2>
          </div>
          {recoveryItems.length > 0 && (
            <Tabs value={recoverySeverityFilter} onValueChange={(v) => setRecoverySeverityFilter(v as CityRecoverySeverity | "all")}>
              <TabsList>
                {RECOVERY_SEVERITY_FILTERS.map((s) => (
                  <TabsTrigger key={s} value={s}>
                    {s === "all" ? "All" : RECOVERY_SEVERITY_META[s].label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        </div>

        {recoveryItems.length === 0 ? (
          <Card>
            <EmptyState icon={ShieldCheck} title="City looks stable" description="0 businesses currently require recovery attention." />
          </Card>
        ) : (
          <div className="space-y-2.5" data-testid="recovery-radar-list">
            {filteredRecoveryItems.map((item) => {
              const business = bizById.get(item.businessId);
              if (!business) return null;
              const meta = RECOVERY_SEVERITY_META[item.severity];
              const backupResult = recoveryBackups.get(item.businessId);
              const topCandidate = backupResult?.candidates[0];
              const topCandidateBusiness = topCandidate ? bizById.get(topCandidate.businessId) : undefined;
              return (
                <Card key={item.businessId} data-testid="recovery-radar-item" data-business-id={item.businessId} data-severity={item.severity}>
                  <div className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{business.name}</div>
                        <div className="text-xs text-muted mt-0.5">
                          {item.rigCount} rig{item.rigCount === 1 ? "" : "s"}
                          {item.targetHours > 0 ? ` · ${item.targetHours}h target` : ""}
                          {item.targetHours > 0 ? ` · ${item.recordedHours.toFixed(1)}h recorded` : ""}
                        </div>
                      </div>
                      <span
                        className={cn("inline-flex items-center gap-1 shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border", meta.badgeClass)}
                        aria-label={`Severity: ${meta.label}`}
                      >
                        {meta.emoji} {meta.label}
                      </span>
                    </div>

                    <div className="text-xs">
                      {item.reason}
                      {item.affectedRigCount > 0 && item.affectedRigCount < item.rigCount ? ` (${item.affectedRigCount} of ${item.rigCount} rigs)` : ""}
                    </div>

                    {topCandidate && topCandidateBusiness ? (
                      <div className="rounded-md bg-surface-2 p-2.5 text-xs" data-testid="recovery-item-top-backup">
                        <div className="font-medium text-muted">Recommended backup</div>
                        <div className="mt-0.5">
                          {topCandidateBusiness.name} · {formatStraightLineDistance(topCandidate.distanceMeters)}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-muted italic" data-testid="recovery-item-no-backup">
                        No eligible backup business found from available production data.
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" variant="outline" onClick={() => navigate(`/businesses/${item.businessId}`)}>
                        View Business
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setBackupReviewItem(item)}>
                        Review Backup
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
            {filteredRecoveryItems.length === 0 && (
              <Card>
                <EmptyState icon={ShieldCheck} title="No items at this severity" description="Try a different filter above." />
              </Card>
            )}
          </div>
        )}
      </div>

      <Dialog open={!!backupReviewItem} onOpenChange={(open) => !open && setBackupReviewItem(null)}>
        <DialogContent className="max-w-lg" data-testid="backup-review-dialog">
          <DialogHeader>
            <DialogTitle>Review Backup</DialogTitle>
            <DialogDescription>Source business, why it needs recovery, and eligible backup candidates ranked by straight-line distance.</DialogDescription>
          </DialogHeader>
          {backupReviewItem &&
            (() => {
              const business = bizById.get(backupReviewItem.businessId);
              const result = recoveryBackups.get(backupReviewItem.businessId);
              return (
                <div className="space-y-4">
                  <div data-testid="backup-review-source">
                    <div className="text-xs font-medium text-muted uppercase tracking-wide">Source business</div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <div className="text-sm font-semibold">{business?.name}</div>
                      <Badge variant={STATUS_BADGE_VARIANT[backupReviewItem.status]}>{CITY_STATUS_META[backupReviewItem.status].label}</Badge>
                    </div>
                    {business?.area && <div className="text-xs text-muted mt-0.5">{business.area}</div>}
                    <div className="text-xs mt-1.5">{backupReviewItem.reason}</div>
                    <div className="grid grid-cols-3 gap-2 text-xs pt-2 mt-2 border-t border-border">
                      <div>
                        <div className="text-muted">Rigs affected</div>
                        <div className="font-medium tabular-nums">
                          {backupReviewItem.affectedRigCount} of {backupReviewItem.rigCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted">Target</div>
                        <div className="font-medium tabular-nums">{backupReviewItem.targetHours}h</div>
                      </div>
                      <div>
                        <div className="text-muted">Recorded</div>
                        <div className="font-medium tabular-nums">{backupReviewItem.recordedHours.toFixed(1)}h</div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-muted uppercase tracking-wide mb-2">Backup options</div>
                    {result && result.candidates.length > 0 ? (
                      <div className="space-y-2" data-testid="backup-candidate-list">
                        {result.candidates.slice(0, 5).map((c, i) => {
                          const candidateBusiness = bizById.get(c.businessId);
                          return (
                            <button
                              key={c.businessId}
                              type="button"
                              data-testid="backup-candidate-row"
                              data-business-id={c.businessId}
                              onClick={() => setSelection({ kind: "business", id: c.businessId })}
                              className="w-full text-left rounded-md border border-border p-2.5 text-xs hover:bg-surface-2 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">
                                  #{i + 1} {candidateBusiness?.name}
                                </span>
                                <span className="tabular-nums text-muted shrink-0">{formatStraightLineDistance(c.distanceMeters)}</span>
                              </div>
                              <div className="mt-1.5 space-y-0.5">
                                {c.checks.map((chk) => (
                                  <div key={chk.label} className={chk.passed ? "text-success" : "text-critical"}>
                                    {chk.passed ? "✓" : "✗"} {chk.label}
                                  </div>
                                ))}
                              </div>
                            </button>
                          );
                        })}
                        {result.referencePointSource && (
                          <div className="text-[11px] text-muted pt-1">
                            Distance measured from {result.referencePointSource === "fo_last_known" ? "the assigned field officer's last known location" : `${business?.name}'s own location`} —
                            straight-line, not driving distance.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted italic" data-testid="backup-no-candidates">
                        No eligible backup business found from available production data.
                      </div>
                    )}
                  </div>

                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setBackupReviewItem(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setBackupReviewItem(null);
                        navigate("/today?tab=planner");
                      }}
                    >
                      Open Assignment Planner
                    </Button>
                  </DialogFooter>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
