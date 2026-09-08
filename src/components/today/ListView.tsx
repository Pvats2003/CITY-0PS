import type { EnrichedAssignment } from "@/engine/todayView";
import { AssignmentRow } from "./AssignmentRow";
import { EmptyState } from "@/components/shared/EmptyState";
import { CalendarClock } from "lucide-react";

export function ListView({ items, onStart }: { items: EnrichedAssignment[]; onStart: (id: string) => void }) {
  if (items.length === 0) {
    return <EmptyState icon={CalendarClock} title="Nothing planned for this day" description="Use the Planner tab to propose a day, or add a visit manually." />;
  }
  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <AssignmentRow key={item.assignment.id} item={item} onStart={onStart} />
      ))}
    </div>
  );
}
