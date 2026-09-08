import { useState } from "react";
import { Link } from "react-router-dom";
import { MapPin, CheckCircle2, PlayCircle } from "lucide-react";
import type { EnrichedAssignment } from "@/engine/todayView";
import { assignmentStatusToStatus } from "@/engine/todayView";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { fmtTime } from "@/lib/dates";
import { PostSessionCheckDialog } from "@/components/forms/PostSessionCheckDialog";

export function AssignmentRow({
  item,
  onStart,
  showFO = true,
  showBusiness = true,
}: {
  item: EnrichedAssignment;
  onStart?: (assignmentId: string) => void;
  showFO?: boolean;
  showBusiness?: boolean;
}) {
  const { assignment, business, fo, rig, session } = item;
  const status = assignmentStatusToStatus(assignment.status);
  const [postCheckOpen, setPostCheckOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 py-3 px-1">
      <div className="w-16 shrink-0 text-xs tabular-nums text-muted">{fmtTime(assignment.plannedStart)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {showBusiness && (
            <Link to={`/businesses/${business?.id}`} className="text-sm font-medium hover:underline truncate">
              {business?.name ?? "Unknown business"}
            </Link>
          )}
          {assignment.priority === "high" && <StatusBadge status="warning">Priority</StatusBadge>}
          <StatusBadge status={status} />
        </div>
        <div className="text-xs text-muted mt-0.5 flex items-center gap-2 flex-wrap">
          {showFO && fo && (
            <Link to={`/field-officers/${fo.id}`} className="hover:underline">
              {fo.name}
            </Link>
          )}
          {business?.area && (
            <span className="inline-flex items-center gap-0.5">
              <MapPin className="size-3" /> {business.area}
            </span>
          )}
          {rig && <span>{rig.code}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {(assignment.status === "planned" || assignment.status === "confirmed") && onStart && (
          <Button size="sm" variant="secondary" onClick={() => onStart(assignment.id)}>
            <PlayCircle className="size-3.5" /> Start
          </Button>
        )}
        {assignment.status === "in_progress" && session && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setPostCheckOpen(true)}>
              <CheckCircle2 className="size-3.5" /> Complete
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link to={`/sessions/${assignment.sessionId}`}>View</Link>
            </Button>
            <PostSessionCheckDialog open={postCheckOpen} onOpenChange={setPostCheckOpen} session={session} />
          </>
        )}
        {assignment.status === "completed" && assignment.sessionId && (
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/sessions/${assignment.sessionId}`}>View session</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
