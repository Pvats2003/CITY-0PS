import { useState } from "react";
import { Sparkles, Building2, ArrowRight, Import } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCity } from "@/store/city";
import { generateDemoData } from "@/lib/demo/generate";

export default function Onboarding() {
  const loadData = useCity((s) => s.loadData);
  const updateSettings = useCity((s) => s.updateSettings);
  const [mode, setMode] = useState<"choice" | "manual">("choice");
  const [cityName, setCityName] = useState("My City");

  function loadDemo() {
    const data = generateDemoData();
    loadData(data);
  }

  function startBlank() {
    updateSettings({ cityName: cityName || "My City", onboarded: true });
  }

  return (
    <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">C</div>
          <div className="text-xl font-semibold tracking-tight">City Ops OS</div>
        </div>

        {mode === "choice" && (
          <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
            <div className="text-center">
              <h1 className="text-lg font-semibold">Welcome to City Ops OS</h1>
              <p className="text-sm text-muted mt-1">
                A local-first command center for running field operations. Everything stays on this device — zero cost, zero cloud.
              </p>
            </div>

            <div className="grid gap-3 pt-2">
              <button
                onClick={loadDemo}
                className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-left hover:border-primary/50 transition-colors"
              >
                <Sparkles className="size-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium">Load Demo City</div>
                  <div className="text-xs text-muted mt-0.5">
                    Explore a fully populated city — 18 businesses, 5 FOs, 8 rigs, and a week of realistic operational history.
                  </div>
                </div>
              </button>

              <button
                onClick={() => setMode("manual")}
                className="flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:border-border-strong transition-colors"
              >
                <Building2 className="size-5 text-muted shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium">Start My City</div>
                  <div className="text-xs text-muted mt-0.5">
                    Begin with a blank city and add your own businesses, field officers, rigs, and plans.
                  </div>
                </div>
              </button>
            </div>

            <div className="text-center pt-1">
              <span className="text-xs text-muted">Have a backup file?</span>{" "}
              <button onClick={startBlank} className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                <Import className="size-3" /> Skip to import
              </button>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
            <h1 className="text-lg font-semibold">Name your city</h1>
            <p className="text-sm text-muted">You can add businesses, field officers, rigs and collectors right after this.</p>
            <div className="space-y-1.5">
              <Label htmlFor="cityname">City name</Label>
              <Input id="cityname" value={cityName} onChange={(e) => setCityName(e.target.value)} placeholder="e.g. Bengaluru South" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setMode("choice")}>
                Back
              </Button>
              <Button onClick={startBlank}>
                Start my city <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
