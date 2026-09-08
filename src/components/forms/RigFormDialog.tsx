import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import type { Rig, RigCondition } from "@/types";

export function RigFormDialog({ open, onOpenChange, rig }: { open: boolean; onOpenChange: (v: boolean) => void; rig?: Rig }) {
  const addRig = useCity((s) => s.addRig);
  const updateRig = useCity((s) => s.updateRig);
  const [code, setCode] = useState("");
  const [model, setModel] = useState("");
  const [active, setActive] = useState(true);
  const [condition, setCondition] = useState<RigCondition>("healthy");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCode(rig?.code ?? "");
      setModel(rig?.model ?? "");
      setActive(rig?.active ?? true);
      setCondition(rig?.condition ?? "healthy");
      setError(null);
    }
  }, [open, rig]);

  function submit() {
    if (!code.trim()) return setError("Rig code is required, e.g. R-01.");
    if (rig) {
      updateRig(rig.id, { code: code.trim(), model: model.trim() || "Unspecified", active, condition });
    } else {
      addRig({ code: code.trim(), model: model.trim() || "Unspecified", active, batteryPct: 100, storagePct: 0, condition });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{rig ? "Edit rig" : "Add rig"}</DialogTitle>
          <DialogDescription>Rigs are the recording devices your FOs deploy in the field.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rig-code">Rig code *</Label>
            <Input id="rig-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. R-01" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rig-model">Model</Label>
            <Input id="rig-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. FieldCam RX2" />
          </div>
          <div className="space-y-1.5">
            <Label>Condition</Label>
            <Select value={condition} onValueChange={(v) => setCondition(v as RigCondition)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="healthy">Healthy</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label htmlFor="rig-active" className="text-sm text-foreground font-normal">
              Active
            </Label>
            <Switch id="rig-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{rig ? "Save changes" : "Add rig"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
