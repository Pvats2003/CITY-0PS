import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCity } from "@/store/city";
import type { Issue } from "@/types";
import { CheckCircle2 } from "lucide-react";

export function ResolveIssueDialog({ open, onOpenChange, issue }: { open: boolean; onOpenChange: (v: boolean) => void; issue?: Issue }) {
  const resolveIssue = useCity((s) => s.resolveIssue);
  const [resolution, setResolution] = useState("");

  function submit() {
    if (!issue) return;
    resolveIssue(issue.id, resolution.trim() || "Resolved.");
    setResolution("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve issue</DialogTitle>
          <DialogDescription>{issue?.title}</DialogDescription>
        </DialogHeader>
        <Textarea placeholder="What was done to resolve this?" value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>
            <CheckCircle2 className="size-4" /> Mark resolved
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
