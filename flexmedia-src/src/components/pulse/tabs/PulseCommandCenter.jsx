/**
 * PulseCommandCenter — 6-card command center overview tab for Industry Pulse.
 * Cards: Weekly Trend, Top Agents Not In CRM, Recent Agent Movements,
 *        Conversion Funnel, Suburb Distribution, Recent Timeline.
 */
import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { TrendingUp, Users, ArrowRight, UserPlus, MapPin, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Tooltip styling ───────────────────────────────────────────────────────────

const tooltipStyle = {
  contentStyle: {
    backgroundColor: "hsl(var(--card))",
    borderColor: "hsl(var(--border))",
    borderRadius: "0.5rem",
    fontSize: "11px",
    color: "hsl(var(--foreground))",
  },
  cursor: { fill: "hsl(var(--muted)/0.3)" },
};

const axisStyle = {
  tick: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtShortDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  } catch {
    return "—";
  }
}

// ── Card 1: Weekly Listings Trend ─────────────────────────────────────────────

function WeeklyTrendCard({ pulseListings }) {
  const data = useMemo(() => {
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 7 * 86400000);
      const end = new Date(Date.now() - i * 7 * 86400000);
      const count = pulseListings.filter(
        (l) => l.listed_date && new Date(l.listed_date) >= start && new Date(l.listed_date) < end
      ).length;
      weeks.push({ week: `W${12 - i}`, count });
    }
    return weeks;
  }, [pulseListings]);

  const hasData = data.some((d) => d.count > 0);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-500" />
          Market Pulse — Weekly Listings Trend
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Last 12 weeks</p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        {!hasData ? (
          <div className="h-[160px] flex items-center justify-center">
            <p className="text-xs text-muted-foreground/50">No listing data yet</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="week" {...axisStyle} tickLine={false} axisLine={false} />
              <YAxis {...axisStyle} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
              <Tooltip
                contentStyle={tooltipStyle.contentStyle}
                cursor={{ fill: "hsl(var(--muted)/0.25)" }}
                formatter={(v) => [v, "Listings"]}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#blueGrad)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: "#3b82f6" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 2: Top Agents Not In CRM ─────────────────────────────────────────────

function TopAgentsNotInCrmCard({ pulseAgents, onAddToCrm }) {
  const agents = useMemo(
    () =>
      (pulseAgents || [])
        .filter((a) => a.is_in_crm === false)
        .sort((a, b) => (b.total_listings_active || 0) - (a.total_listings_active || 0))
        .slice(0, 10),
    [pulseAgents]
  );

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-500" />
          Top Agents Not In CRM
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Sorted by active listings</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">All territory agents are mapped to CRM</p>
        ) : (
          <div className="space-y-1.5">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-2 py-1 group"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{agent.full_name || "—"}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{agent.agency_name || "—"}</p>
                </div>
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 shrink-0 tabular-nums">
                  {agent.total_listings_active ?? 0}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 shrink-0"
                  onClick={() => onAddToCrm && onAddToCrm(agent)}
                >
                  <UserPlus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 3: Recent Agent Movements ────────────────────────────────────────────

function RecentMovementsCard({ pulseAgents }) {
  const movements = useMemo(() => {
    const d30 = new Date(Date.now() - 30 * 86400000);
    return (pulseAgents || [])
      .filter((a) => a.agency_changed_at && new Date(a.agency_changed_at) > d30)
      .sort((a, b) => new Date(b.agency_changed_at) - new Date(a.agency_changed_at))
      .slice(0, 10);
  }, [pulseAgents]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ArrowRight className="h-4 w-4 text-purple-500" />
          Recent Agent Movements
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Agency changes in last 30 days</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {movements.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No agency changes detected recently</p>
        ) : (
          <div className="space-y-2">
            {movements.map((agent) => (
              <div key={agent.id} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{agent.full_name || "—"}</span>
                  <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                    {fmtShortDate(agent.agency_changed_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                  <span className="truncate line-through opacity-60">
                    {agent.previous_agency_name || "Unknown"}
                  </span>
                  <ArrowRight className="h-2.5 w-2.5 shrink-0 text-purple-400" />
                  <span className="truncate text-foreground/80 font-medium">
                    {agent.agency_name || "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 4: Conversion Funnel ─────────────────────────────────────────────────

const FUNNEL_COLORS = ["#94a3b8", "#3b82f6", "#10b981", "#8b5cf6"];

function ConversionFunnelCard({ pulseAgents, crmAgents, projects, stats }) {
  const data = useMemo(() => {
    const activeClients = (crmAgents || []).filter(
      (a) => a.relationship_state === "Active"
    ).length;
    const d30 = new Date(Date.now() - 30 * 86400000);
    const bookedThisMonth = (projects || []).filter(
      (p) => p.created_at && new Date(p.created_at) > d30
    ).length;
    return [
      { stage: "Territory", count: stats?.totalAgents ?? (pulseAgents || []).length },
      { stage: "In CRM", count: (crmAgents || []).length },
      { stage: "Active", count: activeClients },
      { stage: "Booked (30d)", count: bookedThisMonth },
    ];
  }, [pulseAgents, crmAgents, projects, stats]);

  const maxVal = Math.max(...data.map((d) => d.count), 1);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-green-500" />
          Conversion Funnel
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Territory → booked</p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="stage" {...axisStyle} tickLine={false} axisLine={false} />
            <YAxis {...axisStyle} tickLine={false} axisLine={false} allowDecimals={false} width={32} domain={[0, maxVal]} />
            <Tooltip
              contentStyle={tooltipStyle.contentStyle}
              cursor={{ fill: "hsl(var(--muted)/0.25)" }}
              formatter={(v, name) => [v, "Agents"]}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
              {data.map((entry, i) => (
                <Cell key={entry.stage} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── Card 5: Suburb Distribution ───────────────────────────────────────────────

function SuburbDistributionCard({ pulseListings }) {
  const data = useMemo(() => {
    const counts = {};
    (pulseListings || [])
      .filter((l) => l.listing_type === "for_sale" && l.suburb)
      .forEach((l) => {
        counts[l.suburb] = (counts[l.suburb] || 0) + 1;
      });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([suburb, count]) => ({ suburb, count }));
  }, [pulseListings]);

  const maxVal = Math.max(...data.map((d) => d.count), 1);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-rose-500" />
          Suburb Distribution
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Top 15 by for-sale listings</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {data.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No suburb data available</p>
        ) : (
          <div className="space-y-1.5">
            {data.map(({ suburb, count }) => {
              const pct = Math.round((count / maxVal) * 100);
              return (
                <div key={suburb} className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-24 shrink-0 truncate">{suburb}</span>
                  <div className="flex-1 h-4 bg-muted/40 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-rose-400/80 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] tabular-nums text-muted-foreground w-5 text-right shrink-0">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 6: Recent Timeline ───────────────────────────────────────────────────

function RecentTimelineCard({ pulseTimeline }) {
  const recentEntries = useMemo(
    () => (pulseTimeline || []).slice(0, 20),
    [pulseTimeline]
  );

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-500" />
          Recent Timeline
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Last 20 pulse events</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <PulseTimeline
          entries={recentEntries}
          maxHeight="max-h-[360px]"
          emptyMessage="No timeline events yet"
        />
      </CardContent>
    </Card>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function PulseCommandCenter({
  pulseAgents = [],
  pulseAgencies = [],
  pulseListings = [],
  pulseEvents = [],
  pulseSignals = [],
  crmAgents = [],
  projects = [],
  pulseMappings = [],
  pulseTimeline = [],
  stats = {},
  search = "",
  onAddToCrm,
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <WeeklyTrendCard pulseListings={pulseListings} />
      <TopAgentsNotInCrmCard pulseAgents={pulseAgents} onAddToCrm={onAddToCrm} />
      <RecentMovementsCard pulseAgents={pulseAgents} />
      <ConversionFunnelCard
        pulseAgents={pulseAgents}
        crmAgents={crmAgents}
        projects={projects}
        stats={stats}
      />
      <SuburbDistributionCard pulseListings={pulseListings} />
      <RecentTimelineCard pulseTimeline={pulseTimeline} />
    </div>
  );
}
