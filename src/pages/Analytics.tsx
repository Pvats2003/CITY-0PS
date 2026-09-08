import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { PageHeader } from "@/components/shared/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCity } from "@/store/city";
import {
  buildTrend,
  buildLossBreakdown,
  buildBusinessRanking,
  buildFORanking,
  buildQualityDistribution,
} from "@/engine/analytics";
import { EmptyState } from "@/components/shared/EmptyState";
import { BarChart3 } from "lucide-react";

const GRID = "var(--color-border)";
const AXIS = "var(--color-muted)";
const TOOLTIP_STYLE = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};

const QUALITY_COLORS: Record<string, string> = {
  Pass: "var(--color-success)",
  Warn: "var(--color-warning)",
  Fail: "var(--color-critical)",
};

const LOSS_COLORS = ["var(--color-critical)", "var(--color-warning)", "var(--color-accent)", "var(--color-info)", "var(--color-muted)"];

export default function Analytics() {
  const data = useCity();
  const [range, setRange] = useState<"7" | "30">("7");
  const days = Number(range);

  const trend = useMemo(() => buildTrend(data, days), [data, days]);
  const loss = useMemo(() => buildLossBreakdown(data, days), [data, days]);
  const businesses = useMemo(() => buildBusinessRanking(data), [data]);
  const fos = useMemo(() => buildFORanking(data), [data]);
  const quality = useMemo(() => buildQualityDistribution(data), [data]);

  const best = businesses.slice(0, 5);
  const worst = [...businesses]
    .reverse()
    .filter((b) => b.reliability < 90 && !best.includes(b))
    .slice(0, 5);

  const hasAnyData = data.sessions.length > 0;

  if (!hasAnyData) {
    return (
      <div>
        <PageHeader title="Analytics" />
        <EmptyState icon={BarChart3} title="Not enough data yet" description="Analytics fill in once you have sessions on record." />
      </div>
    );
  }

  return (
    <div className="pb-10">
      <PageHeader
        title="Analytics"
        subtitle="A few charts that answer real operating questions."
        actions={
          <Tabs value={range} onValueChange={(v) => setRange(v as "7" | "30")}>
            <TabsList>
              <TabsTrigger value="7">7 days</TabsTrigger>
              <TabsTrigger value="30">30 days</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <div className="px-4 md:px-6 pt-5 grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recording Performance — Target vs Actual</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ left: -12 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} width={36} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="actual" name="Actual hours" fill="var(--color-primary)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line dataKey="target" name="Target" stroke="var(--color-muted-2)" strokeDasharray="4 3" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Utilization — Planned vs Completed vs Lost</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ left: -12 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS }} axisLine={{ stroke: GRID }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} width={36} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="planned" name="Planned" fill="var(--color-muted-2)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="actual" name="Completed" fill="var(--color-success)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="lost" name="Lost" fill="var(--color-critical)" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Business Reliability</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            <div>
              <div className="text-xs font-medium text-success mb-2">Best</div>
              <div className="space-y-2">
                {best.map((b) => (
                  <RankRow key={b.id} to={`/businesses/${b.id}`} name={b.name} value={b.reliability} suffix="%" tone="success" />
                ))}
              </div>
            </div>
            {worst.length > 0 && (
              <div>
                <div className="text-xs font-medium text-critical mb-2">Needs attention</div>
                <div className="space-y-2">
                  {worst.map((b) => (
                    <RankRow key={b.id} to={`/businesses/${b.id}`} name={b.name} value={b.reliability} suffix="%" tone="critical" />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>FO Execution Performance</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fos} layout="vertical" margin={{ left: 8 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} width={90} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => `${v}%`} />
                <Bar dataKey="onTimePct" name="On-time %" fill="var(--color-primary)" radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quality Distribution</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 h-64">
            {quality.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-muted">No quality reviews yet.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={quality} dataKey="count" nameKey="verdict" innerRadius={55} outerRadius={80} paddingAngle={2} fill="var(--color-primary)" isAnimationActive={false}>
                    {quality.map((q) => (
                      <Cell key={q.verdict} fill={QUALITY_COLORS[q.verdict]} stroke="var(--color-surface)" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where Hours Are Being Lost</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 h-64">
            {loss.length === 0 ? (
              <div className="flex items-center justify-center h-full text-sm text-success">No losses in this window.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={loss} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" tick={{ fontSize: 11, fill: AXIS }} axisLine={false} tickLine={false} width={130} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => `${v}h`} />
                  <Bar dataKey="hours" name="Hours lost" radius={[0, 4, 4, 0]} maxBarSize={18}>
                    {loss.map((_, i) => (
                      <Cell key={i} fill={LOSS_COLORS[i % LOSS_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RankRow({ to, name, value, suffix, tone }: { to: string; name: string; value: number; suffix: string; tone: "success" | "critical" }) {
  return (
    <div className="flex items-center gap-2">
      <Link to={to} className="text-sm flex-1 truncate hover:underline">
        {name}
      </Link>
      <span className={`text-sm font-medium tabular-nums ${tone === "success" ? "text-success" : "text-critical"}`}>
        {value}
        {suffix}
      </span>
    </div>
  );
}
