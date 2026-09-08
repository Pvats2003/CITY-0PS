import { Info } from "lucide-react";
import { ScoreBar } from "@/components/shared/ScoreBar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RigSummary } from "@/engine/rigGuardian";
import { RigReadinessBadge } from "./RigReadinessBadge";

export function RigHealthCard({ summary }: { summary: RigSummary }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="text-center shrink-0">
          <div className="text-4xl font-bold tabular-nums">{summary.score}</div>
          <div className="text-[11px] text-muted">/ 100</div>
        </div>
        <div className="flex-1 space-y-1.5">
          <RigReadinessBadge status={summary.readiness} />
          <div className="text-xs text-muted">{summary.readinessReason}</div>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button className="text-muted hover:text-foreground shrink-0" title="Why is this score?">
              <Info className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end">
            <div className="text-xs font-semibold mb-2">Why is this {summary.score}?</div>
            {summary.scoreBreakdown.length === 0 ? (
              <div className="text-xs text-muted">No deductions or bonuses on record — clean history.</div>
            ) : (
              <ul className="space-y-1 text-xs">
                {summary.scoreBreakdown.map((d, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="text-muted">{d.label}</span>
                    <span className={d.delta >= 0 ? "text-success tabular-nums" : "text-critical tabular-nums"}>
                      {d.delta >= 0 ? "+" : ""}
                      {d.delta}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="text-[11px] text-muted-2 mt-2 pt-2 border-t border-border">Operational health score based on recorded history — not a prediction.</div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="space-y-2.5">
        {summary.categories.map((c) => (
          <ScoreBar key={c.key} label={c.label} value={c.value} />
        ))}
      </div>
    </div>
  );
}
