import { useMemo, useState } from "react";
import { CheckCircle2, RotateCcw, XCircle, AlertTriangle, Sparkles, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import { proposeDailyPlan, detectConflicts, scorePlan, type PlanResult } from "@/engine/planner";
import { buildRigSummary, isDeployable } from "@/engine/rigGuardian";
import { RIG_READINESS_EMOJI } from "@/engine/rigTaxonomy";
import { fmtTime, fmtDate } from "@/lib/dates";
import { EmptyState } from "@/components/shared/EmptyState";
import { ReplanPanel } from "./ReplanPanel";
import { cn } from "@/lib/utils";

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function Planner() {
  const data = useCity();
  const addAssignment = useCity((s) => s.addAssignment);
  const addPlan = useCity((s) => s.addPlan);
  const updatePlan = useCity((s) => s.updatePlan);
  const [date, setDate] = useState(tomorrowISO());
  const [result, setResult] = useState<PlanResult | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [published, setPublished] = useState(false);

  const alreadyPlanned = data.assignments.filter((a) => a.date === date && a.status !== "cancelled").length;

  function recalculate() {
    const proposal = proposeDailyPlan(data, date, data.settings);
    setResult(proposal);
    setRemoved(new Set());
    setPublished(false);
  }

  const visibleAssignments = useMemo(
    () =>
      result
        ? result.assignments
            .filter((a) => !removed.has(a.id))
            .sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime())
        : [],
    [result, removed],
  );

  // Recomputed live (not frozen from the original proposal) so manual FO/rig
  // edits immediately reflect in the score and conflict list — including
  // rig safety, which must never be silently stale.
  const liveConflicts = useMemo(() => detectConflicts(visibleAssignments, data, date), [visibleAssignments, data, date]);
  const live = useMemo(
    () => scorePlan(visibleAssignments, liveConflicts, data, data.settings.recordingHoursTargetPerDay),
    [visibleAssignments, liveConflicts, data],
  );
  const hasUnsafeRig = liveConflicts.some((c) => c.type === "rig_unsafe" || c.type === "rig_unavailable");

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

  function acceptPlan() {
    if (!result || hasUnsafeRig) return;
    for (const a of visibleAssignments) {
      addAssignment({
        date: a.date,
        businessId: a.businessId,
        foId: a.foId,
        collectorId: a.collectorId,
        rigId: a.rigId,
        plannedStart: a.plannedStart,
        plannedEnd: a.plannedEnd,
        priority: a.priority,
        status: "confirmed",
      });
    }
    const plan = addPlan({
      date,
      assignmentIds: visibleAssignments.map((a) => a.id),
      score: live.score,
      scoreBreakdown: live.breakdown,
      conflicts: liveConflicts,
    });
    updatePlan(plan.id, { publishedAt: new Date().toISOString() });
    setPublished(true);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Daily Planner</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted">Plan for date</label>
              <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setResult(null); }} className="w-44" />
            </div>
            <Button onClick={recalculate}>
              <Sparkles className="size-4" /> {result ? "Recalculate" : "Propose Plan"}
            </Button>
            {alreadyPlanned > 0 && (
              <span className="text-xs text-muted">{alreadyPlanned} assignment{alreadyPlanned === 1 ? "" : "s"} already exist for {fmtDate(date)}.</span>
            )}
          </div>

          {!result && (
            <EmptyState
              icon={Sparkles}
              title="No plan generated yet"
              description="Propose a plan and the planner will balance FO workload, respect business windows, and avoid conflicts automatically — never assigning a rig that isn't safe to deploy."
            />
          )}

          {result && (
            <>
              <div className="flex items-center gap-4 rounded-lg border border-border bg-surface-2/50 p-4">
                <div className="text-center shrink-0">
                  <div className="text-3xl font-bold tabular-nums">{live.score}</div>
                  <div className="text-[11px] text-muted">PLAN SCORE</div>
                </div>
                <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {live.breakdown.map((b, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      {b.delta < 0 ? (
                        <XCircle className="size-3.5 text-critical shrink-0" />
                      ) : (
                        <CheckCircle2 className="size-3.5 text-success shrink-0" />
                      )}
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

              <div className="rounded-lg border border-border divide-y divide-border">
                {visibleAssignments.length === 0 && (
                  <div className="p-6 text-center text-sm text-muted">No businesses left in this proposal.</div>
                )}
                {visibleAssignments.map((a) => {
                  const rigSummary = a.rigId ? rigSummaryMap.get(a.rigId) : undefined;
                  const rigUnsafe = rigSummary ? !isDeployable(rigSummary.readiness) : false;
                  return (
                    <div key={a.id} className="flex items-center gap-2 px-3 py-2.5 flex-wrap">
                      <span className="text-xs tabular-nums text-muted w-14 shrink-0">{fmtTime(a.plannedStart)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{bizMap.get(a.businessId)?.name}</div>
                        <div className="text-xs text-muted truncate">{bizMap.get(a.businessId)?.area}</div>
                      </div>
                      <Select
                        value={a.foId}
                        onValueChange={(v) => {
                          if (!result) return;
                          setResult({
                            ...result,
                            assignments: result.assignments.map((x) => (x.id === a.id ? { ...x, foId: v } : x)),
                          });
                        }}
                      >
                        <SelectTrigger className="w-32 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {data.fos.filter((f) => f.active).map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={a.rigId ?? "none"}
                        onValueChange={(v) => {
                          if (!result) return;
                          setResult({
                            ...result,
                            assignments: result.assignments.map((x) => (x.id === a.id ? { ...x, rigId: v === "none" ? undefined : v } : x)),
                          });
                        }}
                      >
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
                      {a.priority === "high" && <Badge variant="warning">High</Badge>}
                      <Button size="icon-sm" variant="ghost" onClick={() => setRemoved((s) => new Set(s).add(a.id))} title="Remove from plan">
                        <XCircle className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>

              {hasUnsafeRig && (
                <div className="flex items-center gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2.5 text-sm text-critical">
                  <ShieldAlert className="size-4 shrink-0" />
                  This plan assigns an unsafe rig. Swap it before you can publish.
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={recalculate}>
                  <RotateCcw className="size-4" /> Recalculate
                </Button>
                <Button onClick={acceptPlan} disabled={published || visibleAssignments.length === 0 || hasUnsafeRig}>
                  <CheckCircle2 className="size-4" /> {published ? "Plan published" : "Accept Plan"}
                </Button>
              </div>
              {published && (
                <div className="text-sm text-success flex items-center gap-1.5">
                  <CheckCircle2 className="size-4" /> {visibleAssignments.length} visits published for {fmtDate(date)}.
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ReplanPanel />
    </div>
  );
}
