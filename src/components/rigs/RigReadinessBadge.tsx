import { cn } from "@/lib/utils";
import { RIG_READINESS_EMOJI, RIG_READINESS_LABELS } from "@/engine/rigTaxonomy";
import type { RigReadinessStatus } from "@/types";

const CLASSES: Record<RigReadinessStatus, string> = {
  healthy: "bg-success-bg text-success border-success/20",
  watch: "bg-warning-bg text-warning border-warning/20",
  inspection_required: "bg-warning-bg text-warning border-warning/30",
  do_not_deploy: "bg-critical-bg text-critical border-critical/20",
  in_repair: "bg-info-bg text-info border-info/20",
};

export function RigReadinessBadge({ status, className }: { status: RigReadinessStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", CLASSES[status], className)}>
      <span>{RIG_READINESS_EMOJI[status]}</span>
      {RIG_READINESS_LABELS[status]}
    </span>
  );
}
