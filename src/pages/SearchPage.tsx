import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search as SearchIcon, Sparkles, Database, Lightbulb } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status";
import { useCity } from "@/store/city";
import { buildSearchIndex, searchQuery, type SearchResult } from "@/engine/search";
import { runCopilotQuery, COPILOT_EXAMPLES } from "@/engine/copilot";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<SearchResult["kind"] | "all", string> = {
  all: "All",
  business: "Businesses",
  fo: "Field Officers",
  collector: "Collectors",
  rig: "Rigs",
  session: "Sessions",
  issue: "Issues",
};

export default function SearchPage() {
  const data = useCity();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [kind, setKind] = useState<SearchResult["kind"] | "all">("all");

  const index = useMemo(() => buildSearchIndex(data), [data]);
  const results = useMemo(() => {
    const matched = searchQuery(index, query, 200);
    return kind === "all" ? matched : matched.filter((r) => r.kind === kind);
  }, [index, query, kind]);

  const copilot = useMemo(() => (query.trim().length > 4 ? runCopilotQuery(data, query) : null), [data, query]);

  return (
    <div className="pb-10">
      <PageHeader title="Search" subtitle="Search everything, or ask a question — answered from your local data only." />

      <div className="px-4 md:px-6 pt-5 space-y-5">
        <div className="relative max-w-2xl">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-2" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search businesses, FOs, sessions, issues… or ask a question"
            className="pl-9 h-11 text-sm"
          />
        </div>

        {copilot && (
          <Card className="p-4 max-w-2xl border-primary/25 bg-primary/5">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="size-4 text-primary" />
              <span className="text-sm font-semibold">City Copilot</span>
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  copilot.kind === "recommendation" ? "border-warning/30 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info",
                )}
              >
                {copilot.kind === "recommendation" ? <Lightbulb className="size-3" /> : <Database className="size-3" />}
                {copilot.kind === "recommendation" ? "RECOMMENDATION" : copilot.kind === "help" ? "HELP" : "DATA"}
              </span>
            </div>
            <p className="text-sm">{copilot.answer}</p>
            {copilot.links && (
              <div className="flex gap-2 mt-3">
                {copilot.links.map((l) => (
                  <Button key={l.to} asChild size="sm" variant="secondary">
                    <Link to={l.to}>{l.label}</Link>
                  </Button>
                ))}
              </div>
            )}
          </Card>
        )}

        {!query && (
          <div className="max-w-2xl">
            <div className="text-xs font-medium text-muted mb-2">Try asking City Copilot</div>
            <div className="flex flex-wrap gap-2">
              {COPILOT_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setQuery(ex)}
                  className="text-xs rounded-full border border-border bg-surface px-3 py-1.5 hover:border-border-strong hover:bg-surface-2 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(KIND_LABELS) as (SearchResult["kind"] | "all")[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn(
                "text-xs rounded-full border px-3 py-1 font-medium transition-colors",
                kind === k ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted hover:bg-surface-2",
              )}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {results.length === 0 ? (
          <EmptyState icon={SearchIcon} title="No matches" description="Try a different search term or entity filter." />
        ) : (
          <Card className="max-w-3xl divide-y divide-border overflow-hidden">
            {results.slice(0, 80).map((r) => (
              <Link key={`${r.kind}-${r.id}`} to={r.to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/50">
                <StatusDot status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{r.title}</div>
                  <div className="text-xs text-muted truncate">{r.subtitle}</div>
                </div>
                {r.metric && <span className="text-xs text-muted-2 shrink-0">{r.metric}</span>}
                <span className="text-[10px] uppercase tracking-wide text-muted-2 shrink-0 w-16 text-right">{r.kind}</span>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
