/**
 * PulseCommandCenter — 7-card command center overview tab for Industry Pulse.
 * Cards: Weekly Trend, Top Agents Not In CRM, Recent Enrichment Activity,
 *        Hot Signals (7d), Conversion Funnel, Suburb Distribution, Recent Timeline.
 */
import React, { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import TimelineRow from "@/components/pulse/timeline/TimelineRow";
import SourceDrillDrawer from "@/components/pulse/timeline/SourceDrillDrawer";
import useEntityNameMap from "@/components/pulse/timeline/useEntityNameMap";
import { SYSTEM_EVENT_TYPES } from "@/components/pulse/timeline/timelineIcons";
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, LabelList,
} from "recharts";
import { TrendingUp, Users, UserPlus, MapPin, Activity, ExternalLink, Sparkles, AtSign, Phone, Zap, Flame, Home, FileImage } from "lucide-react";
// Previously imported isActiveListing / isRelationshipState here for client-
// side reduces; all such reduces now live in pulse_get_dashboard_stats (137).

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

// CC04: window picker — user can switch between 4w / 12w / 26w / 52w views.
const TREND_WINDOWS = [
  { value: 4,  label: "4w"  },
  { value: 12, label: "12w" },
  { value: 26, label: "26w" },
  { value: 52, label: "52w" },
];

function WeeklyTrendCard({ weeklyListings }) {
  const [weeks, setWeeks] = useState(12);

  // For ≤12 weeks show per-week labels (W1..W12); for ≥26 switch to
  // month labels so the axis doesn't collapse into a dense strip.
  const useMonthLabels = weeks >= 26;

  // Server-side pre-aggregated weekly listing counts (pulse_get_dashboard_stats).
  // Produces up to 52 rows of { week_start, count }.
  const data = useMemo(() => {
    const byWeek = new Map();
    for (const row of weeklyListings || []) {
      if (!row?.week_start) continue;
      byWeek.set(row.week_start, row.count || 0);
    }
    const rows = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 7 * 86400000);
      const key = start.toISOString().slice(0, 10);
      // Nearest week-start match — the RPC buckets by date_trunc('week')
      // (Monday-rooted), whereas our loop uses exact 7-day offsets. Widen
      // the lookup to ±3 days so we don't miss cells due to offset mismatch.
      let count = 0;
      for (const [k, v] of byWeek) {
        const diff = Math.abs(new Date(k).getTime() - start.getTime());
        if (diff <= 3 * 86400000) { count = v; break; }
      }
      void key;
      const label = useMonthLabels
        ? start.toLocaleDateString("en-AU", { month: "short" })
        : `W${weeks - i}`;
      rows.push({ week: label, count });
    }
    return rows;
  }, [weeklyListings, weeks, useMonthLabels]);

  const hasData = data.some((d) => d.count > 0);

  // #9: Δ vs prior period — compare last 7d (most recent bucket) to prior 7d
  // (second-most-recent bucket). Both already computed in `data`.
  const delta = useMemo(() => {
    if (data.length < 2) return null;
    const last = data[data.length - 1].count;
    const prior = data[data.length - 2].count;
    if (prior === 0) {
      if (last === 0) return null;
      return { direction: "up", label: "new activity", pct: null };
    }
    const change = (last - prior) / prior;
    const pct = Math.round(Math.abs(change) * 100);
    const direction = change >= 0 ? "up" : "down";
    return { direction, pct, label: `${pct}% vs prior 7d` };
  }, [data]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              Market Pulse — Weekly Listings Trend
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">
              Last {weeks} weeks
              {delta && (
                <>
                  {" · "}
                  <span
                    className={
                      delta.direction === "up"
                        ? "text-emerald-600 dark:text-emerald-400 font-medium"
                        : "text-rose-600 dark:text-rose-400 font-medium"
                    }
                  >
                    {delta.direction === "up" ? "↑" : "↓"} {delta.label}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {TREND_WINDOWS.map((w) => (
              <Button
                key={w.value}
                variant={weeks === w.value ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => setWeeks(w.value)}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
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
              <XAxis
                dataKey="week"
                {...axisStyle}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={useMonthLabels ? 24 : 8}
              />
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
// Auditor-11 F3: replaced the single-axis sort (total_listings_active) with a
// composite prospect score so high-value contacts with contact info + high
// average price rank above noisy high-volume juniors.
function prospectScore(a) {
  return (
    (a.total_listings_active || 0) * 1.0 +
    ((a.avg_sold_price || 0) / 1_000_000) * 2.0 +
    (a.mobile ? 10 : 0) +
    (a.email ? 10 : 0) +
    ((a.rea_rating || 0) * 3)
  );
}

function TopAgentsNotInCrmCard({ topUnmappedAgents, onAddToCrm, onOpenEntity }) {
  // Server-side top-10 feed (pulse_get_dashboard_stats.top_unmapped_agents).
  // Each row already carries prospect_score from the RPC so we don't recompute.
  const agents = useMemo(
    () => (topUnmappedAgents || []).map((a) => ({ ...a, _prospect_score: a.prospect_score ?? prospectScore(a) })),
    [topUnmappedAgents],
  );

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-500" />
          Top Agents Not In CRM
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          Ranked by prospect score (listings + $ + contactability + rating)
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">All territory agents are mapped to CRM</p>
        ) : (
          <div className="space-y-1.5">
            {agents.map((agent) => {
              // Tier 3: make the whole row clickable to open the agent slideout
              // (the Add-to-CRM button inside stops propagation).
              const rowContent = (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{agent.full_name || "—"}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{agent.agency_name || "—"}</p>
                  </div>
                  {/* Prospect score badge (F3) — replaces the old listings-only count. */}
                  <Badge
                    variant="secondary"
                    className="text-[9px] px-1.5 py-0 shrink-0 tabular-nums bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
                    title={`Listings ${agent.total_listings_active ?? 0} · avg $${((agent.avg_sold_price || 0) / 1_000_000).toFixed(2)}M · rating ${agent.rea_rating ?? 0}`}
                  >
                    Prospect: {Math.round(agent._prospect_score)}
                  </Badge>
                  {/* Keep listings count visible as a secondary hint so users
                      still know the volume dimension after we re-ranked. */}
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 tabular-nums">
                    {agent.total_listings_active ?? 0}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    // #10: always semi-visible on touch (no hover), hover-reveal on desktop
                    className="h-6 px-2 text-[10px] opacity-60 group-hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onAddToCrm) onAddToCrm(agent);
                    }}
                  >
                    <UserPlus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </>
              );
              return onOpenEntity ? (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onOpenEntity({ type: "agent", id: agent.id })}
                  className="w-full flex items-center gap-2 py-1 group text-left rounded hover:bg-muted/30 transition-colors"
                >
                  {rowContent}
                </button>
              ) : (
                <div key={agent.id} className="flex items-center gap-2 py-1 group">
                  {rowContent}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 3: Recent Enrichment Activity ────────────────────────────────────────
// Data source: `pulse_timeline` rows for enrichment-flavored event_types.
// (Previously read `event_type='agency_change'`, which is never emitted — 0 rows.
// Enrichment events have 200+ rows and reflect the actual moving parts ops sees.)

const ENRICHMENT_EVENT_TYPES = new Set([
  "agent_email_discovered",
  "agent_mobile_discovered",
  "detail_enriched",
  "first_seen",
]);

const ENRICHMENT_CONFIG = {
  agent_email_discovered:  { icon: AtSign,   color: "text-emerald-500", label: "Email discovered" },
  agent_mobile_discovered: { icon: Phone,    color: "text-sky-500",     label: "Mobile discovered" },
  detail_enriched:         { icon: Sparkles, color: "text-violet-500",  label: "Detail enriched" },
  first_seen:              { icon: Zap,      color: "text-cyan-500",    label: "First seen" },
};

function RecentEnrichmentCard({ recentEnrichment, onOpenEntity }) {
  // Server-side pre-filtered to ENRICHMENT_EVENT_TYPES, newest first, limit 10.
  const items = useMemo(() => {
    return (recentEnrichment || []).map((e) => {
      const displayName =
        e.title ||
        (e.entity_type ? `${e.entity_type} ${(e.pulse_entity_id || "").slice(0, 8)}` : "Entity");
      const entityType = e.entity_type || null;
      const openId = e.pulse_entity_id || null;
      return {
        id: e.id,
        eventType: e.event_type,
        displayName,
        description: e.description || null,
        createdAt: e.created_at,
        entityType,
        openId,
      };
    });
  }, [recentEnrichment]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" />
          Recent Enrichment Activity
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Contacts discovered, details enriched, first-seen</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No enrichment events yet</p>
        ) : (
          <div className="space-y-2">
            {items.map((m) => {
              const cfg = ENRICHMENT_CONFIG[m.eventType] || { icon: Activity, color: "text-muted-foreground", label: m.eventType };
              const Icon = cfg.icon;
              const body = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Icon className={`h-3 w-3 shrink-0 ${cfg.color}`} />
                      <span className="font-medium truncate">{m.displayName}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                      {fmtShortDate(m.createdAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground pl-4.5">
                    <span className={`${cfg.color} font-medium`}>{cfg.label}</span>
                    {m.description && (
                      <>
                        <span className="opacity-40">·</span>
                        <span className="truncate opacity-80">{m.description}</span>
                      </>
                    )}
                  </div>
                </>
              );
              const canOpen = onOpenEntity && m.openId && m.entityType;
              return canOpen ? (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onOpenEntity({ type: m.entityType, id: m.openId })}
                  className="w-full text-xs text-left rounded p-1 -m-1 hover:bg-muted/30 transition-colors"
                >
                  {body}
                </button>
              ) : (
                <div key={m.id} className="text-xs">{body}</div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card: Hot Signals (7d) ────────────────────────────────────────────────────
// Reads `pulse_signals` when populated (Fixer 6 pipeline). Falls back to
// timeline event_types `client_new_listing` + `listing_floorplan_added` as
// proxies while signals remain empty. 7-day rolling window.

const HOT_SIGNAL_PROXY_EVENTS = new Set(["client_new_listing", "listing_floorplan_added"]);

const SIGNAL_PROXY_CONFIG = {
  client_new_listing:       { icon: Home,      color: "text-emerald-500", label: "Client new listing" },
  listing_floorplan_added:  { icon: FileImage, color: "text-blue-500",    label: "Floorplan added" },
};

function HotSignalsCard({ hotSignals7d, hotSignalsProxy7d, onOpenEntity }) {
  const items = useMemo(() => {
    // Primary: server-side pulse_signals filtered to last 7 days (10 rows).
    const signals = (hotSignals7d || []).map((s) => ({
      id: s.id,
      source: "signal",
      title: s.title || s.event_type || "Signal",
      description: s.description || null,
      createdAt: s.created_at,
      // pulse_signals uses linked_agent_ids[]/linked_agency_ids[] instead of a
      // single entity reference — prefer agent, then agency when populated.
      entityType: (Array.isArray(s.linked_agent_ids) && s.linked_agent_ids[0]) ? "agent"
        : (Array.isArray(s.linked_agency_ids) && s.linked_agency_ids[0]) ? "agency"
        : null,
      openId: (Array.isArray(s.linked_agent_ids) && s.linked_agent_ids[0])
        || (Array.isArray(s.linked_agency_ids) && s.linked_agency_ids[0])
        || null,
      iconType: s.event_type || "signal",
    }));
    if (signals.length > 0) return signals;

    // Fallback: timeline proxy events (server-filtered to last 7 days, 10 rows).
    return (hotSignalsProxy7d || []).map((e) => ({
      id: e.id,
      source: "timeline",
      title: e.title || e.event_type,
      description: e.description || null,
      createdAt: e.created_at,
      entityType: e.entity_type || null,
      openId: e.pulse_entity_id || null,
      iconType: e.event_type,
    }));
  }, [hotSignals7d, hotSignalsProxy7d]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Flame className="h-4 w-4 text-orange-500" />
          Hot Signals (7d)
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          {items.length > 0 && items[0].source === "signal"
            ? "From pulse_signals"
            : "Proxy: new client listings + floorplan adds"}
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No hot signals in the last 7 days</p>
        ) : (
          <div className="space-y-2">
            {items.map((s) => {
              const cfg = SIGNAL_PROXY_CONFIG[s.iconType] || { icon: Flame, color: "text-orange-500", label: s.iconType };
              const Icon = cfg.icon;
              const body = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Icon className={`h-3 w-3 shrink-0 ${cfg.color}`} />
                      <span className="font-medium truncate">{s.title}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                      {fmtShortDate(s.createdAt)}
                    </span>
                  </div>
                  {s.description && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground truncate pl-4.5">
                      {s.description}
                    </div>
                  )}
                </>
              );
              const canOpen = onOpenEntity && s.openId && s.entityType;
              return canOpen ? (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onOpenEntity({ type: s.entityType, id: s.openId })}
                  className="w-full text-xs text-left rounded p-1 -m-1 hover:bg-muted/30 transition-colors"
                >
                  {body}
                </button>
              ) : (
                <div key={s.id} className="text-xs">{body}</div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 4: Conversion Funnel ─────────────────────────────────────────────────

const FUNNEL_COLORS = ["#94a3b8", "#3b82f6", "#10b981", "#8b5cf6"];

function ConversionFunnelCard({ funnel, stats }) {
  // CC05: log scale by default so all four bars are visibly proportional even
  // when Territory (thousands) dwarfs Booked (single digits). User can switch
  // back to Linear when they want absolute comparison.
  const [scale, setScale] = useState("log");

  const data = useMemo(() => {
    // All inputs come from pulse_get_dashboard_stats.funnel — no client-side
    // reduces over crmAgents / projects arrays.
    const f = funnel || stats?._funnel || {};
    const rows = [
      { stage: "Territory",    count: f.territory     ?? stats?.totalAgents ?? 0 },
      { stage: "In CRM",       count: f.in_crm_total  ?? 0 },
      { stage: "Active",       count: f.in_crm_active ?? 0 },
      { stage: "Booked (30d)", count: f.booked_30d    ?? stats?.recentProjects ?? 0 },
    ];
    // Compute stage-over-stage conversion % (relative to the PREVIOUS stage,
    // not to Territory — "Active/In-CRM" is the more useful funnel metric).
    return rows.map((r, i) => {
      const prev = i > 0 ? rows[i - 1].count : null;
      const pct = prev && prev > 0 ? (r.count / prev) * 100 : null;
      const pctLabel = pct == null
        ? `${r.count.toLocaleString()}`
        : `${r.count.toLocaleString()} (${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%)`;
      return { ...r, pct, pctLabel };
    });
  }, [funnel, stats]);

  const maxVal = Math.max(...data.map((d) => d.count), 1);
  // Log scale can't show 0; use a floor of 1 so empty stages still render a tick.
  const minForLog = 1;
  const isLog = scale === "log";

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-green-500" />
              Conversion Funnel
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">Territory → booked · labels show stage-over-stage %</p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Bonus: help "?" explaining Log vs Linear */}
            <span
              className="inline-flex items-center justify-center h-5 w-5 rounded-full text-[10px] text-muted-foreground/70 border border-border/60 mr-1 cursor-help select-none"
              title="Linear: absolute bar heights (Territory dwarfs the rest). Log: compresses each stage so all 4 bars stay visible even across orders of magnitude — better for spotting drop-offs at the narrow end."
            >
              ?
            </span>
            <Button
              variant={scale === "linear" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => setScale("linear")}
            >
              Linear
            </Button>
            <Button
              variant={scale === "log" ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={() => setScale("log")}
            >
              Log
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} margin={{ top: 20, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="stage" {...axisStyle} tickLine={false} axisLine={false} />
            {isLog ? (
              <YAxis
                {...axisStyle}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={32}
                scale="log"
                // recharts log scale needs explicit domain (it won't infer from data).
                domain={[minForLog, Math.max(maxVal, minForLog)]}
                allowDataOverflow
              />
            ) : (
              <YAxis
                {...axisStyle}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={32}
                domain={[0, maxVal]}
              />
            )}
            <Tooltip
              contentStyle={tooltipStyle.contentStyle}
              cursor={{ fill: "hsl(var(--muted)/0.25)" }}
              formatter={(v, _n, p) => {
                const pct = p?.payload?.pct;
                return pct == null
                  ? [v.toLocaleString(), "Agents"]
                  : [`${v.toLocaleString()} (${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%)`, "Agents"];
              }}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
              {data.map((entry, i) => (
                <Cell key={entry.stage} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
              ))}
              <LabelList
                dataKey="pctLabel"
                position="top"
                style={{ fill: "hsl(var(--muted-foreground))", fontSize: 9, fontWeight: 500 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── Card 5: Suburb Distribution ───────────────────────────────────────────────

function SuburbDistributionCard({ suburbDistribution }) {
  // Server-pre-aggregated in pulse_get_dashboard_stats.suburb_distribution —
  // top 15 suburbs by active listing count (for_sale/for_rent/under_contract).
  const data = useMemo(
    () => (suburbDistribution || []).map((r) => ({ suburb: r.suburb, count: r.count || 0 })),
    [suburbDistribution],
  );

  const maxVal = Math.max(...data.map((d) => d.count), 1);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-rose-500" />
          Suburb Distribution
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Top 15 by active listings</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {data.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No suburb data available</p>
        ) : (
          <div className="space-y-1.5">
            {data.map(({ suburb, count }) => {
              const pct = Math.round((count / maxVal) * 100);
              // Tier 3: each bar links to Listings tab pre-filtered by suburb.
              return (
                <a
                  key={suburb}
                  href={`/IndustryPulse?tab=listings&suburb=${encodeURIComponent(suburb)}`}
                  className="flex items-center gap-2 rounded p-1 -m-1 hover:bg-muted/30 transition-colors"
                  title={`View ${count} listing${count !== 1 ? "s" : ""} in ${suburb}`}
                >
                  <span className="text-[10px] text-muted-foreground w-24 shrink-0 truncate">{suburb}</span>
                  <div className="flex-1 h-4 bg-muted/40 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-rose-400/80 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] tabular-nums text-muted-foreground w-5 text-right shrink-0">{count}</span>
                </a>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Card 6: Recent Timeline ───────────────────────────────────────────────────
// Compact preview only — last 10 events. The "View full timeline" link below
// switches to the dedicated Timeline tab on IndustryPulse, which renders the full
// audit-style view with filters + paging.

function RecentTimelineCard({ pulseTimeline, onViewFullTimeline, onOpenEntity }) {
  // Compact tile: last 10 events, system noise filtered out, inline (not the
  // heavy shared PulseTimeline component — it's read-only by design). Uses
  // the shared TimelineRow + SourceDrillDrawer primitives so visual language
  // stays identical to the full Timeline tab.
  const recentEntries = useMemo(
    () => (pulseTimeline || [])
      .filter(e => !SYSTEM_EVENT_TYPES.has(e.event_type))
      .slice(0, 10),
    [pulseTimeline]
  );

  // Auto-resolve entity names so pills show "Agent Name" not "agent <uuid>".
  const nameMap = useEntityNameMap(recentEntries);

  // Source-drill drawer state — same UX as the full timeline.
  const [drillSource, setDrillSource] = useState(null);

  // Total events in the last 24h — gives ops the scope at a glance
  const events24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (pulseTimeline || []).filter(e => {
      const d = new Date(e.created_at);
      return !isNaN(d.getTime()) && d.getTime() >= cutoff;
    }).length;
  }, [pulseTimeline]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-cyan-500" />
              Recent Timeline
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
                {events24h} in last 24h
              </Badge>
            </CardTitle>
            <p className="text-[10px] text-muted-foreground mt-0.5">Latest 10 pulse events (preview)</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {recentEntries.length === 0 ? (
          <div className="text-center py-6">
            <Activity className="h-5 w-5 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-[10px] text-muted-foreground/50">No timeline events yet</p>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-0">
            {recentEntries.map((entry, i) => (
              <TimelineRow
                key={entry.id || i}
                entry={entry}
                entityName={nameMap[`${entry.entity_type}:${entry.pulse_entity_id}`] || null}
                onOpenEntity={onOpenEntity}
                onOpenSourceDrill={(source, createdAt) => setDrillSource({ source, createdAt })}
                compact
                isLast={i === recentEntries.length - 1}
              />
            ))}
          </div>
        )}
        {onViewFullTimeline && (pulseTimeline?.length || 0) > 0 && (
          <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {(pulseTimeline?.length || 0).toLocaleString()} total events tracked
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] gap-1 text-cyan-700 dark:text-cyan-400 hover:text-cyan-800 dark:hover:text-cyan-300"
              onClick={onViewFullTimeline}
            >
              View full timeline
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        )}
        <SourceDrillDrawer
          source={drillSource?.source}
          createdAt={drillSource?.createdAt}
          open={!!drillSource}
          onClose={() => setDrillSource(null)}
        />
      </CardContent>
    </Card>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

// ── Feature 2: Sold Last 7 Days ─────────────────────────────────────────────
// Ranks territory agencies by sold-count in the last 7 days. Each row shows a
// green "In CRM" badge when the agency has is_in_crm=true, otherwise shows the
// gap explicitly (amber "Not in CRM"). Clicking a row opens the agency in the
// slideout. Data source: pulseListings (already server-loaded up to 5k rows
// per useEntityList cap — fine for 7-day window even in the busiest month).

function SoldLast7DaysCard({ soldLast7Days, onOpenEntity }) {
  // Server-pre-aggregated in pulse_get_dashboard_stats.sold_last_7_days:
  // { agency_key, agency_rea_id, agency_name, pulse_agency_id, is_in_crm, count, total_value }
  const { rows, totalAgencies } = useMemo(() => {
    const list = (soldLast7Days || []).map((r) => ({
      key: r.agency_key,
      agency_rea_id: r.agency_rea_id || null,
      agency_name: r.agency_name || "Unknown agency",
      count: r.count || 0,
      total_value: Number(r.total_value) || 0,
      pulse_agency_id: r.pulse_agency_id || null,
      is_in_crm: r.is_in_crm ?? null,
    }));
    return { rows: list, totalAgencies: list.length };
  }, [soldLast7Days]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Flame className="h-4 w-4 text-orange-500" />
          Sold Last 7 Days
          {totalAgencies > 0 && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
              {totalAgencies} {totalAgencies === 1 ? "agency" : "agencies"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          Top 20 agencies by sold count (last 7 days) — In-CRM badge highlights gaps
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No sales recorded in the last 7 days</p>
        ) : (
          <div className="max-h-[320px] overflow-y-auto">
            {/* #8: Sticky header row — visible while body scrolls */}
            <div className="sticky top-0 bg-background z-10 flex items-center gap-2 py-1 border-b border-border/40 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span className="flex-1 min-w-0">Agency</span>
              <span className="shrink-0 w-[72px] text-center">In-CRM</span>
              <span className="shrink-0 w-8 text-right tabular-nums">Count</span>
            </div>
            <div className="space-y-1.5 pt-1.5">
            {rows.map((r) => {
              const canOpen = onOpenEntity && r.pulse_agency_id;
              const body = (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{r.agency_name}</p>
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      {r.total_value > 0 ? `$${(r.total_value / 1_000_000).toFixed(1)}M total` : "—"}
                    </p>
                  </div>
                  {r.is_in_crm === true ? (
                    <Badge
                      variant="secondary"
                      className="text-[9px] px-1.5 py-0 shrink-0 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/40"
                    >
                      In CRM
                    </Badge>
                  ) : r.is_in_crm === false ? (
                    <Badge
                      variant="secondary"
                      className="text-[9px] px-1.5 py-0 shrink-0 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
                    >
                      Not in CRM
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 text-muted-foreground">
                      Unknown
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0 shrink-0 tabular-nums">
                    {r.count}
                  </Badge>
                </>
              );
              return canOpen ? (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => onOpenEntity({ type: "agency", id: r.pulse_agency_id })}
                  className="w-full flex items-center gap-2 py-1 group text-left rounded hover:bg-muted/30 transition-colors"
                >
                  {body}
                </button>
              ) : (
                <div key={r.key} className="flex items-center gap-2 py-1">
                  {body}
                </div>
              );
            })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Feature 4: Money on the table banner ───────────────────────────────────
// Sum of asking/sold prices for listings whose agency is_in_crm = false.
// Gives an at-a-glance $-value of territory coverage we don't have in CRM.
// We join listings → pulse_agencies via agency_rea_id (primary) then fall
// back to agency_name for pre-id-backfill rows.
function MoneyOnTheTableBanner({ moneyOnTheTable }) {
  // Server-pre-aggregated in pulse_get_dashboard_stats.money_on_the_table —
  // { total, listing_count } for all listings whose agency is_in_crm = false.
  const total = Number(moneyOnTheTable?.total) || 0;
  const listingCount = Number(moneyOnTheTable?.listing_count) || 0;

  if (total <= 0) return null;

  const formatted =
    total >= 1_000_000_000
      ? `$${(total / 1_000_000_000).toFixed(2)}B`
      : total >= 1_000_000
      ? `$${(total / 1_000_000).toFixed(1)}M`
      : total >= 1_000
      ? `$${Math.round(total / 1_000)}K`
      : `$${total}`;

  return (
    <div className="flex items-center justify-end">
      {/* #7: Clickable — jumps to Agencies tab filtered to not-in-CRM, sorted by listing count */}
      <a
        href="?tab=agencies&in_crm=false&sort=listings.desc"
        className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 dark:bg-amber-950/30 dark:border-amber-800/40 hover:bg-amber-100 dark:hover:bg-amber-950/50 hover:border-amber-300 dark:hover:border-amber-700/60 transition-colors cursor-pointer"
        title={`${listingCount.toLocaleString()} territory listing${listingCount === 1 ? "" : "s"} whose agency is not in CRM yet — click to view agencies`}
      >
        <Zap className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold tabular-nums text-amber-900 dark:text-amber-200">
          {formatted} in territory listings not in CRM
        </span>
      </a>
    </div>
  );
}

export default function PulseCommandCenter({
  // Legacy props still accepted — all derived data now flows through
  // `dashboardStats` (pulse_get_dashboard_stats RPC). The old array props are
  // left in the signature so callers can keep passing them without breaking.
  dashboardStats = null,
  pulseTimeline = [],
  stats = {},
  onAddToCrm,
  onOpenEntity,
  onViewFullTimeline,
}) {
  const ds = dashboardStats || {};
  return (
    <div className="space-y-3">
      {/* Feature 4: money-on-the-table banner — top-right of tab content */}
      <MoneyOnTheTableBanner moneyOnTheTable={ds.money_on_the_table} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WeeklyTrendCard weeklyListings={ds.weekly_listings} />
        <TopAgentsNotInCrmCard
          topUnmappedAgents={ds.top_unmapped_agents}
          onAddToCrm={onAddToCrm}
          onOpenEntity={onOpenEntity}
        />
        {/* Feature 2: sold-last-7-days — ranks agencies, shows CRM-match badge */}
        <SoldLast7DaysCard
          soldLast7Days={ds.sold_last_7_days}
          onOpenEntity={onOpenEntity}
        />
        <RecentEnrichmentCard
          recentEnrichment={ds.recent_enrichment}
          onOpenEntity={onOpenEntity}
        />
        <HotSignalsCard
          hotSignals7d={ds.hot_signals_7d}
          hotSignalsProxy7d={ds.hot_signals_proxy_7d}
          onOpenEntity={onOpenEntity}
        />
        <ConversionFunnelCard funnel={ds.funnel} stats={stats} />
        <SuburbDistributionCard suburbDistribution={ds.suburb_distribution} />
        <RecentTimelineCard
          pulseTimeline={pulseTimeline}
          onViewFullTimeline={onViewFullTimeline}
          onOpenEntity={onOpenEntity}
        />
      </div>
    </div>
  );
}
