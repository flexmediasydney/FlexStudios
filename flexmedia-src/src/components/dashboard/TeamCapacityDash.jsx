import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, AlertTriangle, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";

/* ---------- sub-components ---------- */

function UtilizationBar({ name, role, pct }) {
  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-3">
      <div className="w-32">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-[10px] text-muted-foreground capitalize">
          {role?.replace(/_/g, " ")}
        </p>
      </div>
      <div className="flex-1 bg-muted rounded-full h-3">
        <div
          className={cn("h-3 rounded-full transition-all", color)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span
        className={cn(
          "text-xs font-bold w-12 text-right",
          pct > 90 ? "text-red-600" : pct > 70 ? "text-amber-600" : "text-emerald-600"
        )}
      >
        {pct}%
      </span>
    </div>
  );
}

function SummaryCard({ label, value, sub, icon: Icon, color = "text-primary" }) {
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
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-8 text-center">
      <Users className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">No capacity data yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        Staff utilization will appear once team members have assigned tasks.
      </p>
    </Card>
  );
}

/* ---------- main component ---------- */

export default function TeamCapacityDash() {
  const { data: stats, isLoading } = useDashboardStats();

  if (isLoading) return <LoadingSkeleton />;

  const utilization = stats?.utilization;
  const byUser = utilization?.by_user ?? [];
  const byRole = stats?.tasks?.by_role ?? [];

  if (byUser.length === 0) return <EmptyState />;

  const overallPct = utilization?.overall_utilization_pct ?? 0;
  const overloaded = byUser.filter((u) => u.utilization_pct > 90).length;
  const underloaded = byUser.filter((u) => u.utilization_pct < 40).length;

  // Sort by utilization descending so highest load is visible first
  const sortedUsers = [...byUser].sort((a, b) => b.utilization_pct - a.utilization_pct);

  return (
    <div className="space-y-6">
      {/* Team Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          label="Overall Utilization"
          value={`${overallPct}%`}
          sub={`${byUser.length} team member${byUser.length !== 1 ? "s" : ""}`}
          icon={Users}
          color="text-blue-600"
        />
        <SummaryCard
          label="Overloaded"
          value={overloaded}
          sub={overloaded > 0 ? "Above 90% capacity" : "No one overloaded"}
          icon={AlertTriangle}
          color={overloaded > 0 ? "text-red-600" : "text-emerald-600"}
        />
        <SummaryCard
          label="Underloaded"
          value={underloaded}
          sub={underloaded > 0 ? "Below 40% capacity" : "Everyone busy"}
          icon={TrendingDown}
          color={underloaded > 0 ? "text-amber-600" : "text-emerald-600"}
        />
      </div>

      {/* Staff Utilization Bars */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Staff Utilization</CardTitle>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> &lt;70%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> 70-90%
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> &gt;90%
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedUsers.map((u) => (
            <UtilizationBar
              key={u.user_name}
              name={u.user_name}
              role={u.role}
              pct={u.utilization_pct}
            />
          ))}
        </CardContent>
      </Card>

      {/* Task Distribution by Role */}
      {byRole.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Task Distribution by Role</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {byRole.map((r) => (
                <div
                  key={r.role}
                  className="p-3 rounded-lg bg-muted/50 border border-border/40"
                >
                  <p className="text-xs font-medium capitalize truncate">
                    {r.role?.replace(/_/g, " ")}
                  </p>
                  <p className="text-xl font-bold mt-1">{r.task_count ?? 0}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[10px]",
                        (r.avg_utilization ?? 0) > 90
                          ? "bg-red-100 text-red-700"
                          : (r.avg_utilization ?? 0) > 70
                          ? "bg-amber-100 text-amber-700"
                          : "bg-emerald-100 text-emerald-700"
                      )}
                    >
                      {r.avg_utilization ?? 0}% avg
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {r.member_count ?? 0} staff
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
