import { cn } from "@/lib/utils";
import type { Status, Severity } from "@/types";

/**
 * Strict status vocabulary (spec #36). Colors are semantic and consistent
 * everywhere in the product: never assign a status color ad hoc elsewhere.
 */
export const STATUS_META: Record<
  Status,
  { label: string; dot: string; badgeClass: string }
> = {
  healthy: { label: "Healthy", dot: "bg-success", badgeClass: "bg-success-bg text-success border-success/20" },
  warning: { label: "Warning", dot: "bg-warning", badgeClass: "bg-warning-bg text-warning border-warning/20" },
  critical: { label: "Critical", dot: "bg-critical", badgeClass: "bg-critical-bg text-critical border-critical/20" },
  active: { label: "Active", dot: "bg-info animate-pulse", badgeClass: "bg-info-bg text-info border-info/20" },
  pending: { label: "Pending", dot: "bg-neutral", badgeClass: "bg-neutral-bg text-neutral border-neutral/20" },
  completed: { label: "Completed", dot: "bg-success", badgeClass: "bg-success-bg text-success border-success/20" },
  failed: { label: "Failed", dot: "bg-critical", badgeClass: "bg-critical-bg text-critical border-critical/20" },
  cancelled: { label: "Cancelled", dot: "bg-muted-2", badgeClass: "bg-surface-2 text-muted border-border" },
  offline: { label: "Offline", dot: "bg-muted-2", badgeClass: "bg-surface-2 text-muted border-border" },
  unknown: { label: "Unknown", dot: "bg-muted-2", badgeClass: "bg-surface-2 text-muted border-border" },
};

export const SEVERITY_META: Record<
  Severity,
  { label: string; emoji: string; badgeClass: string; textClass: string }
> = {
  critical: { label: "Critical", emoji: "\u{1F534}", badgeClass: "bg-critical-bg text-critical border-critical/20", textClass: "text-critical" },
  warning: { label: "Warning", emoji: "\u{1F7E0}", badgeClass: "bg-warning-bg text-warning border-warning/20", textClass: "text-warning" },
  attention: { label: "Attention", emoji: "\u{1F7E1}", badgeClass: "bg-warning-bg text-warning border-warning/20", textClass: "text-warning" },
  opportunity: { label: "Opportunity", emoji: "\u{1F7E2}", badgeClass: "bg-success-bg text-success border-success/20", textClass: "text-success" },
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  const meta = STATUS_META[status];
  return <span className={cn("inline-block size-2 rounded-full", meta.dot, className)} />;
}

export function StatusBadge({
  status,
  className,
  children,
}: {
  status: Status;
  className?: string;
  children?: React.ReactNode;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        meta.badgeClass,
        className,
      )}
    >
      <StatusDot status={status} />
      {children ?? meta.label}
    </span>
  );
}
