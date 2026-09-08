import { Link } from "react-router-dom";
import type { AttentionItem } from "@/engine/attention";
import { SEVERITY_META } from "@/components/status";
import { relTime } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AttentionList({ items, limit }: { items: AttentionItem[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) {
    return (
      <div className="text-sm text-muted py-8 text-center">
        Nothing needs your attention right now. The city is running smoothly.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {shown.map((item) => (
        <AttentionRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const meta = SEVERITY_META[item.severity];
  return (
    <li className="flex gap-3 py-3">
      <div className={cn("mt-0.5 shrink-0 text-base leading-none")}>{meta.emoji}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-medium leading-snug">{item.title}</div>
          <span className="text-xs text-muted-2 shrink-0 tabular-nums">{relTime(item.at)}</span>
        </div>
        <div className="text-xs text-muted mt-0.5">{item.reason}</div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {item.actions.map((a) => (
            <Button key={a.label} asChild size="sm" variant={a === item.actions[0] ? "secondary" : "ghost"}>
              <Link to={a.to}>{a.label}</Link>
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}
