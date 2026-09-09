import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Menu, X, Command, LogOut } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";
import { useAuth } from "@/auth/AuthContext";

const ROLE_LABEL: Record<string, string> = {
  MANAGER: "Manager",
  FIELD_OFFICER: "Field Officer",
};

export function MobileTopbar() {
  const [open, setOpen] = useState(false);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const { user, logout } = useAuth();

  return (
    <>
      <header className="flex md:hidden items-center gap-2 h-14 border-b border-border bg-surface px-3">
        <button onClick={() => setOpen(true)} className="p-2 -ml-2 rounded-md hover:bg-surface-2">
          <Menu className="size-5" />
        </button>
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-xs">
          C
        </div>
        <div className="text-sm font-semibold flex-1">City Ops OS</div>
        <button onClick={() => setPaletteOpen(true)} className="p-2 rounded-md hover:bg-surface-2">
          <Command className="size-5" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-64 bg-surface border-r border-border p-2 flex flex-col">
            <div className="flex items-center justify-between px-2 py-2">
              <span className="text-sm font-semibold">Menu</span>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-md hover:bg-surface-2">
                <X className="size-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto space-y-0.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={"end" in item ? item.end : false}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium",
                        isActive ? "bg-primary/10 text-primary" : "text-muted hover:bg-surface-2",
                      )
                    }
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </NavLink>
                );
              })}
            </nav>
            {user && (
              <div className="border-t border-border pt-2 mt-2 space-y-1">
                <div className="px-2.5 py-1">
                  <div className="text-xs font-medium truncate">{user.displayName || user.email}</div>
                  <div className="text-[11px] text-muted">{ROLE_LABEL[user.role] ?? user.role}</div>
                </div>
                <button
                  onClick={() => logout()}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
                >
                  <LogOut className="size-4" /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
