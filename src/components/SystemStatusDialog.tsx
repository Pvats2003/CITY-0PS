import { useEffect, useState } from "react";
import { Wifi, WifiOff, HardDrive } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { useCity, STORAGE_KEY } from "@/store/city";

export function SystemStatusDialog() {
  const open = useUI((s) => s.systemStatusOpen);
  const setOpen = useUI((s) => s.setSystemStatusOpen);
  const data = useCity();
  const [online, setOnline] = useState(navigator.onLine);
  const [sizeKB, setSizeKB] = useState(0);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    setSizeKB(Math.round((new Blob([raw]).size / 1024) * 10) / 10);
  }, [open, data]);

  const counts = [
    ["Businesses", data.businesses.length],
    ["Field Officers", data.fos.length],
    ["Collectors", data.collectors.length],
    ["Rigs", data.rigs.length],
    ["Assignments", data.assignments.length],
    ["Sessions", data.sessions.length],
    ["Issues", data.issues.length],
    ["Activity events", data.activity.length],
  ] as const;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>System Status</DialogTitle>
          <DialogDescription>Everything runs locally in this browser. No server, no cloud.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
          {online ? <Wifi className="size-4 text-success" /> : <WifiOff className="size-4 text-warning" />}
          <span className="flex-1">{online ? "Online" : "Offline"} — core workflows work either way</span>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
          <HardDrive className="size-4 text-info" />
          <span className="flex-1">Local storage in use</span>
          <span className="tabular-nums font-medium">{sizeKB} KB</span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          {counts.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2">
              <span className="text-muted">{label}</span>
              <span className="font-medium tabular-nums">{value}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
