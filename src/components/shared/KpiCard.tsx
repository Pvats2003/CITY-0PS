import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
  size = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "default" | "success" | "warning" | "critical";
  size?: "default" | "lg";
  className?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    critical: "text-critical",
  }[tone];

  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4", className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        {Icon && <Icon className="size-4 text-muted-2" />}
      </div>
      <div className={cn("tabular-nums font-semibold mt-1.5", size === "lg" ? "text-3xl" : "text-xl", toneClass)}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
