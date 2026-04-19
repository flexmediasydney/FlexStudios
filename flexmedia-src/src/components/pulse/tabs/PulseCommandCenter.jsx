// PulseCommandCenter — CEO-grade cockpit for Industry Pulse.
// Layout:
//   1) Quick-search strip (`/` to focus)
//   2) "Since you last checked" digest (24h deltas with sparklines)
//   3) Two-column: Action queue (left) + Watchlist rail (right)
//   4) Pipeline KPI tiles (6 tiles w/ trend arrows)
//   5) Legacy intel cards (enrichment, suburb dist, recent timeline)
//
// Backed by pulse_command_digest / pulse_command_actions / pulse_command_watchlist
// / pulse_global_search (migration 172) + pulse_get_market_share + pulse_get_enrichment_health.
// NO JSDoc containing close-star-slash because esbuild chokes on them.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import TimelineRow from "@/components/pulse/timeline/TimelineRow";
import SourceDrillDrawer from "@/components/pulse/timeline/SourceDrillDrawer";
import useEntityNameMap from "@/components/pulse/timeline/useEntityNameMap";
import { SYSTEM_EVENT_TYPES } from "@/components/pulse/timeline/timelineIcons";
import DataFreshnessCard from "@/components/marketshare/DataFreshnessCard";
import {
  Line, LineChart, ResponsiveContainer, Tooltip as RTooltip,
} from "recharts";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight,
  Building2, CheckCircle2, ChevronRight, Clock, DollarSign, ExternalLink,
  Eye, Flame, Home, Keyboard, MapPin, Radio, RefreshCw, Search, Sparkles,
  Star, StarOff, Target, TrendingDown, TrendingUp, User, UserPlus, Users,
  X, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// == Formatters ==============================================================

function fmtInt(n) {
  if (n === null || n === undefined || !isFinite(Number(n))) return "—";
  return Number(n).toLocaleString();
}
function fmtMoney(n) {
  if (!n || !isFinite(Number(n))) return "$0";
  const v = Number(n);
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}
function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || !isFinite(Number(n))) return "—";
  return `${Number(n).toFixed(digits)}%`;
}
function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
function pctDelta(current, prior) {
  if (prior === null || prior === undefined) return null;
  const p = Number(prior);
  const c = Number(current);
  if (!isFinite(p) || !isFinite(c)) return null;
  if (p === 0) return c === 0 ? null : { direction: "up", pct: null, label: "new" };
  const change = (c - p) / p;
  const pct = Math.round(Math.abs(change) * 100);
  return { direction: change >= 0 ? "up" : "down", pct, label: `${pct}%` };
}

// == Watchlist localStorage helpers ==========================================

const LS_AGENTS = "pulse_watchlist_agents";
const LS_AGENCIES = "pulse_watchlist_agencies";
const LS_DISMISSED_ACTIONS = "pulse_dismissed_actions_v1";
const LS_SHORTCUT_SEEN = "pulse_command_shortcut_tip_seen";

function readLsSet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeLsSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    // quota / private mode — silently swallow
  }
}

// Custom hook so multiple components can listen to the same set and rerender
// when it mutates. Stores ids as strings so JSON round-trips cleanly.
function useWatchlist(key) {
  const [set, setSet] = useState(() => readLsSet(key));

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === key) setSet(readLsSet(key));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const toggle = useCallback((id) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeLsSet(key, next);
      return next;
    });
  }, [key]);

  return [set, toggle];
}

// == 1. Quick search strip ===================================================

function GlobalSearchStrip({ onOpenEntity, inputRef }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  // pulse_global_search (migration 176) uses pg_trgm similarity; signature is
  // (q text, lim int) RETURNS (kind, id, label, sub, score real). We ask for
  // 15 rows so the UI can show the top 5 of each kind after a stable sort.
  const { data, isFetching } = useQuery({
    queryKey: ["pulse_global_search", q.trim()],
    queryFn: async () => {
      if (!q.trim()) return [];
      const { data, error } = await api._supabase.rpc("pulse_global_search", {
        q: q.trim(),
        lim: 15,
      });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });

  const rows = data || [];
  // Reset cursor when results change so arrow keys land on first item.
  useEffect(() => { setCursor(0); }, [rows.length]);

  const pick = useCallback((row) => {
    if (!row) return;
    setOpen(false);
    setQ("");
    if (onOpenEntity) onOpenEntity({ type: row.kind, id: row.id });
  }, [onOpenEntity]);

  const onKey = (e) => {
    if (!open || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const iconFor = (kind) => {
    if (kind === "agent") return <User className="h-3.5 w-3.5 text-blue-500" />;
    if (kind === "agency") return <Building2 className="h-3.5 w-3.5 text-violet-500" />;
    if (kind === "listing") return <Home className="h-3.5 w-3.5 text-emerald-500" />;
    return <Search className="h-3.5 w-3.5 text-muted-foreground" />;
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { setTimeout(() => setOpen(false), 200); }}
          onKeyDown={onKey}
          placeholder="Jump to listing / agent / agency / property — type anything  (press / to focus)"
          className="pl-10 pr-20 h-11 text-sm rounded-xl border-muted-foreground/20 focus-visible:ring-2"
          aria-label="Quick search Industry Pulse"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
          {isFetching && q.trim().length >= 2 && (
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
          )}
          <kbd className="hidden sm:inline-flex items-center h-5 px-1.5 text-[10px] font-mono rounded border border-muted-foreground/30 text-muted-foreground bg-muted/40">
            /
          </kbd>
        </div>
      </div>

      {open && q.trim().length >= 2 && (
        <Card className="absolute z-50 top-full mt-1 w-full max-h-[400px] overflow-y-auto shadow-lg border-muted-foreground/20">
          <CardContent className="p-1">
            {rows.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {isFetching ? "Searching…" : `No matches for "${q.trim()}"`}
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {rows.map((row, i) => (
                  <li key={`${row.kind}:${row.id}`}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(row)}
                      onMouseEnter={() => setCursor(i)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-left rounded-md transition-colors",
                        i === cursor ? "bg-muted/60" : "hover:bg-muted/30",
                      )}
                    >
                      {iconFor(row.kind)}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{row.label || "—"}</p>
                        {row.sub && (
                          <p className="text-[11px] text-muted-foreground truncate">{row.sub}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase tracking-wide shrink-0">
                        {row.kind}
                      </Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// == 2. "Since you last checked" digest ======================================

function Sparkline({ data, color = "#3b82f6" }) {
  if (!Array.isArray(data) || data.length === 0) return null;
  return (
    <div className="h-6 w-16">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <Line
            type="monotone"
            dataKey="c"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <RTooltip
            wrapperStyle={{ outline: "none" }}
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              borderColor: "hsl(var(--border))",
              borderRadius: "0.375rem",
              fontSize: "10px",
              padding: "4px 6px",
            }}
            formatter={(v) => [v, "count"]}
            labelFormatter={(l, p) => p?.[0]?.payload?.d || l}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DigestStat({ icon: Icon, color, label, value, sub, delta, sparkline, onClick, tone = "default" }) {
  const toneBg = {
    default: "bg-muted/20 hover:bg-muted/40",
    warning: "bg-amber-50/50 hover:bg-amber-100/60 dark:bg-amber-950/20 dark:hover:bg-amber-950/30",
    danger: "bg-rose-50/50 hover:bg-rose-100/60 dark:bg-rose-950/20 dark:hover:bg-rose-950/30",
    success: "bg-emerald-50/50 hover:bg-emerald-100/60 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30",
  }[tone] || "";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-xl border border-border/60 p-3 transition-colors",
        toneBg,
      )}
    >
      <div className="flex items-start gap-2">
        {Icon && (
          <div className={cn("shrink-0 mt-0.5 rounded-md p-1.5", color)}>
            <Icon className="h-3.5 w-3.5 text-white" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            {label}
          </p>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-lg font-semibold tabular-nums">{value}</span>
            {delta && (
              <span className={cn(
                "text-[10px] font-medium tabular-nums flex items-center",
                delta.direction === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
              )}>
                {delta.direction === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {delta.label}
              </span>
            )}
          </div>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
        </div>
        {sparkline}
      </div>
      <ChevronRight className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

function DigestSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[86px] rounded-xl" />
      ))}
    </div>
  );
}

function DigestSection({ onNavigateTab, onNavigateTabWithFilter }) {
  const [hours, setHours] = useState(24);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["pulse_command_digest", hours],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_command_digest", { p_hours: hours });
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return (
      <Card className="rounded-xl border-0 shadow-sm">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                Since you last checked
              </CardTitle>
              <p className="text-[10px] text-muted-foreground">Loading digest…</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <DigestSkeleton />
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="rounded-xl border-rose-200/60 dark:border-rose-900/40">
        <CardContent className="p-4 text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Digest failed to load: {String(error?.message || error)}
          <Button size="sm" variant="ghost" className="ml-auto h-6 text-[10px]" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const d = data || {};
  const windowLabel =
    hours === 24 ? "last 24h"
    : hours === 6 ? "last 6h"
    : hours === 72 ? "last 72h"
    : hours === 168 ? "last 7d"
    : `last ${hours}h`;

  const spark = Array.isArray(d.listings_sparkline_7d) ? d.listings_sparkline_7d : [];

  const coverageDelta = (() => {
    const cur = Number(d?.enrichment_coverage?.pct_now ?? 0);
    const prev = Number(d?.enrichment_coverage?.pct_prior ?? 0);
    if (!isFinite(cur) || !isFinite(prev)) return null;
    const diff = +(cur - prev).toFixed(1);
    if (diff === 0) return null;
    return { direction: diff > 0 ? "up" : "down", pct: null, label: `${diff > 0 ? "+" : ""}${diff}pp` };
  })();

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              Since you last checked
              {isFetching && <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />}
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">
              Sydney market — {windowLabel}
              {d.window_end && (
                <> · refreshed {fmtRelative(d.window_end)}</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {[
              { v: 6, l: "6h" },
              { v: 24, l: "24h" },
              { v: 72, l: "72h" },
              { v: 168, l: "7d" },
            ].map((w) => (
              <Button
                key={w.v}
                variant={hours === w.v ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => setHours(w.v)}
              >
                {w.l}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <DigestStat
            icon={Home}
            color="bg-blue-500"
            label="CRM-scope new listings"
            value={fmtInt(d?.new_listings_crm?.current ?? 0)}
            sub={`${fmtInt(d?.new_listings?.current ?? 0)} new across all territory`}
            sparkline={<Sparkline data={spark} color="#3b82f6" />}
            onClick={() => onNavigateTab && onNavigateTab("retention")}
          />
          <DigestStat
            icon={DollarSign}
            color="bg-amber-500"
            label="New missed-opps >$1k"
            value={fmtInt(d?.high_value_missed?.current ?? 0)}
            sub={`${fmtMoney(d?.high_value_missed?.value ?? 0)} new missed value`}
            delta={pctDelta(d?.high_value_missed?.current, d?.high_value_missed?.prior)}
            onClick={() => onNavigateTab && onNavigateTab("market_share")}
            tone={(d?.high_value_missed?.current ?? 0) > 0 ? "warning" : "default"}
          />
          <DigestStat
            icon={UserPlus}
            color="bg-violet-500"
            label="New agents outside CRM"
            value={fmtInt(d?.new_agents_outside_crm?.current ?? 0)}
            delta={pctDelta(d?.new_agents_outside_crm?.current, d?.new_agents_outside_crm?.prior)}
            onClick={() => onNavigateTabWithFilter && onNavigateTabWithFilter("agents", { in_crm: "false" })}
          />
          <DigestStat
            icon={Flame}
            color="bg-orange-500"
            label="New signals"
            value={fmtInt(d?.new_signals?.current ?? 0)}
            delta={pctDelta(d?.new_signals?.current, d?.new_signals?.prior)}
            onClick={() => onNavigateTab && onNavigateTab("signals")}
            tone={(d?.new_signals?.current ?? 0) > 0 ? "warning" : "default"}
          />
          <DigestStat
            icon={Sparkles}
            color="bg-emerald-500"
            label="Enrichment coverage"
            value={fmtPct(d?.enrichment_coverage?.pct_now ?? 0)}
            sub={`was ${fmtPct(d?.enrichment_coverage?.pct_prior ?? 0)}`}
            delta={coverageDelta}
            onClick={() => onNavigateTab && onNavigateTab("sources")}
            tone="success"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// == 3. Action queue =========================================================
// Each action has: id (stable for dismissal), icon, tone (urgency), score
// (impact x urgency), headline, context, primary CTA label + onClick, optional
// secondary label + onClick.

function scoreAction(a) {
  // Crude but good enough: urgency + (impact * 5). Callers can override by
  // supplying an explicit `score`.
  if (typeof a.score === "number") return a.score;
  return (a.urgency || 1) + (a.impact || 1) * 5;
}

function buildActions({ actionsData, marketShareData }) {
  const out = [];
  const pm = actionsData?.pending_mappings || {};
  const ss = actionsData?.stale_sources || [];
  const sa = actionsData?.silent_agents || [];
  const os = actionsData?.open_signals || {};
  const eb = actionsData?.enrichment_backlog || {};
  const unclassified = Number(actionsData?.unclassified || 0);

  if ((pm.high_conf_pending || 0) > 0) {
    out.push({
      id: `mappings-high-${pm.high_conf_pending}`,
      icon: CheckCircle2,
      tone: "success",
      urgency: 4,
      impact: 3,
      headline: `${pm.high_conf_pending} high-confidence mappings ready to confirm`,
      context: "Batch-confirm in one click to bring these agents into the CRM graph.",
      primary: { label: "Open Mappings", tab: "mappings" },
    });
  }
  if ((pm.total_pending || 0) > 0 && (pm.high_conf_pending || 0) !== (pm.total_pending || 0)) {
    out.push({
      id: `mappings-total-${pm.total_pending}`,
      icon: Users,
      tone: "info",
      urgency: 2,
      impact: 2,
      headline: `${pm.total_pending} suggested CRM mappings awaiting review`,
      context: "Review suggested agent↔CRM matches.",
      primary: { label: "Review Mappings", tab: "mappings" },
    });
  }

  if (unclassified > 0) {
    out.push({
      id: `unclassified-${unclassified}`,
      icon: AlertTriangle,
      tone: "warning",
      urgency: 3,
      impact: 3,
      headline: `${unclassified} enriched listings classified as UNCLASSIFIABLE`,
      context: "These listings lack floorplan/video signals — investigate to recover pricing fidelity.",
      primary: { label: "Open Market Share", tab: "market_share" },
    });
  }

  for (const s of ss.slice(0, 2)) {
    const hours = Number(s.hours_since_last || 0);
    out.push({
      id: `stale-source-${s.source_id}`,
      icon: Radio,
      tone: hours >= 12 ? "danger" : "warning",
      urgency: hours >= 12 ? 4 : 2,
      impact: 2,
      headline: `Source '${s.source_id}' last ran ${hours.toFixed(1)}h ago`,
      context: s.schedule_cron
        ? `Scheduled: ${s.schedule_cron} · last: ${fmtRelative(s.last_run_at)}`
        : `Last: ${fmtRelative(s.last_run_at)}`,
      primary: { label: "Inspect sources", tab: "sources" },
    });
  }

  for (const a of sa.slice(0, 2)) {
    out.push({
      id: `silent-agent-${a.id}`,
      icon: Target,
      tone: "warning",
      urgency: 3,
      impact: 4,
      headline: `${a.full_name}: active territory, 0 captures this month`,
      context: `${a.agency_name || ""} — open the agent to pick the next shoot.`,
      primary: { label: "Open agent", openEntity: { type: "agent", id: a.id } },
    });
  }

  if ((os.total || 0) > 0) {
    out.push({
      id: `signals-open-${os.total}`,
      icon: Flame,
      tone: "warning",
      urgency: 3,
      impact: 2,
      headline: `${os.total} new signal${os.total === 1 ? "" : "s"} awaiting action`,
      context: `${os.organisation || 0} org-level · ${os.person || 0} person-level`,
      primary: { label: "Open Signals", tab: "signals" },
    });
  }

  if ((eb.pending || 0) > 500) {
    out.push({
      id: `enrich-backlog-${Math.round((eb.pending || 0) / 500)}`,
      icon: Clock,
      tone: "info",
      urgency: 1,
      impact: 2,
      headline: `${fmtInt(eb.pending)} for-sale listings pending enrichment`,
      context: "Background worker processes ~144/hr.",
      primary: { label: "Open Sources", tab: "sources" },
    });
  }
  if ((eb.stale || 0) > 0) {
    out.push({
      id: `enrich-stale-${eb.stale}`,
      icon: AlertTriangle,
      tone: "warning",
      urgency: 2,
      impact: 2,
      headline: `${eb.stale} listings enriched >14 days ago`,
      context: "Media may have changed — re-enrichment recommended.",
      primary: { label: "Open Sources", tab: "sources" },
    });
  }

  // Market Share: capture rate commentary.
  const captureRate = Number(marketShareData?.capture_rate_pct || 0);
  if (captureRate > 0 && captureRate < 2) {
    out.push({
      id: `capture-rate-low-${Math.round(captureRate * 10)}`,
      icon: TrendingDown,
      tone: "danger",
      urgency: 3,
      impact: 5,
      headline: `Capture rate at ${captureRate.toFixed(2)}% — below target`,
      context: `${fmtMoney(marketShareData?.missed_opportunity_value)} missed in last window.`,
      primary: { label: "Open Market Share", tab: "market_share" },
    });
  }

  return out;
}

const ACTION_TONE = {
  default: "bg-muted/30 border-border/60",
  info:    "bg-blue-50/40 dark:bg-blue-950/20 border-blue-200/50 dark:border-blue-900/40",
  success: "bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200/50 dark:border-emerald-900/40",
  warning: "bg-amber-50/40 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-900/40",
  danger:  "bg-rose-50/40 dark:bg-rose-950/20 border-rose-200/50 dark:border-rose-900/40",
};
const ACTION_ICON_TONE = {
  default: "text-muted-foreground",
  info:    "text-blue-600 dark:text-blue-400",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger:  "text-rose-600 dark:text-rose-400",
};

function ActionCard({ action, onDismiss, onNavigateTab, onOpenEntity }) {
  const Icon = action.icon || Activity;
  const toneClass = ACTION_TONE[action.tone] || ACTION_TONE.default;
  const iconToneClass = ACTION_ICON_TONE[action.tone] || ACTION_ICON_TONE.default;

  const onPrimary = () => {
    if (action.primary?.tab && onNavigateTab) {
      onNavigateTab(action.primary.tab);
    } else if (action.primary?.openEntity && onOpenEntity) {
      onOpenEntity(action.primary.openEntity);
    } else if (typeof action.primary?.onClick === "function") {
      action.primary.onClick();
    }
  };

  return (
    <div className={cn(
      "rounded-xl border p-3 flex items-start gap-3 transition-colors",
      toneClass,
    )}>
      <div className={cn("shrink-0 mt-0.5 rounded-md p-1.5 bg-background/70", iconToneClass)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{action.headline}</p>
        {action.context && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{action.context}</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2.5 text-[11px] gap-1"
            onClick={onPrimary}
          >
            {action.primary?.label || "Open"}
            <ArrowRight className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => onDismiss(action.id)}
            title="Dismiss (hides until next distinct count)"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

function ActionQueueSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[84px] rounded-xl" />
      ))}
    </div>
  );
}

function ActionQueueSection({ onNavigateTab, onOpenEntity }) {
  const [dismissed, setDismissed] = useState(() => readLsSet(LS_DISMISSED_ACTIONS));

  const { data: actionsData, isLoading, error, refetch } = useQuery({
    queryKey: ["pulse_command_actions"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_command_actions");
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
    refetchInterval: 180_000,
  });

  // Market Share is a separate RPC so we don't couple data-freshness cycles.
  const { data: marketShareData } = useQuery({
    queryKey: ["pulse_get_market_share_command"],
    queryFn: async () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 365 * 86400000).toISOString();
      const { data, error } = await api._supabase.rpc("pulse_get_market_share", {
        p_from: from, p_to: to, p_suburb: null,
      });
      if (error) throw error;
      return data || {};
    },
    staleTime: 300_000,
  });

  const onDismiss = useCallback((id) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeLsSet(LS_DISMISSED_ACTIONS, next);
      return next;
    });
  }, []);

  const resetDismissed = useCallback(() => {
    writeLsSet(LS_DISMISSED_ACTIONS, new Set());
    setDismissed(new Set());
  }, []);

  const actions = useMemo(() => {
    const built = buildActions({ actionsData, marketShareData });
    return built
      .filter((a) => !dismissed.has(a.id))
      .sort((a, b) => scoreAction(b) - scoreAction(a));
  }, [actionsData, marketShareData, dismissed]);

  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Act on these
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
                {actions.length}
              </Badge>
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">Prioritised by impact × urgency</p>
          </div>
          {dismissed.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[10px] text-muted-foreground"
              onClick={resetDismissed}
            >
              Reset dismissed ({dismissed.size})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading ? (
          <ActionQueueSkeleton />
        ) : error ? (
          <div className="p-4 text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Action queue failed: {String(error?.message || error)}
            <Button size="sm" variant="ghost" className="ml-auto h-6 text-[10px]" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : actions.length === 0 ? (
          <div className="py-6 text-center">
            <CheckCircle2 className="h-8 w-8 mx-auto text-emerald-500 mb-2" />
            <p className="text-sm font-medium">All clear</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              No actions need your attention right now.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {actions.map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                onDismiss={onDismiss}
                onNavigateTab={onNavigateTab}
                onOpenEntity={onOpenEntity}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// == 4. Watchlist rail =======================================================

function WatchlistRow({ entity, onOpenEntity, onUnstar }) {
  return (
    <div className="flex items-start gap-2 py-2 px-2 rounded-md hover:bg-muted/30 transition-colors group">
      <div className="shrink-0 h-7 w-7 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-border/60 flex items-center justify-center">
        {entity.kind === "agent"
          ? <User className="h-3.5 w-3.5 text-primary" />
          : <Building2 className="h-3.5 w-3.5 text-primary" />}
      </div>
      <button
        type="button"
        className="flex-1 min-w-0 text-left"
        onClick={() => onOpenEntity && onOpenEntity({ type: entity.kind, id: entity.id })}
      >
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium truncate">{entity.name || "—"}</p>
          {entity.is_in_crm && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/40">
              CRM
            </Badge>
          )}
        </div>
        {entity.sub && (
          <p className="text-[10px] text-muted-foreground truncate">{entity.sub}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground tabular-nums">
          <span>
            {fmtInt(entity.new_this_week)} new / 7d
          </span>
          {entity.last_activity_at && (
            <span className="opacity-70">· last {fmtRelative(entity.last_activity_at)}</span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onUnstar(entity.kind, entity.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1 rounded hover:bg-muted"
        title="Remove from watchlist"
      >
        <StarOff className="h-3.5 w-3.5 text-muted-foreground hover:text-rose-500" />
      </button>
    </div>
  );
}

function WatchlistSection({ onOpenEntity, onNavigateTab }) {
  const [agentIds, toggleAgent] = useWatchlist(LS_AGENTS);
  const [agencyIds, toggleAgency] = useWatchlist(LS_AGENCIES);

  const idsPayload = useMemo(() => ({
    agent_ids: Array.from(agentIds),
    agency_ids: Array.from(agencyIds),
  }), [agentIds, agencyIds]);

  const empty = agentIds.size === 0 && agencyIds.size === 0;

  const { data, isLoading, error } = useQuery({
    queryKey: ["pulse_command_watchlist", agentIds.size, agencyIds.size, Array.from(agentIds).sort().join(","), Array.from(agencyIds).sort().join(",")],
    queryFn: async () => {
      if (empty) return { agents: [], agencies: [] };
      const { data, error } = await api._supabase.rpc("pulse_command_watchlist", { p_ids: idsPayload });
      if (error) throw error;
      return data || { agents: [], agencies: [] };
    },
    staleTime: 60_000,
  });

  const agents = (data?.agents || []).map((r) => ({ ...r, kind: "agent" }));
  const agencies = (data?.agencies || []).map((r) => ({ ...r, kind: "agency" }));

  const handleUnstar = (kind, id) => {
    if (kind === "agent") toggleAgent(id);
    else if (kind === "agency") toggleAgency(id);
  };

  return (
    <Card className="rounded-xl border-0 shadow-sm h-full">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500 fill-amber-500/20" />
          Watchlist
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
            {agentIds.size + agencyIds.size}
          </Badge>
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Your starred agents &amp; agencies</p>
      </CardHeader>
      <CardContent className="px-2 pb-4">
        {empty ? (
          <div className="py-6 px-3 text-center">
            <Star className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-xs font-medium">No watched entities yet</p>
            <p className="text-[11px] text-muted-foreground mt-1 mb-3">
              Star agents or agencies from any list to surface their activity here.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => onNavigateTab && onNavigateTab("retention")}
            >
              Go to Retention <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-2 px-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[48px] rounded-md" />)}
          </div>
        ) : error ? (
          <div className="text-[11px] text-rose-600 p-2">Watchlist failed: {String(error?.message || error)}</div>
        ) : (
          <div className="space-y-0.5">
            {agents.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 pt-1 pb-0.5 font-medium">
                  Agents ({agents.length})
                </p>
                {agents.map((a) => (
                  <WatchlistRow key={a.id} entity={a} onOpenEntity={onOpenEntity} onUnstar={handleUnstar} />
                ))}
              </div>
            )}
            {agencies.length > 0 && (
              <div className="mt-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 pt-1 pb-0.5 font-medium">
                  Agencies ({agencies.length})
                </p>
                {agencies.map((a) => (
                  <WatchlistRow key={a.id} entity={a} onOpenEntity={onOpenEntity} onUnstar={handleUnstar} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// == 5. Pipeline KPIs ========================================================

function KpiTile({ icon: Icon, label, value, sub, delta, tone = "default", onClick }) {
  const toneColor = {
    default: "text-muted-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-rose-600 dark:text-rose-400",
    info: "text-blue-600 dark:text-blue-400",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group text-left rounded-xl border border-border/60 bg-card hover:border-border transition-colors p-3",
        onClick ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon className={cn("h-3.5 w-3.5", toneColor)} />}
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium truncate">
          {label}
        </p>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        {delta && (
          <span className={cn(
            "text-[10px] font-medium tabular-nums flex items-center",
            delta.direction === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
          )}>
            {delta.direction === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {delta.label}
          </span>
        )}
      </div>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
    </button>
  );
}

function KpiTilesSection({ stats, dashboardStats, onNavigateTab }) {
  // Fetch Market Share + Enrichment Health + prior-period Market Share in
  // parallel. We compare last 12mo vs prior 12mo for capture rate + missed $.
  const now = new Date();
  const from12 = new Date(now.getTime() - 365 * 86400000).toISOString();
  const from24 = new Date(now.getTime() - 2 * 365 * 86400000).toISOString();
  const nowIso = now.toISOString();

  const ms = useQuery({
    queryKey: ["kpi_ms_12m"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_market_share", {
        p_from: from12, p_to: nowIso, p_suburb: null,
      });
      if (error) throw error;
      return data || {};
    },
    staleTime: 300_000,
  });
  const msPrior = useQuery({
    queryKey: ["kpi_ms_12m_prior"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_market_share", {
        p_from: from24, p_to: from12, p_suburb: null,
      });
      if (error) throw error;
      return data || {};
    },
    staleTime: 300_000,
  });
  const eh = useQuery({
    queryKey: ["kpi_enrichment_health"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_enrichment_health");
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
  });

  const isLoading = ms.isLoading || msPrior.isLoading || eh.isLoading;

  // Capture rate + missed $ come from Market Share; projects / agents / cron
  // from dashboardStats (already populated by IndustryPulse shell).
  const captureRate = Number(ms.data?.capture_rate_pct || 0);
  const capturePrior = Number(msPrior.data?.capture_rate_pct || 0);
  const missed = Number(ms.data?.missed_opportunity_value || 0);
  const missedPrior = Number(msPrior.data?.missed_opportunity_value || 0);

  const ehData = eh.data || {};
  const coveragePct = ehData.for_sale_total > 0
    ? (100 * (ehData.for_sale_enriched || 0) / ehData.for_sale_total)
    : 0;

  // New CRM-scope agents this month (approximate from dashboardStats).
  const newAgentsMonth = Number(stats?.agentMovements ?? dashboardStats?.totals?.agent_movements_30d ?? 0);
  const recentProjects = Number(stats?.recentProjects ?? 0);

  // Cron health score: 100 - (stale-source count * 10), floored at 0.
  const staleSources = Array.isArray(dashboardStats?.sources_stale)
    ? dashboardStats.sources_stale.length
    : 0;
  const cronHealth = Math.max(0, 100 - staleSources * 10);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[68px] rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <KpiTile
        icon={Target}
        label="Capture rate"
        value={fmtPct(captureRate, 2)}
        sub="last 12 mo"
        delta={pctDelta(captureRate, capturePrior)}
        tone="info"
        onClick={() => onNavigateTab && onNavigateTab("market_share")}
      />
      <KpiTile
        icon={DollarSign}
        label="Missed $ (12m)"
        value={fmtMoney(missed)}
        sub="enriched quotes"
        delta={(() => {
          if (!missedPrior) return null;
          const diff = (missed - missedPrior) / missedPrior;
          // For missed $, down is good — invert the colour semantics by
          // still showing arrow but letting the KPI tone carry warning.
          return { direction: diff >= 0 ? "up" : "down", pct: Math.round(Math.abs(diff) * 100), label: `${Math.round(Math.abs(diff) * 100)}%` };
        })()}
        tone="warning"
        onClick={() => onNavigateTab && onNavigateTab("market_share")}
      />
      <KpiTile
        icon={Eye}
        label="Projects delivered"
        value={fmtInt(recentProjects)}
        sub="last 30d"
        tone="success"
        onClick={() => onNavigateTab && onNavigateTab("events")}
      />
      <KpiTile
        icon={UserPlus}
        label="Agent movements"
        value={fmtInt(newAgentsMonth)}
        sub="last 30d"
        tone="info"
        onClick={() => onNavigateTab && onNavigateTab("agents")}
      />
      <KpiTile
        icon={Sparkles}
        label="Enrichment coverage"
        value={fmtPct(coveragePct)}
        sub={`${fmtInt(ehData.for_sale_pending)} pending`}
        tone="success"
        onClick={() => onNavigateTab && onNavigateTab("sources")}
      />
      <KpiTile
        icon={Radio}
        label="Cron health"
        value={`${cronHealth}`}
        sub={staleSources > 0 ? `${staleSources} stale` : "all green"}
        tone={cronHealth >= 90 ? "success" : cronHealth >= 70 ? "warning" : "danger"}
        onClick={() => onNavigateTab && onNavigateTab("sources")}
      />
    </div>
  );
}

// == 6. Legacy intel cards (kept compact) ====================================

const ENRICHMENT_EVENT_TYPES = new Set([
  "agent_email_discovered",
  "agent_mobile_discovered",
  "detail_enriched",
  "first_seen",
]);

function SuburbDistributionCard({ suburbDistribution, onNavigateTabWithFilter }) {
  const data = useMemo(
    () => (suburbDistribution || []).slice(0, 10).map((r) => ({ suburb: r.suburb, count: r.count || 0 })),
    [suburbDistribution],
  );
  const maxVal = Math.max(...data.map((d) => d.count), 1);

  return (
    <Card className="rounded-xl border-0 shadow-sm h-full">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-rose-500" />
          Top Suburbs (active)
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">By active listing count</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {data.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No suburb data</p>
        ) : (
          <div className="space-y-1.5">
            {data.map(({ suburb, count }) => {
              const pct = Math.round((count / maxVal) * 100);
              return (
                <button
                  key={suburb}
                  type="button"
                  onClick={() => onNavigateTabWithFilter && onNavigateTabWithFilter("listings", { suburb })}
                  className="w-full flex items-center gap-2 rounded p-1 -m-1 hover:bg-muted/30 transition-colors text-left"
                  title={`View ${count} listings in ${suburb}`}
                >
                  <span className="text-[10px] text-muted-foreground w-24 shrink-0 truncate">{suburb}</span>
                  <div className="flex-1 h-4 bg-muted/40 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-rose-400/80" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
                    {fmtInt(count)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentTimelineCard({ pulseTimeline, onViewFullTimeline, onOpenEntity }) {
  const recentEntries = useMemo(
    () => (pulseTimeline || [])
      .filter((e) => !SYSTEM_EVENT_TYPES.has(e.event_type))
      .slice(0, 8),
    [pulseTimeline],
  );
  const nameMap = useEntityNameMap(recentEntries);
  const [drillSource, setDrillSource] = useState(null);

  const events24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (pulseTimeline || []).filter((e) => {
      const d = new Date(e.created_at);
      return !isNaN(d.getTime()) && d.getTime() >= cutoff;
    }).length;
  }, [pulseTimeline]);

  return (
    <Card className="rounded-xl border-0 shadow-sm h-full">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-500" />
          Recent Timeline
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
            {events24h} / 24h
          </Badge>
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">Latest non-system events</p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {recentEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">No timeline events yet</p>
        ) : (
          <div className="max-h-[260px] overflow-y-auto">
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
        {onViewFullTimeline && recentEntries.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] gap-1 text-cyan-700 dark:text-cyan-400"
              onClick={onViewFullTimeline}
            >
              Full timeline
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

// Top unmapped agents — kept as a compact intel card beside suburb distribution.
function TopAgentsNotInCrmCard({ topUnmappedAgents, onAddToCrm, onOpenEntity, onNavigateTab }) {
  const agents = (topUnmappedAgents || []).slice(0, 6);
  return (
    <Card className="rounded-xl border-0 shadow-sm h-full">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-500" />
          Top unmapped agents
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          Ranked by prospect score (listings + $ + contactability)
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground/50 py-6 text-center">All territory agents mapped</p>
        ) : (
          <div className="space-y-1">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onOpenEntity && onOpenEntity({ type: "agent", id: agent.id })}
                className="w-full flex items-center gap-2 py-1 px-1 -mx-1 group text-left rounded hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{agent.full_name || "—"}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{agent.agency_name || "—"}</p>
                </div>
                <Badge
                  variant="secondary"
                  className="text-[9px] px-1.5 py-0 shrink-0 tabular-nums bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
                >
                  {Math.round(agent.prospect_score ?? 0)}
                </Badge>
                {onAddToCrm && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px] opacity-60 group-hover:opacity-100 transition-opacity text-blue-600 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddToCrm(agent);
                    }}
                  >
                    <UserPlus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                )}
              </button>
            ))}
            {onNavigateTab && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-[11px] justify-between mt-1"
                onClick={() => onNavigateTab("agents")}
              >
                <span>See all unmapped agents</span>
                <ArrowRight className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// == 7. Keyboard shortcut hints tooltip ======================================

function ShortcutHints({ onClose }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-xs rounded-xl border border-border bg-card shadow-lg p-3 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Keyboard className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-semibold">Keyboard shortcuts</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-0.5 rounded"
          aria-label="Dismiss shortcut hints"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <ul className="space-y-1 text-[11px]">
        {[
          { keys: ["/"], desc: "Focus quick search" },
          { keys: ["g", "m"], desc: "Go to Market Share" },
          { keys: ["g", "r"], desc: "Go to Retention" },
          { keys: ["g", "s"], desc: "Go to Signals" },
          { keys: ["g", "a"], desc: "Go to Agents" },
          { keys: ["g", "l"], desc: "Go to Listings" },
          { keys: ["g", "t"], desc: "Go to Timeline" },
        ].map((s, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{s.desc}</span>
            <span className="flex items-center gap-0.5">
              {s.keys.map((k, j) => (
                <kbd key={j} className="inline-flex items-center h-4 px-1 text-[9px] font-mono rounded border border-muted-foreground/30 bg-muted/40">
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// == 8. Main export ==========================================================

export default function PulseCommandCenter({
  // Legacy props still honoured so the surrounding shell remains intact.
  dashboardStats = null,
  pulseTimeline = [],
  stats = {},
  onAddToCrm,
  onOpenEntity,
  onViewFullTimeline,
  onNavigateTab,
}) {
  const ds = dashboardStats || {};
  const searchInputRef = useRef(null);

  // Keyboard shortcuts (`/`, `?`, g-chord, n/p, 1-9) are handled globally by
  // the shell's useKeyboardShortcuts hook in pulseShell.jsx. We used to
  // register a local g-chord handler here but the shell is authoritative —
  // duplicating would double-fire navigations.

  // First-visit shortcut hint — kept as a small tooltip on the Command tab
  // itself because this is where new users land. The shell's `?` help
  // overlay covers the full surface; this is just a nudge.
  const [showShortcutTip, setShowShortcutTip] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(LS_SHORTCUT_SEEN)) {
        const t = setTimeout(() => setShowShortcutTip(true), 1500);
        return () => clearTimeout(t);
      }
    } catch {
      // ignore
    }
  }, []);
  const dismissShortcutTip = useCallback(() => {
    try { localStorage.setItem(LS_SHORTCUT_SEEN, "1"); } catch { /* noop */ }
    setShowShortcutTip(false);
  }, []);

  // Bridge tab navigation that wants a filter param (suburb, in_crm). The
  // shell owns the URL via react-router's useSearchParams; we nudge the URL
  // via history.replaceState and fire a `popstate` event so any listener
  // picks up the new value. In practice the destination tabs read params
  // via useSearchParams on render so the first render after setTab sees
  // them. If a destination tab doesn't honour the filter (most don't), the
  // user simply lands on the unfiltered tab — graceful degradation.
  const navigateWithFilter = useCallback((tab, params) => {
    if (onNavigateTab) onNavigateTab(tab);
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      if (params) {
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      }
      window.history.replaceState({}, "", url.toString());
    } catch {
      // noop — URL manipulation is best-effort
    }
  }, [onNavigateTab]);

  return (
    <div className="space-y-3">
      {/* 1. Quick search strip ---------------------------------------------- */}
      <ErrorBoundary compact resetKey="search" fallbackLabel="Quick Search">
        <GlobalSearchStrip onOpenEntity={onOpenEntity} inputRef={searchInputRef} />
      </ErrorBoundary>

      {/* 2. Since you last checked digest ----------------------------------- */}
      <ErrorBoundary compact resetKey="digest" fallbackLabel="Digest">
        <DigestSection onNavigateTab={onNavigateTab} onNavigateTabWithFilter={navigateWithFilter} />
      </ErrorBoundary>

      {/* 3. Action queue (left) + Watchlist (right) ------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <ErrorBoundary compact resetKey="actions" fallbackLabel="Action Queue">
            <ActionQueueSection onNavigateTab={onNavigateTab} onOpenEntity={onOpenEntity} />
          </ErrorBoundary>
        </div>
        <div className="lg:col-span-1">
          <ErrorBoundary compact resetKey="watchlist" fallbackLabel="Watchlist">
            <WatchlistSection onOpenEntity={onOpenEntity} onNavigateTab={onNavigateTab} />
          </ErrorBoundary>
        </div>
      </div>

      {/* 4. Pipeline KPI tiles --------------------------------------------- */}
      <ErrorBoundary compact resetKey="kpis" fallbackLabel="Pipeline KPIs">
        <KpiTilesSection stats={stats} dashboardStats={ds} onNavigateTab={onNavigateTab} />
      </ErrorBoundary>

      {/* 5. Intel cards ---------------------------------------------------- */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <ErrorBoundary compact resetKey="intel-agents" fallbackLabel="Top Agents">
          <TopAgentsNotInCrmCard
            topUnmappedAgents={ds.top_unmapped_agents}
            onAddToCrm={onAddToCrm}
            onOpenEntity={onOpenEntity}
            onNavigateTab={onNavigateTab}
          />
        </ErrorBoundary>
        <ErrorBoundary compact resetKey="intel-suburbs" fallbackLabel="Suburb Distribution">
          <SuburbDistributionCard
            suburbDistribution={ds.suburb_distribution}
            onNavigateTabWithFilter={navigateWithFilter}
          />
        </ErrorBoundary>
        <ErrorBoundary compact resetKey="intel-freshness" fallbackLabel="Data Freshness">
          <DataFreshnessCard className="rounded-xl border-0 shadow-sm h-full" />
        </ErrorBoundary>
      </div>

      {/* Recent timeline preview full-width at the bottom so power users can */}
      {/* glance at the event stream without switching tabs. */}
      <ErrorBoundary compact resetKey="intel-timeline" fallbackLabel="Recent Timeline">
        <RecentTimelineCard
          pulseTimeline={pulseTimeline}
          onViewFullTimeline={onViewFullTimeline}
          onOpenEntity={onOpenEntity}
        />
      </ErrorBoundary>

      {/* 6. First-visit shortcut hints (dismissable) ---------------------- */}
      {showShortcutTip && <ShortcutHints onClose={dismissShortcutTip} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist star helper — exported so other Pulse tabs (Agents, Agencies,
// Retention) can wire a star button without duplicating the LS plumbing. The
// hook itself is local; consumers read/write via these setter helpers.
// ---------------------------------------------------------------------------
export function togglePulseWatchlistAgent(id) {
  const cur = readLsSet(LS_AGENTS);
  if (cur.has(id)) cur.delete(id); else cur.add(id);
  writeLsSet(LS_AGENTS, cur);
}
export function togglePulseWatchlistAgency(id) {
  const cur = readLsSet(LS_AGENCIES);
  if (cur.has(id)) cur.delete(id); else cur.add(id);
  writeLsSet(LS_AGENCIES, cur);
}
export function isPulseWatchlistAgent(id) {
  return readLsSet(LS_AGENTS).has(id);
}
export function isPulseWatchlistAgency(id) {
  return readLsSet(LS_AGENCIES).has(id);
}
