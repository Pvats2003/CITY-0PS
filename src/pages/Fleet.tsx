import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PlusCircle, ShieldAlert, ShieldCheck, Wrench, ClipboardList, Cpu, TrendingDown, ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCity } from "@/store/city";
import { todayISO, fmtHours } from "@/lib/dates";
import {
  buildFleetRanking,
  buildFleetReadiness,
  buildCityFailureAnalysis,
  computeFailureRateMetrics,
  computeRigLostHours,
  isDeployable,
} from "@/engine/rigGuardian";
import { requestRigInspection } from "@/engine/workflows";
import { RigReadinessBadge } from "@/components/rigs/RigReadinessBadge";
import { RigFormDialog } from "@/components/forms/RigFormDialog";

export default function Fleet() {
  const data = useCity();
  const [addOpen, setAddOpen] = useState(false);
  const date = todayISO();

  const summaries = useMemo(() => buildFleetRanking(data), [data]);
  const readiness = useMemo(() => buildFleetReadiness(data, date, summaries), [data, date, summaries]);
  const failureAnalysis = useMemo(() => buildCityFailureAnalysis(data, 30), [data]);
  const rateMetrics = useMemo(() => computeFailureRateMetrics(data, 30), [data]);
  const fleetLostHours = useMemo(() => computeRigLostHours(data), [data]);

  const best = summaries.slice(0, 3);
  const worst = [...summaries].reverse().filter((s) => s.score < 90).slice(0, 3);

  if (data.rigs.length === 0) {
    return (
      <div>
        <PageHeader title="Fleet" subtitle="Rig Guardian — prevent failures before they cost recording hours." actions={<Button onClick={() => setAddOpen(true)}><PlusCircle className="size-4" /> Add Rig</Button>} />
        <EmptyState icon={Cpu} title="No rigs registered" description="Add your recording rigs so Rig Guardian can track their health and readiness." action={<Button onClick={() => setAddOpen(true)}><PlusCircle className="size-4" /> Add Rig</Button>} />
        <RigFormDialog open={addOpen} onOpenChange={setAddOpen} />
      </div>
    );
  }

  return (
    <div className="pb-10">
      <PageHeader
        title="Fleet"
        subtitle="Rig Guardian — prevent failures before they cost recording hours."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <PlusCircle className="size-4" /> Add Rig
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-5 space-y-5">
        {/* Rig Readiness */}
        <Card>
          <CardHeader>
            <CardTitle>Rig Readiness</CardTitle>
            <span className="text-xs text-muted">{readiness.total} total rigs</span>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <ReadinessCount emoji="🟢" label="Ready" value={readiness.healthy} tone="success" />
              <ReadinessCount emoji="🟡" label="Watch" value={readiness.watch} tone="warning" />
              <ReadinessCount emoji="🟠" label="Inspection Required" value={readiness.inspectionRequired} tone="warning" />
              <ReadinessCount emoji="🔴" label="Do Not Deploy" value={readiness.doNotDeploy} tone="critical" />
            </div>

            <div className={`rounded-lg border p-4 ${readiness.status === "ready" ? "border-success/25 bg-success-bg" : "border-critical/25 bg-critical-bg"}`}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <Stat label="Required today" value={readiness.requiredToday} />
                <Stat label="Ready" value={readiness.readyCount} />
                <Stat label="Buffer" value={readiness.buffer} tone={readiness.buffer < 0 ? "critical" : undefined} />
                <Stat label="Standby" value={readiness.standby} />
                {readiness.retired > 0 && <Stat label="Retired" value={readiness.retired} />}
              </div>
              <div className={`mt-2 flex items-center gap-2 font-semibold text-sm ${readiness.status === "ready" ? "text-success" : "text-critical"}`}>
                {readiness.status === "ready" ? <ShieldCheck className="size-4" /> : <ShieldAlert className="size-4" />}
                {readiness.status === "ready" ? "CITY HAS HEALTHY RIG CAPACITY" : "CITY AT RISK"}
                {readiness.status === "at_risk" && <span className="font-normal">— {readiness.statusMessage}</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {/* Why are our rigs failing */}
          <Card>
            <CardHeader>
              <CardTitle>Why Are Our Rigs Failing?</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              {failureAnalysis.totalIncidents === 0 ? (
                <div className="text-sm text-success">No rig incidents in the last 30 days.</div>
              ) : (
                <>
                  <div className="space-y-2.5">
                    {failureAnalysis.breakdown.map((b) => (
                      <div key={b.group}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-muted">{b.label}</span>
                          <span className="font-medium tabular-nums">{b.pct}%</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, b.pct)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {failureAnalysis.biggest && (
                    <div className="rounded-md border border-border bg-surface-2 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-[11px] text-muted">BIGGEST FAILURE MODE</div>
                          <div className="text-sm font-semibold">{failureAnalysis.biggest.label}</div>
                          <div className="text-xs text-muted">{failureAnalysis.biggest.count} incidents</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[11px] text-muted">RECORDING IMPACT</div>
                          <div className="text-sm font-semibold text-critical tabular-nums">{fmtHours(failureAnalysis.biggest.lostHours)}</div>
                        </div>
                      </div>
                      {failureAnalysis.recommendedAction && (
                        <div className="text-xs pt-2 border-t border-border">
                          <span className="text-muted">RECOMMENDED ACTION: </span>
                          {failureAnalysis.recommendedAction}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border text-center">
                <MiniMetric label="Today" value={fmtHours(fleetLostHours.today)} />
                <MiniMetric label="This week" value={fmtHours(fleetLostHours.week)} />
                <MiniMetric label="This month" value={fmtHours(fleetLostHours.month)} />
              </div>
              <div className="text-[11px] text-muted-2">LOST RECORDING HOURS — the metric that matters most.</div>
            </CardContent>
          </Card>

          {/* Fleet Reliability */}
          <Card>
            <CardHeader>
              <CardTitle>Fleet Reliability</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div>
                <div className="text-xs font-medium text-success mb-2">Best</div>
                <div className="space-y-1.5">
                  {best.map((s) => (
                    <RankRow key={s.rig.id} summary={s} />
                  ))}
                </div>
              </div>
              {worst.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-critical mb-2">Needs attention</div>
                  <div className="space-y-1.5">
                    {worst.map((s) => (
                      <RankRow key={s.rig.id} summary={s} />
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border text-xs">
                <MiniMetric label="Incidents / rig" value={String(rateMetrics.incidentsPerRig)} />
                <MiniMetric label="Incidents / 100 sessions" value={String(rateMetrics.incidentsPer100Sessions)} />
                <MiniMetric label="Repeat failure rate" value={`${rateMetrics.repeatFailureRatePct}%`} />
                <MiniMetric label="Avg repair turnaround" value={rateMetrics.avgRepairTurnaroundHours != null ? fmtHours(rateMetrics.avgRepairTurnaroundHours) : "—"} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Rig grid */}
        <div>
          <div className="text-sm font-semibold mb-3">All Rigs</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {summaries.map((s) => (
              <Link key={s.rig.id} to={`/fleet/${s.rig.id}`}>
                <Card className="p-4 h-full hover:border-border-strong transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{s.rig.code}</div>
                      <div className="text-xs text-muted truncate">{s.rig.model}</div>
                    </div>
                    <RigReadinessBadge status={s.readiness} />
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-2xl font-bold tabular-nums">{s.score}</span>
                    <span className="text-xs text-muted">/ 100 health</span>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                    <span>{s.incidentCount30d} incident{s.incidentCount30d === 1 ? "" : "s"} (30d)</span>
                    {s.lostHours.month > 0 && <span className="text-critical">−{fmtHours(s.lostHours.month)}</span>}
                  </div>
                  {s.repeatedFailures.length > 0 && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-critical">
                      <TrendingDown className="size-3.5" /> Repeated failure pattern
                    </div>
                  )}
                  {s.inspection.required && (
                    <div className="flex items-center justify-between mt-2 gap-2">
                      <span className="flex items-center gap-1 text-xs text-warning">
                        <ClipboardList className="size-3.5" /> Inspection due
                      </span>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          requestRigInspection(s.rig.id, s.inspection.reasons[0]);
                        }}
                        className="text-[11px] text-primary hover:underline shrink-0"
                      >
                        Create task
                      </button>
                    </div>
                  )}
                  {s.rig.deploymentStatus === "repair" && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-info">
                      <Wrench className="size-3.5" /> In repair
                    </div>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <RigFormDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function ReadinessCount({ emoji, label, value, tone }: { emoji: string; label: string; value: number; tone: "success" | "warning" | "critical" }) {
  const toneClass = { success: "text-success", warning: "text-warning", critical: "text-critical" }[tone];
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 p-3 text-center">
      <div className="text-lg">{emoji}</div>
      <div className={`text-2xl font-bold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" }) {
  return (
    <div>
      <span className="text-muted">{label}: </span>
      <span className={`font-semibold tabular-nums ${tone === "critical" ? "text-critical" : ""}`}>{value}</span>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

function RankRow({ summary }: { summary: ReturnType<typeof buildFleetRanking>[number] }) {
  return (
    <Link to={`/fleet/${summary.rig.id}`} className="flex items-center gap-2 hover:underline">
      <span className="text-sm flex-1 truncate">{summary.rig.code}</span>
      <span className={`text-sm font-medium tabular-nums ${summary.score >= 80 ? "text-success" : summary.score >= 60 ? "text-warning" : "text-critical"}`}>{summary.score}/100</span>
      {!isDeployable(summary.readiness) && <ClipboardCheck className="size-3.5 text-critical" />}
    </Link>
  );
}
