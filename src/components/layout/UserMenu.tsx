import { Link } from "react-router-dom";
import { UserRound, Settings as SettingsIcon, LogOut } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ROLE_LABEL: Record<string, string> = {
  MANAGER: "Manager",
  FIELD_OFFICER: "Field Officer",
};

/** Top-right account identity + Sign Out — the one place every
 * authenticated Manager screen shows who's signed in and lets them leave.
 * Real Firebase/demo sign-out via the existing auth abstraction; no new
 * auth mechanism. */
export function UserMenu() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const name = user.displayName || user.email;
  const initials = (user.displayName || user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2 transition-colors">
          <div className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold shrink-0">
            {initials || <UserRound className="size-3.5" />}
          </div>
          <div className="hidden sm:block text-left leading-tight">
            <div className="text-xs font-medium truncate max-w-32">{name}</div>
            <div className="text-[10px] text-muted">{ROLE_LABEL[user.role] ?? user.role}</div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="font-medium text-foreground truncate">{name}</div>
          <div className="text-[11px] text-muted-2">{ROLE_LABEL[user.role] ?? user.role}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <UserRound className="size-4" /> Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SettingsIcon className="size-4" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => logout()}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
