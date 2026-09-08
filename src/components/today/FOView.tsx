import { Link } from "react-router-dom";
import type { EnrichedAssignment } from "@/engine/todayView";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status";
import { assignmentStatusToStatus } from "@/engine/todayView";
import { fmtTime } from "@/lib/dates";
import { EmptyState } from "@/components/shared/EmptyState";
import { Users, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function FOView({ items, onStart }: { items: EnrichedAssignment[]; onStart: (id: string) => void }) {
  const byFO = new Map<string, EnrichedAssignment[]>();
  for (const item of items) {
    const key = item.fo?.id ?? "unassigned";
    byFO.set(key, [...(byFO.get(key) ?? []), item]);
  }

  if (byFO.size === 0) {
    return <EmptyState icon={Users} title="No field officers scheduled" description="Assign FOs from the Planner tab." />;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {[...byFO.entries()].map(([foId, foItems]) => {
        const fo = foItems[0].fo;
        const completed = foItems.filter((i) => i.assignment.status === "completed").length;
        return (
          <Card key={foId}>
            <CardHeader>
              <CardTitle>
                <Link to={`/field-officers/${foId}`} className="hover:underline">
                  {fo?.name ?? "Unassigned"}
                </Link>
              </CardTitle>
              <span className="text-xs text-muted tabular-nums">
                {completed}/{foItems.length} done
              </span>
            </CardHeader>
            <CardContent className="pt-0 space-y-0">
              {foItems.map((item) => (
                <div key={item.assignment.id} className="flex items-center gap-2 py-2 border-t border-border first:border-t-0">
                  <span className="text-xs tabular-nums text-muted w-14 shrink-0">{fmtTime(item.assignment.plannedStart)}</span>
                  <Link to={`/businesses/${item.business?.id}`} className="text-sm flex-1 truncate hover:underline">
                    {item.business?.name}
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
