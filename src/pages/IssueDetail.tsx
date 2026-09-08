import { useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Lightbulb } from "lucide-react";
import { useCity } from "@/store/city";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SEVERITY_META, StatusBadge } from "@/components/status";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { ResolveIssueDialog } from "@/components/forms/ResolveIssueDialog";
import { fmtDateTime } from "@/lib/dates";
import { issueInsightText } from "@/engine/insights";

const TYPE_LABELS: Record<string, string> = {
  business_rejection: "Business rejection",
  fo_no_show: "FO no-show",
  late_arrival: "Late arrival",
  rig_failure: "Rig failure",
  battery: "Battery",
  storage: "Storage",
  network: "Network",
  recording_failure: "Recording failure",
  quality: "Quality",
  damage: "Damage",
  missing_evidence: "Missing evidence",
  scheduling: "Scheduling",
  other: "Other",
};

export default function IssueDetail() {
  const { id } = useParams();
  const data = useCity();
  const [resolveOpen, setResolveOpen] = useState(false);
  const issue = data.issues.find((i) => i.id === id);

  const business = issue?.businessId ? data.businesses.find((b) => b.id === issue.businessId) : undefined;
  const fo = issue?.foId ? data.fos.find((f) => f.id === issue.foId) : undefined;
  const rig = issue?.rigId ? data.rigs.find((r) => r.id === issue.rigId) : undefined;
  const events = useMemo(() => data.activity.filter((e) => e.issueId === id).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()), [data.activity, id]);

  if (!issue) return <Navigate to="/issues" replace />;
  const meta = SEVERITY_META[issue.severity];
  const insight = issueInsightText(data, issue);

  return (
    <div className="pb-10">
      <div className="px-4 md:px-6 pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/issues">
            <ArrowLeft className="size-4" /> Issues
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-2 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base">{meta.emoji}</span>
            <h1 className="text-lg font-semibold tracking-tight">{issue.title}</h1>
            <StatusBadge status={issue.status === "resolved" ? "completed" : issue.status === "cancelled" ? "cancelled" : issue.severity === "critical" ? "critical" : "warning"} />
          </div>
          <p className="text-sm text-muted mt-0.5">
            {TYPE_LABELS[issue.type] ?? issue.type} · Reported {fmtDateTime(issue.createdAt)}
          </p>
        </div>
        {issue.status !== "resolved" && issue.status !== "cancelled" && (
          <Button onClick={() => setResolveOpen(true)}>
            <CheckCircle2 className="size-4" /> Resolve
          </Button>
        )}
      </div>

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <p className="text-sm">{issue.description}</p>
              <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm">
                <Lightbulb className="size-4 shrink-0 mt-0.5 text-muted" />
                <span>{insight}</span>
              </div>
              {issue.lostHours ? (
                <div className="text-sm">
                  <span className="text-muted">Estimated lost hours: </span>
                  <span className="text-critical font-medium tabular-nums">{issue.lostHours}h</span>
                </div>
              ) : null}
              {issue.resolution && (
                <div className="rounded-md border border-success/25 bg-success-bg px-3 py-2.5 text-sm">
                  <div className="text-xs font-semibold text-success mb-1">Resolution</div>
                  {issue.resolution}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ActivityTimeline events={events} emptyLabel="No related activity recorded." />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Related</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted text-xs">Owner</span>
                <span>{issue.owner ?? "Unassigned"}</span>
              </div>
              {business && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Business</span>
                  <Link to={`/businesses/${business.id}`} className="hover:underline">
                    {business.name}
                  </Link>
                </div>
              )}
              {fo && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Field Officer</span>
                  <Link to={`/field-officers/${fo.id}`} className="hover:underline">
                    {fo.name}
                  </Link>
                </div>
              )}
              {rig && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Rig</span>
                  <span>{rig.code}</span>
                </div>
              )}
              {issue.sessionId && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Session</span>
                  <Link to={`/sessions/${issue.sessionId}`} className="hover:underline">
                    View session
                  </Link>
                </div>
              )}
              {issue.resolvedAt && (
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-muted text-xs">Resolved</span>
                  <span>{fmtDateTime(issue.resolvedAt)}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ResolveIssueDialog open={resolveOpen} onOpenChange={setResolveOpen} issue={issue} />
    </div>
  );
}
