import { Link } from "react-router-dom";
import type { EnrichedAssignment } from "@/engine/todayView";
import { EmptyState } from "@/components/shared/EmptyState";
import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtTime } from "@/lib/dates";

const STATUS_BLOCK: Record<string, string> = {
  planned: "bg-neutral/40 border-neutral/60 text-foreground",
  confirmed: "bg-neutral/40 border-neutral/60 text-foreground",
  in_progress: "bg-info/30 border-info text-foreground animate-pulse",
  completed: "bg-success/25 border-success text-foreground",
  rejected: "bg-critical/25 border-critical text-foreground",
  no_show: "bg-critical/25 border-critical text-foreground",
  cancelled: "bg-surface-2 border-border text-muted",
};

export function TimelineView({
  items,
  workStart = "08:00",
  workEnd = "19:00",
}: {
  items: EnrichedAssignment[];
  workStart?: string;
  workEnd?: string;
}) {
  const byFO = new Map<string, EnrichedAssignment[]>();
  for (const item of items) {
    const key = item.fo?.id ?? "unassigned";
    byFO.set(key, [...(byFO.get(key) ?? []), item]);
  }

  if (byFO.size === 0) {
    return <EmptyState icon={CalendarClock} title="Nothing to show on the timeline" description="Plan the day to see FO swimlanes here." />;
  }

  const [wsH, wsM] = workStart.split(":").map(Number);
  const [weH, weM] = workEnd.split(":").map(Number);
  const startMin = wsH * 60 + wsM;
  const endMin = weH * 60 + weM;
  const totalMin = Math.max(1, endMin - startMin);

  const hourMarks: number[] = [];
  for (let h = Math.ceil(startMin / 60); h <= Math.floor(endMin / 60); h++) hourMarks.push(h);

  function pos(iso: string) {
    const d = new Date(iso);
    const min = d.getHours() * 60 + d.getMinutes();
    return Math.max(0, Math.min(100, ((min - startMin) / totalMin) * 100));
  }

  // Greedily assign overlapping assignments within a lane to separate stacked rows.
  function layoutLanes(foItems: EnrichedAssignment[]): { item: EnrichedAssignment; row: number }[] {
    const sorted = [...foItems].sort((a, b) => new Date(a.assignment.plannedStart).getTime() - new Date(b.assignment.plannedStart).getTime());
    const rowEnds: number[] = [];
    return sorted.map((item) => {
      const start = new Date(item.assignment.plannedStart).getTime();
      const end = new Date(item.assignment.plannedEnd).getTime();
      let row = rowEnds.findIndex((e) => e <= start);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(end);
      } else {
        rowEnds[row] = end;
      }
      return { item, row };
    });
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className="relative h-6 ml-32 mb-1">
          {hourMarks.map((h) => (
            <div
              key={h}
              className="absolute text-[10px] text-muted-2 -translate-x-1/2"
              style={{ left: `${((h * 60 - startMin) / totalMin) * 100}%` }}
            >
              {h % 12 === 0 ? 12 : h % 12}
              {h < 12 ? "a" : "p"}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {[...byFO.entries()].map(([foId, foItems]) => {
            const laid = layoutLanes(foItems);
            const rowCount = Math.max(1, ...laid.map((l) => l.row + 1));
            const laneHeight = 32;
            return (
              <div key={foId} className="flex items-center gap-2">
                <Link to={`/field-officers/${foId}`} className="w-32 shrink-0 text-xs font-medium truncate hover:underline">
                  {foItems[0].fo?.name ?? "Unassigned"}
                </Link>
                <div className="relative flex-1 rounded-md bg-surface-2/60" style={{ height: rowCount * laneHeight + 8 }}>
                  {hourMarks.map((h) => (
                    <div
                      key={h}
                      className="absolute top-0 bottom-0 w-px bg-border"
                      style={{ left: `${((h * 60 - startMin) / totalMin) * 100}%` }}
                    />
                  ))}
                  {laid.map(({ item, row }) => {
                    const left = pos(item.assignment.plannedStart);
                    const right = pos(item.assignment.plannedEnd);
                    const width = Math.max(2, right - left);
                    return (
                      <Tooltip key={item.assignment.id}>
                        <TooltipTrigger asChild>
                          <Link
                            to={`/businesses/${item.business?.id}`}
                            className={cn(
                              "absolute rounded border px-1.5 flex items-center text-[11px] font-medium overflow-hidden whitespace-nowrap",
                              STATUS_BLOCK[item.assignment.status] ?? "bg-surface-2 border-border",
                            )}
                            style={{ left: `${left}%`, width: `${width}%`, top: row * laneHeight + 4, height: laneHeight - 6 }}
                          >
                            {item.business?.name}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="font-medium">{item.business?.name}</div>
                          <div className="text-muted-2">
                            {fmtTime(item.assignment.plannedStart)} – {fmtTime(item.assignment.plannedEnd)} · {item.assignment.status.replace("_", " ")}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
