import { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, CalendarClock, List, Users, Store, Sparkles, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useCity } from "@/store/city";
import { todayISO, fmtDate } from "@/lib/dates";
import { enrichAssignments } from "@/engine/todayView";
import { plannedHoursForDate, recordedHoursForDate } from "@/engine/selectors";
import { detectConflicts } from "@/engine/planner";
import { TimelineView } from "@/components/today/TimelineView";
import { ListView } from "@/components/today/ListView";
import { FOView } from "@/components/today/FOView";
import { BusinessView } from "@/components/today/BusinessView";
import { Planner } from "@/components/today/Planner";
import { StartSessionDialog } from "@/components/today/StartSessionDialog";

function shiftDate(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function Today() {
  const data = useCity();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "timeline";
  const [date, setDate] = useState(todayISO());
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [preselect, setPreselect] = useState<string | undefined>();

  const items = useMemo(() => enrichAssignments(data, date), [data, date]);
  const planned = plannedHoursForDate(data, date);
  const recorded = recordedHoursForDate(data, date);
  const conflicts = useMemo(
    () => detectConflicts(items.map((i) => i.assignment), data, date).filter((c) => c.type === "fo_double_booking" || c.type === "rig_double_booking"),
    [items, data, date],
  );

  function setTab(t: string) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("tab", t);
      return next;
    });
  }

  function openStart(id?: string) {
    setPreselect(id);
    setStartDialogOpen(true);
  }

  return (
    <div className="pb-10">
      <PageHeader
        title="Today"
        subtitle={
          <span className="tabular-nums">
            {planned.toFixed(1)}h planned · {recorded.toFixed(1)}h recorded
          </span>
        }
        actions={
          tab !== "planner" ? (
            <div className="flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" onClick={() => setDate((d) => shiftDate(d, -1))}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDate(todayISO())} className="tabular-nums min-w-32">
                {fmtDate(date, "EEE, MMM d")}
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => setDate((d) => shiftDate(d, 1))}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : undefined
        }
      />

      {conflicts.length > 0 && tab !== "planner" && (
        <div className="px-4 md:px-6 pt-4 space-y-1.5">
          {conflicts.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-md border border-critical/25 bg-critical-bg px-3 py-2 text-xs">
              <AlertTriangle className="size-3.5 text-critical shrink-0" />
              <span className="flex-1">{c.message}</span>
              <Button asChild size="sm" variant="secondary">
                <Link to="/today?tab=planner">Fix</Link>
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 md:px-6 pt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="timeline">
              <CalendarClock className="size-3.5 mr-1" /> Timeline
            </TabsTrigger>
            <TabsTrigger value="list">
              <List className="size-3.5 mr-1" /> List
            </TabsTrigger>
            <TabsTrigger value="fo">
              <Users className="size-3.5 mr-1" /> FO View
            </TabsTrigger>
            <TabsTrigger value="business">
              <Store className="size-3.5 mr-1" /> Business View
            </TabsTrigger>
            <TabsTrigger value="planner">
              <Sparkles className="size-3.5 mr-1" /> Planner
            </TabsTrigger>
          </TabsList>

          <TabsContent value="timeline">
            <TimelineView items={items} workStart={data.settings.workingHoursStart} workEnd={data.settings.workingHoursEnd} />
          </TabsContent>
          <TabsContent value="list">
            <ListView items={items} onStart={openStart} />
          </TabsContent>
          <TabsContent value="fo">
            <FOView items={items} onStart={openStart} />
          </TabsContent>
          <TabsContent value="business">
            <BusinessView items={items} onStart={openStart} />
          </TabsContent>
          <TabsContent value="planner">
            <Planner />
          </TabsContent>
        </Tabs>
      </div>

      <StartSessionDialog open={startDialogOpen} onOpenChange={setStartDialogOpen} date={date} preselectAssignmentId={preselect} />
    </div>
  );
}
