import { NavLink } from "react-router-dom";
import { Command, Upload, Settings as SettingsIcon, Sparkles, Activity } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { cn } from "@/lib/utils";
import { useCity } from "@/store/city";
import { useUI } from "@/store/ui";
import { activeSessions, issuesOpen } from "@/engine/selectors";
import { buildFleetRanking, isDeployable } from "@/engine/rigGuardian";
import { useSyncStatus } from "@/data/useSyncStatus";
import { isFirebaseConfigured } from "@/auth/config";
import { Badge } from "@/components/ui/badge";

const STATUS_DOT_CLASS: Record<string, string> = {
  disabled: "bg-success", // demo/local mode is always "healthy" — nothing to fail
  online: "bg-success",
  syncing: "bg-info animate-pulse",
  offline: "bg-warning",
  error: "bg-critical",
};

export function Sidebar() {
  const data = useCity();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const setSystemStatusOpen = useUI((s) => s.setSystemStatusOpen);
  const { status } = useSyncStatus();

  const openCritical = issuesOpen(data).filter((i) => i.severity === "critical").length;
  const liveSessions = activeSessions(data).length;
  const unsafeRigs = buildFleetRanking(data).filter((s) => !isDeployable(s.readiness)).length;

  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
          C
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">City Ops OS</div>
          <div className="text-[11px] text-muted">{data.settings.cityName}</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-none px-2 py-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const badge = item.to === "/issues" ? openCritical : item.to === "/sessions" ? liveSessions : item.to === "/fleet" ? unsafeRigs : 0;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted hover:bg-surface-2 hover:text-foreground",
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {badge > 0 && (
                <Badge variant={item.to === "/issues" || item.to === "/fleet" ? "critical" : "info"} className="px-1.5 py-0 text-[10px]">
                  {badge}
                </Badge>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-border p-2 space-y-0.5">
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
        >
          <Command className="size-4" />
          <span className="flex-1 text-left">Command Palette</span>
          <kbd className="text-[10px] text-muted-2 border border-border rounded px-1">⌘K</kbd>
        </button>
        <NavLink
          to="/settings?tab=data"
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
        >
          <Upload className="size-4" />
          Import / Export
        </NavLink>
        {!isFirebaseConfigured() && (
          <NavLink
            to="/settings?tab=data"
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
          >
            <Sparkles className="size-4" />
            Demo Data
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
        >
          <SettingsIcon className="size-4" />
          Settings
        </NavLink>
        <button
          onClick={() => setSystemStatusOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
        >
          <Activity className="size-4" />
          <span className="flex-1 text-left">System Status</span>
          <span className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[status])} title={status} />
        </button>
      </div>
    </aside>
  );
}
