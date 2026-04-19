//
// PulseHeaderStats — top stat strip for Industry Pulse
// ====================================================
// Replaces the plain 6-card row with a click-through, sparkline-backed,
// trend-aware KPI strip. Each card:
//
//   * shows current value + a 7-day delta arrow (▲ green / ▼ red / → grey)
//   * renders a tiny recharts 30-day sparkline behind the number
//   * on click: navigates to the matching tab with a filter preset applied
//   * right-click / long-press: opens a mini context menu with
//       "Open filtered", "Copy to clipboard", "Set as homepage default"
//
// Data comes from pulse_get_header_stats_with_trends (migration 175). The
// strip falls back to the inline `stats` totals when the trends RPC is in
// flight so first paint is never empty.
//

import React, { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Users, Target, Home, ArrowRight, Clock, Calendar, Zap, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/api/supabaseClient";
import { AreaChart, Area, ResponsiveContainer } from "recharts";

// ── Home-page-default persistence ───────────────────────────────────────
// When the user right-clicks a card and picks "Set as homepage default",
// we store the tab + filter preset in localStorage; IndustryPulse reads
// this on mount and switches to the saved tab. Keeping the key namespaced
// so it doesn't collide with other localStorage consumers.
const HOMEPAGE_STORAGE_KEY = "industryPulse.homepageDefault";

export function getHomepageDefault() {
  try {
    const raw = localStorage.getItem(HOMEPAGE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setHomepageDefault(tab, listingType) {
  try {
    localStorage.setItem(
      HOMEPAGE_STORAGE_KEY,
      JSON.stringify({ tab, listingType: listingType || null })
    );
  } catch { /* storage quota, incognito, etc. — noop */ }
}

// ── Trend computation ───────────────────────────────────────────────────
function computeTrend(current, baseline) {
  if (baseline === null || baseline === undefined) return null;
  if (baseline <= 0) return null;
  const delta = current - baseline;
  const pct = Math.round((delta / baseline) * 100);
  if (pct === 0) return { pct: 0, direction: "flat" };
  return { pct: Math.abs(pct), direction: pct > 0 ? "up" : "down" };
}

function TrendBadge({ trend }) {
  if (!trend) return null;
  const up = trend.direction === "up";
  const flat = trend.direction === "flat";
  const colorCls = flat
    ? "text-muted-foreground"
    : up
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 text-[9px] font-semibold leading-none tabular-nums ml-1", colorCls)}
      title={flat ? "no change vs 7 days ago" : `${up ? "+" : "-"}${trend.pct}% vs 7 days ago`}
    >
      {flat ? "→" : up ? "▲" : "▼"}
      {!flat && (up ? ` +${trend.pct}%` : ` −${trend.pct}%`)}
    </span>
  );
}

// ── Sparkline (background decoration) ───────────────────────────────────
// Tiny area chart, semi-transparent, absolutely positioned behind the card
// content. Recharts `ResponsiveContainer` sizes to the host.
function Sparkline({ data, color }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const prepared = data.map((p, i) => ({ i, v: typeof p === "number" ? p : (p.v || 0) }));
  return (
    <div className="absolute inset-0 pointer-events-none opacity-40 dark:opacity-25">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={prepared} margin={{ top: 12, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1}
            fill={`url(#spark-${color})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Single KPI card ─────────────────────────────────────────────────────
function KpiCard({
  label, value, subtitle, icon: Icon, color, sparkColor, spark, trend,
  onClick, onCopy, onSetHomepage,
}) {
  const clickable = typeof onClick === "function";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          className={cn(
            "relative rounded-xl border-0 shadow-sm overflow-hidden",
            clickable && "cursor-pointer hover:shadow-md hover:bg-muted/40 transition-all focus-within:ring-2 focus-within:ring-primary/40"
          )}
          onClick={clickable ? onClick : undefined}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          aria-label={clickable ? `View ${label}` : undefined}
          onKeyDown={clickable ? (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick();
            }
          } : undefined}
        >
          <Sparkline data={spark} color={sparkColor || "#64748b"} />
          <CardContent className="relative p-3 flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-muted/60 backdrop-blur-sm">
              <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center">
                <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>
                  {value}
                </p>
                <TrendBadge trend={trend} />
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{label}</p>
              {subtitle && (
                <p className="text-[9px] text-muted-foreground/60 truncate">{subtitle}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {clickable && (
          <ContextMenuItem onClick={() => onClick?.()}>
            Open filtered
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onCopy?.()}>
          Copy {label} to clipboard
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onSetHomepage?.()}>
          Set as homepage default
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── Strip placeholder ───────────────────────────────────────────────────
export function HeaderStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-[62px] rounded-xl" />
      ))}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────
// `stats` is the existing shell-side aggregate (from pulse_get_dashboard_stats),
// used as the authoritative "current value" source so the numbers here match
// the tab chip counts exactly. Trends + sparklines come from the new RPC;
// when it hasn't resolved yet we still render the values — just without
// the deltas and backgrounds.
export default function PulseHeaderStats({ stats, onNavigate, toast }) {
  const { data: headerPayload, isLoading } = useQuery({
    queryKey: ["pulse_header_stats_trends"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_header_stats_with_trends");
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const prior = headerPayload?.prior_7d || null;
  const spark = headerPayload?.sparklines || {};

  // Copy helper — falls back silently if clipboard API is unavailable.
  const copyValue = useCallback((label, value) => {
    const text = `${label}: ${value}`;
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text);
      }
    } catch { /* noop */ }
    // Lightweight toast if the parent provides one.
    toast?.({ title: "Copied", description: text });
  }, [toast]);

  const markHomepage = useCallback((tab, listingType) => {
    setHomepageDefault(tab, listingType);
    toast?.({ title: "Homepage default set", description: `Industry Pulse will open on "${tab}" next time.` });
  }, [toast]);

  const trends = useMemo(() => ({
    agents:          computeTrend(stats.totalAgents,    prior?.agents),
    agencies:        computeTrend(stats.totalAgencies,  prior?.agencies),
    activeListings:  computeTrend(stats.activeListings, prior?.for_sale),
    rentals:         computeTrend(stats.rentals,        prior?.for_rent),
    avgDom:          computeTrend(stats.avgDom,         prior?.avg_dom),
    upcomingEvents:  computeTrend(stats.upcomingEvents, prior?.upcoming_events),
    newSignals:      computeTrend(stats.newSignals,     prior?.new_signals),
    marketShare:     computeTrend(stats.marketShare,    prior?.market_share_pct),
  }), [stats, prior]);

  if (isLoading && !headerPayload) {
    // First paint: skeleton while we wait. `stats` is still passed in, but
    // the sparklines are the visual anchor — better to show the skeleton
    // shape than a naked number-only row.
    return <HeaderStatsSkeleton />;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
      <KpiCard
        label="Agents"
        value={stats.totalAgents.toLocaleString()}
        subtitle={`${stats.notInCrm} not in CRM`}
        icon={Users}
        color="text-blue-500"
        sparkColor="#3b82f6"
        spark={spark.agents}
        trend={trends.agents}
        onClick={() => onNavigate?.("agents", { crm: "not_in_crm" })}
        onCopy={() => copyValue("Agents", stats.totalAgents.toLocaleString())}
        onSetHomepage={() => markHomepage("agents", null)}
      />
      <KpiCard
        label="Agencies"
        value={stats.totalAgencies.toLocaleString()}
        subtitle={`${stats.agenciesNotInCrm} not in CRM`}
        icon={Target}
        color="text-violet-500"
        sparkColor="#8b5cf6"
        spark={spark.agencies}
        trend={trends.agencies}
        onClick={() => onNavigate?.("agencies", { crm: "not_in_crm" })}
        onCopy={() => copyValue("Agencies", stats.totalAgencies.toLocaleString())}
        onSetHomepage={() => markHomepage("agencies", null)}
      />
      <KpiCard
        label="For Sale"
        value={stats.activeListings.toLocaleString()}
        subtitle={`${stats.sold} sold`}
        icon={Home}
        color="text-emerald-500"
        sparkColor="#10b981"
        spark={spark.for_sale}
        trend={trends.activeListings}
        onClick={() => onNavigate?.("listings", { listingType: "for_sale" })}
        onCopy={() => copyValue("For Sale", stats.activeListings.toLocaleString())}
        onSetHomepage={() => markHomepage("listings", "for_sale")}
      />
      <KpiCard
        label="Rentals"
        value={stats.rentals.toLocaleString()}
        icon={ArrowRight}
        color="text-cyan-500"
        sparkColor="#06b6d4"
        spark={spark.for_rent}
        trend={trends.rentals}
        onClick={() => onNavigate?.("listings", { listingType: "for_rent" })}
        onCopy={() => copyValue("Rentals", stats.rentals.toLocaleString())}
        onSetHomepage={() => markHomepage("listings", "for_rent")}
      />
      <KpiCard
        label="Avg DOM"
        value={stats.avgDom > 0 ? `${stats.avgDom}d` : "—"}
        icon={Clock}
        color="text-amber-500"
        sparkColor="#f59e0b"
        trend={trends.avgDom}
        onClick={() => onNavigate?.("listings", {})}
        onCopy={() => copyValue("Avg DOM", stats.avgDom > 0 ? `${stats.avgDom}d` : "—")}
        onSetHomepage={() => markHomepage("listings", null)}
      />
      <KpiCard
        label="Events"
        value={stats.upcomingEvents}
        subtitle="upcoming"
        icon={Calendar}
        color="text-rose-500"
        sparkColor="#f43f5e"
        spark={spark.upcoming_events}
        trend={trends.upcomingEvents}
        onClick={() => onNavigate?.("events", {})}
        onCopy={() => copyValue("Upcoming Events", String(stats.upcomingEvents))}
        onSetHomepage={() => markHomepage("events", null)}
      />
      <KpiCard
        label="Signals"
        value={stats.newSignals}
        subtitle="new"
        icon={Zap}
        color="text-orange-500"
        sparkColor="#f97316"
        spark={spark.new_signals}
        trend={trends.newSignals}
        onClick={() => onNavigate?.("signals", {})}
        onCopy={() => copyValue("New Signals", String(stats.newSignals))}
        onSetHomepage={() => markHomepage("signals", null)}
      />
      <KpiCard
        label="Market Share"
        value={stats.marketShare > 0 ? `${stats.marketShare}%` : "—"}
        subtitle="30-day · 12m window"
        icon={TrendingUp}
        color="text-green-500"
        sparkColor="#22c55e"
        trend={trends.marketShare}
        onClick={() => onNavigate?.("market_share", { window: "12m" })}
        onCopy={() => copyValue("Market Share", stats.marketShare > 0 ? `${stats.marketShare}%` : "—")}
        onSetHomepage={() => markHomepage("market_share", null)}
      />
    </div>
  );
}
