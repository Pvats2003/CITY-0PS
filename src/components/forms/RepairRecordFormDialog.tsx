import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { saveRepairRecord } from "@/engine/workflows";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rigId: string;
  incidentId: string;
}

export function RepairRecordFormDialog({ open, onOpenChange, rigId, incidentId }: Props) {
  const [diagnosis, setDiagnosis] = useState("");
  const [repairAction, setRepairAction] = useState("");
  const [parts, setParts] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDiagnosis("");
      setRepairAction("");
      setParts("");
      setNotes("");
      setError(null);
    }
  }, [open]);

  function submit() {
    if (!diagnosis.trim()) return setError("What was diagnosed?");
    if (!repairAction.trim()) return setError("What repair action was taken?");
    saveRepairRecord({
      rigId,
      incidentId,
      diagnosis: diagnosis.trim(),
      repairAction: repairAction.trim(),
      parts: parts.trim() || undefined,
      notes: notes.trim() || undefined,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log repair</DialogTitle>
          <DialogDescription>Recording a repair moves this incident to Testing — only a passing post-repair test returns the rig to service.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="repair-diagnosis">Diagnosis *</Label>
            <Textarea id="repair-diagnosis" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} rows={2} placeholder="Root cause identified" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repair-action">Repair action *</Label>
            <Textarea id="repair-action" value={repairAction} onChange={(e) => setRepairAction(e.target.value)} rows={2} placeholder="What was done to fix it" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repair-parts">Parts used</Label>
            <Input id="repair-parts" value={parts} onChange={(e) => setParts(e.target.value)} placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="repair-notes">Notes</Label>
            <Textarea id="repair-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional" />
          </div>
        </div>

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Save repair &amp; move to testing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
