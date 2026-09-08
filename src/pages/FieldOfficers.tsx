import { useState } from "react";
import { Link } from "react-router-dom";
import { PlusCircle, Users } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status";
import { useCity } from "@/store/city";
import { computeFOStats } from "@/engine/insights";
import { todayISO } from "@/lib/dates";
import { FOFormDialog } from "@/components/forms/FOFormDialog";

export default function FieldOfficers() {
  const data = useCity();
  const [open, setOpen] = useState(false);
  const date = todayISO();

  return (
    <div className="pb-10">
      <PageHeader
        title="Field Officers"
        subtitle={`${data.fos.length} total · ${data.fos.filter((f) => f.active).length} active`}
        actions={
          <Button onClick={() => setOpen(true)}>
            <PlusCircle className="size-4" /> Add Field Officer
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-5">
        {data.fos.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No field officers yet"
            description="Add FOs so you can assign them to visits and sessions."
            action={
              <Button onClick={() => setOpen(true)}>
                <PlusCircle className="size-4" /> Add Field Officer
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.fos.map((fo) => {
              const stats = computeFOStats(data, fo);
              const todaysAssignments = data.assignments.filter((a) => a.foId === fo.id && a.date === date);
              const activeNow = todaysAssignments.some((a) => a.status === "in_progress");
              return (
                <Link key={fo.id} to={`/field-officers/${fo.id}`}>
                  <Card className="p-4 h-full hover:border-border-strong transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm shrink-0">
                          {fo.name
                            .split(" ")
                            .map((p) => p[0])
                            .join("")
                            .slice(0, 2)}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">{fo.name}</div>
                          <div className="text-xs text-muted truncate">{fo.homeArea ?? "—"}</div>
                        </div>
                      </div>
                      <StatusBadge status={!fo.active ? "offline" : activeNow ? "active" : "healthy"} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border text-center">
                      <div>
                        <div className="text-sm font-semibold tabular-nums">{stats.attendancePct}%</div>
                        <div className="text-[10px] text-muted">Attendance</div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold tabular-nums">{stats.onTimePct}%</div>
                        <div className="text-[10px] text-muted">On-time</div>
                      </div>
                      <div>
                        <div className="text-sm font-semibold tabular-nums">{stats.visitsCompleted}</div>
                        <div className="text-[10px] text-muted">Visits</div>
                      </div>
                    </div>
                    <div className="text-xs text-muted mt-2">
                      {todaysAssignments.length > 0 ? `${todaysAssignments.length} visit${todaysAssignments.length === 1 ? "" : "s"} today` : "Nothing scheduled today"}
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <FOFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
