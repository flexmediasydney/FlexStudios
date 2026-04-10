import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign, TrendingUp, AlertTriangle, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";

/* ---------- sub-components ---------- */

function HorizontalBar({ label, value, maxValue, color = "bg-primary" }) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-muted-foreground w-28 truncate">{label}</span>
      <div className="flex-1 bg-muted rounded-full h-2.5">
        <div
          className={cn("h-2.5 rounded-full transition-all", color)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs font-medium w-16 text-right">
        ${(value / 1000).toFixed(1)}k
      </span>
    </div>
  );
}

function VelocityChart({ weeks = [] }) {
  const max = Math.max(...weeks.flatMap((w) => [w.created, w.completed]), 1);
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1 h-32">
        {weeks.map((w, i) => (
          <div key={i} className="flex-1 flex items-end gap-0.5">
            <div
              className="flex-1 bg-blue-400/60 rounded-t"
              style={{ height: `${(w.created / max) * 100}%` }}
              title={`Created: ${w.created}`}
            />
            <div
              className="flex-1 bg-emerald-500/60 rounded-t"
              style={{ height: `${(w.completed / max) * 100}%` }}
              title={`Completed: ${w.completed}`}
            />
          </div>
        ))}
      </div>
      {/* week labels */}
      <div className="flex gap-1">
        {weeks.map((w, i) => (
          <span key={i} className="flex-1 text-[10px] text-muted-foreground text-center truncate">
            {w.week_start ? new Date(w.week_start).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : `W${i + 1}`}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-400/60" /> Created
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500/60" /> Completed
        </span>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, color = "text-primary" }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className={cn("p-2 rounded-lg bg-muted", color)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold truncate">{value}</p>
          {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-20 rounded-xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-8 text-center">
      <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">No dashboard data yet</p>
      <p className="text-xs text-muted-foreground mt-1">Stats will appear once projects are being tracked.</p>
    </Card>
  );
}

/* ---------- main component ---------- */

export default function BusinessIntelDash() {
  const { data: stats, isLoading } = useDashboardStats();

  if (isLoading) return <LoadingSkeleton />;

  const revenue = stats?.revenue;
  const delivery = stats?.delivery;
  const velocity = stats?.velocity;
  const pipeline = stats?.pipeline;

  const hasData = revenue || delivery || velocity;
  if (!hasData) return <EmptyState />;

  // Revenue by agency — top 10
  const agencyRevenue = revenue?.by_agency ?? [];
  const topAgencies = [...agencyRevenue].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)).slice(0, 10);
  const maxAgencyRev = topAgencies[0]?.revenue || 1;

  // Velocity weeks
  const weeks = velocity?.weekly ?? [];

  return (
    <div className="space-y-6">
      {/* Revenue Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Month-to-Date"
          value={`$${((revenue?.mtd_revenue ?? 0) / 1000).toFixed(1)}k`}
          sub={revenue?.growth_pct != null ? `${revenue.growth_pct >= 0 ? "+" : ""}${revenue.growth_pct}% vs last month` : undefined}
          icon={DollarSign}
          color="text-emerald-600"
        />
        <StatCard
          label="Total Revenue"
          value={`$${((revenue?.total_revenue ?? 0) / 1000).toFixed(1)}k`}
          icon={DollarSign}
          color="text-blue-600"
        />
        <StatCard
          label="Avg Project Value"
          value={`$${((revenue?.avg_project_value ?? 0) / 1000).toFixed(1)}k`}
          icon={TrendingUp}
          color="text-violet-600"
        />
        <StatCard
          label="At Risk"
          value={`$${((revenue?.revenue_at_risk ?? 0) / 1000).toFixed(1)}k`}
          sub={pipeline?.needs_attention?.length ? `${pipeline.needs_attention.length} project${pipeline.needs_attention.length !== 1 ? "s" : ""}` : undefined}
          icon={AlertTriangle}
          color="text-red-600"
        />
      </div>

      {/* Revenue by Agency */}
      {topAgencies.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Revenue by Agency (Top 10)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {topAgencies.map((a) => (
              <HorizontalBar
                key={a.agency_name}
                label={a.agency_name}
                value={a.revenue ?? 0}
                maxValue={maxAgencyRev}
                color="bg-blue-500"
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Velocity Chart */}
      {weeks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Project Velocity (8 Weeks)</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                Created vs Completed
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <VelocityChart weeks={weeks} />
          </CardContent>
        </Card>
      )}

      {/* Delivery Quality */}
      {delivery && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Delivery Quality</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold">
                  {delivery.on_time_pct != null ? `${delivery.on_time_pct}%` : "--"}
                </p>
                <p className="text-xs text-muted-foreground">On-Time Delivery</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold">
                  {delivery.avg_turnaround_days != null ? `${delivery.avg_turnaround_days}d` : "--"}
                </p>
                <p className="text-xs text-muted-foreground">Avg Turnaround</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold">
                  {delivery.revision_rate != null ? `${delivery.revision_rate}%` : "--"}
                </p>
                <p className="text-xs text-muted-foreground">Revision Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
