import { cn } from "@/lib/utils";

export function ScoreBar({ label, value, className }: { label: string; value: number; className?: string }) {
  const tone = value >= 80 ? "bg-success" : value >= 60 ? "bg-warning" : "bg-critical";
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-medium tabular-nums">{value}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}
