import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie
} from "recharts";
import {
  TrendingUp, TrendingDown, DollarSign, Clock, AlertTriangle,
  CheckCircle, Users, Building2, Camera, Repeat, Wrench,
  CalendarClock, ArrowUpRight, UserPlus, Star, BarChart as BarChartIcon
} from "lucide-react";
import {
  differenceInDays, format, subMonths, startOfMonth, endOfMonth,
  eachMonthOfInterval, subDays, startOfWeek, eachWeekOfInterval
} from "date-fns";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt$ = n => !n ? "$0" : n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${Math.round(n)}`;
const fmtDays = n => (n == null || isNaN(n)) ? "—" : `${n.toFixed(1)}d`;
const pctStr = (n, d) => !d ? "—" : `${Math.round((n/d)*100)}%`;

function KpiCard({ label, value, sub, icon: Icon, color = "text-foreground", trend, alert }) {
  return (
    <Card className={alert ? "border-orange-300 bg-orange-50/40" : ""}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
            <p className={`text-2xl font-bold truncate ${color}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          {Icon && <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${alert ? "text-orange-500" : "text-muted-foreground opacity-40"}`} />}
        </div>
        {trend != null && (
          <div className={`flex items-center gap-1 mt-2 text-xs ${trend >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trend >= 0 ? "+" : ""}{trend}% vs prior period
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionHeader({ icon: Icon, title, sub, color = "text-foreground" }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon className={`h-5 w-5 ${color}`} />
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function AlertRow({ icon: Icon, color, message, count, href }) {
  return (
    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg text-sm ${color}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {count != null && <Badge className="shrink-0 text-[10px]">{count}</Badge>}
      {href && (
        <a href={href} className="shrink-0 hover:underline text-xs flex items-center gap-0.5">
          View <ArrowUpRight className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

const PERIOD_OPTIONS = [
  { value: "3m",  label: "Last 3 months" },
  { value: "6m",  label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
];

const TYPE_COLORS = {
  residential: "#6366f1", commercial: "#f59e0b", luxury: "#10b981",
  rental: "#3b82f6", land: "#8b5cf6", other: "#94a3b8",
};

import { usePermissions } from '@/components/auth/PermissionGuard';
import ErrorBoundary from "@/components/common/ErrorBoundary";

export default function BusinessIntelligence() {
  const { canSeeBI } = usePermissions();
  const [period, setPeriod] = useState("3m");

  // All hooks must be called unconditionally (React rules of hooks)
  const { data: allProjects = [], loading: projectsLoading }   = useEntityList("Project");
  const { data: allRevisions = [], loading: revisionsLoading }  = useEntityList("ProjectRevision");
  const { data: allUsers = [], loading: usersLoading }      = useEntityList("User");
  const { data: allAgencies = [] }   = useEntityList("Agency");
  const { data: allAgents = [] }     = useEntityList("Agent");
  const { data: webhookLogs = [] }   = useEntityList("TonomoWebhookLog", "-received_at", 500);
  const { data: allTasks = [] }      = useEntityList("ProjectTask", "-created_date", 2000);
  const { data: allTimeLogs = [] }   = useEntityList("TaskTimeLog", "-created_date", 2000);
  const { data: allEmails = [] }     = useEntityList("EmailMessage", "-received_at", 1000);
  const { data: allNotifs = [] }     = useEntityList("Notification", "-created_date", 500);

  const biLoading = projectsLoading || revisionsLoading || usersLoading;

  // ── Data truncation warning ───────────────────────────────────────────────
  const DATA_WARNING_THRESHOLD = 950;
  const isDataTruncated = allTasks.length >= DATA_WARNING_THRESHOLD ||
                          allTimeLogs.length >= DATA_WARNING_THRESHOLD ||
                          allEmails.length >= DATA_WARNING_THRESHOLD;

  // ── Period bounds ─────────────────────────────────────────────────────────
  const { start, end, prevStart } = useMemo(() => {
    const e = new Date();
    const months = period === "3m" ? 3 : period === "6m" ? 6 : 12;
    const s = subMonths(e, months);
    const ps = subMonths(s, months);
    return { start: s, end: e, prevStart: ps };
  }, [period]);

  const projectValue = p => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

  const inPeriod = (p) => {
    const raw = p.shoot_date || p.created_date;
    if (!raw) return false;
    const d = new Date(fixTimestamp(raw));
    return d >= start && d <= end;
  };

  const inPrev = (p) => {
    const raw = p.shoot_date || p.created_date;
    if (!raw) return false;
    const d = new Date(fixTimestamp(raw));
    return d >= prevStart && d < start;
  };

  const periodProjects = useMemo(() => allProjects.filter(inPeriod), [allProjects, start, end]);
  const prevProjects   = useMemo(() => allProjects.filter(inPrev), [allProjects, prevStart, start]);
  const activeProjects = useMemo(() => allProjects.filter(p => !["delivered","cancelled"].includes(p.status)), [allProjects]);
  const deliveredAll   = useMemo(() => allProjects.filter(p => p.status === "delivered"), [allProjects]);

  // ── Revenue KPIs ──────────────────────────────────────────────────────────
  const revenue     = useMemo(() => periodProjects.reduce((s, p) => s + projectValue(p), 0), [periodProjects]);
  const prevRevenue = useMemo(() => prevProjects.reduce((s, p) => s + projectValue(p), 0), [prevProjects]);
  const revTrend    = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null;

  const invoicedRev  = periodProjects.filter(p => p.invoiced_amount).reduce((s, p) => s + (p.invoiced_amount || 0), 0);
  const quotedRev    = periodProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
  const cashCollected= periodProjects.filter(p => p.payment_status === "paid").reduce((s, p) => s + projectValue(p), 0);
  const outstanding  = revenue - cashCollected;

  // ── Monthly revenue trend ─────────────────────────────────────────────────
  const revenueTrend = useMemo(() => {
    const months = eachMonthOfInterval({ start: subMonths(end, period === "3m" ? 2 : period === "6m" ? 5 : 11), end });
    return months.map(ms => {
      const me = endOfMonth(ms);
      const rev = allProjects.filter(p => {
        const raw = p.shoot_date || p.created_date;
        if (!raw) return false;
        const d = new Date(fixTimestamp(raw));
        return d >= ms && d <= me;
      }).reduce((s, p) => s + projectValue(p), 0);
      return { label: format(ms, "MMM"), revenue: Math.round(rev), month: ms };
    });
  }, [allProjects, period, end]);

  // ── Pipeline health ───────────────────────────────────────────────────────
  const today = new Date();
  const stuckThreshold = 7; // days in same stage = stuck
  const overdueProjects = activeProjects.filter(p => {
    if (!p.delivery_date) return false;
    return new Date(fixTimestamp(p.delivery_date)) < today;
  });
  const stuckProjects = activeProjects.filter(p => {
    const lastChange = p.last_status_change || p.updated_date || p.created_date;
    if (!lastChange) return false;
    return differenceInDays(today, new Date(fixTimestamp(lastChange))) > stuckThreshold
      && !["delivered", "to_be_scheduled", "scheduled"].includes(p.status);
  });
  const highValueAtRisk = overdueProjects.filter(p => projectValue(p) > 500);

  // ── Stage aging ───────────────────────────────────────────────────────────
  const stageAging = useMemo(() => {
    const stages = ["to_be_scheduled","scheduled","onsite","uploaded","submitted","in_progress","in_revision","delivered"];
    return stages.map(s => {
      const ps = allProjects.filter(p => p.status === s);
      const totalDays = ps.reduce((sum, p) => {
        const raw = p.last_status_change || p.updated_date || p.created_date;
        if (!raw) return sum;
        return sum + differenceInDays(today, new Date(fixTimestamp(raw)));
      }, 0);
      const avgDays = ps.length ? totalDays / ps.length : 0;
      return { stage: s.replace(/_/g, " "), count: ps.length, avgDays: parseFloat(avgDays.toFixed(1)) };
    }).filter(s => s.count > 0);
  }, [allProjects]);

  // ── Agency leaderboard ────────────────────────────────────────────────────
  const agencyLeaderboard = useMemo(() => {
    const map = {};
    periodProjects.forEach(p => {
      const key = p.agency_id || p.agency_name || "unknown";
      if (!map[key]) {
        const agency = allAgencies.find(a => a.id === p.agency_id);
        map[key] = {
          id: key,
          name: agency?.name || p.agency_name || "Unknown Agency",
          revenue: 0,
          projects: 0,
          delivered: 0,
        };
      }
      map[key].revenue += projectValue(p);
      map[key].projects++;
      if (p.status === "delivered") map[key].delivered++;
    });

    // Rebook rate: agencies that also had projects in prev period
    const prevAgencies = new Set(prevProjects.map(p => p.agency_id || p.agency_name).filter(Boolean));

    return Object.values(map)
      .map(a => ({
        ...a,
        isRepeat: prevAgencies.has(a.id),
        avgValue: a.projects ? a.revenue / a.projects : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }, [periodProjects, prevProjects, allAgencies]);

  // ── Agent performance ─────────────────────────────────────────────────────
  const agentPerformance = useMemo(() => {
    const map = {};
    periodProjects.forEach(p => {
      const key = p.agent_id || p.agent_name || "unknown";
      if (!key || key === "unknown") return;
      if (!map[key]) {
        const agent = allAgents.find(a => a.id === p.agent_id);
        map[key] = { id: key, name: agent?.name || p.agent_name || "Unknown", revenue: 0, projects: 0, delivered: 0, onTime: 0 };
      }
      map[key].revenue += projectValue(p);
      map[key].projects++;
      if (p.status === "delivered") {
        map[key].delivered++;
        if (p.delivery_date && p.updated_date) {
          if (new Date(fixTimestamp(p.updated_date)) <= new Date(fixTimestamp(p.delivery_date))) {
            map[key].onTime++;
          }
        }
      }
    });
    return Object.values(map)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);
  }, [periodProjects, allAgents]);

  // ── Rework rate (revisions per project) ───────────────────────────────────
  const reworkRate = useMemo(() => {
    const projectsWithRevisions = new Set(allRevisions.filter(r => {
      const raw = r.created_date;
      if (!raw) return false;
      const d = new Date(fixTimestamp(raw));
      return d >= start && d <= end;
    }).map(r => r.project_id));
    return periodProjects.length ? Math.round((projectsWithRevisions.size / periodProjects.length) * 100) : 0;
  }, [allRevisions, periodProjects, start, end]);

  // ── Turnaround trend (monthly avg) ───────────────────────────────────────
  const turnaroundTrend = useMemo(() => {
    const months = eachMonthOfInterval({ start: subMonths(end, period === "3m" ? 2 : period === "6m" ? 5 : 11), end });
    return months.map(ms => {
      const me = endOfMonth(ms);
      const monthDelivered = deliveredAll.filter(p => {
        if (!p.shoot_date || !p.updated_date) return false;
        const d = new Date(fixTimestamp(p.updated_date));
        return d >= ms && d <= me;
      });
      const avgDays = monthDelivered.length
        ? monthDelivered.reduce((s, p) =>
            s + Math.max(0, differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.shoot_date)))), 0
          ) / monthDelivered.length
        : null;
      return { label: format(ms, "MMM"), days: avgDays ? parseFloat(avgDays.toFixed(1)) : null };
    });
  }, [deliveredAll, period, end]);

  // ── Booking source ────────────────────────────────────────────────────────
  const tonomoCount  = periodProjects.filter(p => p.source === "tonomo").length;
  const manualCount  = periodProjects.length - tonomoCount;

  // ── On-time delivery KPI ──────────────────────────────────────────────────
  const periodDelivered = periodProjects.filter(p => p.status === "delivered" && p.delivery_date && p.updated_date);
  const onTimeCount     = periodDelivered.filter(p =>
    new Date(fixTimestamp(p.updated_date)) <= new Date(fixTimestamp(p.delivery_date))
  ).length;
  const onTimeRate = periodDelivered.length ? Math.round((onTimeCount / periodDelivered.length) * 100) : null;

  // ── Avg turnaround ────────────────────────────────────────────────────────
  const periodWithDates = periodProjects.filter(p => p.shoot_date && p.updated_date && p.status === "delivered");
  const avgTurnaround   = periodWithDates.length
    ? periodWithDates.reduce((s, p) =>
        s + Math.max(0, differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.shoot_date)))), 0
      ) / periodWithDates.length
    : null;

  // ── Revenue by type ───────────────────────────────────────────────────────
  const revenueByType = useMemo(() => {
    const map = {};
    periodProjects.forEach(p => {
      const t = p.property_type || "other";
      map[t] = (map[t] || 0) + projectValue(p);
    });
    return Object.entries(map).map(([type, revenue]) => ({
      type, revenue: Math.round(revenue),
      fill: TYPE_COLORS[type] || TYPE_COLORS.other
    })).sort((a, b) => b.revenue - a.revenue);
  }, [periodProjects]);

  // Task completion rate for the period
  const taskCompletionRate = useMemo(() => {
    const periodTasks = allTasks.filter(t => {
      if (!t.created_date) return false;
      const d = new Date(fixTimestamp(t.created_date));
      return d >= start && d <= end;
    });
    if (periodTasks.length === 0) return null;
    const completed = periodTasks.filter(t => t.is_completed).length;
    return Math.round((completed / periodTasks.length) * 100);
  }, [allTasks, start, end]);

  // Avg hours logged per delivered project
  const avgEffortPerProject = useMemo(() => {
    if (periodProjects.length === 0) return null;
    const deliveredIds = new Set(periodProjects.filter(p => p.status === 'delivered').map(p => p.id));
    const relevantLogs = allTimeLogs.filter(l => deliveredIds.has(l.project_id));
    const totalSeconds = relevantLogs.reduce((s, l) => s + (l.total_seconds || 0), 0);
    return deliveredIds.size > 0 ? (totalSeconds / 3600 / deliveredIds.size).toFixed(1) : null;
  }, [allTimeLogs, periodProjects]);

  // Booking source split: Tonomo vs manual
  const bookingSourceSplit = useMemo(() => {
    const tonomo = periodProjects.filter(p => p.source === 'tonomo').length;
    const manual = periodProjects.length - tonomo;
    return { tonomo, manual, total: periodProjects.length };
  }, [periodProjects]);

  // First-order rate (new agents this period)
  const firstOrderRate = useMemo(() => {
    const firstOrders = periodProjects.filter(p => p.is_first_order).length;
    return periodProjects.length > 0
      ? Math.round((firstOrders / periodProjects.length) * 100)
      : null;
  }, [periodProjects]);

  // Email response activity linked to projects
  const emailActivity = useMemo(() => {
    const linked = allEmails.filter(e => e.project_id && !e.is_deleted);
    const sent = linked.filter(e => e.is_sent).length;
    const received = linked.filter(e => !e.is_sent).length;
    return { linked: linked.length, sent, received };
  }, [allEmails]);

  // Top 5 performing agents this period
  const topAgents = useMemo(() => {
    const agentMap = new Map();
    periodProjects.forEach(p => {
      if (!p.agent_id) return;
      const a = agentMap.get(p.agent_id) || { id: p.agent_id, name: p.agent_name || 'Unknown', revenue: 0, count: 0 };
      a.revenue += projectValue(p);
      a.count++;
      agentMap.set(p.agent_id, a);
    });
    return [...agentMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  }, [periodProjects]);

  // Pricing tier split
  const tierSplit = useMemo(() => {
    const premium = periodProjects.filter(p => p.pricing_tier === 'premium');
    const standard = periodProjects.filter(p => p.pricing_tier !== 'premium');
    const premiumRev = premium.reduce((s, p) => s + projectValue(p), 0);
    const standardRev = standard.reduce((s, p) => s + projectValue(p), 0);
    return { premium: premium.length, standard: standard.length, premiumRev, standardRev };
  }, [periodProjects]);

  if (!canSeeBI) {
    return <div className="p-8 text-center text-muted-foreground">Access denied — admin only</div>;
  }

  if (biLoading) {
    return (
      <div className="p-6 lg:p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-3 border-primary/30 border-t-primary rounded-full mx-auto mb-4" />
          <p className="text-muted-foreground text-sm">Loading business intelligence...</p>
        </div>
      </div>
    );
  }

  if (allProjects.length === 0) {
    return (
      <div className="p-6 lg:p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <TrendingUp className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">No project data yet</p>
          <p className="text-sm text-muted-foreground mt-1">Business intelligence will populate once projects are created.</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
    <div className="p-6 lg:p-8 space-y-10">

      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-7 w-7 text-primary" />
            Business Intelligence
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Strategic view for {format(start, "d MMM")} – {format(end, "d MMM yyyy")}
          </p>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isDataTruncated && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600" />
          <span>Analytics are based on the most recent 1,000 records per category. Older data may not be reflected in totals and charts.</span>
        </div>
      )}

      {/* ── SECTION 1: Executive summary ─────────────────────────────── */}
      <section>
        <SectionHeader icon={CheckCircle} title="Executive Summary" color="text-primary" />

        {/* Alert strip */}
        {(overdueProjects.length > 0 || stuckProjects.length > 0 || outstanding > 2000) && (
          <div className="space-y-1 mb-4 bg-orange-50 rounded-xl p-3 border border-orange-200">
            {overdueProjects.length > 0 && (
              <AlertRow icon={AlertTriangle} color="text-orange-700"
                message={`${overdueProjects.length} project${overdueProjects.length > 1 ? "s" : ""} past delivery deadline`}
                count={overdueProjects.length}
                href={createPageUrl("Projects")} />
            )}
            {stuckProjects.length > 0 && (
              <AlertRow icon={CalendarClock} color="text-orange-600"
                message={`${stuckProjects.length} project${stuckProjects.length > 1 ? "s" : ""} stuck in same stage for ${stuckThreshold}+ days`}
                count={stuckProjects.length} />
            )}
            {outstanding > 2000 && (
              <AlertRow icon={DollarSign} color="text-amber-700"
                message={`${fmt$(outstanding)} outstanding — not yet collected`} />
            )}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard label="Revenue" value={fmt$(revenue)} trend={revTrend}
            icon={DollarSign} color="text-emerald-700"
            sub={`${periodProjects.length} projects`} />
          <KpiCard label="Collected" value={fmt$(cashCollected)}
            icon={CheckCircle}
            sub={pctStr(cashCollected, revenue) + " of revenue"}
            color={cashCollected >= revenue * 0.8 ? "text-emerald-700" : "text-amber-600"} />
          <KpiCard label="Outstanding" value={fmt$(outstanding)}
            icon={DollarSign} color={outstanding > 2000 ? "text-orange-600" : "text-foreground"}
            alert={outstanding > 2000}
            sub="unpaid invoices" />
          <KpiCard label="On-time delivery" icon={Clock}
            value={onTimeRate != null ? `${onTimeRate}%` : "—"}
            color={onTimeRate >= 85 ? "text-emerald-700" : onTimeRate >= 70 ? "text-amber-600" : "text-red-600"}
            alert={onTimeRate != null && onTimeRate < 70} />
          <KpiCard label="Avg turnaround" icon={Clock}
            value={fmtDays(avgTurnaround)} sub="shoot → deliver" />
          <KpiCard label="Rework rate" icon={Wrench}
            value={`${reworkRate}%`}
            sub="projects with requests"
            color={reworkRate > 30 ? "text-orange-600" : "text-foreground"}
            alert={reworkRate > 40} />
          {taskCompletionRate !== null && (
            <KpiCard label="Task completion" value={`${taskCompletionRate}%`}
              icon={CheckCircle} color="text-teal-600"
              sub="of tasks completed this period" />
          )}
          {avgEffortPerProject !== null && (
            <KpiCard label="Avg effort/project" value={`${avgEffortPerProject}h`}
              icon={Clock} color="text-indigo-600"
              sub="hours logged per delivered project" />
          )}
          <KpiCard label="Tonomo bookings"
            value={`${bookingSourceSplit.tonomo}`}
            icon={TrendingUp} color="text-violet-600"
            sub={`${bookingSourceSplit.manual} manual`} />
          {firstOrderRate !== null && (
            <KpiCard label="New agents" value={`${firstOrderRate}%`}
              icon={UserPlus} color="text-blue-600"
              sub="of bookings from first-time agents" />
          )}
        </div>
      </section>

      {/* ── SECTION 2: Revenue ───────────────────────────────────────── */}
      <section>
        <SectionHeader icon={DollarSign} title="Revenue" color="text-emerald-600"
          sub="All figures use invoiced amount where set, otherwise quoted price" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Monthly trend */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Monthly revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={revenueTrend} barSize={28}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                  <Tooltip formatter={v => [fmt$(v), "Revenue"]} />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Revenue by type */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">By property type</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {revenueByType.map(({ type, revenue: rev, fill }) => {
                const total = revenueByType.reduce((s, r) => s + r.revenue, 0);
                const pct = total ? Math.round((rev / total) * 100) : 0;
                return (
                  <div key={type}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="capitalize text-muted-foreground">{type}</span>
                      <span className="font-medium">{fmt$(rev)}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full">
                      <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: fill }} />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── SECTION 3: Pipeline health ───────────────────────────────── */}
      <section>
        <SectionHeader icon={CalendarClock} title="Pipeline Health" color="text-violet-600"
          sub="Current state of all active projects" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Stage aging chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Average days in stage (all time)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={stageAging} layout="vertical" barSize={12} margin={{ left: 8 }}>
                  <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="stage" tick={{ fontSize: 10 }} width={105} tickLine={false} axisLine={false} />
                  <Tooltip formatter={v => [`${v} days`, "Avg days"]} />
                  <Bar dataKey="avgDays" radius={[0,3,3,0]}>
                    {stageAging.map((s, i) => (
                      <Cell key={i}
                        fill={s.avgDays > 7 ? "#f97316" : s.avgDays > 3 ? "#f59e0b" : "#10b981"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* At-risk + stuck lists */}
          <div className="space-y-3">
            {overdueProjects.length > 0 && (
              <Card className="border-red-200 bg-red-50/30">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm text-red-700 flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" /> Overdue ({overdueProjects.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {overdueProjects.slice(0, 5).map(p => (
                    <div key={p.id} className="flex items-center justify-between text-xs">
                      <span className="truncate text-muted-foreground">{p.title || p.property_address}</span>
                      <span className="shrink-0 ml-2 text-red-600 font-medium">
                        {differenceInDays(today, new Date(fixTimestamp(p.delivery_date)))}d late
                      </span>
                    </div>
                  ))}
                  {overdueProjects.length > 5 && (
                    <p className="text-[10px] text-muted-foreground">+{overdueProjects.length - 5} more</p>
                  )}
                </CardContent>
              </Card>
            )}
            {stuckProjects.length > 0 && (
              <Card className="border-amber-200 bg-amber-50/30">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm text-amber-700 flex items-center gap-1.5">
                    <CalendarClock className="h-4 w-4" /> Stuck ({stuckProjects.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {stuckProjects.slice(0, 5).map(p => {
                    const lastChange = p.last_status_change || p.updated_date || p.created_date;
                    const daysStuck = lastChange ? differenceInDays(today, new Date(fixTimestamp(lastChange))) : 0;
                    return (
                      <div key={p.id} className="flex items-center justify-between text-xs">
                        <span className="truncate text-muted-foreground">{p.title || p.property_address}</span>
                        <span className="shrink-0 ml-2 text-amber-700 font-medium capitalize">
                          {p.status?.replace(/_/g, " ")} · {daysStuck}d
                        </span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}
            {overdueProjects.length === 0 && stuckProjects.length === 0 && (
              <Card className="border-emerald-200 bg-emerald-50/30 p-6 text-center">
                <CheckCircle className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-emerald-700">Pipeline is clear</p>
                <p className="text-xs text-muted-foreground">No overdue or stuck projects</p>
              </Card>
            )}
          </div>
        </div>
      </section>

      {/* ── SECTION 4: Pricing & Mix ─────────────────────────────────── */}
      <section>
        <SectionHeader icon={TrendingUp} title="Pricing & Mix"
          sub="Standard vs premium split and revenue per tier" color="text-amber-600" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard label="Premium bookings" value={String(tierSplit.premium)}
            color="text-amber-600" icon={Star}
            sub={`${periodProjects.length > 0 ? Math.round(tierSplit.premium / periodProjects.length * 100) : 0}% of total`} />
          <KpiCard label="Premium revenue" value={fmt$(tierSplit.premiumRev)}
            color="text-amber-600" icon={DollarSign} />
          <KpiCard label="Standard bookings" value={String(tierSplit.standard)}
            color="text-blue-600" icon={BarChartIcon} />
          <KpiCard label="Standard revenue" value={fmt$(tierSplit.standardRev)}
            color="text-blue-600" icon={DollarSign} />
        </div>
      </section>

      {/* ── SECTION 5: Client intelligence ───────────────────────────── */}
      <section>
        <SectionHeader icon={Building2} title="Client Intelligence" color="text-blue-600"
          sub="Agency and agent performance for the selected period" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Agency leaderboard */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Top agencies by revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 text-xs font-medium text-muted-foreground">Agency</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Revenue</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground hidden sm:table-cell">Projects</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Repeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agencyLeaderboard.map((a, i) => (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground w-4">{i+1}</span>
                            <span className="font-medium text-xs truncate max-w-[120px]">{a.name}</span>
                          </div>
                        </td>
                        <td className="py-2 text-right font-semibold text-xs">{fmt$(a.revenue)}</td>
                        <td className="py-2 text-right text-muted-foreground text-xs hidden sm:table-cell">{a.projects}</td>
                        <td className="py-2 text-right">
                          {a.isRepeat
                            ? <Badge className="text-[10px] bg-emerald-100 text-emerald-700">✓</Badge>
                            : <span className="text-[10px] text-muted-foreground/50">new</span>
                          }
                        </td>
                      </tr>
                    ))}
                    {agencyLeaderboard.length === 0 && (
                      <tr><td colSpan={4} className="py-6 text-center text-xs text-muted-foreground">No agency data this period</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Top agents by revenue */}
          <Card>
           <CardHeader className="pb-2">
             <CardTitle className="text-sm">Top agents by revenue</CardTitle>
           </CardHeader>
           <CardContent>
             <div className="space-y-2">
               {topAgents.map((a, i) => (
                 <div key={a.id} className="flex items-center gap-3">
                   <span className="text-xs text-muted-foreground w-4">{i + 1}</span>
                   <div className="flex-1 min-w-0">
                     <p className="text-sm font-medium truncate">{a.name}</p>
                     <p className="text-xs text-muted-foreground">{a.count} booking{a.count !== 1 ? 's' : ''}</p>
                   </div>
                   <span className="text-sm font-semibold text-green-700">{fmt$(a.revenue)}</span>
                 </div>
               ))}
               {topAgents.length === 0 && (
                 <p className="text-sm text-muted-foreground text-center py-4">No data for this period</p>
               )}
             </div>
           </CardContent>
          </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          {/* Agent performance */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Agent performance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 text-xs font-medium text-muted-foreground">Agent</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Revenue</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground hidden sm:table-cell">Jobs</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">On time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentPerformance.map((a, i) => (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground w-4">{i+1}</span>
                            <span className="font-medium text-xs truncate max-w-[120px]">{a.name}</span>
                          </div>
                        </td>
                        <td className="py-2 text-right font-semibold text-xs">{fmt$(a.revenue)}</td>
                        <td className="py-2 text-right text-muted-foreground text-xs hidden sm:table-cell">{a.projects}</td>
                        <td className="py-2 text-right">
                          {a.delivered > 0
                            ? <Badge className={`text-[10px] ${
                                Math.round((a.onTime/a.delivered)*100) >= 85
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-amber-100 text-amber-700"
                              }`}>
                                {Math.round((a.onTime / a.delivered) * 100)}%
                              </Badge>
                            : <span className="text-[10px] text-muted-foreground/50">—</span>
                          }
                        </td>
                      </tr>
                    ))}
                    {agentPerformance.length === 0 && (
                      <tr><td colSpan={4} className="py-6 text-center text-xs text-muted-foreground">No agent data this period</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── SECTION 6: Operations ────────────────────────────────────── */}
      <section>
        <SectionHeader icon={Wrench} title="Operations" color="text-slate-600"
          sub="Delivery performance and workflow efficiency" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Turnaround trend */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Avg turnaround days (shoot → deliver) by month</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={turnaroundTrend}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                    tickFormatter={v => `${v}d`} width={32} />
                  <Tooltip formatter={v => [`${v} days`, "Avg turnaround"]} />
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <Line type="monotone" dataKey="days" stroke="hsl(var(--primary))"
                    strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Operational snapshot */}
          <div className="space-y-3">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Rework rate this period</p>
              <p className={`text-3xl font-bold ${reworkRate > 30 ? "text-orange-600" : "text-foreground"}`}>
                {reworkRate}%
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                of projects had a change request
              </p>
              <div className="mt-2 h-1.5 bg-muted rounded-full">
                <div className={`h-1.5 rounded-full ${reworkRate > 30 ? "bg-orange-400" : "bg-primary"}`}
                  style={{ width: `${Math.min(reworkRate, 100)}%` }} />
              </div>
            </Card>

            <Card className="p-4">
              <p className="text-xs text-muted-foreground mb-2">Booking source</p>
              <div className="flex gap-4">
                <div>
                  <p className="text-xl font-bold text-emerald-600">{tonomoCount}</p>
                  <p className="text-[10px] text-muted-foreground">via Tonomo</p>
                </div>
                <div>
                  <p className="text-xl font-bold">{manualCount}</p>
                  <p className="text-[10px] text-muted-foreground">manual</p>
                </div>
              </div>
              {periodProjects.length > 0 && (
                <div className="mt-2 h-1.5 bg-muted rounded-full flex overflow-hidden">
                  <div className="h-1.5 bg-emerald-500 rounded-l-full"
                    style={{ width: `${Math.round((tonomoCount/periodProjects.length)*100)}%` }} />
                  <div className="h-1.5 bg-blue-400 flex-1 rounded-r-full" />
                </div>
              )}
            </Card>
          </div>
        </div>
      </section>
    </div>
    </ErrorBoundary>
  );
}