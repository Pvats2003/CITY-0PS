import { useMemo, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, RotateCcw, ImageOff, UploadCloud, CloudCheck, CloudAlert } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useCity } from "@/store/city";
import { evidenceCompleteness, runEvidenceQA } from "@/engine/execution";
import { reviewEvidence, reviewAssignment } from "@/engine/workflows";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { fmtDateTime, fmtHours } from "@/lib/dates";
import type { Evidence, EvidenceFile } from "@/types";

/** One evidence photo, preferring the durable Storage downloadUrl over the
 * transient local blob URL (spec: "every evidence viewer must prefer
 * downloadUrl over localUrl"). Falls back to localUrl only for the brief
 * pre-upload window on the SAME device that captured it — and even then,
 * an onError swap means a stale/foreign blob: reference never renders as a
 * silent broken-image icon; it renders as an explicit "not yet available"
 * placeholder instead, since that's exactly the known cross-device gap
 * this phase closes for uploaded photos and documents for ones still in
 * flight. */
export function EvidenceThumb({ file }: { file: EvidenceFile }) {
  const [broken, setBroken] = useState(false);
  const src = file.downloadUrl ?? file.localUrl;
  const status = file.uploadStatus;

  return (
    <div className="relative">
      {!broken ? (
        <img key={src} src={src} alt={file.name} onError={() => setBroken(true)} className="size-16 rounded-md object-cover border border-border" />
      ) : (
        <div className="size-16 rounded-md border border-border bg-surface-2 flex flex-col items-center justify-center gap-1 text-muted-2">
          <ImageOff className="size-4" />
          <span className="text-[9px]">Not available</span>
        </div>
      )}
      {status && status !== "uploaded" && (
        <div
          className={`absolute -bottom-1.5 -right-1.5 flex items-center justify-center size-5 rounded-full border border-border ${
            status === "upload_failed" ? "bg-critical-bg text-critical" : "bg-warning-bg text-warning"
          }`}
          title={status === "local_only" ? "Pending upload" : status === "uploading" ? "Uploading…" : "Upload failed — retrying"}
        >
          {status === "upload_failed" ? <CloudAlert className="size-3" /> : <UploadCloud className="size-3" />}
        </div>
      )}
      {status === "uploaded" && (
        <div className="absolute -bottom-1.5 -right-1.5 flex items-center justify-center size-5 rounded-full border border-border bg-success-bg text-success" title="Uploaded">
          <CloudCheck className="size-3" />
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assignmentId: string | null;
}

/** The Manager's evidence review surface (spec Phase 16/17) — reuses
 * evidenceCompleteness/runEvidenceQA (engine/execution.ts, the same
 * deterministic functions the FO Cockpit reads) and ActivityTimeline (the
 * existing activity feed, filtered to this assignment — the evidence
 * timeline requirement is satisfied by the SAME activity log every
 * workflow function in engine/workflows.ts already writes to, not a
 * second parallel timeline). Manager is the only actor that can approve,
 * reject, or request a recheck — never AI, never the FO. */
export function EvidenceReviewDialog({ open, onOpenChange, assignmentId }: Props) {
  const data = useCity();
  const [recheckTarget, setRecheckTarget] = useState<Evidence | null>(null);
  const [recheckNote, setRecheckNote] = useState("");
  const [assignmentNote, setAssignmentNote] = useState("");

  const assignment = data.assignments.find((a) => a.id === assignmentId);
  const business = data.businesses.find((b) => b.id === assignment?.businessId);
  const fo = data.fos.find((f) => f.id === assignment?.foId);
  const rig = data.rigs.find((r) => r.id === assignment?.rigId);
  const evidence = useMemo(
    () => (assignment ? data.evidence.filter((e) => e.assignmentId === assignment.id).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) : []),
    [data.evidence, assignment],
  );
  const events = useMemo(
    () => (assignment ? data.activity.filter((e) => e.entityId === assignment.id).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) : []),
    [data.activity, assignment],
  );
  const completeness = assignment ? evidenceCompleteness(assignment, data.evidence) : null;

  if (!assignment || !business) return null;

  const hours = (new Date(assignment.plannedEnd).getTime() - new Date(assignment.plannedStart).getTime()) / 3_600_000;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Evidence Review</DialogTitle>
          <DialogDescription>
            {business.name} · {fo?.name ?? "Unassigned"} {rig ? `· ${rig.code}` : ""} · {fmtHours(hours)}
          </DialogDescription>
        </DialogHeader>

        {completeness && (
          <div className="rounded-lg border border-border bg-surface-2/50 p-3">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold">EVIDENCE</span>
              <span className="tabular-nums text-muted">
                {completeness.completeCount} / {completeness.totalCount} complete
              </span>
              {assignment.reviewStatus && assignment.reviewStatus !== "pending" && (
                <Badge variant={assignment.reviewStatus === "approved" ? "success" : "warning"}>{assignment.reviewStatus.replace("_", " ")}</Badge>
              )}
            </div>
            {completeness.missing.length > 0 && <div className="text-xs text-muted">Missing: {completeness.missing.join(", ")}</div>}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted-2 uppercase tracking-wide">Evidence records</div>
          {evidence.length === 0 && <div className="text-sm text-muted py-4 text-center">No evidence submitted yet.</div>}
          {evidence.map((e) => {
            const qa = runEvidenceQA(e, evidence);
            const isReplaced = evidence.some((other) => other.replacesEvidenceId === e.id);
            return (
              <div key={e.id} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="text-sm font-medium">{e.type.replace(/_/g, " ")}</div>
                    <div className="text-xs text-muted">{fmtDateTime(e.createdAt)}</div>
                  </div>
                  <Badge
                    variant={
                      e.status === "approved" ? "success" : e.status === "rejected" ? "critical" : e.status === "recheck_requested" ? "warning" : "default"
                    }
                  >
                    {e.status.replace("_", " ")}
                  </Badge>
                </div>

                {e.files.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {e.files.map((f) => (
                      <EvidenceThumb key={f.id} file={f} />
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <ImageOff className="size-3.5" /> No photo attached
                  </div>
                )}
                {e.notes && <div className="text-xs text-muted">{e.notes}</div>}
                {e.distanceFromExpectedMeters != null && (
                  <div className="text-xs text-muted">{e.distanceFromExpectedMeters}m from expected location</div>
                )}

                {qa.length > 0 && (
                  <div className="space-y-1">
                    {qa.map((f, i) => (
                      <div key={i} className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning-bg px-2 py-1.5 text-xs text-warning">
                        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-medium">AI QA — {f.confidence}% confidence</div>
                          <div>{f.message}</div>
                          <div className="italic">{f.recommendation}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isReplaced && <div className="text-[11px] text-muted italic">Superseded by a later resubmission — kept for history.</div>}
                {e.reviewNote && <div className="text-[11px] text-muted">Manager note: {e.reviewNote}</div>}

                {!isReplaced && e.status !== "approved" && e.status !== "rejected" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => reviewEvidence(e, "approved", "You")}>
                      <CheckCircle2 className="size-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRecheckTarget(e)}>
                      <RotateCcw className="size-3.5" /> Request Recheck
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => reviewEvidence(e, "rejected", "You")}>
                      <XCircle className="size-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {recheckTarget && (
          <div className="rounded-lg border border-warning/30 bg-warning-bg p-3 space-y-2">
            <div className="text-sm font-medium">Request recheck — {recheckTarget.type.replace(/_/g, " ")}</div>
            <Textarea
              placeholder="e.g. Retake the final installation photo showing the complete rig and cable connection."
              value={recheckNote}
              onChange={(e) => setRecheckNote(e.target.value)}
              rows={2}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  reviewEvidence(recheckTarget, "recheck_requested", "You", recheckNote.trim() || undefined);
                  reviewAssignment(assignment, "recheck_requested", "You", recheckNote.trim() || undefined);
                  setRecheckTarget(null);
                  setRecheckNote("");
                }}
              >
                Send Recheck Request
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRecheckTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted-2 uppercase tracking-wide">Timeline</div>
          <ActivityTimeline events={events} emptyLabel="No activity recorded yet." />
        </div>

        {assignment.reviewStatus !== "approved" && (
          <div className="border-t border-border pt-3 space-y-2">
            <Textarea placeholder="Note (optional)" value={assignmentNote} onChange={(e) => setAssignmentNote(e.target.value)} rows={2} />
            <div className="flex gap-2 justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  reviewAssignment(assignment, "recheck_requested", "You", assignmentNote.trim() || undefined);
                  setAssignmentNote("");
                }}
              >
                Request Recheck
              </Button>
              <Button
                onClick={() => {
                  reviewAssignment(assignment, "approved", "You", assignmentNote.trim() || undefined);
                  setAssignmentNote("");
                }}
              >
                <CheckCircle2 className="size-4" /> Approve
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
