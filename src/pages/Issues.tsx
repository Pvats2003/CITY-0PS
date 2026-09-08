import { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { AlertTriangle, PlusCircle, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SEVERITY_META, StatusBadge } from "@/components/status";
import { useCity } from "@/store/city";
import { relTime } from "@/lib/dates";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";
import { ResolveIssueDialog } from "@/components/forms/ResolveIssueDialog";
import type { Issue } from "@/types";

export default function Issues() {
  const data = useCity();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get("severity") === "critical" ? "critical" : "open");
  const [businessFilter, setBusinessFilter] = useState("all");
  const [foFilter, setFoFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(params.get("new") === "1");
  const [resolveTarget, setResolveTarget] = useState<Issue | undefined>();

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));

  const filtered = data.issues.filter((i) => {
    if (businessFilter !== "all" && i.businessId !== businessFilter) return false;
    if (foFilter !== "all" && i.foId !== foFilter) return false;
    return true;
  });

  const byTab = useMemo(() => {
    switch (tab) {
      case "critical":
        return filtered.filter((i) => i.severity === "critical" && i.status !== "resolved" && i.status !== "cancelled");
      case "open":
        return filtered.filter((i) => i.status === "open" || i.status === "in_progress");
      case "resolved":
        return filtered.filter((i) => i.status === "resolved");
      default:
        return filtered;
    }
  }, [filtered, tab]);

  const sorted = [...byTab].sort((a, b) => {
    const rank = { critical: 0, warning: 1, attention: 2, opportunity: 3 } as const;
    const r = rank[a.severity] - rank[b.severity];
    if (r !== 0) return r;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  function closeCreate(v: boolean) {
    setCreateOpen(v);
    if (!v && params.get("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }

  const openCount = data.issues.filter((i) => i.status === "open" || i.status === "in_progress").length;
  const criticalCount = data.issues.filter((i) => i.severity === "critical" && (i.status === "open" || i.status === "in_progress")).length;

  return (
    <div className="pb-10">
      <PageHeader
        title="Issues"
        subtitle={`${openCount} open · ${criticalCount} critical`}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusCircle className="size-4" /> Report Issue
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="open">Action Inbox</TabsTrigger>
              <TabsTrigger value="critical">Critical</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex gap-2">
            <Select value={businessFilter} onValueChange={setBusinessFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="By business" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {data.businesses.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={foFilter} onValueChange={setFoFilter}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="By FO" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All FOs</SelectItem>
                {data.fos.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="pt-4">
          {sorted.length === 0 ? (
            <EmptyState
              icon={tab === "open" ? CheckCircle2 : AlertTriangle}
              title={tab === "open" ? "Nothing needs action" : "No issues here"}
              description={tab === "open" ? "All caught up — the city is running smoothly." : "Try a different tab or filter."}
            />
          ) : (
            <Card className="divide-y divide-border overflow-hidden">
              {sorted.map((issue) => {
                const meta = SEVERITY_META[issue.severity];
                const biz = issue.businessId ? bizMap.get(issue.businessId) : undefined;
                const fo = issue.foId ? foMap.get(issue.foId) : undefined;
                const rig = issue.rigId ? rigMap.get(issue.rigId) : undefined;
                return (
                  <div key={issue.id} className="flex gap-3 p-4">
                    <div className="text-base leading-none mt-0.5">{meta.emoji}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <Link to={`/issues/${issue.id}`} className="text-sm font-medium hover:underline">
                          {issue.title}
                        </Link>
                        <span className="text-xs text-muted-2 shrink-0 tabular-nums">{relTime(issue.createdAt)}</span>
                      </div>
                      <div className="text-xs text-muted mt-0.5">{issue.description}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        {biz && (
                          <Link to={`/businesses/${biz.id}`} className="text-xs text-primary hover:underline">
                            {biz.name}
                          </Link>
                        )}
                        {fo && (
                          <Link to={`/field-officers/${fo.id}`} className="text-xs text-primary hover:underline">
                            {fo.name}
                          </Link>
                        )}
                        {rig && <span className="text-xs text-muted">{rig.code}</span>}
                        <StatusBadge status={issue.status === "resolved" ? "completed" : issue.status === "cancelled" ? "cancelled" : issue.severity === "critical" ? "critical" : "warning"} />
                        {issue.lostHours ? <span className="text-xs text-critical tabular-nums">−{issue.lostHours}h</span> : null}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      {issue.status !== "resolved" && issue.status !== "cancelled" && (
                        <Button size="sm" variant="secondary" onClick={() => setResolveTarget(issue)}>
                          Resolve
                        </Button>
                      )}
                      <Button asChild size="sm" variant="ghost">
                        <Link to={`/issues/${issue.id}`}>View</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      </div>

      <IssueFormDialog open={createOpen} onOpenChange={closeCreate} />
      <ResolveIssueDialog open={!!resolveTarget} onOpenChange={(v) => !v && setResolveTarget(undefined)} issue={resolveTarget} />
    </div>
  );
}
