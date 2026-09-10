import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useCity } from "@/store/city";
import { isGoogleMapsUrl } from "@/lib/googleMaps";
import { omitUndefined } from "@/lib/omitUndefined";
import type { Business } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  business?: Business;
  onSaved?: (b: Business) => void;
}

const emptyForm = {
  name: "",
  category: "",
  area: "",
  address: "",
  googleMapsUrl: "",
  contactName: "",
  contactPhone: "",
  preferredWindowStart: "",
  preferredWindowEnd: "",
  capacityHoursPerDay: 3,
  notes: "",
  active: true,
};

export function BusinessFormDialog({ open, onOpenChange, business, onSaved }: Props) {
  const addBusiness = useCity((s) => s.addBusiness);
  const updateBusiness = useCity((s) => s.updateBusiness);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setForm(
        business
          ? {
              name: business.name,
              category: business.category,
              area: business.area,
              address: business.address,
              googleMapsUrl: business.googleMapsUrl ?? "",
              contactName: business.contactName ?? "",
              contactPhone: business.contactPhone ?? "",
              preferredWindowStart: business.preferredWindowStart ?? "",
              preferredWindowEnd: business.preferredWindowEnd ?? "",
              capacityHoursPerDay: business.capacityHoursPerDay,
              notes: business.notes ?? "",
              active: business.active,
            }
          : emptyForm,
      );
    }
  }, [open, business]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    if (!form.name.trim()) return setError("Business name is required.");
    if (!form.area.trim()) return setError("Area is required.");
    if (form.capacityHoursPerDay <= 0) return setError("Capacity hours must be greater than 0.");
    const trimmedMapsUrl = form.googleMapsUrl.trim();
    if (trimmedMapsUrl && !isGoogleMapsUrl(trimmedMapsUrl)) {
      return setError("That doesn't look like a Google Maps link. Paste a link from Google Maps (google.com/maps, maps.google.com, or a maps.app.goo.gl share link).");
    }

    // omitUndefined: Firestore's setDoc() rejects a document containing an
    // explicit `undefined` field value client-side — a blank optional
    // field below must be OMITTED, not set to undefined (see
    // src/lib/omitUndefined.ts).
    const payload = omitUndefined({
      name: form.name.trim(),
      category: form.category.trim() || "General",
      area: form.area.trim(),
      address: form.address.trim(),
      googleMapsUrl: trimmedMapsUrl || undefined,
      contactName: form.contactName.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      preferredWindowStart: form.preferredWindowStart || undefined,
      preferredWindowEnd: form.preferredWindowEnd || undefined,
      capacityHoursPerDay: form.capacityHoursPerDay,
      notes: form.notes.trim() || undefined,
      active: form.active,
    });

    if (business) {
      updateBusiness(business.id, payload);
      onSaved?.({ ...business, ...payload });
    } else {
      const created = addBusiness(payload);
      onSaved?.(created);
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{business ? "Edit business" : "Add business"}</DialogTitle>
          <DialogDescription>Businesses are the sites your field officers visit for recording sessions.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="biz-name">Business name *</Label>
            <Input id="biz-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Urban Grocer" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-category">Category</Label>
            <Input id="biz-category" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="e.g. Retail" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-area">Area *</Label>
            <Input id="biz-area" value={form.area} onChange={(e) => set("area", e.target.value)} placeholder="e.g. Indiranagar" />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="biz-address">Address</Label>
            <Input id="biz-address" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, landmark" />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="biz-maps-url">Google Maps Location</Label>
            <Input
              id="biz-maps-url"
              value={form.googleMapsUrl}
              onChange={(e) => set("googleMapsUrl", e.target.value)}
              placeholder="Paste Google Maps link"
            />
            <p className="text-xs text-muted">Paste the Google Maps link for the business location.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-contact">Contact name</Label>
            <Input id="biz-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-phone">Contact phone</Label>
            <Input id="biz-phone" value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-window-start">Preferred window start</Label>
            <Input id="biz-window-start" type="time" value={form.preferredWindowStart} onChange={(e) => set("preferredWindowStart", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-window-end">Preferred window end</Label>
            <Input id="biz-window-end" type="time" value={form.preferredWindowEnd} onChange={(e) => set("preferredWindowEnd", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-capacity">Capacity (hours/day)</Label>
            <Input
              id="biz-capacity"
              type="number"
              min={0.5}
              step={0.5}
              value={form.capacityHoursPerDay}
              onChange={(e) => set("capacityHoursPerDay", Number(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 self-end">
            <Label htmlFor="biz-active" className="text-sm text-foreground font-normal">
              Active
            </Label>
            <Switch id="biz-active" checked={form.active} onCheckedChange={(v) => set("active", v)} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="biz-notes">Notes</Label>
            <Textarea id="biz-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
          </div>
        </div>

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{business ? "Save changes" : "Add business"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
