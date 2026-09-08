import { useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Pencil,
  AlertTriangle,
  MapPin,
  Phone,
  User,
  Clock,
  ExternalLink,
  Lightbulb,
  Radio,
  UserPlus,
  Users,
} from "lucide-react";
import { useCity } from "@/store/city";
import { computeBusinessStats, businessInsightText } from "@/engine/insights";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { BusinessFormDialog } from "@/components/forms/BusinessFormDialog";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";
import { fmtDate, fmtDateTime, fmtHours } from "@/lib/dates";

export default function BusinessDetail() {
  const { id } = useParams();
  const data = useCity();
  const addCollector = useCity((s) => s.addCollector);
  const [editOpen, setEditOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [newCollector, setNewCollector] = useState("");
  const business = data.businesses.find((b) => b.id === id);

  const stats = useMemo(() => (business ? computeBusinessStats(data, business) : null), [data, business]);
  const events = useMemo(() => data.activity.filter((e) => e.businessId === id).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()), [data.activity, id]);
  const sessions = useMemo(() => data.sessions.filter((s) => s.businessId === id).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()), [data.sessions, id]);
  const openIssues = useMemo(() => data.issues.filter((i) => i.businessId === id && i.status !== "resolved" && i.status !== "cancelled"), [data.issues, id]);
  const collectors = useMemo(() => data.collectors.filter((c) => c.businessId === id), [data.collectors, id]);

  function submitCollector() {
    if (!newCollector.trim() || !business) return;
    addCollector({ name: newCollector.trim(), businessId: business.id, active: true });
    setNewCollector("");
  }

  if (!business) return <Navigate to="/businesses" replace />;
  const insight = businessInsightText(stats!);

  return (
    <div className="pb-10">
      <div className="px-4 md:px-6 pt-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/businesses">
            <ArrowLeft className="size-4" /> Businesses
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-2 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold tracking-tight">{business.name}</h1>
            <StatusBadge status={business.active ? "healthy" : "offline"} />
          </div>
          <p className="text-sm text-muted mt-0.5">
            {business.category} · {business.area}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setIssueOpen(true)}>
            <AlertTriangle className="size-4" /> Report Issue
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" /> Edit
          </Button>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-5">
          {/* Business Intelligence */}
          <Card>
            <CardHeader>
              <CardTitle>Business Intelligence</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${insight.startsWith("At risk") ? "border-warning/25 bg-warning-bg" : insight.startsWith("Insufficient") ? "border-border bg-surface-2" : "border-success/25 bg-success-bg"}`}>
                <Lightbulb className="size-4 shrink-0 mt-0.5" />
                <span>{insight}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Total Visits" value={stats!.totalVisits} />
                <Stat label="Successful" value={stats!.successfulVisits} />
                <Stat label="Rejected" value={stats!.rejectedVisits} tone={stats!.rejectedVisits > 0 ? "critical" : undefined} />
                <Stat label="No-shows" value={stats!.noShowVisits} tone={stats!.noShowVisits > 0 ? "critical" : undefined} />
                <Stat label="Recording Hours" value={fmtHours(stats!.totalRecordingHours)} />
                <Stat label="Avg / Visit" value={fmtHours(stats!.avgRecordingHours)} />
                <Stat label="Target Achievement" value={`${stats!.targetAchievementPct}%`} />
                <Stat label="QA Pass Rate" value={`${stats!.qaPassRate}%`} />
                <Stat label="Issues" value={stats!.issueCount} tone={stats!.issueCount > 0 ? "warning" : undefined} />
                <Stat label="Cancellations" value={stats!.cancellationCount} />
                <Stat label="Avg Delay" value={`${stats!.avgDelayMin}m`} />
                <Stat label="Reliability" value={`${stats!.reliabilityScore}%`} tone={stats!.reliabilityScore < 75 ? "critical" : "success"} />
              </div>
            </CardContent>
          </Card>

          {/* Visit timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Visit Timeline</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ActivityTimeline events={events} groupByDay emptyLabel="No visits recorded yet for this business." />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          {/* Info card */}
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2.5 text-sm">
              {business.address && (
                <div className="flex items-start gap-2">
                  <MapPin className="size-4 text-muted shrink-0 mt-0.5" />
                  <span className="flex-1">{business.address}</span>
                </div>
              )}
              {business.lat && business.lng && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-primary text-xs hover:underline pl-6"
                >
                  Open in Maps <ExternalLink className="size-3" />
                </a>
              )}
              {business.contactName && (
                <div className="flex items-center gap-2">
                  <User className="size-4 text-muted shrink-0" />
                  <span>{business.contactName}</span>
                </div>
              )}
              {business.contactPhone && (
                <div className="flex items-center gap-2">
                  <Phone className="size-4 text-muted shrink-0" />
                  <span>{business.contactPhone}</span>
                </div>
              )}
              {(business.preferredWindowStart || business.preferredWindowEnd) && (
                <div className="flex items-center gap-2">
                  <Clock className="size-4 text-muted shrink-0" />
                  <span>
                    Preferred window {business.preferredWindowStart ?? "—"}–{business.preferredWindowEnd ?? "—"}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-muted text-xs">Capacity</span>
                <span className="tabular-nums">{business.capacityHoursPerDay}h/day</span>
              </div>
              {stats!.lastVisitAt && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Last visit</span>
                  <span>{fmtDate(stats!.lastVisitAt)}</span>
                </div>
              )}
              {stats!.nextPlannedAt && (
                <div className="flex items-center justify-between">
                  <span className="text-muted text-xs">Next planned</span>
                  <span>{fmtDateTime(stats!.nextPlannedAt)}</span>
                </div>
              )}
              {business.notes && <div className="text-xs text-muted pt-2 border-t border-border whitespace-pre-wrap">{business.notes}</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Collectors</CardTitle>
              <Users className="size-4 text-muted" />
            </CardHeader>
            <CardContent className="pt-0 space-y-2.5">
              {collectors.length === 0 ? (
                <div className="text-xs text-muted">No collectors added yet.</div>
              ) : (
                <ul className="space-y-1.5">
                  {collectors.map((c) => (
                    <li key={c.id} className="flex items-center justify-between text-sm">
                      <span>{c.name}</span>
                      <StatusBadge status={c.active ? "healthy" : "offline"} />
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-1.5 pt-1">
                <Input
                  value={newCollector}
                  onChange={(e) => setNewCollector(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitCollector()}
                  placeholder="Collector name"
                  className="h-8 text-xs"
                />
                <Button size="icon-sm" variant="secondary" onClick={submitCollector} disabled={!newCollector.trim()}>
                  <UserPlus className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>

          {openIssues.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Open Issues</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {openIssues.map((i) => (
                  <Link key={i.id} to={`/issues/${i.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                    <span className="truncate">{i.title}</span>
                    <StatusBadge status={i.severity === "critical" ? "critical" : "warning"} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {sessions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Sessions</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {sessions.slice(0, 6).map((s) => (
                  <Link key={s.id} to={`/sessions/${s.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                    <span className="flex items-center gap-1.5 truncate">
                      <Radio className="size-3.5 text-muted" /> {fmtDate(s.date)}
                    </span>
                    <StatusBadge status={s.status === "active" ? "active" : s.status} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <BusinessFormDialog open={editOpen} onOpenChange={setEditOpen} business={business} />
      <IssueFormDialog open={issueOpen} onOpenChange={setIssueOpen} defaults={{ businessId: business.id }} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "critical" | "warning" | "success" }) {
  const toneClass = tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-foreground";
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}
