import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCity } from "@/store/city";
import type { FieldOfficer } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fo?: FieldOfficer;
}

export function FOFormDialog({ open, onOpenChange, fo }: Props) {
  const addFO = useCity((s) => s.addFO);
  const updateFO = useCity((s) => s.updateFO);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [homeArea, setHomeArea] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(fo?.name ?? "");
      setPhone(fo?.phone ?? "");
      setHomeArea(fo?.homeArea ?? "");
      setActive(fo?.active ?? true);
      setError(null);
    }
  }, [open, fo]);

  function submit() {
    if (!name.trim()) return setError("Name is required.");
    const payload = { name: name.trim(), phone: phone.trim() || undefined, homeArea: homeArea.trim() || undefined, active };
    if (fo) updateFO(fo.id, payload);
    else addFO(payload);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{fo ? "Edit field officer" : "Add field officer"}</DialogTitle>
          <DialogDescription>Field officers execute visits and record sessions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fo-name">Name *</Label>
            <Input id="fo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Arjun Mehta" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fo-phone">Phone</Label>
            <Input id="fo-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fo-area">Home area</Label>
            <Input id="fo-area" value={homeArea} onChange={(e) => setHomeArea(e.target.value)} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <Label htmlFor="fo-active" className="text-sm text-foreground font-normal">
              Active
            </Label>
            <Switch id="fo-active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{fo ? "Save changes" : "Add field officer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
