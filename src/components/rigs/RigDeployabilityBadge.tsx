import { cn } from "@/lib/utils";
import { RIG_DEPLOYABILITY_EMOJI, RIG_DEPLOYABILITY_LABELS } from "@/engine/rigTaxonomy";
import type { RigDeployability } from "@/engine/rigTaxonomy";

const CLASSES: Record<RigDeployability, string> = {
  READY: "bg-success-bg text-success border-success/20",
  AT_RISK: "bg-warning-bg text-warning border-warning/20",
  BLOCKED: "bg-critical-bg text-critical border-critical/20",
};

/** The exact READY / AT_RISK / BLOCKED vocabulary — "can this rig be
 * deployed right now?" — distinct from RigReadinessBadge's 5-tier detail
 * (which stays for the fuller historical/override view on Rig 360). */
export function RigDeployabilityBadge({ status, className }: { status: RigDeployability; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", CLASSES[status], className)}>
      <span>{RIG_DEPLOYABILITY_EMOJI[status]}</span>
      {RIG_DEPLOYABILITY_LABELS[status]}
    </span>
  );
}
