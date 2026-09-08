import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import type { IssueType, Severity } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaults?: { businessId?: string; foId?: string; rigId?: string; sessionId?: string; assignmentId?: string };
}

const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  business_rejection: "Business rejection",
  fo_no_show: "FO no-show",
  late_arrival: "Late arrival",
  rig_failure: "Rig failure",
  battery: "Battery",
  storage: "Storage",
  network: "Network",
  recording_failure: "Recording failure",
  quality: "Quality",
  damage: "Damage",
  missing_evidence: "Missing evidence",
  scheduling: "Scheduling",
  other: "Other",
};

export function IssueFormDialog({ open, onOpenChange, defaults }: Props) {
  const addIssue = useCity((s) => s.addIssue);
  const businesses = useCity((s) => s.businesses);
  const fos = useCity((s) => s.fos);
  const [type, setType] = useState<IssueType>("other");
  const [severity, setSeverity] = useState<Severity>("warning");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [businessId, setBusinessId] = useState<string>(defaults?.businessId ?? "");
  const [foId, setFoId] = useState<string>(defaults?.foId ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType("other");
      setSeverity("warning");
      setTitle("");
      setDescription("");
      setBusinessId(defaults?.businessId ?? "");
      setFoId(defaults?.foId ?? "");
      setError(null);
    }
  }, [open, defaults]);

  function submit() {
    if (!title.trim()) return setError("A short title is required.");
    addIssue({
      type,
      severity,
      title: title.trim(),
      description: description.trim() || title.trim(),
      businessId: businessId || undefined,
      foId: foId || undefined,
      rigId: defaults?.rigId,
      sessionId: defaults?.sessionId,
      assignmentId: defaults?.assignmentId,
      owner: "You",
      status: "open",
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report issue</DialogTitle>
          <DialogDescription>Issues appear in the Action Inbox with an owner, severity, and resolution state.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as IssueType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ISSUE_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
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
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="issue-title">Title *</Label>
            <Input id="issue-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" />
          </div>
          <div className="space-y-1.5">
            <Label>Business</Label>
            <Select value={businessId || "none"} onValueChange={(v) => setBusinessId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {businesses.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Field Officer</Label>
            <Select value={foId || "none"} onValueChange={(v) => setFoId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {fos.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="issue-desc">Description</Label>
            <Textarea id="issue-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
        </div>

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Report issue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
