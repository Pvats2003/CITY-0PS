import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import { enrichAssignments } from "@/engine/todayView";
import { startSessionForAssignment } from "@/engine/workflows";
import { PlayCircle } from "lucide-react";

export function StartSessionDialog({
  open,
  onOpenChange,
  date,
  preselectAssignmentId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  date: string;
  preselectAssignmentId?: string;
}) {
  const data = useCity();
  const [assignmentId, setAssignmentId] = useState(preselectAssignmentId ?? "");

  const startable = useMemo(
    () => enrichAssignments(data, date).filter((e) => e.assignment.status === "planned" || e.assignment.status === "confirmed"),
    [data, date],
  );

  function submit() {
    const target = startable.find((e) => e.assignment.id === assignmentId) ?? startable.find((e) => e.assignment.id === preselectAssignmentId);
    if (!target) return;
    startSessionForAssignment(target.assignment);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start session</DialogTitle>
          <DialogDescription>Marks the FO as arrived and begins recording for the selected visit.</DialogDescription>
        </DialogHeader>

        {startable.length === 0 ? (
          <div className="text-sm text-muted py-4 text-center">No plannable visits remaining today.</div>
        ) : (
          <Select value={assignmentId} onValueChange={setAssignmentId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a visit" />
            </SelectTrigger>
            <SelectContent>
              {startable.map((e) => (
                <SelectItem key={e.assignment.id} value={e.assignment.id}>
                  {e.business?.name} — {e.fo?.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!assignmentId && !preselectAssignmentId}>
            <PlayCircle className="size-4" /> Start session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
