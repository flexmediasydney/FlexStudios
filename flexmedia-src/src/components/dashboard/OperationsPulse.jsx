import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";
import Sparkline from "@/components/dashboard/Sparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp, TrendingDown, AlertTriangle, Clock,
  CheckCircle2, Calendar, DollarSign, Zap, UserX,
  ArrowRight, Camera, Package,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/api/supabaseClient";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { format, isToday, isTomorrow, parseISO } from "date-fns";

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

function KpiCard({ title, value, subtitle, trend, trendData, icon: Icon, color }) {
  const isPositive = trend > 0;
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={cn("p-1.5 rounded-lg", color)}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">{title}</span>
          </div>
          <Sparkline data={trendData} width={60} height={20} color={isPositive ? "#22c55e" : "#ef4444"} />
        </div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="flex items-center gap-1 mt-1">
          <TrendIcon className={cn("h-3 w-3", isPositive ? "text-green-600" : "text-red-600")} />
          <span className={cn("text-xs font-medium", isPositive ? "text-green-600" : "text-red-600")}>
            {Math.abs(trend).toFixed(1)}%
          </span>
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Attention item
// ---------------------------------------------------------------------------

const SEVERITY_STYLES = {
  critical: { bg: "border-l-red-500 bg-red-50/50", badge: "bg-red-100 text-red-700" },
  warning:  { bg: "border-l-amber-500 bg-amber-50/50", badge: "bg-amber-100 text-amber-700" },
};

function AttentionRow({ severity, icon: Icon, label, count, link }) {
  const sev = SEVERITY_STYLES[severity] || SEVERITY_STYLES.warning;
  return (
    <Link
      to={link}
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border-l-4 transition-colors hover:brightness-95",
        sev.bg,
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", severity === "critical" ? "text-red-600" : "text-amber-600")} />
      <span className="flex-1 text-sm font-medium">{label}</span>
      <Badge variant="secondary" className={cn("text-xs", sev.badge)}>{count}</Badge>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Shoot timeline item
// ---------------------------------------------------------------------------

function ShootRow({ project }) {
  const time = project.shoot_time || "TBD";
  const title = project.title || project.property_address || "Untitled";
  const subtitle = project.property_address && project.title !== project.property_address
    ? project.property_address : (project.photographer_name || project.status || "");
  return (
    <Link
      to={createPageUrl(`ProjectDetails?id=${project.id}`)}
      className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary shrink-0">
        <Camera className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{title}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
      <div className="text-xs font-mono text-muted-foreground shrink-0">{time}</div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseNumeric(val) {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && val.value != null) return Number(val.value) || 0;
  return Number(val) || 0;
}

function parseTrend(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map(Number);
  if (typeof val === "object" && Array.isArray(val.trend)) return val.trend.map(Number);
  return [];
}

function parsePct(val) {
  if (val == null) return 0;
  if (typeof val === "object" && val.pct != null) return Number(val.pct) || 0;
  return Number(val) || 0;
}

function fmtCurrency(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function OperationsPulse() {
  const { data: stats, isLoading: statsLoading } = useDashboardStats();

  // Fetch today's and tomorrow's shoots
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const tomorrowStr = format(new Date(Date.now() + 86400000), "yyyy-MM-dd");

  const { data: upcomingShoots = [] } = useQuery({
    queryKey: ["ops-pulse-shoots", todayStr],
    queryFn: async () => {
      const rows = await api.entities.Project.filter(
        { shoot_date: { $gte: todayStr, $lte: tomorrowStr } },
        "shoot_date",
        50,
      );
      return rows;
    },
    staleTime: 5 * 60 * 1000,
  });

  const { todayShoots, tomorrowShoots } = useMemo(() => {
    const today = [];
    const tomorrow = [];
    for (const p of upcomingShoots) {
      if (!p.shoot_date) continue;
      try {
        const d = parseISO(p.shoot_date);
        if (isToday(d)) today.push(p);
        else if (isTomorrow(d)) tomorrow.push(p);
      } catch { /* skip bad dates */ }
    }
    // Sort by shoot_time
    const byTime = (a, b) => (a.shoot_time || "99:99").localeCompare(b.shoot_time || "99:99");
    today.sort(byTime);
    tomorrow.sort(byTime);
    return { todayShoots: today, tomorrowShoots: tomorrow };
  }, [upcomingShoots]);

  // Extract KPI values from stats (nested structure from useDashboardStats)
  const s = stats || {};

  // Revenue KPI
  const revenue        = parseNumeric(s.revenue?.mtd_revenue);
  const revenuePct     = parseNumeric(s.revenue?.growth_pct);

  // Pipeline value: sum revenue across all stages
  const pipeline       = Object.values(s.pipeline?.by_stage ?? {})
    .reduce((sum, stage) => sum + parseNumeric(stage?.revenue), 0);
  const pipelinePct    = 0; // no growth field available for pipeline

  // Overdue tasks
  const overdue        = parseNumeric(s.tasks?.overdue_tasks);
  const overduePct     = 0; // no trend field available

  // Delivery rate
  const deliveryRate   = parseNumeric(s.delivery?.on_time_pct);
  const deliveryPct    = 0; // no trend field available

  // Sparkline data from velocity.weekly
  const weeklyData     = Array.isArray(s.velocity?.weekly) ? s.velocity.weekly : [];
  const revenueTrend   = weeklyData.map(w => parseNumeric(w?.completed));
  const pipelineTrend  = weeklyData.map(w => parseNumeric(w?.created));
  const overdueTrend   = weeklyData.map(w => parseNumeric(w?.created));
  const deliveryTrend  = weeklyData.map(w => parseNumeric(w?.completed));

  // Build attention items from stats (using nested structure)
  const attentionItems = useMemo(() => {
    const items = [];

    // Pending reviews
    const pendingReview = parseNumeric(s.pipeline?.pending_review_count);
    const avgWaitHours = parseNumeric(s.pipeline?.avg_pending_wait_hours);
    if (pendingReview > 0) {
      const hourLabel = avgWaitHours > 0 ? ` (avg ${Math.round(avgWaitHours)}h wait)` : "";
      items.push({
        severity: "critical",
        icon: Clock,
        label: `${pendingReview} project${pendingReview !== 1 ? "s" : ""} pending review${hourLabel}`,
        count: pendingReview,
        link: createPageUrl("Projects"),
      });
    }

    // Overdue tasks
    const overdueTasks = parseNumeric(s.tasks?.overdue_tasks);
    if (overdueTasks > 0) {
      items.push({
        severity: overdueTasks >= 5 ? "critical" : "warning",
        icon: AlertTriangle,
        label: `${overdueTasks} overdue task${overdueTasks !== 1 ? "s" : ""}`,
        count: overdueTasks,
        link: createPageUrl("Projects"),
      });
    }

    // Needs attention (aggregate from pipeline)
    const needsAttention = parseNumeric(s.pipeline?.needs_attention);
    if (needsAttention > 0) {
      items.push({
        severity: "warning",
        icon: UserX,
        label: `${needsAttention} project${needsAttention !== 1 ? "s" : ""} need attention`,
        count: needsAttention,
        link: createPageUrl("Projects"),
      });
    }

    // Overall completion rate (show if below 80%)
    const completionRate = parseNumeric(s.tasks?.completion_rate_pct);
    if (completionRate > 0 && completionRate < 80) {
      items.push({
        severity: "warning",
        icon: Package,
        label: `Task completion rate at ${completionRate.toFixed(0)}%`,
        count: `${completionRate.toFixed(0)}%`,
        link: createPageUrl("Projects"),
      });
    }

    return items;
  }, [s]);

  if (statsLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="p-4 h-24 animate-pulse bg-muted/40" /></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── KPI cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Revenue MTD"
          value={fmtCurrency(revenue)}
          subtitle="vs last month"
          trend={revenuePct}
          trendData={revenueTrend}
          icon={DollarSign}
          color="bg-green-100 text-green-700"
        />
        <KpiCard
          title="Pipeline"
          value={fmtCurrency(pipeline)}
          subtitle="open value"
          trend={pipelinePct}
          trendData={pipelineTrend}
          icon={Zap}
          color="bg-blue-100 text-blue-700"
        />
        <KpiCard
          title="Overdue Tasks"
          value={overdue}
          subtitle="vs last week"
          trend={overduePct * -1} // Invert: fewer overdue = positive
          trendData={overdueTrend}
          icon={AlertTriangle}
          color="bg-red-100 text-red-700"
        />
        <KpiCard
          title="Delivery Rate"
          value={`${deliveryRate}%`}
          subtitle="on-time"
          trend={deliveryPct}
          trendData={deliveryTrend}
          icon={CheckCircle2}
          color="bg-purple-100 text-purple-700"
        />
      </div>

      {/* ── Needs Attention ───────────────────────────────────── */}
      {attentionItems.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Needs Attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {attentionItems.map((item, i) => (
              <AttentionRow key={i} {...item} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Today's Shoots + Tomorrow's Prep ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Today's Shoots
              <Badge variant="secondary" className="ml-auto text-xs">{todayShoots.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {todayShoots.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-6">
                No shoots scheduled today
              </div>
            ) : (
              todayShoots.map(p => <ShootRow key={p.id} project={p} />)
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Tomorrow's Prep
              <Badge variant="secondary" className="ml-auto text-xs">{tomorrowShoots.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {tomorrowShoots.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-6">
                No shoots scheduled tomorrow
              </div>
            ) : (
              tomorrowShoots.map(p => <ShootRow key={p.id} project={p} />)
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
