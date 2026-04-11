import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DollarSign, FolderOpen, CheckCircle2, TrendingUp,
  AlertCircle, Calendar, Users, RefreshCw, Clock,
  BarChart3, Award, Zap
} from "lucide-react";
import { format, startOfMonth, endOfMonth, isWithinInterval, differenceInDays } from "date-fns";
import { parseDate } from "@/components/utils/dateUtils";

function StatCard({ icon: Icon, label, value, sub, color = "blue", highlight = false }) {
  const colorMap = {
    blue:   { bg: "bg-blue-50",   icon: "text-blue-600",   border: "border-blue-100" },
    green:  { bg: "bg-green-50",  icon: "text-green-600",  border: "border-green-100" },
    purple: { bg: "bg-purple-50", icon: "text-purple-600", border: "border-purple-100" },
    amber:  { bg: "bg-amber-50",  icon: "text-amber-600",  border: "border-amber-100" },
    red:    { bg: "bg-red-50",    icon: "text-red-600",    border: "border-red-100" },
    teal:   { bg: "bg-teal-50",   icon: "text-teal-600",   border: "border-teal-100" },
    indigo: { bg: "bg-indigo-50", icon: "text-indigo-600", border: "border-indigo-100" },
    emerald:{ bg: "bg-emerald-50",icon: "text-emerald-600",border: "border-emerald-100" },
    orange: { bg: "bg-orange-50", icon: "text-orange-600", border: "border-orange-100" },
    gray:   { bg: "bg-gray-50",   icon: "text-gray-500",   border: "border-gray-100" },
  };
  const c = colorMap[color] || colorMap.blue;

  return (
    <Card className={`border ${c.border} ${highlight ? "shadow-md" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className={`w-9 h-9 rounded-lg ${c.bg} flex items-center justify-center`}>
            <Icon className={`h-4.5 w-4.5 ${c.icon}`} style={{ height: "18px", width: "18px" }} />
          </div>
        </div>
        <p className="text-2xl font-semibold tracking-tight leading-none mb-1">{value}</p>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-1 leading-tight">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function fmtMoney(val) {
  if (!val) return "$0";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000)     return `$${(val / 1_000).toFixed(1)}k`;
  return `$${Math.round(val).toLocaleString()}`;
}

function StatusBar({ projects }) {
  const statusGroups = {
    "To Schedule":  ["to_be_scheduled"],
    "Scheduled":    ["scheduled", "onsite"],
    "Editing":      ["uploaded", "submitted", "in_progress", "ready_for_partial"],
    "In Revision":  ["in_revision"],
    "Delivered":    ["delivered"],
  };
  const colors = ["bg-gray-400", "bg-blue-500", "bg-amber-500", "bg-orange-500", "bg-green-500"];
  const total = projects.length;
  if (total === 0) return null;

  const counts = Object.entries(statusGroups).map(([label, statuses], i) => ({
    label,
    count: projects.filter(p => statuses.includes(p.status)).length,
    color: colors[i],
  })).filter(g => g.count > 0);

  return (
    <Card className="border-muted">
      <CardContent className="p-4">
        <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Pipeline Distribution</p>
        <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-3">
          {counts.map(g => (
            <div
              key={g.label}
              className={`${g.color} transition-all`}
              style={{ width: `${(g.count / total) * 100}%` }}
              title={`${g.label}: ${g.count}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          {counts.map((g, i) => (
            <div key={g.label} className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${g.color}`} />
              <span className="text-xs text-muted-foreground">{g.label}</span>
              <span className="text-xs font-semibold">{g.count}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AgencyStatsDashboard({ projects = [], agents = [], teams = [] }) {
  const stats = useMemo(() => {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd   = endOfMonth(now);

    const pricedProjects = projects.filter(p => p.calculated_price || p.price);
    const totalRevenue   = pricedProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);

    const openProjects      = projects.filter(p => p.outcome === "open");
    const deliveredProjects = projects.filter(p => p.status === "delivered");
    const wonProjects       = projects.filter(p => p.outcome === "won");
    const lostProjects      = projects.filter(p => p.outcome === "lost");
    const closedCount       = wonProjects.length + lostProjects.length;
    const winRate           = closedCount > 0 ? Math.round((wonProjects.length / closedCount) * 100) : null;

    const unpaidRevenue = pricedProjects
      .filter(p => p.payment_status === "unpaid")
      .reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);

    const avgValue = pricedProjects.length > 0 ? totalRevenue / pricedProjects.length : 0;

    const thisMonthProjects = projects.filter(p => {
      const d = p.shoot_date ? new Date(p.shoot_date) : new Date(p.created_date);
      return isWithinInterval(d, { start: monthStart, end: monthEnd });
    });

    // Avg turnaround (shoot → delivery)
    const turnaroundProjects = projects.filter(p => p.shoot_date && p.delivery_date);
    const avgTurnaround = turnaroundProjects.length > 0
      ? Math.round(turnaroundProjects.reduce((s, p) => {
          const shoot = parseDate(p.shoot_date);
          const delivery = parseDate(p.delivery_date);
          if (!shoot || !delivery) return s;
          return s + differenceInDays(delivery, shoot);
        }, 0) / turnaroundProjects.length)
      : null;

    // Repeat bookers: agents with >1 project
    const agentProjectCounts = {};
    projects.forEach(p => { if (p.agent_id) agentProjectCounts[p.agent_id] = (agentProjectCounts[p.agent_id] || 0) + 1; });
    const agentsWithProjects = Object.keys(agentProjectCounts);
    const repeatBookers      = agentsWithProjects.filter(id => agentProjectCounts[id] > 1).length;
    const repeatRate         = agentsWithProjects.length > 0 ? Math.round((repeatBookers / agentsWithProjects.length) * 100) : null;

    // Highest value project
    const topProject = projects.reduce((best, p) => {
      const val = p.calculated_price || p.price || 0;
      return val > (best?.val || 0) ? { ...p, val } : best;
    }, null);

    return {
      totalRevenue, openProjects, deliveredProjects, wonProjects, lostProjects,
      winRate, unpaidRevenue, avgValue, thisMonthProjects, avgTurnaround,
      repeatBookers, repeatRate, topProject, pricedProjects,
    };
  }, [projects, agents, teams]);

  return (
    <div className="space-y-4">
      {/* Row 1 – Primary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={DollarSign}
          label="Total Revenue"
          value={fmtMoney(stats.totalRevenue)}
          sub={`${stats.pricedProjects.length} priced projects`}
          color="green"
          highlight
        />
        <StatCard
          icon={FolderOpen}
          label="Open Projects"
          value={stats.openProjects.length}
          sub={`${projects.length} total all time`}
          color="blue"
        />
        <StatCard
          icon={CheckCircle2}
          label="Delivered"
          value={stats.deliveredProjects.length}
          sub={`${projects.length > 0 ? Math.round((stats.deliveredProjects.length / projects.length) * 100) : 0}% completion rate`}
          color="emerald"
        />
        <StatCard
          icon={TrendingUp}
          label="Win Rate"
          value={stats.winRate !== null ? `${stats.winRate}%` : "—"}
          sub={`${stats.wonProjects.length} won · ${stats.lostProjects.length} lost`}
          color="purple"
        />
      </div>

      {/* Row 2 – Financial & Operational */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={AlertCircle}
          label="Unpaid Revenue"
          value={fmtMoney(stats.unpaidRevenue)}
          sub={stats.unpaidRevenue > 0 ? "Awaiting payment" : "All collected"}
          color={stats.unpaidRevenue > 0 ? "red" : "teal"}
        />
        <StatCard
          icon={BarChart3}
          label="Avg Project Value"
          value={fmtMoney(stats.avgValue)}
          sub="Per priced project"
          color="amber"
        />
        <StatCard
          icon={Calendar}
          label="This Month"
          value={stats.thisMonthProjects.length}
          sub={`Projects in ${format(new Date(), "MMMM yyyy")}`}
          color="indigo"
        />
        <StatCard
          icon={Clock}
          label="Avg Turnaround"
          value={stats.avgTurnaround !== null ? `${stats.avgTurnaround}d` : "—"}
          sub="Shoot to delivery"
          color="orange"
        />
      </div>

      {/* Row 3 – People & Engagement */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Users}
          label="People & Teams"
          value={agents.length}
          sub={`Across ${teams.length} team${teams.length !== 1 ? "s" : ""}`}
          color="gray"
        />
        <StatCard
          icon={RefreshCw}
          label="Repeat Booking Rate"
          value={stats.repeatRate !== null ? `${stats.repeatRate}%` : "—"}
          sub={`${stats.repeatBookers} repeat bookers`}
          color="teal"
        />
        <StatCard
          icon={Award}
          label="Top Project Value"
          value={stats.topProject ? fmtMoney(stats.topProject.val) : "—"}
          sub={stats.topProject?.title ? stats.topProject.title.slice(0, 28) : "No projects yet"}
          color="purple"
        />
        <StatCard
          icon={Zap}
          label="Active People"
          value={agents.filter(a => a.relationship_state === "Active").length}
          sub={`${agents.filter(a => a.relationship_state === "Prospecting").length} prospecting`}
          color="blue"
        />
      </div>

      {/* Pipeline bar */}
      <StatusBar projects={projects} />
    </div>
  );
}