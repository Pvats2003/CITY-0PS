import { Link } from "react-router-dom";
import type { EnrichedAssignment } from "@/engine/todayView";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status";
import { assignmentStatusToStatus } from "@/engine/todayView";
import { fmtTime } from "@/lib/dates";
import { EmptyState } from "@/components/shared/EmptyState";
import { Store, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BusinessView({ items, onStart }: { items: EnrichedAssignment[]; onStart: (id: string) => void }) {
  const byBiz = new Map<string, EnrichedAssignment[]>();
  for (const item of items) {
    const key = item.business?.id ?? "unknown";
    byBiz.set(key, [...(byBiz.get(key) ?? []), item]);
  }

  if (byBiz.size === 0) {
    return <EmptyState icon={Store} title="No businesses scheduled" description="Use the Planner tab to propose visits for today." />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {[...byBiz.entries()].map(([bizId, bizItems]) => {
        const biz = bizItems[0].business;
        return (
          <Card key={bizId}>
            <CardHeader>
              <CardTitle>
                <Link to={`/businesses/${bizId}`} className="hover:underline">
                  {biz?.name ?? "Unknown"}
                </Link>
              </CardTitle>
              <span className="text-xs text-muted">{biz?.area}</span>
            </CardHeader>
            <CardContent className="pt-0 space-y-0">
              {bizItems.map((item) => (
                <div key={item.assignment.id} className="flex items-center gap-2 py-2 border-t border-border first:border-t-0">
                  <span className="text-xs tabular-nums text-muted w-14 shrink-0">{fmtTime(item.assignment.plannedStart)}</span>
                  <Link to={`/field-officers/${item.fo?.id}`} className="text-sm flex-1 truncate hover:underline">
                    {item.fo?.name}
                  </Link>
                  <StatusBadge status={assignmentStatusToStatus(item.assignment.status)} />
                  {(item.assignment.status === "planned" || item.assignment.status === "confirmed") && (
                    <Button size="icon-sm" variant="ghost" onClick={() => onStart(item.assignment.id)} title="Start session">
                      <PlayCircle className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
