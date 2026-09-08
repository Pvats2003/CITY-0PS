import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { completeSession } from "@/engine/workflows";
import { RigIncidentFormDialog } from "./RigIncidentFormDialog";
import type { Session } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: Session;
}

/** Quick Rig Check, shown whenever a recording session ends — desktop and
 * FO Execution mode alike. Branches into COMPLETE SESSION or REPORT DAMAGE;
 * either path finishes by completing the session, since the recording
 * itself is already over. */
export function PostSessionCheckDialog({ open, onOpenChange, session }: Props) {
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (open) setReporting(false);
  }, [open]);

  function finish() {
    completeSession(session.id);
    onOpenChange(false);
  }

  if (reporting && session.rigId) {
    return (
      <RigIncidentFormDialog
        open
        onOpenChange={(v) => {
          if (!v) finish();
        }}
        rigId={session.rigId}
        defaultDiscoveryStage="post_session"
        defaults={{ sessionId: session.id, assignmentId: session.assignmentId, businessId: session.businessId, foId: session.foId }}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : finish())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Quick Rig Check</DialogTitle>
          <DialogDescription>Any damage or issues with the rig during this session?</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2.5">
          <Button size="lg" className="h-14 text-base" onClick={finish}>
            <CheckCircle2 className="size-5" /> Complete Session
          </Button>
          <Button size="lg" variant="destructive" className="h-14 text-base" onClick={() => setReporting(true)} disabled={!session.rigId}>
            <AlertTriangle className="size-5" /> Report Damage
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
