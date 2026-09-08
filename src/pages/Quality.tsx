import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ShieldAlert, ShieldX, Clock, Wrench } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status";
import { useCity } from "@/store/city";
import { fmtDateTime } from "@/lib/dates";
import { QualityReviewDialog } from "@/components/forms/QualityReviewDialog";
import type { QualityReview } from "@/types";

export default function Quality() {
  const data = useCity();
  const [tab, setTab] = useState("awaiting");
  const [target, setTarget] = useState<QualityReview | undefined>();

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));

  const awaiting = data.qualityReviews.filter((q) => !q.reviewedAt);
  const flagged = data.qualityReviews.filter((q) => q.verdict === "warn" || q.verdict === "fail");
  const passed = data.qualityReviews.filter((q) => q.verdict === "pass");
  const failed = data.qualityReviews.filter((q) => q.verdict === "fail");

  const list = useMemo(() => {
    switch (tab) {
      case "flagged":
        return flagged;
      case "passed":
        return passed;
      case "failed":
        return failed;
      default:
        return awaiting;
    }
  }, [tab, awaiting, flagged, passed, failed]);

  const sorted = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const passRate = data.qualityReviews.length ? Math.round((passed.length / data.qualityReviews.length) * 100) : 100;

  return (
    <div className="pb-10">
      <PageHeader title="Quality Center" subtitle={`${passRate}% pass rate · ${awaiting.length} awaiting review`} />

      <div className="px-4 md:px-6 pt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Clock} label="Awaiting Review" value={awaiting.length} tone="warning" />
        <SummaryCard icon={ShieldCheck} label="Passed" value={passed.length} tone="success" />
        <SummaryCard icon={ShieldAlert} label="Warnings" value={data.qualityReviews.filter((q) => q.verdict === "warn").length} tone="warning" />
        <SummaryCard icon={ShieldX} label="Failed" value={failed.length} tone="critical" />
      </div>

      <div className="px-4 md:px-6 pt-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="awaiting">Awaiting Review</TabsTrigger>
            <TabsTrigger value="flagged">Flagged</TabsTrigger>
            <TabsTrigger value="passed">Passed</TabsTrigger>
            <TabsTrigger value="failed">Failed</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="pt-4">
          {sorted.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Nothing here" description="No sessions match this view right now." />
          ) : (
            <Card className="divide-y divide-border overflow-hidden">
              {sorted.map((q) => {
                const biz = bizMap.get(q.businessId);
                const fo = foMap.get(q.foId);
                const correctiveAction = q.correctiveActionId ? data.correctiveActions.find((c) => c.id === q.correctiveActionId) : undefined;
                return (
                  <div key={q.id} className="flex items-center gap-3 p-4">
                    <VerdictIcon verdict={q.verdict} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link to={`/sessions/${q.sessionId}`} className="text-sm font-medium hover:underline">
                          {biz?.name ?? "Session"}
                        </Link>
                        <span className="text-xs text-muted">{fo?.name}</span>
                      </div>
                      {q.flags.length > 0 && <div className="text-xs text-muted mt-0.5">{q.flags.map((f) => f.label).join(" · ")}</div>}
                      <div className="text-[11px] text-muted-2 mt-1 tabular-nums">{fmtDateTime(q.createdAt)}</div>
                      {correctiveAction && (
                        <div className="flex items-center gap-1.5 text-xs text-warning mt-1">
                          <Wrench className="size-3.5" /> Corrective action: {correctiveAction.type.replace("_", " ")}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!q.reviewedAt || q.verdict !== "pass" ? (
                        <Button size="sm" variant="secondary" onClick={() => setTarget(q)}>
                          Review
                        </Button>
                      ) : (
                        <StatusBadge status="completed">Reviewed</StatusBadge>
                      )}
                      <Button asChild size="sm" variant="ghost">
                        <Link to={`/sessions/${q.sessionId}`}>View</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      </div>

      <QualityReviewDialog open={!!target} onOpenChange={(v) => !v && setTarget(undefined)} review={target} />
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: QualityReview["verdict"] }) {
  if (verdict === "pass") return <ShieldCheck className="size-5 text-success shrink-0" />;
  if (verdict === "warn") return <ShieldAlert className="size-5 text-warning shrink-0" />;
  if (verdict === "fail") return <ShieldX className="size-5 text-critical shrink-0" />;
  return <Clock className="size-5 text-muted shrink-0" />;
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone: "success" | "warning" | "critical";
}) {
  const toneClass = { success: "text-success", warning: "text-warning", critical: "text-critical" }[tone];
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        <Icon className={`size-4 ${toneClass}`} />
      </div>
      <div className={`text-2xl font-bold tabular-nums mt-1.5 ${toneClass}`}>{value}</div>
    </div>
  );
}
