import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  RotateCcw,
  XCircle,
  AlertTriangle,
  Sparkles,
  ShieldAlert,
  PlusCircle,
  Building2,
  Users,
  Radio,
  Target,
  BadgeCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import { proposeDailyPlan, detectConflicts, scorePlan, explainAssignments } from "@/engine/planner";
import { buildRigSummary, buildFleetReadiness, isDeployable } from "@/engine/rigGuardian";
import { RIG_READINESS_EMOJI } from "@/engine/rigTaxonomy";
import { AssignmentFormDialog } from "@/components/forms/AssignmentFormDialog";
import { fmtTime, fmtDate, fmtHours } from "@/lib/dates";
import { EmptyState } from "@/components/shared/EmptyState";
import { ReplanPanel } from "./ReplanPanel";
import { cn } from "@/lib/utils";
import type { Assignment } from "@/types";

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const CONFIDENCE_BADGE = { high: "success", medium: "warning", low: "critical" } as const;

/** Every assignment in this workspace is one of these three states relative
 * to the AI's own proposal — the "3 accepted / 1 rejected" counters in the
 * Plan Summary come directly from this, never a separate AI-side tally. */
type SuggestionOutcome = "accepted" | "edited" | "rejected" | "manual";

export function Planner() {
  const data = useCity();
  const addPlan = useCity((s) => s.addPlan);
  const updatePlan = useCity((s) => s.updatePlan);
  const approvePlan = useCity((s) => s.approvePlan);

  const [date, setDate] = useState(tomorrowISO());
  const [draft, setDraft] = useState<Assignment[]>([]);
  const [aiSuggestedIds, setAiSuggestedIds] = useState<Set<string>>(new Set());
  const [editedIds, setEditedIds] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [planId, setPlanId] = useState<string | null>(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignDialogDefaults, setAssignDialogDefaults] = useState<{ foId?: string } | undefined>(undefined);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [approvedNotice, setApprovedNotice] = useState(false);

  // Resume an existing draft for this date (survives navigating away and
  // back — DRAFT is real persisted state, not component-local scratch).
  useEffect(() => {
    const existing = [...data.plans].filter((p) => p.date === date && p.status !== "cancelled").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (existing && existing.status !== "approved" && existing.status !== "active" && existing.status !== "completed") {
      setPlanId(existing.id);
      setDraft(existing.draftAssignments ?? []);
      setAiSuggestedIds(new Set(existing.aiSuggestedIds ?? []));
      setEditedIds(new Set());
      setRemoved(new Set());
    } else {
      setPlanId(null);
      setDraft([]);
      setAiSuggestedIds(new Set());
      setEditedIds(new Set());
      setRemoved(new Set());
    }
    setSavedNotice(false);
    setApprovedNotice(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const alreadyActive = data.assignments.filter((a) => a.date === date && a.status !== "cancelled").length;

  function generateRecommendations() {
    const proposal = proposeDailyPlan(data, date, data.settings);
    setDraft(proposal.assignments);
    setAiSuggestedIds(new Set(proposal.assignments.map((a) => a.id)));
    setEditedIds(new Set());
    setRemoved(new Set());
    setSavedNotice(false);
    setApprovedNotice(false);
  }

  const visibleDraft = useMemo(
    () => draft.filter((a) => !removed.has(a.id)).sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime()),
    [draft, removed],
  );

  // Recomputed live from the CURRENT draft, never frozen from the original
  // proposal — a Manager's edits (FO swap, rig swap, added/removed rows)
  // immediately show their real conflicts, score, and reasoning.
  const liveConflicts = useMemo(() => detectConflicts(visibleDraft, data, date), [visibleDraft, data, date]);
  const live = useMemo(() => scorePlan(visibleDraft, liveConflicts, data, data.settings.recordingHoursTargetPerDay), [visibleDraft, liveConflicts, data]);
  const liveRecommendations = useMemo(
    () => explainAssignments(visibleDraft, data, liveConflicts, data.settings.recordingHoursTargetPerDay),
    [visibleDraft, liveConflicts, data],
  );
  const recommendationMap = useMemo(() => new Map(liveRecommendations.map((r) => [r.assignmentId, r])), [liveRecommendations]);

  const hasUnsafeRig = liveConflicts.some((c) => c.type === "rig_unsafe" || c.type === "rig_unavailable");
  const hasCriticalConflict = liveConflicts.some((c) => c.severity === "critical");

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const rigSummaries = useMemo(
    () =>
      data.rigs
        .filter((r) => r.deploymentStatus !== "retired")
        .map((r) => buildRigSummary(data, r))
        .sort((a, b) => b.score - a.score),
    [data],
  );
  const rigSummaryMap = new Map(rigSummaries.map((s) => [s.rig.id, s]));
  const fleetReadiness = useMemo(() => buildFleetReadiness(data, date, rigSummaries), [data, date, rigSummaries]);

  // ---- City Capacity ----
  const activeFOs = data.fos.filter((f) => f.active);
  const activeBusinesses = data.businesses.filter((b) => b.active);
  const targetHours = data.settings.recordingHoursTargetPerDay;
  const plannedHours = visibleDraft.reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);
  const coveragePct = targetHours > 0 ? Math.round((plannedHours / targetHours) * 100) : 0;

  // ---- Per-FO breakdown ----
  const byFO = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of visibleDraft) map.set(a.foId, [...(map.get(a.foId) ?? []), a]);
    return map;
  }, [visibleDraft]);

  // ---- Unassigned work / rigs ----
  const assignedBizIds = new Set(visibleDraft.map((a) => a.businessId));
  const unassignedBusinesses = activeBusinesses.filter((b) => !assignedBizIds.has(b.id) && !b.unavailableDates?.includes(date));
  const assignedRigIds = new Set(visibleDraft.map((a) => a.rigId).filter(Boolean));
  const unassignedRigs = rigSummaries.filter((s) => !assignedRigIds.has(s.rig.id));

  function outcomeFor(a: Assignment): SuggestionOutcome {
    if (!aiSuggestedIds.has(a.id)) return "manual";
    return editedIds.has(a.id) ? "edited" : "accepted";
  }
  const rejectedCount = [...draft].filter((a) => aiSuggestedIds.has(a.id) && removed.has(a.id)).length;
  const acceptedCount = visibleDraft.filter((a) => outcomeFor(a) === "accepted").length;
  const editedCount = visibleDraft.filter((a) => outcomeFor(a) === "edited").length;

  function patchAssignment(aid: string, patch: Partial<Assignment>) {
    setDraft((d) => d.map((x) => (x.id === aid ? { ...x, ...patch } : x)));
    setEditedIds((s) => new Set(s).add(aid));
  }

  function addManualAssignment(a: Assignment) {
    setDraft((d) => [...d, a]);
  }

  function persistDraft(status: "draft" = "draft") {
    if (planId) {
      updatePlan(planId, {
        status,
        draftAssignments: draft.filter((a) => !removed.has(a.id)),
        recommendations: liveRecommendations,
        aiSuggestedIds: [...aiSuggestedIds],
        score: live.score,
        scoreBreakdown: live.breakdown,
        conflicts: liveConflicts,
        updatedAt: new Date().toISOString(),
      });
      return planId;
    }
    const plan = addPlan({
      date,
      status,
      draftAssignments: draft.filter((a) => !removed.has(a.id)),
      recommendations: liveRecommendations,
      aiSuggestedIds: [...aiSuggestedIds],
      assignmentIds: [],
      score: live.score,
      scoreBreakdown: live.breakdown,
      conflicts: liveConflicts,
      createdBy: "You",
    });
    setPlanId(plan.id);
    return plan.id;
  }

  function saveDraft() {
    persistDraft("draft");
    setSavedNotice(true);
    setApprovedNotice(false);
  }

  function confirmApprove() {
    const pid = persistDraft("draft");
    approvePlan(pid, "You");
    setApproveDialogOpen(false);
    setApprovedNotice(true);
    setSavedNotice(false);
  }

  const hasDraft = draft.length > 0;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Plan {fmtDate(date)}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted">Plan for date</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
            </div>
            <Button onClick={generateRecommendations}>
              <Sparkles className="size-4" /> {hasDraft ? "Regenerate AI Recommendations" : "Generate AI Recommendations"}
            </Button>
            {alreadyActive > 0 && (
              <span className="text-xs text-muted">
                {alreadyActive} assignment{alreadyActive === 1 ? "" : "s"} already active for {fmtDate(date)}.
              </span>
            )}
          </div>

          {/* CITY CAPACITY */}
          <div className="rounded-lg border border-border bg-surface-2/50 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2 mb-3">City Capacity — {fmtDate(date)}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <CapacityStat icon={Building2} label="Businesses" value={activeBusinesses.length} />
              <CapacityStat icon={Users} label="Field Officers" value={activeFOs.length} />
              <CapacityStat icon={Radio} label="Healthy rigs" value={fleetReadiness.healthy} />
              <CapacityStat icon={ShieldAlert} label="Unavailable rigs" value={fleetReadiness.doNotDeploy} tone={fleetReadiness.doNotDeploy > 0 ? "warning" : undefined} />
              <CapacityStat icon={Target} label="Target hours" value={fmtHours(targetHours)} />
              <CapacityStat icon={Target} label="Planned hours" value={fmtHours(plannedHours)} />
              <CapacityStat icon={BadgeCheck} label="Coverage" value={`${coveragePct}%`} tone={coveragePct < 80 ? "warning" : "success"} />
              <CapacityStat icon={Radio} label="Available rigs" value={rigSummaries.filter((s) => s.deployable).length} />
            </div>
          </div>

          {!hasDraft && (
            <EmptyState
              icon={Sparkles}
              title="No plan generated yet"
              description="Generate AI recommendations and the planner will balance FO workload, respect business windows, and explain every suggestion — never assigning a rig that isn't safe to deploy. Nothing is finalized until you approve it."
            />
          )}

          {hasDraft && (
            <>
              {/* PLAN SCORE */}
              <div className="flex items-center gap-4 rounded-lg border border-border bg-surface-2/50 p-4">
                <div className="text-center shrink-0">
                  <div className="text-3xl font-bold tabular-nums">{live.score}</div>
                  <div className="text-[11px] text-muted">PLAN HEALTH</div>
                </div>
                <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {live.breakdown.map((b, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      {b.delta < 0 ? <XCircle className="size-3.5 text-critical shrink-0" /> : <CheckCircle2 className="size-3.5 text-success shrink-0" />}
                      <span className="text-muted">{b.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {liveConflicts.length > 0 && (
                <div className="space-y-1.5">
                  {liveConflicts.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2 text-xs">
                      <AlertTriangle className="size-3.5 text-critical shrink-0 mt-0.5" />
                      <span>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* FIELD OFFICERS */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Field Officers</div>
                {activeFOs.map((fo) => {
                  const rows = (byFO.get(fo.id) ?? []).sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime());
                  const foHours = rows.reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);
                  return (
                    <div key={fo.id} className="rounded-lg border border-border p-3 space-y-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <div className="text-sm font-medium">{fo.name}</div>
                          <div className="text-xs text-muted">
                            {fmtHours(foHours)} / {fmtHours(targetHours)} planned · {rows.length} rig{rows.length === 1 ? "" : "s"} assigned
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setAssignDialogDefaults({ foId: fo.id });
                            setAssignDialogOpen(true);
                          }}
                        >
                          <PlusCircle className="size-3.5" /> Assign Rig
                        </Button>
                      </div>

                      {rows.length === 0 && <div className="text-xs text-muted py-1">No assignments yet.</div>}

                      {rows.map((a) => {
                        const rigSummary = a.rigId ? rigSummaryMap.get(a.rigId) : undefined;
                        const rigUnsafe = rigSummary ? !isDeployable(rigSummary.readiness) : false;
                        const rec = recommendationMap.get(a.id);
                        const outcome = outcomeFor(a);
                        return (
                          <div key={a.id} className="rounded-md border border-border bg-surface p-2.5 space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs tabular-nums text-muted w-14 shrink-0">{fmtTime(a.plannedStart)}</span>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">{bizMap.get(a.businessId)?.name}</div>
                                <div className="text-xs text-muted truncate">{bizMap.get(a.businessId)?.area}</div>
                              </div>
                              <Select value={a.rigId ?? "none"} onValueChange={(v) => patchAssignment(a.id, { rigId: v === "none" ? undefined : v })}>
                                <SelectTrigger className={cn("w-32 h-8 text-xs", rigUnsafe && "border-critical text-critical")}>
                                  <SelectValue placeholder="No rig" />
                                </SelectTrigger>
                                <SelectContent>
                                  {rigSummaries.map((s) => (
                                    <SelectItem key={s.rig.id} value={s.rig.id}>
                                      {RIG_READINESS_EMOJI[s.readiness]} {s.rig.code} {s.readiness === "healthy" ? "· Ready" : `· ${s.score}/100`}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {outcome !== "manual" && (
                                <Badge variant={outcome === "edited" ? "warning" : "primary"} className="shrink-0">
                                  {outcome === "edited" ? "AI · edited" : "AI recommendation"}
                                </Badge>
                              )}
                              <Button size="icon-sm" variant="ghost" onClick={() => setRemoved((s) => new Set(s).add(a.id))} title="Remove">
                                <XCircle className="size-4" />
                              </Button>
                            </div>
                            {rec && rec.why.length > 0 && (
                              <div className="flex items-start gap-1.5 pl-16 text-[11px] text-muted">
                                <Badge variant={CONFIDENCE_BADGE[rec.confidence]} className="shrink-0 uppercase">
                                  {rec.confidence}
                                </Badge>
                                <span>
                                  {rec.why.join(" · ")}
                                  {rec.risk ? ` — Risk: ${rec.risk}` : ""}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* UNASSIGNED WORK */}
              {unassignedBusinesses.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Unassigned work</div>
                  {unassignedBusinesses.map((b) => (
                    <div key={b.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <div>
                        <div className="font-medium">{b.name}</div>
                        <div className="text-xs text-muted">{b.capacityHoursPerDay}h target · No FO assigned</div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setAssignDialogDefaults(undefined);
                          setAssignDialogOpen(true);
                        }}
                      >
                        <PlusCircle className="size-3.5" /> Assign
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* UNASSIGNED RIGS */}
              {unassignedRigs.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Unassigned rigs</div>
                  <div className="flex flex-wrap gap-1.5">
                    {unassignedRigs.map((s) => (
                      <Badge key={s.rig.id} variant={s.readiness === "healthy" ? "success" : s.deployable ? "warning" : "critical"}>
                        {RIG_READINESS_EMOJI[s.readiness]} {s.rig.code}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {hasUnsafeRig && (
                <div className="flex items-center gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2.5 text-sm text-critical">
                  <ShieldAlert className="size-4 shrink-0" />
                  This plan assigns a rig that isn't ready. Swap it before you can approve.
                </div>
              )}

              {/* PLAN SUMMARY */}
              <div className="rounded-lg border border-border p-4 space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Plan Summary</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div>
                    <div className="text-lg font-semibold tabular-nums">{visibleDraft.length}</div>
                    <div className="text-xs text-muted">assignments</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold tabular-nums">{new Set(visibleDraft.map((a) => a.foId)).size}</div>
                    <div className="text-xs text-muted">FOs</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold tabular-nums">{new Set(visibleDraft.map((a) => a.rigId).filter(Boolean)).size}</div>
                    <div className="text-xs text-muted">rigs</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold tabular-nums">{fmtHours(plannedHours)}</div>
                    <div className="text-xs text-muted">{coveragePct}% target coverage</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted pt-1 border-t border-border">
                  <span>
                    Risks: {liveConflicts.filter((c) => c.severity === "critical").length} critical, {liveConflicts.filter((c) => c.severity === "warning").length} medium
                  </span>
                  <span>
                    AI suggestions: {acceptedCount} accepted, {editedCount} edited, {rejectedCount} rejected
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={generateRecommendations}>
                  <RotateCcw className="size-4" /> Recalculate
                </Button>
                <Button variant="secondary" onClick={saveDraft}>
                  Save Draft
                </Button>
                <Button onClick={() => setApproveDialogOpen(true)} disabled={visibleDraft.length === 0 || hasUnsafeRig || hasCriticalConflict}>
                  <CheckCircle2 className="size-4" /> Approve {fmtDate(date)}'s Plan
                </Button>
              </div>
              {savedNotice && (
                <div className="text-sm text-muted flex items-center gap-1.5">
                  <CheckCircle2 className="size-4" /> Draft saved — nothing is visible to Field Officers yet.
                </div>
              )}
              {approvedNotice && (
                <div className="text-sm text-success flex items-center gap-1.5">
                  <CheckCircle2 className="size-4" /> {visibleDraft.length} assignments approved for {fmtDate(date)} — Field Officers can now see their own.
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ReplanPanel />

      <AssignmentFormDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        date={date}
        existingAssignments={visibleDraft}
        defaults={assignDialogDefaults}
        onCreate={addManualAssignment}
      />

      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Approve {fmtDate(date)} plan?</DialogTitle>
            <DialogDescription>
              This will make the plan active for Field Officers. {visibleDraft.length} assignment{visibleDraft.length === 1 ? "" : "s"} across{" "}
              {new Set(visibleDraft.map((a) => a.foId)).size} FO{new Set(visibleDraft.map((a) => a.foId)).size === 1 ? "" : "s"} will become visible immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmApprove}>Approve Plan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CapacityStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  tone?: "warning" | "success";
}) {
  const toneClass = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-foreground";
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2">
      <Icon className="size-4 text-muted shrink-0" />
      <div>
        <div className={cn("text-sm font-semibold tabular-nums", toneClass)}>{value}</div>
        <div className="text-[10px] text-muted">{label}</div>
      </div>
    </div>
  );
}
