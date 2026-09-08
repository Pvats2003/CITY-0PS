import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radio, Battery, HardDrive, Wifi, Search } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/status";
import { Progress } from "@/components/ui/progress";
import { useCity } from "@/store/city";
import { fmtDateTime, fmtDuration } from "@/lib/dates";

function useTick(intervalMs: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

export default function Sessions() {
  const data = useCity();
  useTick(1000);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));
  const colMap = new Map(data.collectors.map((c) => [c.id, c]));

  const live = data.sessions.filter((s) => s.status === "active");
  const history = data.sessions
    .filter((s) => s.status !== "active")
    .filter((s) => {
      if (status !== "all" && s.status !== status) return false;
      if (query) {
        const biz = bizMap.get(s.businessId)?.name ?? "";
        const fo = foMap.get(s.foId)?.name ?? "";
        if (!`${biz} ${fo}`.toLowerCase().includes(query.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return (
    <div className="pb-10">
      <PageHeader title="Session Center" subtitle={`${live.length} live · ${data.sessions.length} total sessions`} />

      <div className="px-4 md:px-6 pt-5 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Radio className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Live Sessions</h2>
          </div>
          {live.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="No active sessions"
              description="Start a session from Today's Plan to see it here in real time."
              className="border border-border rounded-lg"
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {live.map((s) => {
                const elapsedMin = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000);
                const h = Math.floor(elapsedMin / 60);
                const m = elapsedMin % 60;
                return (
                  <Link key={s.id} to={`/sessions/${s.id}`}>
                    <Card className="p-4 h-full hover:border-border-strong transition-colors border-info/30">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-sm font-semibold">{bizMap.get(s.businessId)?.name}</div>
                          <div className="text-xs text-muted mt-0.5">
                            {foMap.get(s.foId)?.name} {colMap.get(s.collectorId ?? "") && `· ${colMap.get(s.collectorId ?? "")?.name}`}
                          </div>
                        </div>
                        <StatusBadge status="active" />
                      </div>
                      <div className="text-2xl font-bold tabular-nums mt-3">
                        {h}h {m}m
                      </div>
                      <div className="text-xs text-muted">of {fmtDuration(s.plannedDurationMin)} planned</div>
                      <div className="space-y-2 mt-3">
                        <MiniBar icon={Battery} label="Battery" value={s.batteryPct} tone={s.batteryPct < 30 ? "critical" : "default"} />
                        <MiniBar icon={HardDrive} label="Storage" value={s.storagePct} tone={s.storagePct > 85 ? "warning" : "default"} />
                      </div>
                      <div className="flex items-center gap-1.5 text-xs mt-2.5">
                        <Wifi className={`size-3.5 ${s.signal === "healthy" ? "text-success" : "text-warning"}`} />
                        {s.signal === "healthy" ? "Signal healthy" : "Signal intermittent"}
                        {rigMap.get(s.rigId ?? "") && <span className="text-muted ml-auto">{rigMap.get(s.rigId ?? "")?.code}</span>}
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold">All Sessions</h2>
            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-2" />
                <Input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8 w-48" />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Card>
            <CardContent className="p-0">
              {history.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted">No sessions match your filters.</div>
              ) : (
                <div className="divide-y divide-border">
                  {history.slice(0, 60).map((s) => {
                    const review = data.qualityReviews.find((q) => q.sessionId === s.id);
                    return (
                      <Link key={s.id} to={`/sessions/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/50">
                        <div className="w-32 shrink-0 text-xs text-muted tabular-nums">{fmtDateTime(s.startedAt)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{bizMap.get(s.businessId)?.name}</div>
                          <div className="text-xs text-muted truncate">{foMap.get(s.foId)?.name}</div>
                        </div>
                        {review && (
                          <StatusBadge status={review.verdict === "pass" ? "healthy" : review.verdict === "warn" ? "warning" : "critical"}>
                            QA {review.verdict}
                          </StatusBadge>
                        )}
                        <StatusBadge status={s.status === "completed" ? "completed" : s.status} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MiniBar({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone: "default" | "critical" | "warning";
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className={`size-3.5 ${tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-muted"}`} />
      <span className="text-muted w-12 shrink-0">{label}</span>
      <Progress value={value} className="flex-1 h-1.5" indicatorClassName={tone === "critical" ? "bg-critical" : tone === "warning" ? "bg-warning" : undefined} />
      <span className="tabular-nums w-8 text-right">{value}%</span>
    </div>
  );
}
