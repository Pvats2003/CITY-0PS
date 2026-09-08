import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileTopbar } from "./MobileNav";
import { CommandPalette } from "@/components/CommandPalette";
import { SystemStatusDialog } from "@/components/SystemStatusDialog";

export function AppShell() {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <MobileTopbar />
        <div className="hidden md:block">
          <Topbar />
        </div>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <SystemStatusDialog />
    </div>
  );
}
