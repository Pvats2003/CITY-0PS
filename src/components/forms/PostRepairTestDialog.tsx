import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { runPostRepairTest } from "@/engine/workflows";
import type { RepairTestChecklist } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  repairRecordId: string;
}

const CHECKLIST_ITEMS: { key: keyof RepairTestChecklist; label: string }[] = [
  { key: "power", label: "Power / boots up" },
  { key: "battery", label: "Battery holds charge" },
  { key: "cameras", label: "Cameras detected" },
  { key: "cables", label: "Cables intact" },
  { key: "connectors", label: "Connectors secure" },
  { key: "storage", label: "Storage reads/writes" },
  { key: "recording", label: "Test recording completes" },
];

const EMPTY_CHECKLIST: RepairTestChecklist = { power: false, cameras: false, cables: false, connectors: false, storage: false, recording: false, battery: false };

export function PostRepairTestDialog({ open, onOpenChange, repairRecordId }: Props) {
  const [checklist, setChecklist] = useState<RepairTestChecklist>(EMPTY_CHECKLIST);

  useEffect(() => {
    if (open) setChecklist(EMPTY_CHECKLIST);
  }, [open]);

  const allChecked = CHECKLIST_ITEMS.every((item) => checklist[item.key]);

  function submit(result: "pass" | "fail") {
    runPostRepairTest(repairRecordId, checklist, result);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Post-repair test</DialogTitle>
          <DialogDescription>Only a PASS returns this rig to service. A FAIL sends it back for further repair.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {CHECKLIST_ITEMS.map((item) => (
            <label key={item.key} className="flex items-center gap-2.5 cursor-pointer">
              <Checkbox
                checked={checklist[item.key]}
                onCheckedChange={(v) => setChecklist((c) => ({ ...c, [item.key]: v === true }))}
              />
              <Label className="cursor-pointer font-normal">{item.label}</Label>
            </label>
          ))}
        </div>

        {!allChecked && <div className="text-xs text-muted">All items should be checked before marking PASS.</div>}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => submit("fail")}>
            Fail — send back
          </Button>
          <Button onClick={() => submit("pass")} disabled={!allChecked}>
            Pass — return to service
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
