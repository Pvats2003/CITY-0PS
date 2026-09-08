import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  PlusCircle,
  CalendarClock,
  UserPlus,
  PlayCircle,
  AlertTriangle,
  Clock,
  Store,
  Users,
  Radio,
  ShieldAlert,
  Info,
  ArrowRight,
} from "lucide-react";
import { useCity } from "@/store/city";
import { todayISO, fmtHours, fmtDate } from "@/lib/dates";
import { computeCityHealth, healthStatus } from "@/engine/health";
import { buildAttentionFeed } from "@/engine/attention";
import { computeLostHours } from "@/engine/lostHours";
import { buildTomorrowRecommendations } from "@/engine/reports";
import { assignmentsForDate, recordedHoursForDate, activeSessions } from "@/engine/selectors";
import { KpiCard } from "@/components/shared/KpiCard";
import { ScoreBar } from "@/components/shared/ScoreBar";
import { AttentionList } from "@/components/shared/AttentionList";
import { ActivityTimeline } from "@/components/shared/ActivityTimeline";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BusinessFormDialog } from "@/components/forms/BusinessFormDialog";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";

export default function CommandCenter() {
  const data = useCity();
  const date = todayISO();
  const [addBusinessOpen, setAddBusinessOpen] = useState(false);
  const [reportIssueOpen, setReportIssueOpen] = useState(false);

  const target = data.settings.recordingHoursTargetPerDay;
  const health = useMemo(() => computeCityHealth(data, date, target), [data, date, target]);
  const attention = useMemo(() => buildAttentionFeed(data, date), [data, date]);
  const lostHours = useMemo(() => computeLostHours(data, date), [data, date]);
  const tomorrowRecs = useMemo(() => buildTomorrowRecommendations(data, date), [data, date]);

  const assignments = assignmentsForDate(data, date);
  const completed = assignments.filter((a) => a.status === "completed").length;
  const recordedHours = recordedHoursForDate(data, date);
  const achievementPct = target > 0 ? Math.round((recordedHours / target) * 100) : 0;
  const activeFOIds = new Set(assignments.filter((a) => a.status === "in_progress").map((a) => a.foId));
  const openCritical = data.issues.filter((i) => i.severity === "critical" && (i.status === "open" || i.status === "in_progress")).length;
  const live = activeSessions(data);

  const todaysEvents = data.activity.filter((e) => e.at.slice(0, 10) === date).slice(0, 14);

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6 pt-5 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">Command Center</h1>
            <StatusBadge status={healthStatus(health.score)}>City Health {health.score}</StatusBadge>
          </div>
          <p className="text-sm text-muted mt-0.5">{fmtDate(date, "EEEE, MMMM d, yyyy")} · {data.settings.cityName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setAddBusinessOpen(true)}>
            <PlusCircle className="size-4" /> Add Business
          </Button>
          <Button size="sm" variant="secondary" asChild>
            <Link to="/today?tab=planner">
              <CalendarClock className="size-4" /> Plan Day
            </Link>
          </Button>
          <Button size="sm" variant="secondary" asChild>
            <Link to="/today?tab=planner">
              <UserPlus className="size-4" /> Assign FO
            </Link>
          </Button>
          <Button size="sm" variant="secondary" asChild>
            <Link to="/today">
              <PlayCircle className="size-4" /> Start Session
            </Link>
          </Button>
          <Button size="sm" onClick={() => setReportIssueOpen(true)}>
            <AlertTriangle className="size-4" /> Report Issue
          </Button>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 space-y-5">
        {/* KPI strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard
            className="lg:col-span-2"
            size="lg"
            label="Recording Hours / Target"
            value={`${fmtHours(recordedHours)} / ${fmtHours(target, 0)}`}
            sub={`${achievementPct}% achieved today`}
            tone={achievementPct >= 90 ? "success" : achievementPct >= 70 ? "warning" : "critical"}
            icon={Clock}
          />
          <KpiCard label="Businesses" value={`${completed}/${assignments.length}`} sub="completed / planned" icon={Store} />
          <KpiCard label="Active FOs" value={activeFOIds.size} sub={`of ${data.fos.filter((f) => f.active).length} total`} icon={Users} />
          <KpiCard label="Active Sessions" value={live.length} sub="recording now" icon={Radio} tone={live.length > 0 ? "success" : "default"} />
          <KpiCard
            label="Open Critical Issues"
            value={openCritical}
            sub={openCritical > 0 ? "needs action" : "all clear"}
            icon={ShieldAlert}
            tone={openCritical > 0 ? "critical" : "success"}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Attention panel */}
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>What needs my attention?</CardTitle>
              <span className="text-xs text-muted">{attention.length} item{attention.length === 1 ? "" : "s"}</span>
            </CardHeader>
            <CardContent className="pt-0">
              <AttentionList items={attention} limit={8} />
              {attention.length > 8 && (
                <div className="pt-3 text-center">
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/issues">
                      View all {attention.length} <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* City Pulse */}
          <Card>
            <CardHeader>
              <CardTitle>City Pulse</CardTitle>
              <Popover>
                <PopoverTrigger asChild>
                  <button className="text-muted hover:text-foreground">
                    <Info className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80">
                  <div className="text-xs font-semibold mb-2">Why is this {health.score}?</div>
                  <ul className="space-y-1 text-xs">
                    {health.deltas.map((d, i) => (
                      <li key={i} className="flex items-center justify-between gap-2">
                        <span className="text-muted">{d.label}</span>
                        <span className={d.delta >= 0 ? "text-success tabular-nums" : "text-critical tabular-nums"}>
                          {d.delta >= 0 ? "+" : ""}
                          {d.delta}
                        </span>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="text-center py-2">
                <div className="text-4xl font-bold tabular-nums">{health.score}</div>
                <div className="text-xs text-muted">Operational Health</div>
              </div>
              <div className="space-y-2.5">
                {health.categories.map((c) => (
                  <ScoreBar key={c.key} label={c.label} value={c.value} />
                ))}
              </div>
              <div className="border-t border-border pt-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted">Today</span>
                  <span className="tabular-nums">
                    {completed}/{assignments.length} businesses · {fmtHours(recordedHours)}/{fmtHours(target, 0)}
                  </span>
                </div>
              </div>
              {lostHours.topCause && (
                <div className="border-t border-border pt-3">
                  <div className="text-xs font-semibold text-muted mb-1">Biggest Loss</div>
                  <div className="flex items-center justify-between text-sm">
                    <span>{lostHours.topCause.label}</span>
                    <span className="text-critical tabular-nums">−{fmtHours(lostHours.topCause.hours)}</span>
                  </div>
                </div>
              )}
              {tomorrowRecs[0] && (
                <div className="border-t border-border pt-3">
                  <div className="text-xs font-semibold text-muted mb-1">Next Best Action</div>
                  <div className="text-sm">{tomorrowRecs[0].description}</div>
                  <Button size="sm" variant="secondary" className="mt-2 w-full" asChild>
                    <Link to="/reports?tab=tomorrow">
                      View recommendation <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* What happened today */}
        <Card>
          <CardHeader>
            <CardTitle>What happened today?</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link to="/reports?tab=eod">
                Full EOD <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <ActivityTimeline events={todaysEvents} emptyLabel="No activity recorded yet today." />
          </CardContent>
        </Card>
      </div>

      <BusinessFormDialog open={addBusinessOpen} onOpenChange={setAddBusinessOpen} />
      <IssueFormDialog open={reportIssueOpen} onOpenChange={setReportIssueOpen} />
    </div>
  );
}
