/**
 * PulseCommandCenter — 7-card command center overview tab for Industry Pulse.
 * Cards: Weekly Trend, Top Agents Not In CRM, Recent Enrichment Activity,
 *        Hot Signals (7d), Conversion Funnel, Suburb Distribution, Recent Timeline.
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
import { TrendingUp, Users, UserPlus, MapPin, Activity, ExternalLink, Sparkles, AtSign, Phone, Zap, Flame, Home, FileImage } from "lucide-react";
import {
  isActiveListing,
  isRelationshipState,
} from "@/components/pulse/utils/listingHelpers";

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

function TopAgentsNotInCrmCard({ pulseAgents, onAddToCrm, onOpenEntity }) {
  const agents = useMemo(() => {
    // Attach the score once, then sort — lets us display it per-row cheaply.
    return (pulseAgents || [])
      .filter((a) => a.is_in_crm === false)
      .map((a) => ({ ...a, _prospect_score: prospectScore(a) }))
      .sort((a, b) => b._prospect_score - a._prospect_score)
      .slice(0, 10);
  }, [pulseAgents]);

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
                    className="h-6 px-2 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 shrink-0"
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

function RecentEnrichmentCard({ pulseAgents, pulseTimeline, onOpenEntity }) {
  const items = useMemo(() => {
    // Build lookup for name resolution on agent-typed rows.
    const agentByReaId = new Map();
    const agentById = new Map();
    for (const a of pulseAgents || []) {
      if (a.rea_agent_id) agentByReaId.set(String(a.rea_agent_id), a);
      if (a.id) agentById.set(a.id, a);
    }

    return (pulseTimeline || [])
      .filter((e) => ENRICHMENT_EVENT_TYPES.has(e.event_type))
      .slice(0, 10)
      .map((e) => {
        const lookupAgent =
          (e.rea_id && agentByReaId.get(String(e.rea_id))) ||
          (e.pulse_entity_id && agentById.get(e.pulse_entity_id)) ||
          null;
        const displayName =
          e.title ||
          lookupAgent?.full_name ||
          (e.entity_type ? `${e.entity_type} ${(e.pulse_entity_id || "").slice(0, 8)}` : "Entity");
        const entityType = e.entity_type || (lookupAgent ? "agent" : null);
        const openId = e.pulse_entity_id || lookupAgent?.id || null;
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
  }, [pulseTimeline, pulseAgents]);

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

function HotSignalsCard({ pulseSignals, pulseTimeline, onOpenEntity }) {
  const items = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000;

    // Primary: pulse_signals (when populated)
    const signals = (pulseSignals || [])
      .filter((s) => {
        if (!s.created_at) return false;
        const t = new Date(s.created_at).getTime();
        return !isNaN(t) && t >= cutoff;
      })
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        source: "signal",
        title: s.title || s.signal_type || "Signal",
        description: s.description || null,
        createdAt: s.created_at,
        entityType: s.entity_type || null,
        openId: s.pulse_entity_id || s.entity_id || null,
        iconType: s.signal_type || "signal",
      }));

    if (signals.length > 0) return signals;

    // Fallback: proxy events in timeline
    return (pulseTimeline || [])
      .filter((e) => {
        if (!HOT_SIGNAL_PROXY_EVENTS.has(e.event_type)) return false;
        if (!e.created_at) return false;
        const t = new Date(e.created_at).getTime();
        return !isNaN(t) && t >= cutoff;
      })
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        source: "timeline",
        title: e.title || e.event_type,
        description: e.description || null,
        createdAt: e.created_at,
        entityType: e.entity_type || null,
        openId: e.pulse_entity_id || null,
        iconType: e.event_type,
      }));
  }, [pulseSignals, pulseTimeline]);

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

function ConversionFunnelCard({ pulseAgents, crmAgents, projects, stats }) {
  const data = useMemo(() => {
    // relationship_state casing has drifted in the CRM — "Active"/"active"/etc.
    // Use shared `isRelationshipState` for case-insensitive matching.
    const activeClients = (crmAgents || []).filter(
      (a) => isRelationshipState(a, "Active")
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
    // Use `isActiveListing` — covers for_sale + for_rent + under_contract
    // (previously only for_sale, so under_contract listings silently dropped).
    (pulseListings || [])
      .filter((l) => isActiveListing(l) && l.suburb)
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

function RecentTimelineCard({ pulseTimeline, onViewFullTimeline }) {
  const recentEntries = useMemo(
    () => (pulseTimeline || []).slice(0, 10),
    [pulseTimeline]
  );

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
        <PulseTimeline
          entries={recentEntries}
          maxHeight="max-h-[300px]"
          emptyMessage="No timeline events yet"
          compact
        />
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

function SoldLast7DaysCard({ pulseListings, pulseAgencies, onOpenEntity }) {
  const { rows, totalAgencies } = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const byAgency = new Map();
    for (const l of pulseListings || []) {
      if (l.listing_type !== "sold") continue;
      if (!l.sold_date) continue;
      const d = new Date(l.sold_date).getTime();
      if (isNaN(d) || d < cutoff) continue;
      const key = l.agency_rea_id || (l.agency_name || "").trim().toLowerCase();
      if (!key) continue;
      const existing = byAgency.get(key);
      if (existing) {
        existing.count += 1;
        existing.total_value += Number(l.sold_price) || 0;
      } else {
        byAgency.set(key, {
          key,
          agency_rea_id: l.agency_rea_id || null,
          agency_name: l.agency_name || "Unknown agency",
          count: 1,
          total_value: Number(l.sold_price) || 0,
        });
      }
    }
    // Match each aggregate back to a pulse_agencies row for is_in_crm + id
    const agencyByReaId = new Map();
    const agencyByName = new Map();
    for (const a of pulseAgencies || []) {
      if (a.rea_agency_id) agencyByReaId.set(String(a.rea_agency_id), a);
      if (a.name) agencyByName.set(a.name.trim().toLowerCase(), a);
    }
    const enriched = Array.from(byAgency.values()).map((r) => {
      const match =
        (r.agency_rea_id && agencyByReaId.get(String(r.agency_rea_id))) ||
        agencyByName.get(r.agency_name.trim().toLowerCase()) ||
        null;
      return {
        ...r,
        pulse_agency_id: match?.id || null,
        is_in_crm: match?.is_in_crm ?? null,
      };
    });
    enriched.sort((a, b) => b.count - a.count || b.total_value - a.total_value);
    return { rows: enriched.slice(0, 20), totalAgencies: enriched.length };
  }, [pulseListings, pulseAgencies]);

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
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
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
function MoneyOnTheTableBanner({ pulseListings, pulseAgencies }) {
  const { total, listingCount } = useMemo(() => {
    // Build agency-by-id map for O(1) lookups across all listings.
    const notInCrmByReaId = new Set();
    const notInCrmByName = new Set();
    const inCrmByReaId = new Set();
    const inCrmByName = new Set();
    for (const a of pulseAgencies || []) {
      if (a.is_in_crm === false) {
        if (a.rea_agency_id) notInCrmByReaId.add(String(a.rea_agency_id));
        if (a.name) notInCrmByName.add(a.name.trim().toLowerCase());
      } else if (a.is_in_crm === true) {
        if (a.rea_agency_id) inCrmByReaId.add(String(a.rea_agency_id));
        if (a.name) inCrmByName.add(a.name.trim().toLowerCase());
      }
    }
    let sum = 0;
    let count = 0;
    for (const l of pulseListings || []) {
      // Only count listings whose agency we've classified as NOT in CRM.
      const reaIdKey = l.agency_rea_id ? String(l.agency_rea_id) : null;
      const nameKey = (l.agency_name || "").trim().toLowerCase() || null;
      const isNotInCrm =
        (reaIdKey && notInCrmByReaId.has(reaIdKey)) ||
        (!reaIdKey && nameKey && notInCrmByName.has(nameKey));
      if (!isNotInCrm) continue;
      // Skip if the same listing's agency is ALSO found in the in-CRM set —
      // we have duplicate-name agencies in the wild. Prefer in-CRM classification.
      if (reaIdKey && inCrmByReaId.has(reaIdKey)) continue;
      const price = Number(l.asking_price) || Number(l.sold_price) || 0;
      if (price <= 0) continue;
      sum += price;
      count += 1;
    }
    return { total: sum, listingCount: count };
  }, [pulseListings, pulseAgencies]);

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
      <div
        className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 dark:bg-amber-950/30 dark:border-amber-800/40"
        title={`${listingCount.toLocaleString()} territory listing${listingCount === 1 ? "" : "s"} whose agency is not in CRM yet`}
      >
        <Zap className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold tabular-nums text-amber-900 dark:text-amber-200">
          {formatted} in territory listings not in CRM
        </span>
      </div>
    </div>
  );
}

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
  onOpenEntity,
  onViewFullTimeline,
}) {
  return (
    <div className="space-y-3">
      {/* Feature 4: money-on-the-table banner — top-right of tab content */}
      <MoneyOnTheTableBanner
        pulseListings={pulseListings}
        pulseAgencies={pulseAgencies}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WeeklyTrendCard pulseListings={pulseListings} />
        <TopAgentsNotInCrmCard
          pulseAgents={pulseAgents}
          onAddToCrm={onAddToCrm}
          onOpenEntity={onOpenEntity}
        />
        {/* Feature 2: sold-last-7-days — ranks agencies, shows CRM-match badge */}
        <SoldLast7DaysCard
          pulseListings={pulseListings}
          pulseAgencies={pulseAgencies}
          onOpenEntity={onOpenEntity}
        />
        <RecentEnrichmentCard
          pulseAgents={pulseAgents}
          pulseTimeline={pulseTimeline}
          onOpenEntity={onOpenEntity}
        />
        <HotSignalsCard
          pulseSignals={pulseSignals}
          pulseTimeline={pulseTimeline}
          onOpenEntity={onOpenEntity}
        />
        <ConversionFunnelCard
          pulseAgents={pulseAgents}
          crmAgents={crmAgents}
          projects={projects}
          stats={stats}
        />
        <SuburbDistributionCard pulseListings={pulseListings} />
        <RecentTimelineCard
          pulseTimeline={pulseTimeline}
          onViewFullTimeline={onViewFullTimeline}
        />
      </div>
    </div>
  );
}
