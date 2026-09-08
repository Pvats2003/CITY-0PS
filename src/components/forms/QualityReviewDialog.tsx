import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import type { CorrectiveActionType, QualityReview, QualityVerdict } from "@/types";
import { nowISO } from "@/lib/dates";
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";

const CORRECTIVE_LABELS: Record<CorrectiveActionType, string> = {
  recapture: "Recapture session",
  fo_followup: "FO follow-up",
  business_followup: "Business follow-up",
  rig_inspection: "Rig inspection",
  collector_retraining: "Collector retraining",
};

export function QualityReviewDialog({ open, onOpenChange, review }: { open: boolean; onOpenChange: (v: boolean) => void; review?: QualityReview }) {
  const updateQualityReview = useCity((s) => s.updateQualityReview);
  const addCorrectiveAction = useCity((s) => s.addCorrectiveAction);
  const [verdict, setVerdict] = useState<QualityVerdict>("pass");
  const [notes, setNotes] = useState("");
  const [correctiveType, setCorrectiveType] = useState<CorrectiveActionType>("recapture");

  useEffect(() => {
    if (open && review) {
      setVerdict(review.verdict === "pending" ? "pass" : review.verdict);
      setNotes(review.notes ?? "");
      setCorrectiveType("recapture");
    }
  }, [open, review]);

  function submit() {
    if (!review) return;
    updateQualityReview(review.id, { verdict, notes: notes.trim() || undefined, reviewedAt: nowISO() });
    if (verdict === "fail") {
      const action = addCorrectiveAction({ qualityReviewId: review.id, type: correctiveType, notes: notes.trim() || undefined, status: "open" });
      updateQualityReview(review.id, { correctiveActionId: action.id });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Review session quality</DialogTitle>
          <DialogDescription>Decide the verdict for this session. A fail requires a corrective action.</DialogDescription>
        </DialogHeader>

        {review && review.flags.length > 0 && (
          <ul className="space-y-1 text-sm text-muted rounded-md bg-surface-2 p-3">
            {review.flags.map((f, i) => (
              <li key={i}>• {f.detail}</li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-3 gap-2">
          <VerdictButton icon={ShieldCheck} label="Pass" active={verdict === "pass"} tone="success" onClick={() => setVerdict("pass")} />
          <VerdictButton icon={ShieldAlert} label="Warn" active={verdict === "warn"} tone="warning" onClick={() => setVerdict("warn")} />
          <VerdictButton icon={ShieldX} label="Fail" active={verdict === "fail"} tone="critical" onClick={() => setVerdict("fail")} />
        </div>

        {verdict === "fail" && (
          <div className="space-y-1.5">
            <Label>Corrective action *</Label>
            <Select value={correctiveType} onValueChange={(v) => setCorrectiveType(v as CorrectiveActionType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CORRECTIVE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Save review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VerdictButton({
  icon: Icon,
  label,
  active,
  tone,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  tone: "success" | "warning" | "critical";
  onClick: () => void;
}) {
  const toneClass = { success: "border-success text-success bg-success-bg", warning: "border-warning text-warning bg-warning-bg", critical: "border-critical text-critical bg-critical-bg" }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex flex-col items-center gap-1 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors", active ? toneClass : "border-border text-muted hover:bg-surface-2")}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
