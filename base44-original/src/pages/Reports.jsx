import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Skeleton } from "@/components/ui/skeleton";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell
} from "recharts";
import {
  TrendingUp, TrendingDown, DollarSign, Clock,
  Users, CheckCircle, Camera, Download
} from "lucide-react";
import {
  differenceInDays, format, subDays, subMonths,
  eachWeekOfInterval, eachMonthOfInterval
} from "date-fns";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt$ = n => !n ? "$0" : n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${Math.round(n)}`;
const fmtDays = n => (n == null) ? "—" : `${n.toFixed(1)}d`;
const pct = (n, d) => !d ? "—" : `${Math.round((n/d)*100)}%`;

// Prefer invoiced_amount if set, fall back to calculated_price then price
const projectValue = p => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

function exportCSV(projects, filename = 'report') {
  const headers = ['Title', 'Agent', 'Agency', 'Shoot Date', 'Status', 'Pricing Tier', 'Value', 'Invoiced'];
  const rows = projects.map(p => [
    p.title || p.property_address || '',
    p.agent_name || '',
    p.agency_name || '',
    p.shoot_date || '',
    p.status || '',
    p.pricing_tier || 'standard',
    p.calculated_price || p.price || 0,
    p.invoiced_amount || 0,
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, sub, icon: Icon, trend, color = "text-foreground" }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          {Icon && <Icon className="h-5 w-5 text-muted-foreground opacity-40 mt-0.5" />}
        </div>
        {trend != null && (
          <div className={`flex items-center gap-1 mt-2 text-xs ${trend >= 0 ? "text-green-600" : "text-red-500"}`}>
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trend >= 0 ? "+" : ""}{trend}% vs prior period
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PERIOD_OPTIONS = [
  { value: "4w",  label: "Last 4 weeks" },
  { value: "3m",  label: "Last 3 months" },
  { value: "6m",  label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
];

const PROPERTY_COLORS = {
  residential: "#6366f1", commercial: "#f59e0b",
  luxury: "#10b981",      rental: "#3b82f6", land: "#8b5cf6",
};

import { usePermissions } from '@/components/auth/PermissionGuard';

export default function Reports() {
  const { canSeeReports } = usePermissions();
  const [period, setPeriod] = useState("3m");
  const [drillDown, setDrillDown] = useState(null);

  if (!canSeeReports) {
    return <div className="p-8 text-center text-muted-foreground">Access denied</div>;
  }

  const { data: allProjects = [], loading: projectsLoading } = useEntityList("Project");
  const { data: allUsers = [], loading: usersLoading }       = useEntityList("User");

  const isLoading = projectsLoading || usersLoading;

  // ── Period bounds ──────────────────────────────────────────────────────────
  const { periodStart, periodEnd, prevStart, bucketBy } = useMemo(() => {
    const end    = new Date();
    const months = period === "4w" ? 1 : period === "3m" ? 3 : period === "6m" ? 6 : 12;
    const start  = period === "4w" ? subDays(end, 28) : subMonths(end, months);
    const prev   = period === "4w" ? subDays(start, 28) : subMonths(start, months);
    return { periodStart: start, periodEnd: end, prevStart: prev, bucketBy: period === "4w" ? "week" : "month" };
  }, [period]);

  const inPeriod = (p, from, to) => {
    const raw = p.shoot_date || p.created_date;
    if (!raw) return false;
    const d = new Date(fixTimestamp(raw));
    return d >= from && d <= to;
  };

  const periodProjects = useMemo(() => allProjects.filter(p => inPeriod(p, periodStart, periodEnd)), [allProjects, periodStart, periodEnd]);
  const prevProjects   = useMemo(() => allProjects.filter(p => inPeriod(p, prevStart, periodStart)),  [allProjects, prevStart, periodStart]);

  // ── Revenue KPIs ──────────────────────────────────────────────────────────
  const revenueKPIs = useMemo(() => {
    const revenue     = periodProjects.reduce((s, p) => s + projectValue(p), 0);
    const prevRevenue = prevProjects.reduce((s, p) => s + projectValue(p), 0);
    const trend       = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null;
    const paidRev     = periodProjects.filter(p => p.payment_status === "paid").reduce((s, p) => s + projectValue(p), 0);
    return {
      revenue, trend,
      count:     periodProjects.length,
      avgValue:  periodProjects.length ? revenue / periodProjects.length : 0,
      paidRev,
      delivered: periodProjects.filter(p => p.status === "delivered").length,
    };
  }, [periodProjects, prevProjects]);

  // ── Revenue trend ──────────────────────────────────────────────────────────
  const revenueTrend = useMemo(() => {
    const intervals = bucketBy === "week"
      ? eachWeekOfInterval({ start: periodStart, end: periodEnd }, { weekStartsOn: 1 })
      : eachMonthOfInterval({ start: periodStart, end: periodEnd });

    return intervals.map((bucketStart, i) => {
      const next      = intervals[i + 1] || new Date(periodEnd.getTime() + 86400000);
      const bucketEnd = subDays(next, 1);
      const label     = format(bucketStart, bucketBy === "week" ? "d MMM" : "MMM");
      const rev = periodProjects
        .filter(p => { const raw = p.shoot_date || p.created_date; if (!raw) return false; const d = new Date(fixTimestamp(raw)); return d >= bucketStart && d <= bucketEnd; })
        .reduce((s, p) => s + projectValue(p), 0);
      return { label, revenue: Math.round(rev) };
    });
  }, [periodProjects, periodStart, periodEnd, bucketBy]);

  // ── Revenue by property type ───────────────────────────────────────────────
  const revenueByType = useMemo(() => {
    const map = {};
    periodProjects.forEach(p => { const t = p.property_type || "other"; map[t] = (map[t] || 0) + projectValue(p); });
    return Object.entries(map).map(([type, revenue]) => ({ type, revenue: Math.round(revenue) })).sort((a, b) => b.revenue - a.revenue);
  }, [periodProjects]);

  // ── Stage funnel (all projects) ────────────────────────────────────────────
  const stageFunnel = useMemo(() => {
    const stages = ["to_be_scheduled","scheduled","onsite","uploaded","submitted","in_progress","ready_for_partial","delivered"];
    const counts  = {};
    allProjects.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    return stages.map(s => ({ stage: s.replace(/_/g, " "), count: counts[s] || 0 }));
  }, [allProjects]);

  // ── Photographer performance ───────────────────────────────────────────────
  const photographerStats = useMemo(() => {
    const staffIds = new Set(periodProjects.flatMap(p =>
      [p.project_owner_id, p.onsite_staff_1_id, p.onsite_staff_2_id].filter(Boolean)
    ));
    return Array.from(staffIds).map(uid => {
      const userRecord    = allUsers.find(u => u.id === uid);
      const staffProjects = periodProjects.filter(p =>
        p.project_owner_id === uid || p.onsite_staff_1_id === uid || p.onsite_staff_2_id === uid
      );
      const delivered  = staffProjects.filter(p => p.status === "delivered");
      const onTime     = delivered.filter(p => p.delivery_date && p.updated_date &&
        new Date(fixTimestamp(p.updated_date)) <= new Date(fixTimestamp(p.delivery_date)));
      const turnaroundDays = delivered
        .filter(p => p.shoot_date && p.updated_date)
        .map(p => differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.shoot_date))))
        .filter(d => d >= 0);
      return {
        id:             uid,
        name:           userRecord?.full_name || userRecord?.email || uid.slice(0, 8),
        projectCount:   staffProjects.length,
        deliveredCount: delivered.length,
        onTimePct:      delivered.length ? Math.round((onTime.length / delivered.length) * 100) : null,
        avgTurnaround:  turnaroundDays.length ? turnaroundDays.reduce((s, d) => s + d, 0) / turnaroundDays.length : null,
      };
    }).filter(s => s.projectCount > 0).sort((a, b) => b.projectCount - a.projectCount);
  }, [periodProjects, allUsers]);

  // ── Business health (all-time) ─────────────────────────────────────────────
  const health = useMemo(() => {
    const delivered    = allProjects.filter(p => p.status === "delivered");
    const withDeadline = delivered.filter(p => p.delivery_date && p.updated_date);
    const onTime       = withDeadline.filter(p =>
      new Date(fixTimestamp(p.updated_date)) <= new Date(fixTimestamp(p.delivery_date))
    );
    const withDates    = delivered.filter(p => p.shoot_date && p.updated_date);
    const totalDays    = withDates.reduce((s, p) =>
      s + Math.max(0, differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.shoot_date)))), 0);
    const paid     = allProjects.filter(p => p.payment_status === "paid").length;
    const invoiced = allProjects.filter(p => ["paid","unpaid"].includes(p.payment_status)).length;
    return {
      onTimeRate:     withDeadline.length ? Math.round((onTime.length / withDeadline.length) * 100) : null,
      avgTurnaround:  withDates.length ? totalDays / withDates.length : null,
      paymentRate:    invoiced ? Math.round((paid / invoiced) * 100) : null,
      totalDelivered: delivered.length,
      activeProjects: allProjects.filter(p => !["delivered","cancelled"].includes(p.status)).length,
    };
  }, [allProjects]);

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 space-y-10">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <TrendingUp className="h-7 w-7 text-primary" /> Reports
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">Loading data...</p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array(4).fill(0).map((_, i) => (
            <Card key={i}><CardContent className="pt-5 pb-4"><Skeleton className="h-12 w-full mb-2" /><Skeleton className="h-4 w-20" /></CardContent></Card>
          ))}
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-48 w-full" /></CardContent></Card>
      </div>
    );
  }

  if (allProjects.length === 0) {
    return (
      <div className="p-6 lg:p-8">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-10">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <TrendingUp className="h-7 w-7 text-primary" /> Reports
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">Revenue, performance and business health</p>
          </div>
        </div>
        <Card className="p-12 text-center border-2 border-dashed bg-muted/30">
          <Camera className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
          <h3 className="text-lg font-semibold mb-2">No project data yet</h3>
          <p className="text-muted-foreground text-sm">Create some projects to see reports and analytics</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-7 w-7 text-primary" /> Reports
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">Revenue, performance and business health</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-44 shadow-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <button
            onClick={() => exportCSV(periodProjects, `report_${period}`)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       border border-border hover:bg-muted transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
        </div>

      {/* ── REVENUE ──────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-green-600" /> Revenue
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div
            onClick={() => setDrillDown({ title: 'All projects this period', projects: periodProjects })}
            className="cursor-pointer hover:shadow-md transition-shadow"
          >
            <Stat label="Total revenue" value={fmt$(revenueKPIs.revenue)} trend={revenueKPIs.trend}
              icon={DollarSign} color="text-green-700" />
          </div>
          <div
            onClick={() => setDrillDown({ title: 'All projects this period', projects: periodProjects })}
            className="cursor-pointer hover:shadow-md transition-shadow"
          >
            <Stat label="Projects" value={revenueKPIs.count} sub={`${revenueKPIs.delivered} delivered`} icon={Camera} />
          </div>
          <Stat label="Avg project value" value={fmt$(revenueKPIs.avgValue)} icon={TrendingUp} />
          <Stat label="Collected (paid)" value={fmt$(revenueKPIs.paidRev)}
            sub={pct(revenueKPIs.paidRev, revenueKPIs.revenue) + " of revenue"} icon={CheckCircle}
            color={revenueKPIs.paidRev >= revenueKPIs.revenue * 0.8 ? "text-green-700" : "text-amber-600"} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Revenue trend</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={revenueTrend} barSize={24}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={fmt$} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                  <Tooltip 
                    formatter={v => [fmt$(v), "Revenue"]}
                    contentStyle={{ fontSize: 12, padding: '8px 12px', borderRadius: 8 }}
                  />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">By property type</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {revenueByType.length === 0
                ? <p className="text-xs text-muted-foreground">No data</p>
                : revenueByType.map(({ type, revenue }) => {
                    const total  = revenueByType.reduce((s, r) => s + r.revenue, 0);
                    const pctVal = total ? Math.round((revenue / total) * 100) : 0;
                    return (
                      <div key={type}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="capitalize text-muted-foreground">{type}</span>
                          <span className="font-medium">{fmt$(revenue)}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full">
                          <div className="h-1.5 rounded-full" style={{ width: `${pctVal}%`, backgroundColor: PROPERTY_COLORS[type] || "#94a3b8" }} />
                        </div>
                      </div>
                    );
                  })
              }
            </CardContent>
            </Card>
            </div>

            {/* Shoot types */}
            <section>
            <h2 className="text-base font-semibold mb-3">Shoot types</h2>
            <div className="grid grid-cols-2 gap-4">
            <div className="border rounded-xl p-4">
              <p className="text-xs text-muted-foreground mb-1">Standard shoots</p>
              <p className="text-2xl font-semibold">
                {periodProjects.filter(p => !p.tonomo_is_twilight).length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {fmt$(periodProjects.filter(p => !p.tonomo_is_twilight)
                  .reduce((s, p) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0))}
              </p>
            </div>
            <div className="border rounded-xl p-4" style={{ borderColor: '#e9d5ff' }}>
              <p className="text-xs text-muted-foreground mb-1">🌅 Twilight shoots</p>
              <p className="text-2xl font-semibold text-purple-700">
                {periodProjects.filter(p => p.tonomo_is_twilight).length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {fmt$(periodProjects.filter(p => p.tonomo_is_twilight)
                  .reduce((s, p) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0))}
              </p>
            </div>
            </div>
            </section>

            <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Current pipeline — all projects by stage</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={stageFunnel} layout="vertical" barSize={14}>
                <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="stage" tick={{ fontSize: 10 }} width={120} tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary) / 0.7)" radius={[0,3,3,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </section>

      {/* ── PHOTOGRAPHER PERFORMANCE ─────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Users className="h-5 w-5 text-blue-600" /> Photographer Performance
        </h2>
        <p className="text-xs text-muted-foreground -mt-2">Staff assigned as project owner or onsite staff in this period</p>
        {photographerStats.length === 0
          ? <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No staff assignments in this period</CardContent></Card>
          : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    {["Staff member","Projects","Delivered","On-time","Avg turnaround"].map(h => (
                      <th key={h} className={`px-4 py-2.5 text-xs font-medium text-muted-foreground ${h === "Staff member" ? "text-left" : "text-right"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {photographerStats.map(s => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-2.5 font-medium">{s.name}</td>
                      <td className="px-4 py-2.5 text-right">{s.projectCount}</td>
                      <td className="px-4 py-2.5 text-right">{s.deliveredCount}</td>
                      <td className="px-4 py-2.5 text-right">
                        {s.onTimePct != null
                          ? <Badge className={`text-[10px] ${s.onTimePct >= 90 ? "bg-green-100 text-green-700" : s.onTimePct >= 70 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>{s.onTimePct}%</Badge>
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{fmtDays(s.avgTurnaround)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </section>

      {/* ── BUSINESS HEALTH ──────────────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <CheckCircle className="h-5 w-5 text-violet-600" /> Business Health
        </h2>
        <p className="text-xs text-muted-foreground -mt-2">All-time figures across the full project history</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="On-time delivery"
            value={health.onTimeRate != null ? `${health.onTimeRate}%` : "—"} icon={CheckCircle}
            color={health.onTimeRate == null ? "" : health.onTimeRate >= 85 ? "text-green-700" : health.onTimeRate >= 70 ? "text-amber-600" : "text-red-600"} />
          <Stat label="Avg shoot→deliver" value={fmtDays(health.avgTurnaround)} sub="calendar days" icon={Clock} />
          <Stat label="Payment collection"
            value={health.paymentRate != null ? `${health.paymentRate}%` : "—"} icon={DollarSign}
            color={health.paymentRate == null ? "" : health.paymentRate >= 85 ? "text-green-700" : "text-amber-600"} />
          <Stat label="Active projects" value={health.activeProjects} sub={`${health.totalDelivered} delivered total`} icon={Camera} />
        </div>
        </section>

        {/* Drill-down modal */}
        {drillDown && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setDrillDown(null)}
        >
          <div
            className="bg-card border rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="text-base font-semibold">{drillDown.title}</h2>
              <button
                className="text-muted-foreground hover:text-foreground text-lg"
                onClick={() => setDrillDown(null)}
              >✕</button>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Project</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Agent</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Date</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {drillDown.projects.map(p => (
                    <tr key={p.id} className="border-t hover:bg-muted/20 cursor-pointer"
                      onClick={() => { window.location.href = `/ProjectDetails?id=${p.id}`; }}>
                      <td className="px-4 py-2.5 max-w-[200px] truncate font-medium">
                        {p.title || p.property_address}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {p.agent_name || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {p.shoot_date
                          ? new Date(p.shoot_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-green-700">
                        {fmt$(p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t text-xs text-muted-foreground flex items-center justify-between">
              <span>{drillDown.projects.length} project{drillDown.projects.length !== 1 ? 's' : ''}</span>
              <button
                onClick={() => exportCSV(drillDown.projects, drillDown.title)}
                className="text-primary hover:underline"
              >
                Export CSV
              </button>
            </div>
          </div>
        </div>
        )}
        </div>
        );
        }