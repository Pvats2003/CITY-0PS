import { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Copy, Download, Printer, CheckCircle2, X, Lightbulb, TrendingUp, Cpu } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status";
import { useCity } from "@/store/city";
import { todayISO, fmtDate, fmtTime, fmtHours } from "@/lib/dates";
import { buildSOD, buildMOD, buildEOD, buildTomorrowRecommendations } from "@/engine/reports";
import { requestRigInspection } from "@/engine/workflows";

export default function Reports() {
  const data = useCity();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "sod";
  const [date, setDate] = useState(todayISO());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const updateBusiness = useCity((s) => s.updateBusiness);
  const addReport = useCity((s) => s.addReport);
  const logActivity = useCity((s) => s.logActivity);

  const sod = useMemo(() => buildSOD(data, date), [data, date]);
  const mod = useMemo(() => buildMOD(data, date), [data, date]);
  const eod = useMemo(() => buildEOD(data, date), [data, date]);
  const recs = useMemo(() => buildTomorrowRecommendations(data, date), [data, date]);

  function setTab(t: string) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("tab", t);
      return next;
    });
  }

  function reportText(): string {
    if (tab === "sod") {
      return [
        `START OF DAY — ${fmtDate(date)}`,
        `Expected hours: ${sod.expectedHours}h / ${sod.targetHours}h target`,
        ``,
        `BUSINESSES PLANNED (${sod.businessesPlanned.length})`,
        ...sod.businessesPlanned.map((b) => `- ${fmtTime(b.time)} ${b.name} (${b.foName})`),
        ``,
        `RISKS`,
        ...(sod.risks.length ? sod.risks.map((r) => `- ${r}`) : ["- None identified"]),
        ``,
        `ACTIONS`,
        ...sod.actions.map((a) => `- ${a}`),
      ].join("\n");
    }
    if (tab === "mod") {
      return [
        `MID DAY — ${fmtDate(date)}`,
        `Planned: ${mod.plannedHours}h · Actual so far: ${mod.actualHours}h`,
        `Completed visits: ${mod.completedVisits}/${mod.totalPlannedVisits}`,
        `Active sessions: ${mod.activeSessions}`,
        `Delays: ${mod.delays} · Open issues: ${mod.openIssues}`,
        `Projected EOD: ${mod.projectedEODHours}h (${mod.projectedAchievementPct}% of target)`,
      ].join("\n");
    }
    if (tab === "eod") {
      return [
        `END OF DAY — ${fmtDate(date)}`,
        `Businesses completed: ${eod.businessesCompleted}/${eod.businessesPlanned}`,
        `Recording hours: ${eod.recordingHours}h / ${eod.targetHours}h (${eod.achievementPct}%)`,
        `Quality pass rate: ${eod.qualityPassRate}%`,
        `Issues: ${eod.issueCount}`,
        `Lost hours: ${eod.lostHours.totalLost}h`,
        ...eod.lostHours.breakdown.map((b) => `  - ${b.label}: -${b.hours}h`),
        `City Health: ${eod.healthScore}/100`,
        ``,
        `FLEET / RIG PERFORMANCE`,
        `Rig incidents: ${eod.rigPerformance.incidentCount} · Lost hours: ${eod.rigPerformance.lostHours}h`,
        ...(eod.rigPerformance.actionForTomorrow ? [`Action for tomorrow: ${eod.rigPerformance.actionForTomorrow}`] : []),
        ``,
        `NARRATIVE`,
        eod.narrative,
      ].join("\n");
    }
    return [`TOMORROW RECOMMENDATIONS — ${fmtDate(date)}`, ...recs.map((r) => `- ${r.description} (${r.reasoning})`)].join("\n");
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(reportText());
    } catch {
      // clipboard unavailable — no-op, user can still use Export JSON
    }
  }

  function exportJson() {
    const kindMap = { sod, mod, eod, tomorrow: { recommendations: recs } } as const;
    const payload = (kindMap as Record<string, unknown>)[tab] ?? {};
    const reportKind = tab === "tomorrow" ? "eod" : (tab as "sod" | "mod" | "eod");
    const report = addReport({ date, kind: reportKind, data: payload as Record<string, unknown>, narrative: tab === "eod" ? eod.narrative : undefined });
    const blob = new Blob([JSON.stringify({ ...report, data: payload }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `city-ops-${tab}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyRecommendation(recId: string) {
    const rec = recs.find((r) => r.id === recId);
    if (!rec) return;
    if (rec.patch?.businessId && rec.patch?.time) {
      const [h, m] = rec.patch.time.split(":").map(Number);
      const endH = Math.min(23, h + 2);
      updateBusiness(rec.patch.businessId, {
        preferredWindowStart: rec.patch.time,
        preferredWindowEnd: `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      });
    }
    if (rec.patch?.rigId) {
      requestRigInspection(rec.patch.rigId, rec.reasoning);
    }
    if (rec.patch?.replaceRigId) {
      requestRigInspection(rec.patch.replaceRigId, rec.reasoning);
    }
    logActivity({ type: "plan_changed", entityKind: "plan", entityId: recId, summary: `Applied recommendation: ${rec.description}` });
    setApplied((s) => new Set(s).add(recId));
  }

  return (
    <div className="pb-10 print:pb-0">
      <div className="print:hidden">
        <PageHeader
          title="Reports"
          subtitle="Start of Day, Mid Day, End of Day, and tomorrow's recommendations — generated from live data."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
              <Button variant="secondary" size="sm" onClick={copyReport}>
                <Copy className="size-4" /> Copy Report
              </Button>
              <Button variant="secondary" size="sm" onClick={exportJson}>
                <Download className="size-4" /> Export JSON
              </Button>
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                <Printer className="size-4" /> Print
              </Button>
            </div>
          }
        />

        <div className="px-4 md:px-6 pt-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="sod">SOD</TabsTrigger>
              <TabsTrigger value="mod">MOD</TabsTrigger>
              <TabsTrigger value="eod">EOD</TabsTrigger>
              <TabsTrigger value="tomorrow">Tomorrow</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-5 max-w-3xl print:px-0 print:pt-0">
        {tab === "sod" && (
          <div className="space-y-5">
            <ReportTitle kind="Start of Day" date={date} />
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Expected Hours" value={fmtHours(sod.expectedHours)} />
              <Stat label="Target" value={fmtHours(sod.targetHours, 0)} />
            </div>
            <Section title={`Businesses Planned (${sod.businessesPlanned.length})`}>
              {sod.businessesPlanned.length === 0 ? (
                <div className="text-sm text-muted">Nothing planned yet.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {sod.businessesPlanned.map((b, i) => (
                    <li key={i} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        <Link to={`/businesses/${b.id}`} className="hover:underline">
                          {b.name}
                        </Link>{" "}
                        <span className="text-muted">· {b.foName}</span>
                      </span>
                      <span className="tabular-nums text-muted">{fmtTime(b.time)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Risks">
              {sod.risks.length === 0 ? (
                <div className="text-sm text-success">No blocking risks identified.</div>
              ) : (
                <ul className="space-y-1 text-sm">
                  {sod.risks.map((r, i) => (
                    <li key={i} className="text-warning">
                      • {r}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Important Actions">
              <ul className="space-y-1 text-sm">
                {sod.actions.map((a, i) => (
                  <li key={i}>• {a}</li>
                ))}
              </ul>
            </Section>
          </div>
        )}

        {tab === "mod" && (
          <div className="space-y-5">
            <ReportTitle kind="Mid Day" date={date} />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Planned Hours" value={fmtHours(mod.plannedHours)} />
              <Stat label="Actual So Far" value={fmtHours(mod.actualHours)} />
              <Stat label="Projected EOD" value={fmtHours(mod.projectedEODHours)} sub={`${mod.projectedAchievementPct}% of target`} />
              <Stat label="Completed Visits" value={`${mod.completedVisits}/${mod.totalPlannedVisits}`} />
              <Stat label="Active Sessions" value={mod.activeSessions} />
              <Stat label="Delays" value={mod.delays} tone={mod.delays > 0 ? "warning" : undefined} />
            </div>
            {mod.openIssues > 0 && (
              <div className="rounded-md border border-warning/25 bg-warning-bg px-3 py-2.5 text-sm">
                {mod.openIssues} open issue{mod.openIssues === 1 ? "" : "s"} today —{" "}
                <Link to="/issues" className="underline">
                  review Action Inbox
                </Link>
                .
              </div>
            )}
          </div>
        )}

        {tab === "eod" && (
          <div className="space-y-5">
            <ReportTitle kind="End of Day" date={date} />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Businesses" value={`${eod.businessesCompleted}/${eod.businessesPlanned}`} />
              <Stat label="Recording Hours" value={fmtHours(eod.recordingHours)} sub={`of ${eod.targetHours}h target`} />
              <Stat label="Achievement" value={`${eod.achievementPct}%`} tone={eod.achievementPct >= 90 ? "success" : eod.achievementPct >= 70 ? "warning" : "critical"} />
              <Stat label="Quality Pass Rate" value={`${eod.qualityPassRate}%`} />
              <Stat label="Issues" value={eod.issueCount} tone={eod.issueCount > 0 ? "warning" : undefined} />
              <Stat label="City Health" value={eod.healthScore} />
            </div>

            <Section title="Lost Hours">
              {eod.lostHours.breakdown.length === 0 ? (
                <div className="text-sm text-success">No recorded losses today.</div>
              ) : (
                <>
                  <div className="text-2xl font-bold text-critical tabular-nums">−{fmtHours(eod.lostHours.totalLost)}</div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {eod.lostHours.breakdown.map((b, i) => (
                      <li key={i} className="flex items-center justify-between">
                        <span>{b.label}</span>
                        <span className="text-critical tabular-nums">−{fmtHours(b.hours)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>

            <Section title="Fleet / Rig Performance">
              {eod.rigPerformance.incidentCount === 0 ? (
                <div className="text-sm text-success">No rig incidents today.</div>
              ) : (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-muted">
                      <Cpu className="size-3.5" /> Incidents
                    </span>
                    <span className="tabular-nums">{eod.rigPerformance.incidentCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Lost recording hours</span>
                    <span className="text-critical tabular-nums">−{fmtHours(eod.rigPerformance.lostHours)}</span>
                  </div>
                  {eod.rigPerformance.worstAffectedRig && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Worst affected rig</span>
                      <Link to={`/fleet/${eod.rigPerformance.worstAffectedRig.id}`} className="hover:underline tabular-nums">
                        {eod.rigPerformance.worstAffectedRig.code} ({eod.rigPerformance.worstAffectedRig.incidentCount})
                      </Link>
                    </div>
                  )}
                  {eod.rigPerformance.rigsNeedingInspection.length > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted">Needs inspection</span>
                      <span className="tabular-nums">
                        {eod.rigPerformance.rigsNeedingInspection.map((r, i) => (
                          <span key={r.id}>
                            {i > 0 && ", "}
                            <Link to={`/fleet/${r.id}`} className="hover:underline">
                              {r.code}
                            </Link>
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                  {eod.rigPerformance.actionForTomorrow && (
                    <div className="border-t border-border pt-2 mt-2 flex items-start gap-1.5">
                      <Lightbulb className="size-3.5 shrink-0 mt-0.5 text-muted" />
                      {eod.rigPerformance.actionForTomorrow}
                    </div>
                  )}
                </div>
              )}
            </Section>

            <Section title="FO Performance">
              <ul className="space-y-1.5 text-sm">
                {eod.foPerformance.map((f) => (
                  <li key={f.id} className="flex items-center justify-between">
                    <Link to={`/field-officers/${f.id}`} className="hover:underline">
                      {f.name}
                    </Link>
                    <span className="text-muted tabular-nums">
                      {f.visits} visits · {f.onTimePct}% on-time
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="City Daily Review">
              <div className="flex items-start gap-2 text-sm">
                <TrendingUp className="size-4 shrink-0 mt-0.5 text-muted" />
                <span>{eod.narrative}</span>
              </div>
            </Section>
          </div>
        )}

        {tab === "tomorrow" && (
          <div className="space-y-5 print:hidden">
            <ReportTitle kind="Tomorrow Recommendations" date={date} />
            {recs.length === 0 ? (
              <div className="text-sm text-muted">No recommendations — today went smoothly, or there isn't enough data yet.</div>
            ) : (
              <div className="space-y-2.5">
                {recs
                  .filter((r) => !dismissed.has(r.id))
                  .map((r, i) => (
                    <Card key={r.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold shrink-0">{i + 1}</div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{r.description}</div>
                          <div className="text-xs text-muted mt-1 flex items-start gap-1.5">
                            <Lightbulb className="size-3.5 shrink-0 mt-0.5" /> {r.reasoning}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {applied.has(r.id) ? (
                            <StatusBadge status="completed">Applied</StatusBadge>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => applyRecommendation(r.id)}>
                              <CheckCircle2 className="size-3.5" /> Apply
                            </Button>
                          )}
                          <Button size="icon-sm" variant="ghost" onClick={() => setDismissed((s) => new Set(s).add(r.id))}>
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportTitle({ kind, date }: { kind: string; date: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted tracking-wide">{kind.toUpperCase()}</div>
      <div className="text-lg font-semibold">{fmtDate(date, "EEEE, MMMM d, yyyy")}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "success" | "warning" | "critical" }) {
  const toneClass = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "critical" ? "text-critical" : "text-foreground";
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-2 mt-0.5">{sub}</div>}
    </div>
  );
}
