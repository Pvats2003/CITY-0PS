import { useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, Pencil, Smartphone, Lightbulb, CheckCircle2, Circle, PlayCircle, PlusCircle, XCircle, ClipboardCheck } from "lucide-react";
import { AlertTriangle } from "lucide-react";
import { useCity } from "@/store/city";
import { useCollectionSyncStatus } from "@/data/useCollectionSyncStatus";
import { computeFOStats, foInsightText } from "@/engine/insights";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { FOFormDialog } from "@/components/forms/FOFormDialog";
import { AssignmentFormDialog } from "@/components/forms/AssignmentFormDialog";
import { EvidenceReviewDialog } from "@/components/forms/EvidenceReviewDialog";
import { fmtTime, fmtHours, todayISO } from "@/lib/dates";
import { assignmentStatusToStatus } from "@/engine/todayView";

export default function FieldOfficerDetail() {
  const { id } = useParams();
  const data = useCity();
  const addAssignment = useCity((s) => s.addAssignment);
  const updateAssignment = useCity((s) => s.updateAssignment);
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [reviewAssignmentId, setReviewAssignmentId] = useState<string | null>(null);
  const fo = data.fos.find((f) => f.id === id);
  const date = todayISO();

  const assignmentsSync = useCollectionSyncStatus("assignments");
  const stats = useMemo(() => (fo ? computeFOStats(data, fo) : null), [data, fo]);
  const events = useMemo(() => data.activity.filter((e) => e.foId === id).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()), [data.activity, id]);
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));
  const today = useMemo(
    () => data.assignments.filter((a) => a.foId === id && a.date === date).sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime()),
    [data.assignments, id, date],
  );
  const todayHours = today.reduce((s, a) => s + (new Date(a.plannedEnd).getTime() - new Date(a.plannedStart).getTime()) / 3_600_000, 0);

  if (!fo) return <Navigate to="/field-officers" replace />;
  const insight = foInsightText(stats!);

  return (
    <div className="pb-10">
      <div className="px-4 md:px-6 pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/field-officers">
            <ArrowLeft className="size-4" /> Field Officers
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-2 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold shrink-0">
            {fo.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{fo.name}</h1>
              <StatusBadge status={fo.active ? "healthy" : "offline"} />
            </div>
            <p className="text-sm text-muted mt-0.5">{fo.homeArea ?? "No home area set"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" asChild>
            <Link to={`/field-officers/${fo.id}/execute`} target="_blank">
              <Smartphone className="size-4" /> Execution Mode
            </Link>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Edit
          </Button>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>FO Performance</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm">
                <Lightbulb className="size-4 shrink-0 mt-0.5 text-muted" />
                <span>{insight}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Attendance" value={`${stats!.attendancePct}%`} tone={stats!.attendancePct < 85 ? "warning" : "success"} />
                <Stat label="On-time" value={`${stats!.onTimePct}%`} tone={stats!.onTimePct < 80 ? "warning" : "success"} />
                <Stat label="Visits Completed" value={stats!.visitsCompleted} />
                <Stat label="Sessions Started" value={stats!.sessionsStarted} />
                <Stat label="Sessions Completed" value={stats!.sessionsCompleted} />
                <Stat label="Avg Delay" value={`${stats!.avgDelayMin}m`} tone={stats!.avgDelayMin > 15 ? "warning" : undefined} />
                <Stat label="Issues" value={stats!.issueCount} tone={stats!.issueCount > 0 ? "warning" : undefined} />
                <Stat label="Recording Hours" value={fmtHours(stats!.recordingHoursManaged)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ActivityTimeline events={events} groupByDay emptyLabel="No activity recorded yet for this FO." />
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>
                FO Today <span className="text-muted font-normal text-xs ml-1">{fmtHours(todayHours)} planned</span>
              </CardTitle>
              <Button size="sm" variant="secondary" onClick={() => setAssignOpen(true)}>
                <PlusCircle className="size-3.5" /> Assign rig
              </Button>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {assignmentsSync.error && (
                <div className="flex items-start gap-2 rounded-md border border-critical/20 bg-critical-bg px-3 py-2 text-xs text-critical">
                  <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                  <span>Assignments aren't syncing to the server ({assignmentsSync.error}) — anything shown below may not exist on {fo.name}'s device yet.</span>
                </div>
              )}
              {today.length === 0 && <div className="text-sm text-muted py-4 text-center">Nothing scheduled today.</div>}
              {today.map((a) => {
                const status = assignmentStatusToStatus(a.status);
                const Icon = a.status === "completed" ? CheckCircle2 : a.status === "in_progress" ? PlayCircle : Circle;
                const rig = a.rigId ? rigMap.get(a.rigId) : undefined;
                const removable = a.status === "planned" || a.status === "confirmed";
                const hasEvidence = a.actualArrivalAt || data.evidence.some((e) => e.assignmentId === a.id);
                return (
                  <div key={a.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
                    <Icon className={`size-4 shrink-0 ${a.status === "completed" ? "text-success" : a.status === "in_progress" ? "text-info" : "text-muted-2"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{bizMap.get(a.businessId)?.name}</div>
                      <div className="text-xs text-muted truncate">
                        {fmtTime(a.plannedStart)}–{fmtTime(a.plannedEnd)}
                        {rig && <span> · {rig.code}</span>}
                      </div>
                    </div>
                    <StatusBadge status={status} />
                    {hasEvidence && (
                      <Button size="icon-sm" variant="ghost" title="Review evidence" onClick={() => setReviewAssignmentId(a.id)}>
                        <ClipboardCheck className="size-4" />
                      </Button>
                    )}
                    {removable && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Remove"
                        onClick={() => updateAssignment(a.id, { status: "cancelled" })}
                      >
                        <XCircle className="size-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>

      <FOFormDialog open={editOpen} onOpenChange={setEditOpen} fo={fo} />
      {fo && (
        <AssignmentFormDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          date={date}
          existingAssignments={data.assignments.filter((a) => a.date === date)}
          defaults={{ foId: fo.id }}
          onCreate={(a) => addAssignment({ ...a, status: "confirmed" })}
        />
      )}
      <EvidenceReviewDialog open={reviewAssignmentId != null} onOpenChange={(v) => !v && setReviewAssignmentId(null)} assignmentId={reviewAssignmentId} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warning" | "success" }) {
  const toneClass = tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-foreground";
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}
