import { Search, Sun, Moon, Laptop } from "lucide-react";
import { useCity } from "@/store/city";
import { useUI } from "@/store/ui";
import { computeCityHealth, healthStatus } from "@/engine/health";
import { todayISO, fmtDate } from "@/lib/dates";
import { StatusBadge } from "@/components/status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { UserMenu } from "./UserMenu";

export function Topbar() {
  const data = useCity();
  const updateSettings = useCity((s) => s.updateSettings);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const date = todayISO();
  const health = computeCityHealth(data, date);
  const status = healthStatus(health.score);

  const ThemeIcon = data.settings.theme === "dark" ? Moon : data.settings.theme === "light" ? Sun : Laptop;

  return (
    <header className="flex items-center gap-3 h-14 border-b border-border bg-surface px-4">
      <button
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 flex-1 max-w-md rounded-md border border-border bg-background px-3 h-9 text-sm text-muted-2 hover:border-border-strong transition-colors"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search businesses, FOs, sessions…</span>
        <kbd className="text-[10px] border border-border rounded px-1 py-0.5">⌘K</kbd>
      </button>

      <div className="flex-1" />

      <div className="hidden sm:block text-sm text-muted tabular-nums">{fmtDate(date, "EEEE, MMM d")}</div>

      <StatusBadge status={status} className="tabular-nums">
        City {health.score}
      </StatusBadge>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm">
            <ThemeIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => updateSettings({ theme: "light" })}>
            <Sun className="size-4" /> Light
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => updateSettings({ theme: "dark" })}>
            <Moon className="size-4" /> Dark
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => updateSettings({ theme: "system" })}>
            <Laptop className="size-4" /> System
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="w-px h-6 bg-border" />

      <UserMenu />
    </header>
  );
}
