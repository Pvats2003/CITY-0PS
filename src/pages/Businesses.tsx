import { useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { PlusCircle, Search, Store, MapPin } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status";
import { useCity } from "@/store/city";
import { computeBusinessStats } from "@/engine/insights";
import { BusinessFormDialog } from "@/components/forms/BusinessFormDialog";
import { fmtDate } from "@/lib/dates";

export default function Businesses() {
  const data = useCity();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("all");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(params.get("new") === "1");

  const areas = useMemo(() => [...new Set(data.businesses.map((b) => b.area))].sort(), [data.businesses]);

  const filtered = data.businesses.filter((b) => {
    if (query && !`${b.name} ${b.category} ${b.area}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (area !== "all" && b.area !== area) return false;
    if (status === "active" && !b.active) return false;
    if (status === "inactive" && b.active) return false;
    return true;
  });

  function closeDialog(v: boolean) {
    setOpen(v);
    if (!v && params.get("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }

  return (
    <div className="pb-10">
      <PageHeader
        title="Businesses"
        subtitle={`${data.businesses.length} total · ${data.businesses.filter((b) => b.active).length} active`}
        actions={
          <Button onClick={() => setOpen(true)}>
            <PlusCircle className="size-4" /> Add Business
          </Button>
        }
      />

      <div className="px-4 md:px-6 pt-4 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-56 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-2" />
          <Input placeholder="Search businesses…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select value={area} onValueChange={setArea}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="px-4 md:px-6 pt-4">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Store}
            title={data.businesses.length === 0 ? "No businesses yet" : "No businesses match your filters"}
            description={data.businesses.length === 0 ? "Add your first business to start planning visits." : "Try a different search or clear filters."}
            action={
              data.businesses.length === 0 && (
                <Button onClick={() => setOpen(true)}>
                  <PlusCircle className="size-4" /> Add Business
                </Button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((b) => {
              const stats = computeBusinessStats(data, b);
              return (
                <Link key={b.id} to={`/businesses/${b.id}`}>
                  <Card className="p-4 h-full hover:border-border-strong transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{b.name}</div>
                        <div className="text-xs text-muted mt-0.5">{b.category}</div>
                      </div>
                      <StatusBadge status={b.active ? "healthy" : "offline"} />
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted mt-2">
                      <MapPin className="size-3" /> {b.area}
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-border text-xs">
                      <span className="text-muted">
                        {stats.totalVisits > 0 ? `${stats.successfulVisits}/${stats.totalVisits} successful` : "No visits yet"}
                      </span>
                      {stats.reliabilityScore < 75 && stats.totalVisits >= 2 ? (
                        <Badge variant="warning">At risk</Badge>
                      ) : stats.totalVisits >= 2 ? (
                        <Badge variant="success">Reliable</Badge>
                      ) : null}
                    </div>
                    {stats.lastVisitAt && <div className="text-[11px] text-muted-2 mt-1">Last visit {fmtDate(stats.lastVisitAt)}</div>}
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <BusinessFormDialog open={open} onOpenChange={closeDialog} />
    </div>
  );
}
