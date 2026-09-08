import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DAMAGE_GROUPS, DISCOVERY_STAGE_LABELS, categoryLabel } from "@/engine/rigTaxonomy";
import { reportRigIncident } from "@/engine/workflows";
import type { DamageCategory, DiscoveryStage, Severity } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rigId: string;
  defaultDiscoveryStage?: DiscoveryStage;
  defaults?: { sessionId?: string; assignmentId?: string; businessId?: string; foId?: string };
}

export function RigIncidentFormDialog({ open, onOpenChange, rigId, defaultDiscoveryStage, defaults }: Props) {
  const [category, setCategory] = useState<DamageCategory>("unknown_technical");
  const [severity, setSeverity] = useState<Severity>("warning");
  const [discoveryStage, setDiscoveryStage] = useState<DiscoveryStage>(defaultDiscoveryStage ?? "other");
  const [description, setDescription] = useState("");
  const [lostHours, setLostHours] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCategory("unknown_technical");
      setSeverity("warning");
      setDiscoveryStage(defaultDiscoveryStage ?? "other");
      setDescription("");
      setLostHours("");
      setError(null);
    }
  }, [open]);

  function submit() {
    if (!description.trim()) return setError("Describe what happened.");
    reportRigIncident({
      rigId,
      category,
      severity,
      discoveryStage,
      description: description.trim(),
      lostHours: lostHours ? Number(lostHours) : undefined,
      ...defaults,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report rig incident</DialogTitle>
          <DialogDescription>Logs a structured incident on this rig and opens a matching issue in the Action Inbox.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label>Damage category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as DamageCategory)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAMAGE_GROUPS.map((g) => (
                  <div key={g.group}>
                    <div className="px-2 py-1 text-[11px] font-semibold text-muted-2 uppercase">{g.label}</div>
                    {g.categories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {categoryLabel(c)}
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="attention">Attention</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Discovered at</Label>
            <Select value={discoveryStage} onValueChange={(v) => setDiscoveryStage(v as DiscoveryStage)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DISCOVERY_STAGE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="incident-desc">Description *</Label>
            <Textarea id="incident-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What happened, and what did you observe?" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="incident-lost-hours">Recording hours lost (optional)</Label>
            <Input id="incident-lost-hours" type="number" min="0" step="0.1" value={lostHours} onChange={(e) => setLostHours(e.target.value)} placeholder="Leave blank to estimate" />
          </div>
        </div>

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Report incident</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
