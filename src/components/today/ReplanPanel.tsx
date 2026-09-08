import { useState } from "react";
import { Zap, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import { proposeReplan, type ReplanSuggestion } from "@/engine/planner";
import { todayISO } from "@/lib/dates";

const KINDS = [
  { value: "fo_unavailable", label: "FO becomes unavailable" },
  { value: "rig_unavailable", label: "Rig fails / becomes unsafe" },
  { value: "business_cancelled", label: "Business cancels" },
] as const;

export function ReplanPanel() {
  const data = useCity();
  const updateAssignment = useCity((s) => s.updateAssignment);
  const logActivity = useCity((s) => s.logActivity);
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("fo_unavailable");
  const [targetId, setTargetId] = useState("");
  const [result, setResult] = useState<{ note: string; suggestions: ReplanSuggestion[] } | null>(null);
  const [applied, setApplied] = useState(false);

  const targets =
    kind === "fo_unavailable"
      ? data.fos.filter((f) => f.active)
      : kind === "rig_unavailable"
        ? data.rigs.filter((r) => r.deploymentStatus !== "retired")
        : data.businesses.filter((b) => b.active);

  function run() {
    if (!targetId) return;
    const disruption =
      kind === "fo_unavailable"
        ? { kind, foId: targetId }
        : kind === "rig_unavailable"
          ? { kind, rigId: targetId }
          : { kind, businessId: targetId };
    const r = proposeReplan(data, todayISO(), disruption);
    setResult(r);
    setApplied(false);
  }

  function apply() {
    if (!result) return;
    for (const s of result.suggestions) {
      updateAssignment(s.assignmentId, s.patch);
    }
    logActivity({
      type: "plan_changed",
      entityKind: "plan",
      entityId: "replan",
      summary: `Smart replan applied: ${result.suggestions.length} change${result.suggestions.length === 1 ? "" : "s"}`,
    });
    setApplied(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Smart Replanning</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-muted">
          Something changed today? Model the disruption and get a minimal set of changes — no need to rebuild the whole day.
        </p>
        <div className="flex flex-wrap gap-2">
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v as typeof kind);
              setTargetId("");
              setResult(null);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {"name" in t ? t.name : t.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="secondary" onClick={run} disabled={!targetId}>
            <Zap className="size-4" /> Show impact
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="text-sm font-medium">PLAN IMPACT</div>
            <div className="text-sm text-muted">{result.note}</div>
            {result.suggestions.length > 0 && (
              <ol className="space-y-2 list-decimal list-inside text-sm">
                {result.suggestions.map((s, i) => (
                  <li key={i}>
                    {s.description}
                    {s.why && s.why.length > 0 && (
                      <div className="ml-5 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-success">
                        {s.why.map((w, j) => (
                          <span key={j}>✓ {w}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {result.suggestions.length > 0 && (
              <Button size="sm" onClick={apply} disabled={applied}>
                <CheckCircle2 className="size-4" /> {applied ? "Applied" : "Apply Changes"}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
