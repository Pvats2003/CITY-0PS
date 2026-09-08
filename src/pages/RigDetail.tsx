import { useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, Pencil, AlertTriangle, TrendingDown, Wrench, ShieldQuestion, ClipboardList, Archive, XCircle } from "lucide-react";
import { useCity } from "@/store/city";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { RigHealthCard } from "@/components/rigs/RigHealthCard";
import { RigReadinessBadge } from "@/components/rigs/RigReadinessBadge";
import { RigFormDialog } from "@/components/forms/RigFormDialog";
import { RigIncidentFormDialog } from "@/components/forms/RigIncidentFormDialog";
import { RepairRecordFormDialog } from "@/components/forms/RepairRecordFormDialog";
import { PostRepairTestDialog } from "@/components/forms/PostRepairTestDialog";
import { fmtDateTime, fmtHours } from "@/lib/dates";
import { buildRigSummary, assessRetirement } from "@/engine/rigGuardian";
import { advanceRigIncidentStatus, retireRig, setRigStatusOverride } from "@/engine/workflows";
import { categoryLabel, DISCOVERY_STAGE_LABELS, RIG_DEPLOYMENT_STATUS_LABELS, RIG_INCIDENT_STATUS_LABELS, RIG_READINESS_LABELS } from "@/engine/rigTaxonomy";
import type { RigIncident, RigReadinessStatus } from "@/types";

export default function RigDetail() {
  const { id } = useParams();
  const data = useCity();
  const rig = data.rigs.find((r) => r.id === id);

  const [editOpen, setEditOpen] = useState(false);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [repairIncident, setRepairIncident] = useState<RigIncident | null>(null);
  const [testRepairId, setTestRepairId] = useState<string | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<RigReadinessStatus | "none">("none");
  const [overrideReason, setOverrideReason] = useState("");

  const summary = useMemo(() => (rig ? buildRigSummary(data, rig) : null), [data, rig]);
  const retirement = useMemo(() => (rig && summary ? assessRetirement(data, rig, summary) : null), [data, rig, summary]);
  const incidents = useMemo(
    () => data.rigIncidents.filter((i) => i.rigId === id).sort((a, b) => new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime()),
    [data.rigIncidents, id],
  );
  const repairs = useMemo(
    () => data.repairRecords.filter((r) => r.rigId === id).sort((a, b) => new Date(b.repairedAt).getTime() - new Date(a.repairedAt).getTime()),
    [data.repairRecords, id],
  );
  const events = useMemo(
    () => data.activity.filter((e) => e.rigId === id).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [data.activity, id],
  );

  if (!rig || !summary) return <Navigate to="/fleet" replace />;

  function applyOverride() {
    setRigStatusOverride(rig!.id, overrideStatus === "none" ? undefined : overrideStatus, overrideReason.trim() || undefined);
    setOverrideStatus("none");
    setOverrideReason("");
  }

  function handleRetire() {
    if (window.confirm(`Retire ${rig!.code}? It will be excluded from all future assignments.`)) {
      retireRig(rig!.id, "Retired from Rig 360.");
    }
  }

  return (
    <div className="pb-10">
      <div className="px-4 md:px-6 pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/fleet">
            <ArrowLeft className="size-4" /> Fleet
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-2 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold tracking-tight">{rig.code}</h1>
            <RigReadinessBadge status={summary.readiness} />
            {summary.overridden && <span className="text-[11px] text-warning">(manual override)</span>}
          </div>
          <p className="text-sm text-muted mt-0.5">
            {rig.model} &middot; {RIG_DEPLOYMENT_STATUS_LABELS[rig.deploymentStatus]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {rig.deploymentStatus !== "retired" && (
            <Button size="sm" variant="secondary" onClick={() => setIncidentOpen(true)}>
              <AlertTriangle className="size-4" /> Report Incident
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Edit
          </Button>
          {rig.deploymentStatus !== "retired" && (
            <Button size="sm" variant="destructive" onClick={handleRetire}>
              <Archive className="size-4" /> Retire
            </Button>
          )}
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Rig Health</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <RigHealthCard summary={summary} />
            </CardContent>
          </Card>

          {summary.repeatedFailures.length > 0 && (
            <Card className="border-critical/25">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-critical">
                  <TrendingDown className="size-4" /> Repeated Failure Pattern
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {summary.repeatedFailures.map((p, i) => (
                  <div key={i} className="rounded-md border border-critical/20 bg-critical-bg p-3 text-sm">
                    <div className="font-medium text-critical">{p.message}</div>
                    <div className="text-xs text-muted mt-1">Recommendation: {p.recommendation}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Damage &amp; Incident Timeline</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {incidents.length === 0 ? (
                <div className="text-sm text-muted py-6 text-center">No incidents recorded for this rig.</div>
              ) : (
                <div className="space-y-3">
                  {incidents.map((i) => (
                    <IncidentRow key={i.id} incident={i} onRepair={() => setRepairIncident(i)} onTest={() => i.repairRecordId && setTestRepairId(i.repairRecordId)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {repairs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Repair History</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                {repairs.map((r) => (
                  <div key={r.id} className="rounded-md border border-border p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.repairAction}</span>
                      <span className={`text-xs font-medium ${r.testResult === "pass" ? "text-success" : r.testResult === "fail" ? "text-critical" : "text-muted"}`}>
                        {r.testResult === "pass" ? "Test passed" : r.testResult === "fail" ? "Test failed" : "Awaiting test"}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{r.diagnosis}</div>
                    {r.parts && <div className="text-xs text-muted-2">Parts: {r.parts}</div>}
                    <div className="text-[11px] text-muted-2">{fmtDateTime(r.repairedAt)}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ActivityTimeline events={events} groupByDay emptyLabel="No activity recorded yet for this rig." />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Lost Recording Hours</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 grid grid-cols-3 gap-2 text-center">
              <MiniStat label="Today" value={fmtHours(summary.lostHours.today)} />
              <MiniStat label="This week" value={fmtHours(summary.lostHours.week)} />
              <MiniStat label="This month" value={fmtHours(summary.lostHours.month)} />
            </CardContent>
          </Card>

          {summary.inspection.required && (
            <Card className="border-warning/25">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-warning">
                  <ClipboardList className="size-4" /> Inspection Required
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="text-xs text-muted space-y-1 list-disc pl-4">
                  {summary.inspection.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {retirement && (
            <Card className={retirement.recommend ? "border-critical/25" : undefined}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldQuestion className="size-4" /> Retire vs Repair
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                <div className={`text-sm font-semibold ${retirement.recommend ? "text-critical" : "text-success"}`}>{retirement.label}</div>
                <ul className="text-xs text-muted space-y-1 list-disc pl-4">
                  {retirement.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Manual Status Override</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2.5">
              {rig.statusOverride && (
                <div className="text-xs rounded-md bg-warning-bg border border-warning/20 px-2.5 py-2 text-warning">
                  Currently overridden to {RIG_READINESS_LABELS[rig.statusOverride]}
                  {rig.statusOverrideReason && ` — ${rig.statusOverrideReason}`}.
                  <button className="ml-2 underline" onClick={() => setRigStatusOverride(rig.id, undefined)}>
                    Clear
                  </button>
                </div>
              )}
              <Select value={overrideStatus} onValueChange={(v) => setOverrideStatus(v as RigReadinessStatus | "none")}>
                <SelectTrigger>
                  <SelectValue placeholder="Set status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No override</SelectItem>
                  {(Object.keys(RIG_READINESS_LABELS) as RigReadinessStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {RIG_READINESS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="space-y-1.5">
                <Label htmlFor="override-reason">Reason</Label>
                <Input id="override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why override?" />
              </div>
              <Button size="sm" variant="secondary" className="w-full" onClick={applyOverride} disabled={overrideStatus === "none"}>
                Apply override
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <RigFormDialog open={editOpen} onOpenChange={setEditOpen} rig={rig} />
      <RigIncidentFormDialog open={incidentOpen} onOpenChange={setIncidentOpen} rigId={rig.id} />
      {repairIncident && (
        <RepairRecordFormDialog open={!!repairIncident} onOpenChange={(v) => !v && setRepairIncident(null)} rigId={rig.id} incidentId={repairIncident.id} />
      )}
      {testRepairId && <PostRepairTestDialog open={!!testRepairId} onOpenChange={(v) => !v && setTestRepairId(null)} repairRecordId={testRepairId} />}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-2 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function IncidentRow({ incident, onRepair, onTest }: { incident: RigIncident; onRepair: () => void; onTest: () => void }) {
  const sevClass = incident.severity === "critical" ? "text-critical" : incident.severity === "warning" ? "text-warning" : "text-muted";
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className={`text-sm font-medium ${sevClass}`}>{categoryLabel(incident.category)}</div>
          <div className="text-xs text-muted mt-0.5">{incident.description}</div>
        </div>
        <span className="text-[11px] text-muted-2 shrink-0 whitespace-nowrap">{fmtDateTime(incident.discoveredAt)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-2">
        <span className="rounded bg-surface-2 px-1.5 py-0.5">{RIG_INCIDENT_STATUS_LABELS[incident.status]}</span>
        <span>Discovered: {DISCOVERY_STAGE_LABELS[incident.discoveryStage]}</span>
        {incident.evidence.length > 0 && <span>{incident.evidence.length} evidence file(s)</span>}
        {incident.lostHours ? <span className="text-critical">−{fmtHours(incident.lostHours)}</span> : null}
      </div>
      {incident.status !== "resolved" && incident.status !== "cancelled" && (
        <div className="flex flex-wrap gap-2 pt-1">
          {incident.status === "open" && (
            <Button size="sm" variant="secondary" onClick={() => advanceRigIncidentStatus(incident.id, "triage")}>
              <Wrench className="size-3.5" /> Move to Triage
            </Button>
          )}
          {(incident.status === "open" || incident.status === "triage") && (
            <Button size="sm" variant="secondary" onClick={() => advanceRigIncidentStatus(incident.id, "inspection")}>
              Send to Inspection
            </Button>
          )}
          {incident.status !== "repair" && incident.status !== "testing" && (
            <Button size="sm" variant="secondary" onClick={() => advanceRigIncidentStatus(incident.id, "repair")}>
              Send to Repair
            </Button>
          )}
          {incident.status === "repair" && (
            <Button size="sm" onClick={onRepair}>
              Log Repair
            </Button>
          )}
          {incident.status === "testing" && (
            <Button size="sm" onClick={onTest}>
              Run Post-Repair Test
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => advanceRigIncidentStatus(incident.id, "cancelled")}>
            <XCircle className="size-3.5" /> Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
