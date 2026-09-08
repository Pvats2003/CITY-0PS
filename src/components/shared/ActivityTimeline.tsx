import {
  CalendarPlus,
  UserCheck,
  ScanLine,
  PlayCircle,
  BatteryWarning,
  HardDrive,
  WifiOff,
  StopCircle,
  ImagePlus,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  AlertTriangle,
  CheckCircle2,
  Ban,
  ClipboardList,
  Sunrise,
  Sunset,
  StickyNote,
} from "lucide-react";
import type { ActivityEvent, ActivityEventType } from "@/types";
import { fmtTime, fmtDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

const ICONS: Record<ActivityEventType, React.ComponentType<{ className?: string }>> = {
  assignment_created: CalendarPlus,
  fo_arrived: UserCheck,
  rig_scanned: ScanLine,
  session_started: PlayCircle,
  battery_warning: BatteryWarning,
  storage_warning: HardDrive,
  signal_warning: WifiOff,
  session_ended: StopCircle,
  evidence_added: ImagePlus,
  qa_passed: ShieldCheck,
  qa_warned: ShieldAlert,
  qa_failed: ShieldX,
  issue_reported: AlertTriangle,
  issue_resolved: CheckCircle2,
  business_rejected: Ban,
  plan_published: ClipboardList,
  plan_changed: ClipboardList,
  day_started: Sunrise,
  day_ended: Sunset,
  note: StickyNote,
};

const COLOR: Record<ActivityEventType, string> = {
  assignment_created: "text-muted",
  fo_arrived: "text-info",
  rig_scanned: "text-muted",
  session_started: "text-primary",
  battery_warning: "text-warning",
  storage_warning: "text-warning",
  signal_warning: "text-warning",
  session_ended: "text-success",
  evidence_added: "text-muted",
  qa_passed: "text-success",
  qa_warned: "text-warning",
  qa_failed: "text-critical",
  issue_reported: "text-critical",
  issue_resolved: "text-success",
  business_rejected: "text-critical",
  plan_published: "text-primary",
  plan_changed: "text-primary",
  day_started: "text-muted",
  day_ended: "text-muted",
  note: "text-muted",
};

export function ActivityTimeline({
  events,
  groupByDay = false,
  emptyLabel = "No activity yet.",
}: {
  events: ActivityEvent[];
  groupByDay?: boolean;
  emptyLabel?: string;
}) {
  if (events.length === 0) {
    return <div className="text-sm text-muted py-6 text-center">{emptyLabel}</div>;
  }

  if (!groupByDay) {
    return (
      <ol className="space-y-0">
        {events.map((e) => (
          <TimelineRow key={e.id} event={e} />
        ))}
      </ol>
    );
  }

  const groups = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const day = e.at.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), e]);
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([day, dayEvents]) => (
        <div key={day}>
          <div className="text-xs font-semibold text-muted mb-1.5 sticky top-0 bg-surface">{fmtDate(day)}</div>
          <ol className="space-y-0">
            {dayEvents.map((e) => (
              <TimelineRow key={e.id} event={e} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function TimelineRow({ event }: { event: ActivityEvent }) {
  const Icon = ICONS[event.type] ?? StickyNote;
  return (
    <li className="flex gap-3 group">
      <div className="flex flex-col items-center">
        <div className={cn("flex size-6 items-center justify-center rounded-full bg-surface-2 shrink-0", COLOR[event.type])}>
          <Icon className="size-3.5" />
        </div>
        <div className="w-px flex-1 bg-border group-last:hidden" />
      </div>
      <div className="pb-4 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted-2 tabular-nums shrink-0">{fmtTime(event.at)}</span>
          <span className="text-sm">{event.summary}</span>
        </div>
        {event.detail && <div className="text-xs text-muted mt-0.5">{event.detail}</div>}
      </div>
    </li>
  );
}
