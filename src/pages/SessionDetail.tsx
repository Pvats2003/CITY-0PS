import { useMemo, useRef, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Battery,
  HardDrive,
  Wifi,
  User,
  Users as UsersIcon,
  Cpu,
  Paperclip,
  Upload,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  StopCircle,
  Download,
} from "lucide-react";
import { useCity } from "@/store/city";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status";
import { Progress } from "@/components/ui/progress";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";
import { PostSessionCheckDialog } from "@/components/forms/PostSessionCheckDialog";
import { fmtDate, fmtTime, fmtDuration, fmtHours } from "@/lib/dates";
import { sessionInsightText } from "@/engine/insights";
import { id as genId } from "@/lib/id";
import { downloadJSON } from "@/lib/csv";
import { stashPendingFile, takePendingFile } from "@/lib/pendingFileBlobs";
import { enqueueMediaUpload, drainMediaOutbox } from "@/data/mediaOutbox";

export default function SessionDetail() {
  const { id } = useParams();
  const data = useCity();
  const addEvidence = useCity((s) => s.addEvidence);
  const updateEvidence = useCity((s) => s.updateEvidence);
  const [issueOpen, setIssueOpen] = useState(false);
  const [postCheckOpen, setPostCheckOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const session = data.sessions.find((s) => s.id === id);
  const business = data.businesses.find((b) => b.id === session?.businessId);
  const fo = data.fos.find((f) => f.id === session?.foId);
  const collector = data.collectors.find((c) => c.id === session?.collectorId);
  const rig = data.rigs.find((r) => r.id === session?.rigId);
  const review = data.qualityReviews.find((q) => q.sessionId === id);
  const evidence = data.evidence.find((e) => e.sessionId === id);
  const events = useMemo(() => data.activity.filter((e) => e.sessionId === id).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()), [data.activity, id]);

  if (!session || !business) return <Navigate to="/sessions" replace />;

  const actualMin = session.endedAt ? (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000 : (Date.now() - new Date(session.startedAt).getTime()) / 60000;
  const achievement = session.plannedDurationMin > 0 ? Math.round((actualMin / session.plannedDurationMin) * 100) : 0;

  function onFiles(files: FileList | null) {
    if (!files || files.length === 0 || !session) return;
    const items = Array.from(files).map((f) => {
      const id = genId("file");
      stashPendingFile(id, f);
      return {
        id,
        name: f.name,
        type: f.type || "application/octet-stream",
        sizeBytes: f.size,
        localUrl: URL.createObjectURL(f),
        capturedAt: new Date().toISOString(),
        uploadStatus: "local_only" as const,
      };
    });
    let evidenceId: string;
    if (evidence) {
      updateEvidence(evidence.id, { files: [...evidence.files, ...items] });
      evidenceId = evidence.id;
    } else {
      evidenceId = addEvidence({
        assignmentId: session.assignmentId,
        sessionId: session.id,
        businessId: session.businessId,
        foId: session.foId,
        collectorId: session.collectorId,
        rigId: session.rigId,
        type: "OTHER",
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        files: items,
        status: "submitted",
      }).id;
    }
    for (const item of items) {
      const raw = takePendingFile(item.id);
      if (!raw) continue;
      void enqueueMediaUpload({
        foId: session.foId,
        assignmentId: session.assignmentId,
        evidenceId,
        fileId: item.id,
        fileName: item.name,
        mimeType: item.type,
        blob: raw,
      }).then(() => drainMediaOutbox());
    }
  }

  function saveNotes() {
    if (!session || !notes.trim()) return;
    if (evidence) updateEvidence(evidence.id, { notes });
    else
      addEvidence({
        assignmentId: session.assignmentId,
        sessionId: session.id,
        businessId: session.businessId,
        foId: session.foId,
        collectorId: session.collectorId,
        rigId: session.rigId,
        type: "OTHER",
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        files: [],
        notes,
        status: "submitted",
      });
    setNotes("");
  }

  function exportEvidence() {
    if (!evidence || !session || !business) return;
    downloadJSON(`evidence-${business.name.replace(/\s+/g, "-").toLowerCase()}-${session.date}.json`, {
      session: { id: session.id, business: business.name, fo: fo?.name, collector: collector?.name, rig: rig?.code, date: session.date, startedAt: session.startedAt, endedAt: session.endedAt },
      location: evidence.lat && evidence.lng ? { lat: evidence.lat, lng: evidence.lng } : undefined,
      notes: evidence.notes,
      status: evidence.status,
      files: evidence.files.map((f) => ({ name: f.name, type: f.type, sizeBytes: f.sizeBytes, capturedAt: f.capturedAt })),
    });
  }

  return (
    <div className="pb-10">
      <div className="px-4 md:px-6 pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/sessions">
            <ArrowLeft className="size-4" /> Sessions
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-2 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold tracking-tight">
              <Link to={`/businesses/${business.id}`} className="hover:underline">
                {business.name}
              </Link>
            </h1>
            <StatusBadge status={session.status === "active" ? "active" : session.status} />
          </div>
          <p className="text-sm text-muted mt-0.5 tabular-nums">
            {fmtDate(session.date)} · {fmtTime(session.startedAt)}
            {session.endedAt ? `–${fmtTime(session.endedAt)}` : " – in progress"} · {fmtDuration(actualMin)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {session.status === "active" && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setIssueOpen(true)}>
                <AlertTriangle className="size-4" /> Report Issue
              </Button>
              <Button size="sm" onClick={() => setPostCheckOpen(true)}>
                <StopCircle className="size-4" /> End Session
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Performance</CardTitle>
              <span className="text-xs text-muted">{sessionInsightText(session)}</span>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-2xl font-bold tabular-nums">{fmtHours(session.plannedDurationMin / 60)}</div>
                  <div className="text-[11px] text-muted">Planned</div>
                </div>
                <div>
                  <div className="text-2xl font-bold tabular-nums">{fmtHours(actualMin / 60)}</div>
                  <div className="text-[11px] text-muted">Actual</div>
                </div>
                <div>
                  <div className={`text-2xl font-bold tabular-nums ${achievement >= 90 ? "text-success" : achievement >= 70 ? "text-warning" : "text-critical"}`}>
                    {achievement}%
                  </div>
                  <div className="text-[11px] text-muted">Achievement</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quality</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {!review ? (
                <div className="text-sm text-muted">Awaiting review — quality is auto-flagged when the session ends.</div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    {review.verdict === "pass" && <ShieldCheck className="size-4 text-success" />}
                    {review.verdict === "warn" && <ShieldAlert className="size-4 text-warning" />}
                    {review.verdict === "fail" && <ShieldX className="size-4 text-critical" />}
                    <span className="text-sm font-medium capitalize">{review.verdict}</span>
                  </div>
                  {review.flags.length > 0 && (
                    <ul className="space-y-1 text-sm text-muted">
                      {review.flags.map((f, i) => (
                        <li key={i}>• {f.detail}</li>
                      ))}
                    </ul>
                  )}
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/quality">Open Quality Center</Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                  <Upload className="size-4" /> Add evidence files
                </Button>
                {evidence && (
                  <Button size="sm" variant="ghost" onClick={exportEvidence}>
                    <Download className="size-4" /> Export Evidence
                  </Button>
                )}
              </div>
              {evidence?.files.length ? (
                <ul className="space-y-1.5">
                  {evidence.files.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 text-sm">
                      <Paperclip className="size-3.5 text-muted" />
                      <span className="truncate flex-1">{f.name}</span>
                      {f.uploadStatus && f.uploadStatus !== "uploaded" && (
                        <span className={`text-xs ${f.uploadStatus === "upload_failed" ? "text-critical" : "text-muted"}`}>
                          {f.uploadStatus === "upload_failed" ? "upload failed" : f.uploadStatus === "uploading" ? "uploading…" : "pending upload"}
                        </span>
                      )}
                      <span className="text-xs text-muted-2">{Math.round(f.sizeBytes / 1024)} KB</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-muted">No evidence files attached yet.</div>
              )}
              <div className="pt-2 border-t border-border">
                <Textarea placeholder="Add a note…" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                {evidence?.notes && <div className="text-xs text-muted mt-2">Existing note: {evidence.notes}</div>}
                <Button size="sm" variant="ghost" className="mt-2" onClick={saveNotes} disabled={!notes.trim()}>
                  Save note
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ActivityTimeline events={events} emptyLabel="No activity recorded for this session." />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Device</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3 text-sm">
              <DeviceRow icon={Battery} label="Battery" value={`${session.batteryPct}%`} progress={session.batteryPct} tone={session.batteryPct < 30 ? "critical" : "default"} />
              <DeviceRow icon={HardDrive} label="Storage" value={`${session.storagePct}%`} progress={session.storagePct} tone={session.storagePct > 85 ? "warning" : "default"} />
              <div className="flex items-center gap-2">
                <Wifi className={`size-4 ${session.signal === "healthy" ? "text-success" : "text-warning"}`} />
                <span className="flex-1">Signal</span>
                <span className="capitalize">{session.signal}</span>
              </div>
              {rig && (
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <Cpu className="size-4 text-muted" />
                  <span className="flex-1">Rig</span>
                  <span>
                    {rig.code} · {rig.model}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2.5 text-sm">
              {fo && (
                <Link to={`/field-officers/${fo.id}`} className="flex items-center gap-2 hover:underline">
                  <User className="size-4 text-muted" /> {fo.name} <span className="text-xs text-muted">(FO)</span>
                </Link>
              )}
              {collector && (
                <div className="flex items-center gap-2">
                  <UsersIcon className="size-4 text-muted" /> {collector.name} <span className="text-xs text-muted">(Collector)</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <IssueFormDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        defaults={{ businessId: session.businessId, foId: session.foId, rigId: session.rigId, sessionId: session.id }}
      />
      <PostSessionCheckDialog open={postCheckOpen} onOpenChange={setPostCheckOpen} session={session} />
    </div>
  );
}

function DeviceRow({
  icon: Icon,
  label,
  value,
  progress,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  progress: number;
  tone: "default" | "critical" | "warning";
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Icon className={`size-4 ${tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-muted"}`} />
        <span className="flex-1">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <Progress value={progress} className="h-1.5 mt-1.5" indicatorClassName={tone === "critical" ? "bg-critical" : tone === "warning" ? "bg-warning" : undefined} />
    </div>
  );
}
