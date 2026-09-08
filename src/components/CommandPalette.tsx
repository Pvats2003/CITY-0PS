import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  LayoutDashboard,
  CalendarClock,
  Store,
  Users,
  Radio,
  AlertTriangle,
  ShieldCheck,
  FileText,
  BarChart3,
  PlusCircle,
  UserPlus,
  PlayCircle,
  Sparkles,
} from "lucide-react";
import { useCity } from "@/store/city";
import { useUI } from "@/store/ui";
import { buildSearchIndex, searchQuery } from "@/engine/search";
import { runCopilotQuery } from "@/engine/copilot";
import { StatusDot } from "@/components/status";

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  const navigate = useNavigate();
  const data = useCity();
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const index = useMemo(() => buildSearchIndex(data), [data]);
  const results = useMemo(() => (query ? searchQuery(index, query, 8) : []), [index, query]);
  const copilotAnswer = useMemo(() => (query.length > 6 ? runCopilotQuery(data, query) : null), [data, query]);

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command Palette"
      shouldFilter={false}
      className="fixed left-1/2 top-[18%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
    >
      <div className="flex items-center border-b border-border px-3">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Search or ask a question…"
          className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-2"
        />
        <kbd className="text-[10px] text-muted-2 border border-border rounded px-1">Esc</kbd>
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        <Command.Empty className="py-8 text-center text-sm text-muted">No results found.</Command.Empty>

        {copilotAnswer && (
          <Command.Group heading="City Copilot" className="text-[11px] font-medium text-muted px-2 py-1.5">
            <div className="mx-1 mb-2 rounded-md bg-primary/5 border border-primary/15 px-3 py-2 text-sm">
              {copilotAnswer.answer}
            </div>
          </Command.Group>
        )}

        {!query && (
          <Command.Group heading="Quick Actions" className="text-[11px] font-medium text-muted px-2 py-1.5">
            <Item icon={PlusCircle} onSelect={() => go("/businesses?new=1")}>Add Business</Item>
            <Item icon={CalendarClock} onSelect={() => go("/today?tab=planner")}>Plan Day</Item>
            <Item icon={UserPlus} onSelect={() => go("/today?tab=planner")}>Assign FO</Item>
            <Item icon={PlayCircle} onSelect={() => go("/today")}>Start Session</Item>
            <Item icon={AlertTriangle} onSelect={() => go("/issues?new=1")}>Report Issue</Item>
          </Command.Group>
        )}

        {!query && (
          <Command.Group heading="Go to" className="text-[11px] font-medium text-muted px-2 py-1.5">
            <Item icon={LayoutDashboard} onSelect={() => go("/")}>Command Center</Item>
            <Item icon={CalendarClock} onSelect={() => go("/today")}>Today</Item>
            <Item icon={Store} onSelect={() => go("/businesses")}>Businesses</Item>
            <Item icon={Users} onSelect={() => go("/field-officers")}>Field Officers</Item>
            <Item icon={Radio} onSelect={() => go("/sessions")}>Sessions</Item>
            <Item icon={AlertTriangle} onSelect={() => go("/issues")}>Issues</Item>
            <Item icon={ShieldCheck} onSelect={() => go("/quality")}>Quality</Item>
            <Item icon={FileText} onSelect={() => go("/reports")}>Reports</Item>
            <Item icon={BarChart3} onSelect={() => go("/analytics")}>Analytics</Item>
            <Item icon={Sparkles} onSelect={() => go("/search")}>City Copilot / Search</Item>
          </Command.Group>
        )}

        {results.length > 0 && (
          <Command.Group heading="Results" className="text-[11px] font-medium text-muted px-2 py-1.5">
            {results.map((r) => (
              <Command.Item
                key={`${r.kind}-${r.id}`}
                value={`${r.kind}-${r.id}-${r.title}`}
                onSelect={() => go(r.to)}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer aria-selected:bg-surface-2"
              >
                <StatusDot status={r.status} />
                <span className="flex-1 truncate">{r.title}</span>
                <span className="text-xs text-muted truncate max-w-[40%]">{r.subtitle}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function Item({
  icon: Icon,
  children,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer aria-selected:bg-surface-2"
    >
      <Icon className="size-4 text-muted" />
      {children}
    </Command.Item>
  );
}
