/**
 * PulseRetention — scope-based Client Retention dashboard (Industry Pulse subtab).
 *
 * "Scope" is the set of CRM-mapped entities we treat as active customers:
 *   • pulse_agents.is_in_crm = true  → per-agent scope
 *   • pulse_agencies.is_in_crm = true → per-agency scope
 *
 * For each scope entity in the selected window we show two flows:
 *   1. Projects we've done           (projects.project_type_name = 'Residential Real Estate'
 *                                      AND status IN delivered/scheduled/ready_for_partial/to_be_scheduled)
 *   2. For-sale listings that arrived (pulse_listings.listing_type='for_sale')
 *      with/without a matching project at the same property_key.
 *
 * Retention % = projects_in_scope / (projects_in_scope + listings_in_window).
 *
 * Data: pulse_get_retention_agent_scope / agency_scope / *_detail  (migration 165).
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle, CheckCircle2, ArrowLeft,
  ExternalLink, Search, RefreshCw, DollarSign, Target,
  ChevronRight, Flame, Droplet, Star, Building2, Download,
  Mail, UserCheck, User as UserIcon, Briefcase, Package as PkgIcon,
  Filter, Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EnrichmentBadge from "@/components/marketshare/EnrichmentBadge";
import DataFreshnessCard from "@/components/marketshare/DataFreshnessCard";
// QuoteProvenance now landed — swapped from local shim to the real reusable
// component that reads from pulse_get_listing_quote_detail.
import { QuoteProvenance } from "@/components/marketshare/QuoteProvenance";
import { WINDOWS, minusWeeks, fmtMoney, fmtInt, fmtPct, fmtDate, monthsSince, toCsv, downloadCsv } from "@/components/marketshare/retention/retentionFormat";
import { RetentionHeatmap, RetentionScatter, LeakyBucketWaterfall, WeeklyCaptureTrend } from "@/components/marketshare/retention/RetentionCharts";

// ══════════════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════════════
export default function PulseRetention({ onOpenEntity, onNavigateTab }) {
  const [windowKey, setWindowKey] = useState("12m");
  const [mode, setMode] = useState("agent");         // "agent" | "agency"
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);    // drill target

  // Advanced filters — dimension-aware + retention band + activity + agency
  const [dimFocus, setDimFocus] = useState("both");           // "both" | "current" | "sold"
  const [retentionBand, setRetentionBand] = useState("all");  // "all" | "at_risk" | "mid" | "healthy"  (<25 / 25-75 / >=75)
  const [missedMin, setMissedMin] = useState(0);              // $ threshold
  const [activityFilter, setActivityFilter] = useState("all");// "all" | "active_only" | "no_projects"
  const [agencyFilter, setAgencyFilter] = useState("");       // text match on agency_name (agent mode)
  const [sortKey, setSortKey] = useState("current_missed_value"); // column to sort by
  const [sortDir, setSortDir] = useState("desc");
  const [showFilters, setShowFilters] = useState(false);

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === windowKey) || WINDOWS[5];
    return { fromDate: wd.from(), toDate: new Date() };
  }, [windowKey]);
  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  // --- Scope rows (v2 — strict CRM-only, dual dimension current + sold) -----
  const rpcName = mode === "agent" ? "pulse_get_retention_agent_scope_v2" : "pulse_get_retention_agency_scope_v2";
  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["pulse_retention_scope_v2", mode, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc(rpcName, {
        p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
  });

  // --- Trend listings (last 12w) — single-shot query so the spark + heatmap
  // + leaky-bucket share data across the whole viz block -----------------
  const trendFrom = useMemo(() => minusWeeks(new Date(), 12).toISOString(), []);
  const { data: trendAgents = [] } = useQuery({
    queryKey: ["pulse_retention_trend_rows_v2", mode, trendFrom],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc(rpcName, {
        p_from: trendFrom, p_to: new Date().toISOString(),
      });
      if (error) throw error;
      return data || [];
    },
    staleTime: 120_000,
  });

  // Filtering — advanced filter chain
  const filtered = useMemo(() => {
    let out = rows;

    // Free-text search
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(r =>
        (r.agent_name || r.agency_name || "").toLowerCase().includes(q)
        || (r.agency_name || "").toLowerCase().includes(q)
        || (r.agent_rea_id || r.rea_agency_id || "").toLowerCase().includes(q)
      );
    }

    // Agency narrowing (agent mode)
    if (agencyFilter && mode === "agent") {
      const a = agencyFilter.toLowerCase();
      out = out.filter(r => (r.agency_name || "").toLowerCase().includes(a));
    }

    // Dimension focus — hide rows with zero activity in the focused dimension
    if (dimFocus === "current") out = out.filter(r => (Number(r.current_listings) || 0) > 0);
    else if (dimFocus === "sold") out = out.filter(r => (Number(r.sold_listings) || 0) > 0);

    // Retention band — against the focused dimension (or "any" for both)
    const getRet = r => {
      if (dimFocus === "sold") return Number(r.sold_retention_pct) || 0;
      // both / current → use current when it has any listings, else sold
      return (Number(r.current_listings) || 0) > 0
        ? (Number(r.current_retention_pct) || 0)
        : (Number(r.sold_retention_pct) || 0);
    };
    if (retentionBand === "at_risk")  out = out.filter(r => getRet(r) < 25);
    else if (retentionBand === "mid") out = out.filter(r => getRet(r) >= 25 && getRet(r) < 75);
    else if (retentionBand === "healthy") out = out.filter(r => getRet(r) >= 75);

    // Missed $ threshold
    if (missedMin > 0) {
      out = out.filter(r => {
        const missed = (Number(r.current_missed_value) || 0) + (Number(r.sold_missed_value) || 0);
        return missed >= missedMin;
      });
    }

    // Activity filter
    if (activityFilter === "active_only") {
      out = out.filter(r =>
        (Number(r.current_listings) || 0) > 0
        || (Number(r.sold_listings) || 0) > 0
        || (Number(r.projects_in_window) || 0) > 0
      );
    } else if (activityFilter === "no_projects") {
      out = out.filter(r => (Number(r.projects_in_window) || 0) === 0);
    }

    // Sort
    const sortGetter = {
      current_missed_value: r => Number(r.current_missed_value) || 0,
      current_retention_pct: r => Number(r.current_retention_pct) || 0,
      current_listings: r => Number(r.current_listings) || 0,
      sold_listings: r => Number(r.sold_listings) || 0,
      sold_retention_pct: r => Number(r.sold_retention_pct) || 0,
      projects_in_window: r => Number(r.projects_in_window) || 0,
      name: r => (r.agent_name || r.agency_name || "").toLowerCase(),
    }[sortKey] || (r => Number(r.current_missed_value) || 0);

    out = [...out].sort((a, b) => {
      const av = sortGetter(a), bv = sortGetter(b);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return out;
  }, [rows, search, agencyFilter, dimFocus, retentionBand, missedMin, activityFilter, mode, sortKey, sortDir]);

  const activeFilterCount = [
    agencyFilter, dimFocus !== "both", retentionBand !== "all",
    missedMin > 0, activityFilter !== "all",
  ].filter(Boolean).length;

  const clearFilters = () => {
    setAgencyFilter("");
    setDimFocus("both");
    setRetentionBand("all");
    setMissedMin(0);
    setActivityFilter("all");
  };

  const totals = useMemo(() => aggregateTotals(filtered), [filtered]);

  // --- Drill view ------------------------------------------------------------
  if (selected) {
    return (
      <DetailView
        mode={mode}
        selected={selected}
        fromIso={fromIso}
        toIso={toIso}
        windowLabel={WINDOWS.find(w => w.value === windowKey)?.label}
        onBack={() => setSelected(null)}
        onOpenEntity={onOpenEntity}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindowKey(w.value)}
              className={cn(
                "text-xs px-2.5 py-1 rounded transition-colors",
                windowKey === w.value ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >{w.label}</button>
          ))}
        </div>

        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <button
            onClick={() => setMode("agent")}
            className={cn(
              "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
              mode === "agent" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
            )}
          ><UserIcon className="h-3 w-3" />Agents</button>
          <button
            onClick={() => setMode("agency")}
            className={cn(
              "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
              mode === "agency" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
            )}
          ><Building2 className="h-3 w-3" />Agencies</button>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter name or REA id" className="h-8 text-xs w-56 pl-7" />
          </div>
          <Button
            variant={showFilters || activeFilterCount > 0 ? "secondary" : "ghost"}
            size="sm"
            className="h-8 gap-1"
            onClick={() => setShowFilters(v => !v)}
            title="Advanced filters"
          >
            <Filter className="h-3.5 w-3.5" />
            {activeFilterCount > 0 && (
              <span className="text-[10px] bg-primary text-primary-foreground rounded-full px-1 tabular-nums">{activeFilterCount}</span>
            )}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1" title="Export CSV"
            onClick={() => exportCsv(filtered, mode)}>
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* ── Advanced filters panel ──────────────────────────────── */}
      {showFilters && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">Advanced filters</span>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground underline">
                Clear all ({activeFilterCount})
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {/* Dimension focus */}
            <FilterPill label="Dimension">
              {["both", "current", "sold"].map(v => (
                <button
                  key={v}
                  onClick={() => setDimFocus(v)}
                  className={cn(
                    "text-[11px] px-2 py-0.5 rounded border transition-colors capitalize",
                    dimFocus === v ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-border hover:bg-muted"
                  )}
                >{v}</button>
              ))}
            </FilterPill>

            {/* Retention band */}
            <FilterPill label="Retention">
              {[
                { v: "all",     l: "All",       cls: "" },
                { v: "at_risk", l: "<25%",      cls: "text-red-700" },
                { v: "mid",     l: "25-75%",    cls: "text-amber-700" },
                { v: "healthy", l: "≥75%",      cls: "text-emerald-700" },
              ].map(opt => (
                <button
                  key={opt.v}
                  onClick={() => setRetentionBand(opt.v)}
                  className={cn(
                    "text-[11px] px-2 py-0.5 rounded border transition-colors",
                    retentionBand === opt.v ? "bg-primary text-primary-foreground border-primary" : cn("bg-transparent border-border hover:bg-muted", opt.cls)
                  )}
                >{opt.l}</button>
              ))}
            </FilterPill>

            {/* Missed $ min */}
            <FilterPill label="Missed $ ≥">
              <Input
                type="number"
                value={missedMin || ""}
                onChange={(e) => setMissedMin(Number(e.target.value) || 0)}
                placeholder="0"
                min={0} step={500}
                className="h-7 text-[11px] w-28"
              />
            </FilterPill>

            {/* Activity */}
            <FilterPill label="Activity">
              {[
                { v: "all",          l: "All" },
                { v: "active_only",  l: "Has activity" },
                { v: "no_projects",  l: "No projects" },
              ].map(opt => (
                <button
                  key={opt.v}
                  onClick={() => setActivityFilter(opt.v)}
                  className={cn(
                    "text-[11px] px-2 py-0.5 rounded border transition-colors",
                    activityFilter === opt.v ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-border hover:bg-muted"
                  )}
                >{opt.l}</button>
              ))}
            </FilterPill>

            {/* Agency text-match (agent mode only) */}
            {mode === "agent" && (
              <FilterPill label="Agency">
                <Input
                  value={agencyFilter}
                  onChange={(e) => setAgencyFilter(e.target.value)}
                  placeholder="e.g. Belle Property"
                  className="h-7 text-[11px] w-36"
                />
              </FilterPill>
            )}
          </div>
          {/* Sort controls */}
          <div className="flex items-center gap-2 pt-1 border-t">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Sort by</span>
            {[
              { k: "current_missed_value",  l: "Current missed $" },
              { k: "current_retention_pct", l: "Current retention %" },
              { k: "current_listings",      l: "Current listings" },
              { k: "sold_listings",         l: "Sold listings" },
              { k: "sold_retention_pct",    l: "Sold retention %" },
              { k: "projects_in_window",    l: "Projects" },
              { k: "name",                  l: "Name" },
            ].map(opt => (
              <button
                key={opt.k}
                onClick={() => {
                  if (sortKey === opt.k) setSortDir(d => d === "desc" ? "asc" : "desc");
                  else { setSortKey(opt.k); setSortDir("desc"); }
                }}
                className={cn(
                  "text-[11px] px-1.5 py-0.5 rounded transition-colors inline-flex items-center gap-0.5",
                  sortKey === opt.k ? "bg-muted font-medium" : "hover:bg-muted/60 text-muted-foreground"
                )}
              >
                {opt.l}
                {sortKey === opt.k && (sortDir === "desc" ? "↓" : "↑")}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* ── Data freshness strip — visibility on enrichment coverage ── */}
      <DataFreshnessCard compact className="px-1" />

      {/* ── KPI strip ────────────────────────────────────────────── */}
      <KpiStrip mode={mode} totals={totals} count={filtered.length} />

      {/* ── Leaky-bucket summary ─────────────────────────────────── */}
      <LeakyBucketBar totals={totals} />

      {/* ── Main ranking table ───────────────────────────────────── */}
      <Card className="p-3">
        <div className="flex items-center gap-2 mb-2">
          {mode === "agent" ? <UserIcon className="h-4 w-4 text-muted-foreground" /> : <Building2 className="h-4 w-4 text-muted-foreground" />}
          <h3 className="text-sm font-semibold">
            {mode === "agent" ? "CRM agents in scope" : "CRM agencies in scope"} — ranked by missed opportunity
          </h3>
          <Badge variant="secondary" className="ml-auto text-xs">{filtered.length} {mode === "agent" ? "agents" : "agencies"}</Badge>
        </div>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading {mode}s…</div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">No {mode}s match — widen the window or clear the filter.</div>
        ) : mode === "agent" ? (
          <AgentTable rows={filtered} onSelect={setSelected} />
        ) : (
          <AgencyTable rows={filtered} onSelect={setSelected} />
        )}
      </Card>

      {/* ── CEO-grade visualisations ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TrendBlock trendAgents={trendAgents} mode={mode} />
        <RetentionScatter rows={filtered} onOpenAgent={(a) => setSelected(a)} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Totals + KPI (v2 — dual dimension: current for_sale + sold)
// ══════════════════════════════════════════════════════════════════════════
function aggregateTotals(rows) {
  return rows.reduce((acc, r) => {
    acc.current_listings += Number(r.current_listings) || 0;
    acc.current_captured += Number(r.current_captured) || 0;
    acc.current_missed   += Number(r.current_missed)   || 0;
    acc.current_missed_$ += Number(r.current_missed_value) || 0;
    acc.sold_listings    += Number(r.sold_listings)    || 0;
    acc.sold_captured    += Number(r.sold_captured)    || 0;
    acc.sold_missed      += Number(r.sold_missed)      || 0;
    acc.sold_missed_$    += Number(r.sold_missed_value)|| 0;
    acc.projects_in_window += Number(r.projects_in_window) || 0;
    return acc;
  }, {
    current_listings: 0, current_captured: 0, current_missed: 0, current_missed_$: 0,
    sold_listings: 0, sold_captured: 0, sold_missed: 0, sold_missed_$: 0,
    projects_in_window: 0,
  });
}

function KpiStrip({ mode, totals, count }) {
  const currentPct = totals.current_listings > 0 ? (100 * totals.current_captured / totals.current_listings) : 0;
  const soldPct    = totals.sold_listings    > 0 ? (100 * totals.sold_captured    / totals.sold_listings)    : 0;
  return (
    <div className="space-y-2">
      {/* Scope + projects row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Kpi icon={mode === "agent" ? UserIcon : Building2}
             label={mode === "agent" ? "CRM agents in scope" : "CRM agencies in scope"}
             value={fmtInt(count)} color="text-slate-700" bg="bg-slate-50" />
        <Kpi icon={Briefcase}    label="Projects in window" value={fmtInt(totals.projects_in_window)} color="text-indigo-700" bg="bg-indigo-50" />
        <Kpi icon={DollarSign}   label="Total missed $"     value={fmtMoney(totals.current_missed_$ + totals.sold_missed_$)}
             sub={`${fmtMoney(totals.current_missed_$)} current · ${fmtMoney(totals.sold_missed_$)} sold`}
             color="text-amber-700" bg="bg-amber-50" emphasis />
      </div>
      {/* Current listings dimension */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi icon={Target}           label="Current listings"  value={fmtInt(totals.current_listings)} color="text-blue-600"    bg="bg-blue-50" />
        <Kpi icon={CheckCircle2}     label="Current captured"  value={fmtInt(totals.current_captured)} sub={fmtPct(currentPct)} color="text-emerald-600" bg="bg-emerald-50" />
        <Kpi icon={AlertTriangle}    label="Current missed"    value={fmtInt(totals.current_missed)}   color="text-amber-600"   bg="bg-amber-50" />
        <Kpi icon={DollarSign}       label="Current missed $"  value={fmtMoney(totals.current_missed_$)} color="text-amber-700" bg="bg-amber-50" />
      </div>
      {/* Sold listings dimension */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi icon={Target}           label="Sold listings"     value={fmtInt(totals.sold_listings)}    color="text-purple-600" bg="bg-purple-50" />
        <Kpi icon={CheckCircle2}     label="Sold captured"     value={fmtInt(totals.sold_captured)}    sub={fmtPct(soldPct)}    color="text-emerald-600" bg="bg-emerald-50" />
        <Kpi icon={AlertTriangle}    label="Sold missed"       value={fmtInt(totals.sold_missed)}      color="text-amber-600"   bg="bg-amber-50" />
        <Kpi icon={DollarSign}       label="Sold missed $"     value={fmtMoney(totals.sold_missed_$)}  color="text-amber-700" bg="bg-amber-50" />
      </div>
    </div>
  );
}

function FilterPill({ label, children }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      {children}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, color, bg, emphasis }) {
  return (
    <Card className={cn("p-2.5", emphasis && "ring-1 ring-amber-200")}>
      <div className="flex items-start gap-2">
        <div className={cn("w-7 h-7 rounded flex items-center justify-center", bg)}>
          <Icon className={cn("h-3.5 w-3.5", color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-muted-foreground">{label}</div>
          <div className="text-sm font-semibold tabular-nums">{value}</div>
          {sub && <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

function LeakyBucketBar({ totals }) {
  const curTotal = totals.current_listings;
  const soldTotal = totals.sold_listings;
  if (!curTotal && !soldTotal) return null;
  const curPct = curTotal ? 100 * totals.current_captured / curTotal : 0;
  const soldPct = soldTotal ? 100 * totals.sold_captured / soldTotal : 0;
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold">Leaky-bucket summary</h4>
        <span className="text-[11px] text-muted-foreground">captured vs missed by dimension</span>
      </div>
      {/* Current dimension */}
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[11px] font-medium text-blue-700">Current listings</span>
          <span className="text-[11px] text-muted-foreground">
            {fmtInt(totals.current_captured)} captured · {fmtInt(totals.current_missed)} missed of {fmtInt(curTotal)}
          </span>
          <span className="ml-auto text-[11px] tabular-nums">
            <span className="text-emerald-700 font-medium">{curPct.toFixed(1)}%</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-amber-700 font-medium">{(100 - curPct).toFixed(1)}%</span>
          </span>
        </div>
        <div className="h-2.5 rounded-full overflow-hidden flex ring-1 ring-border/60">
          <div style={{ width: `${curPct}%` }} className="bg-emerald-500" />
          <div style={{ width: `${100 - curPct}%` }} className="bg-amber-500" />
        </div>
      </div>
      {/* Sold dimension */}
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[11px] font-medium text-purple-700">Sold listings</span>
          <span className="text-[11px] text-muted-foreground">
            {fmtInt(totals.sold_captured)} captured · {fmtInt(totals.sold_missed)} missed of {fmtInt(soldTotal)}
          </span>
          <span className="ml-auto text-[11px] tabular-nums">
            <span className="text-emerald-700 font-medium">{soldPct.toFixed(1)}%</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-amber-700 font-medium">{(100 - soldPct).toFixed(1)}%</span>
          </span>
        </div>
        <div className="h-2.5 rounded-full overflow-hidden flex ring-1 ring-border/60">
          <div style={{ width: `${soldPct}%` }} className="bg-emerald-500" />
          <div style={{ width: `${100 - soldPct}%` }} className="bg-amber-500" />
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Agent table
// ══════════════════════════════════════════════════════════════════════════
function AgentTable({ rows, onSelect }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          {/* Grouped header: Current dimension + Sold dimension */}
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1.5 font-medium px-2" rowSpan={2}>#</th>
            <th className="text-left py-1.5 font-medium" rowSpan={2}>Agent</th>
            <th className="text-left py-1.5 font-medium" rowSpan={2}>Agency</th>
            <th className="text-right py-1.5 font-medium" rowSpan={2}>Proj</th>
            <th className="text-center py-1 font-semibold text-blue-700 border-l" colSpan={4}>Current (for sale)</th>
            <th className="text-center py-1 font-semibold text-purple-700 border-l" colSpan={3}>Sold</th>
            <th className="w-4" rowSpan={2}></th>
          </tr>
          <tr className="border-b text-muted-foreground">
            <th className="text-right py-1.5 font-medium border-l">Listings</th>
            <th className="text-right py-1.5 font-medium">Cap</th>
            <th className="text-right py-1.5 font-medium">Ret %</th>
            <th className="text-right py-1.5 font-medium">Missed $</th>
            <th className="text-right py-1.5 font-medium border-l">Listings</th>
            <th className="text-right py-1.5 font-medium">Cap</th>
            <th className="text-right py-1.5 font-medium">Ret %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <AgentRow key={r.agent_rea_id || i} r={r} idx={i} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ r, idx, onSelect }) {
  const curRet  = Number(r.current_retention_pct) || 0;
  const soldRet = Number(r.sold_retention_pct) || 0;
  const curListings = Number(r.current_listings) || 0;
  const projects = Number(r.projects_in_window) || 0;
  const leaky    = (monthsSince(r.last_project_date) ?? 0) > 6 && curListings > 0;
  const newOppty = Number(r.current_missed_value) > 5000 && projects === 0;
  return (
    <tr
      className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
      onClick={() => onSelect(r)}
      title="Drill into scope detail"
    >
      <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{idx + 1}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar url={r.profile_image} name={r.agent_name} />
          <div className="min-w-0">
            <div className="font-medium truncate max-w-[170px]" title={r.agent_name}>{r.agent_name || "—"}</div>
            <div className="text-[10px] text-muted-foreground truncate max-w-[170px]" title={r.agent_rea_id}>REA {r.agent_rea_id}</div>
          </div>
          <FlagIcons atRisk={false} leaky={leaky} newOppty={newOppty} />
        </div>
      </td>
      <td className="py-1.5 text-muted-foreground truncate max-w-[200px]" title={r.agency_name}>{r.agency_name || "—"}</td>
      <td className="py-1.5 text-right tabular-nums">{fmtInt(projects)}</td>
      {/* Current */}
      <td className="py-1.5 text-right tabular-nums border-l">{fmtInt(curListings)}</td>
      <td className="py-1.5 text-right tabular-nums text-emerald-700">
        <CapturedCell total={r.current_captured} active={r.current_captured_active} legacy={r.current_captured_legacy} />
      </td>
      <td className="py-1.5 text-right tabular-nums"><RetentionBadge pct={curRet} /></td>
      <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(r.current_missed_value)}</td>
      {/* Sold */}
      <td className="py-1.5 text-right tabular-nums border-l">{fmtInt(r.sold_listings)}</td>
      <td className="py-1.5 text-right tabular-nums text-emerald-700">
        <CapturedCell total={r.sold_captured} active={r.sold_captured_active} legacy={r.sold_captured_legacy} />
      </td>
      <td className="py-1.5 text-right tabular-nums"><RetentionBadge pct={soldRet} /></td>
      <td className="py-1.5 text-muted-foreground"><ChevronRight className="h-3.5 w-3.5" /></td>
    </tr>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Agency table (with expandable agents-within)
// ══════════════════════════════════════════════════════════════════════════
function AgencyTable({ rows, onSelect }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1.5 font-medium px-2" rowSpan={2}>#</th>
            <th className="text-left py-1.5 font-medium" rowSpan={2}>Agency</th>
            <th className="text-right py-1.5 font-medium" rowSpan={2}>Agents</th>
            <th className="text-right py-1.5 font-medium" rowSpan={2}>Proj</th>
            <th className="text-center py-1 font-semibold text-blue-700 border-l" colSpan={4}>Current (for sale)</th>
            <th className="text-center py-1 font-semibold text-purple-700 border-l" colSpan={3}>Sold</th>
            <th className="w-4" rowSpan={2}></th>
          </tr>
          <tr className="border-b text-muted-foreground">
            <th className="text-right py-1.5 font-medium border-l">Listings</th>
            <th className="text-right py-1.5 font-medium">Cap</th>
            <th className="text-right py-1.5 font-medium">Ret %</th>
            <th className="text-right py-1.5 font-medium">Missed $</th>
            <th className="text-right py-1.5 font-medium border-l">Listings</th>
            <th className="text-right py-1.5 font-medium">Cap</th>
            <th className="text-right py-1.5 font-medium">Ret %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <AgencyRow key={r.agency_pulse_id || i} r={r} idx={i} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgencyRow({ r, idx, onSelect }) {
  const curRet  = Number(r.current_retention_pct) || 0;
  const soldRet = Number(r.sold_retention_pct) || 0;
  const curListings = Number(r.current_listings) || 0;
  const projects = Number(r.projects_in_window) || 0;
  const leaky    = (monthsSince(r.last_project_date) ?? 0) > 6 && curListings > 0;
  return (
    <tr
      className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
      onClick={() => onSelect(r)}
    >
      <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{idx + 1}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar url={r.logo_url} name={r.agency_name} shape="square" />
          <div className="min-w-0">
            <div className="font-medium truncate max-w-[240px]" title={r.agency_name}>{r.agency_name || "—"}</div>
            <div className="text-[10px] text-muted-foreground">REA {r.rea_agency_id || "—"}</div>
          </div>
          <FlagIcons atRisk={false} leaky={leaky} newOppty={false} />
        </div>
      </td>
      <td className="py-1.5 text-right tabular-nums">{fmtInt(r.agents_in_agency)}</td>
      <td className="py-1.5 text-right tabular-nums">{fmtInt(projects)}</td>
      {/* Current */}
      <td className="py-1.5 text-right tabular-nums border-l">{fmtInt(curListings)}</td>
      <td className="py-1.5 text-right tabular-nums text-emerald-700">
        <CapturedCell total={r.current_captured} active={r.current_captured_active} legacy={r.current_captured_legacy} />
      </td>
      <td className="py-1.5 text-right tabular-nums"><RetentionBadge pct={curRet} /></td>
      <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(r.current_missed_value)}</td>
      {/* Sold */}
      <td className="py-1.5 text-right tabular-nums border-l">{fmtInt(r.sold_listings)}</td>
      <td className="py-1.5 text-right tabular-nums text-emerald-700">
        <CapturedCell total={r.sold_captured} active={r.sold_captured_active} legacy={r.sold_captured_legacy} />
      </td>
      <td className="py-1.5 text-right tabular-nums"><RetentionBadge pct={soldRet} /></td>
      <td className="py-1.5 text-muted-foreground"><ChevronRight className="h-3.5 w-3.5" /></td>
    </tr>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Shared small UI
// ══════════════════════════════════════════════════════════════════════════
function Avatar({ url, name, shape = "circle" }) {
  const initials = (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join("").toUpperCase();
  const radius = shape === "square" ? "rounded" : "rounded-full";
  if (url) {
    return <img src={url} alt={name || ""} referrerPolicy="no-referrer" className={cn("w-6 h-6 object-cover bg-muted", radius)} />;
  }
  return (
    <div className={cn("w-6 h-6 flex items-center justify-center text-[10px] font-semibold text-slate-600 bg-slate-100", radius)}>
      {initials || "?"}
    </div>
  );
}

/**
 * CapturedCell — renders a captured count with a hover tooltip breaking it
 * into active + legacy when the agent-3 RPC extension populates those fields.
 * Falls back gracefully (no tooltip) when the columns are missing.
 */
function CapturedCell({ total, active, legacy }) {
  const hasBreakdown = active != null || legacy != null;
  const a = Number(active) || 0;
  const l = Number(legacy) || 0;
  const title = hasBreakdown
    ? `${a} active + ${l} legacy = ${Number(total) || (a + l)} captured`
    : undefined;
  return (
    <span title={title} className={cn("inline-flex items-center gap-0.5", hasBreakdown && l > 0 && "underline decoration-dotted decoration-slate-400 underline-offset-2 cursor-help")}>
      {fmtInt(total)}
      {hasBreakdown && l > 0 && (
        <Archive className="h-2.5 w-2.5 text-slate-400" aria-hidden="true" />
      )}
    </span>
  );
}

function RetentionBadge({ pct, delta }) {
  const cls =
    pct >= 70 ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : pct >= 40 ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-red-100 text-red-800 border-red-200";
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <Badge className={cn("text-[10px] h-4 px-1", cls)}>{pct.toFixed(0)}%</Badge>
      {delta != null && Math.abs(delta) >= 1 && (
        <span className={cn("text-[10px]", delta > 0 ? "text-emerald-700" : "text-red-700")}>
          {delta > 0 ? "▲" : "▼"}{Math.abs(delta).toFixed(0)}
        </span>
      )}
    </span>
  );
}

function FlagIcons({ atRisk, leaky, newOppty }) {
  return (
    <span className="inline-flex items-center gap-0.5 ml-auto">
      {atRisk   && <Flame  className="h-3 w-3 text-red-500"    aria-label="At-risk"       title="At risk: retention dropped ≥20% vs previous window" />}
      {leaky    && <Droplet className="h-3 w-3 text-rose-500"  aria-label="Leaky bucket"  title="Leaky: last project > 6 months ago, listings still arriving" />}
      {newOppty && <Star   className="h-3 w-3 text-amber-500"  aria-label="New opportunity" title="New opportunity: >$5K missed and no prior projects" />}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Trend block — tabs switch between sparkline + heatmap + leaky-bucket
// ══════════════════════════════════════════════════════════════════════════
function TrendBlock({ trendAgents, mode }) {
  const [sub, setSub] = useState("spark");
  // For the listings needed by the 3 charts, query the 12w listings for the
  // same set of top rows. Done once per mode change.
  const { data: deepListings = [] } = useQuery({
    queryKey: ["pulse_retention_12w_listings", mode, trendAgents.map(r => r.agent_rea_id || r.agency_pulse_id).slice(0, 30).join(",")],
    queryFn: async () => {
      // Sample down to the top 30 for heatmap/scatter — the trend line itself
      // ignores this and works off aggregates anyway.
      if (mode === "agent") {
        // Fetch per-agent detail for the top 30 by missed $, concat all listings
        const top = trendAgents.slice(0, 30);
        const out = [];
        for (const r of top) {
          const { data, error } = await api._supabase.rpc("pulse_get_retention_agent_detail", {
            p_agent_rea_id: r.agent_rea_id,
            p_from: minusWeeks(new Date(), 12).toISOString(),
            p_to:   new Date().toISOString(),
          });
          if (error) continue;
          const ls = (data?.listings || []).map(l => ({ ...l, agent_rea_id: r.agent_rea_id, agent_name: r.agent_name }));
          out.push(...ls);
        }
        return out;
      }
      // Agency mode: top 10 agencies, merged listings
      const top = trendAgents.slice(0, 10);
      const out = [];
      for (const r of top) {
        const { data, error } = await api._supabase.rpc("pulse_get_retention_agency_detail", {
          p_agency_pulse_id: r.agency_pulse_id,
          p_from: minusWeeks(new Date(), 12).toISOString(),
          p_to:   new Date().toISOString(),
        });
        if (error) continue;
        const ls = (data?.listings || []).map(l => ({ ...l, agent_rea_id: l.agent_rea_id || r.agency_pulse_id, agent_name: l.agent_name || r.agency_name }));
        out.push(...ls);
      }
      return out;
    },
    enabled: Array.isArray(trendAgents) && trendAgents.length > 0,
    staleTime: 180_000,
  });

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <button
          onClick={() => setSub("spark")}
          className={cn("text-[11px] px-2 py-0.5 rounded", sub === "spark" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >Trend</button>
        <button
          onClick={() => setSub("heatmap")}
          className={cn("text-[11px] px-2 py-0.5 rounded", sub === "heatmap" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >Heatmap</button>
        <button
          onClick={() => setSub("bucket")}
          className={cn("text-[11px] px-2 py-0.5 rounded", sub === "bucket" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >Leaky bucket</button>
      </div>
      <div className="p-0">
        {sub === "spark"   && <WeeklyCaptureTrend listings={deepListings} />}
        {sub === "heatmap" && <RetentionHeatmap listings={deepListings} />}
        {sub === "bucket"  && <LeakyBucketWaterfall listings={deepListings} />}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Detail view (drill)
// ══════════════════════════════════════════════════════════════════════════
function DetailView({ mode, selected, fromIso, toIso, windowLabel, onBack, onOpenEntity }) {
  const rpc = mode === "agent" ? "pulse_get_retention_agent_detail" : "pulse_get_retention_agency_detail";
  const args = mode === "agent"
    ? { p_agent_rea_id: selected.agent_rea_id, p_from: fromIso, p_to: toIso }
    : { p_agency_pulse_id: selected.agency_pulse_id, p_from: fromIso, p_to: toIso };

  // Legacy-import visibility toggle for the captured_listings table.
  const [capturedView, setCapturedView] = useState("all"); // "all" | "active" | "legacy"

  const { data: detail, isLoading } = useQuery({
    queryKey: ["pulse_retention_detail", mode, selected.agent_rea_id || selected.agency_pulse_id, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc(rpc, args);
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
  });

  const d         = detail || {};
  const header    = mode === "agent" ? d.agent   : d.agency;
  const projects  = Array.isArray(d.projects) ? d.projects : [];
  const listings  = Array.isArray(d.listings) ? d.listings : [];
  const matches   = Array.isArray(d.matches)  ? d.matches  : [];
  const agents    = Array.isArray(d.agents)   ? d.agents   : [];
  const summary   = d.summary || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />Back
        </Button>
        <div className="text-xs text-muted-foreground">{windowLabel}</div>
      </div>

      {/* ── Header ──────────────────────────────────────────────── */}
      <Card className="p-3">
        <div className="flex items-start gap-3">
          <Avatar url={mode === "agent" ? header?.profile_image : header?.logo_url} name={mode === "agent" ? header?.full_name : header?.agency_name} shape={mode === "agent" ? "circle" : "square"} />
          <div className="flex-1 min-w-0">
            {(header?.agent_pulse_id || header?.agency_pulse_id) && onOpenEntity ? (
              <button
                className="text-lg font-semibold truncate hover:underline text-left"
                onClick={() => onOpenEntity({
                  type: mode === "agent" ? "agent" : "agency",
                  id: mode === "agent" ? header.agent_pulse_id : header.agency_pulse_id,
                })}
                title="Open slideout"
              >{mode === "agent" ? header?.full_name : header?.agency_name}</button>
            ) : (
              <div className="text-lg font-semibold truncate">{mode === "agent" ? header?.full_name : header?.agency_name}</div>
            )}
            {mode === "agent" && header?.agency_name && (
              <div className="text-xs text-muted-foreground truncate">{header.agency_name}</div>
            )}
            <div className="text-[11px] text-muted-foreground">
              {mode === "agent" ? <>REA agent ID: <code>{header?.rea_agent_id}</code></>
                                : <>REA agency ID: <code>{header?.rea_agency_id || "—"}</code></>}
              {header?.is_in_crm && <span className="ml-2 inline-flex items-center gap-1 text-emerald-700"><UserCheck className="h-3 w-3" />CRM</span>}
            </div>
          </div>

          {/* Onboard CTAs */}
          <div className="flex items-center gap-1">
            {mode === "agent" && header?.email && (
              <a href={`mailto:${header.email}`}
                 className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
                 title={`Email ${header.email}`}>
                <Mail className="h-3 w-3" />Email
              </a>
            )}
            {(header?.agent_pulse_id || header?.agency_pulse_id) && onOpenEntity && (
              <button
                onClick={() => onOpenEntity({
                  type: mode === "agent" ? "agent" : "agency",
                  id: mode === "agent" ? header.agent_pulse_id : header.agency_pulse_id,
                })}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              ><UserIcon className="h-3 w-3" />Slideout</button>
            )}
            {mode === "agent" && header?.crm_agent_id && (
              <a href={`/crm/contact/${header.crm_agent_id}`}
                 className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted">
                <Briefcase className="h-3 w-3" />CRM
              </a>
            )}
          </div>
        </div>
      </Card>

      {/* ── Summary strip ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Kpi icon={Briefcase}      label="Projects in scope" value={fmtInt(summary.projects_in_scope)}       color="text-slate-700"   bg="bg-slate-50" />
        <Kpi icon={Target}         label="Listings in window" value={fmtInt(summary.listings_in_window)}     color="text-blue-600"    bg="bg-blue-50" />
        <Kpi icon={CheckCircle2}   label="Captured"          value={fmtInt(summary.listings_captured)}      color="text-emerald-600" bg="bg-emerald-50" />
        <Kpi icon={AlertTriangle}  label="Missed"            value={fmtInt(summary.listings_missed)}        color="text-amber-600"   bg="bg-amber-50" />
        <Kpi icon={DollarSign}     label="Missed $"          value={fmtMoney(summary.missed_opportunity_value)} color="text-amber-700" bg="bg-amber-50" emphasis />
      </div>

      {isLoading ? (
        <Card className="p-8 text-xs text-muted-foreground text-center">Loading detail…</Card>
      ) : (
        <>
          {/* For agency mode: the agents-within rollup */}
          {mode === "agency" && agents.length > 0 && (
            <Card className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <UserIcon className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Agents at this agency</h3>
                <Badge variant="secondary" className="ml-auto text-xs">{agents.length}</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-1.5 font-medium">Agent</th>
                      <th className="text-left py-1.5 font-medium">CRM</th>
                      <th className="text-right py-1.5 font-medium">Projects</th>
                      <th className="text-right py-1.5 font-medium">Listings</th>
                      <th className="text-right py-1.5 font-medium">Captured</th>
                      <th className="text-right py-1.5 font-medium">Missed</th>
                      <th className="text-right py-1.5 font-medium">Missed $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map(a => (
                      <tr key={a.agent_pulse_id} className="border-b last:border-b-0 hover:bg-muted/40">
                        <td className="py-1.5">
                          <div className="flex items-center gap-2">
                            <Avatar url={a.profile_image} name={a.agent_name} />
                            <button
                              className="font-medium hover:underline"
                              onClick={() => onOpenEntity && a.agent_pulse_id && onOpenEntity({ type: "agent", id: a.agent_pulse_id })}
                            >{a.agent_name}</button>
                          </div>
                        </td>
                        <td className="py-1.5">{a.is_in_crm ? <Badge className="h-4 text-[10px] px-1 bg-emerald-100 text-emerald-800 border-emerald-200">Yes</Badge> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtInt(a.projects_cnt)}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtInt(a.listings_cnt)}</td>
                        <td className="py-1.5 text-right tabular-nums text-emerald-700">{fmtInt(a.captured_cnt)}</td>
                        <td className="py-1.5 text-right tabular-nums text-amber-700">{fmtInt(a.missed_cnt)}</td>
                        <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(a.missed_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Side-by-side tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ProjectsTable projects={projects} onOpenEntity={onOpenEntity} />
            <MissedListingsTable listings={listings.filter(l => !l.is_captured)} onOpenEntity={onOpenEntity} />
          </div>

          {/* Captured listings — with legacy visibility toggle */}
          <CapturedListingsTable
            listings={listings.filter(l => l.is_captured)}
            capturedView={capturedView}
            setCapturedView={setCapturedView}
            onOpenEntity={onOpenEntity}
          />

          {/* Matches grid: property_key pills */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <PkgIcon className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Property match grid</h3>
              <Badge variant="secondary" className="ml-auto text-xs">{matches.length} properties</Badge>
            </div>
            {matches.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 text-center">No properties in this window</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {matches.map(m => (
                  <span
                    key={m.property_key}
                    className={cn(
                      "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border",
                      m.any_captured ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                     : "bg-red-50 text-red-800 border-red-200"
                    )}
                    title={`${m.any_captured ? "Captured" : "Missed"} — ${m.listings_cnt} listing(s)`}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full", m.any_captured ? "bg-emerald-500" : "bg-red-500")}></span>
                    {m.property_key}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Drill detail tables ─────────────────────────────────────────────────────

function ProjectsTable({ projects, onOpenEntity }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <h3 className="text-sm font-semibold">Projects we've delivered / booked</h3>
        <Badge variant="secondary" className="ml-auto text-xs">{projects.length}</Badge>
      </div>
      {projects.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No in-scope projects — pure prospect.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1.5 font-medium px-1">Address</th>
                <th className="text-left py-1.5 font-medium">Date</th>
                <th className="text-left py-1.5 font-medium">Status</th>
                <th className="text-left py-1.5 font-medium">Package</th>
                <th className="text-right py-1.5 font-medium">$</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.project_id} className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => onOpenEntity && onOpenEntity({ type: "project", id: p.project_id })}
                >
                  <td className="py-1.5 px-1 truncate max-w-[240px] hover:underline" title={p.property_address}>{p.property_address || p.property_key || "—"}</td>
                  <td className="py-1.5 tabular-nums">{fmtDate(p.booking_date)}</td>
                  <td className="py-1.5"><StatusBadge status={p.status} /></td>
                  <td className="py-1.5 truncate max-w-[160px]" title={p.package_name}>{p.package_name ? <Badge variant="outline" className="text-[10px] h-4 px-1">{p.package_name.replace(" Package", "")}</Badge> : "—"}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{fmtMoney(p.calculated_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }) {
  const map = {
    delivered:            ["bg-emerald-100 text-emerald-800 border-emerald-200", "Delivered"],
    scheduled:            ["bg-blue-100    text-blue-800    border-blue-200",    "Scheduled"],
    ready_for_partial:    ["bg-purple-100  text-purple-800  border-purple-200",  "Partial"],
    to_be_scheduled:      ["bg-slate-100   text-slate-700   border-slate-200",   "To schedule"],
  };
  const [cls, label] = map[status] || ["bg-slate-100 text-slate-700 border-slate-200", status || "—"];
  return <Badge className={cn("text-[10px] h-4 px-1", cls)}>{label}</Badge>;
}

/**
 * CapturedListingsTable — captured-side counterpart to MissedListingsTable.
 * Adds a "captured_by" chip (Active / Legacy / Both) and a view toggle to
 * filter by source. Consumes listing.captured_by populated by agent 3's
 * RPC extension; rows without the field are treated as "active" so the
 * table never collapses to empty pre-migration.
 */
function CapturedListingsTable({ listings, capturedView, setCapturedView, onOpenEntity }) {
  const shown = (listings || []).filter(l => {
    const cb = l.captured_by || "active"; // defensive default
    if (capturedView === "active") return cb === "active" || cb === "both";
    if (capturedView === "legacy") return cb === "legacy" || cb === "both";
    return true;
  });
  const counts = {
    all: (listings || []).length,
    active: (listings || []).filter(l => (l.captured_by || "active") === "active" || l.captured_by === "both").length,
    legacy: (listings || []).filter(l => l.captured_by === "legacy" || l.captured_by === "both").length,
  };
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <h3 className="text-sm font-semibold">Captured listings</h3>
        <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 ml-2" title="Filter captured listings by source">
          {[
            { v: "all",    l: `All (${counts.all})` },
            { v: "active", l: `Active (${counts.active})` },
            { v: "legacy", l: `Legacy (${counts.legacy})` },
          ].map(opt => (
            <button
              key={opt.v}
              onClick={() => setCapturedView(opt.v)}
              className={cn(
                "text-[11px] px-1.5 py-0.5 rounded transition-colors",
                capturedView === opt.v ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >{opt.l}</button>
          ))}
        </div>
        <Badge variant="secondary" className="ml-auto text-xs">{shown.length}</Badge>
      </div>
      {shown.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          {counts.all === 0 ? "No captures in this window." : "Nothing in this source."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1.5 font-medium px-1">Captured by</th>
                <th className="text-left py-1.5 font-medium">Address</th>
                <th className="text-left py-1.5 font-medium">First seen</th>
                <th className="text-left py-1.5 font-medium">Package</th>
                <th className="text-right py-1.5 font-medium">Quote</th>
                <th className="text-right py-1.5 font-medium px-1">Link</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(l => {
                const cb = l.captured_by || "active";
                return (
                  <tr key={l.listing_id} className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                      onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: l.listing_id })}>
                    <td className="py-1.5 px-1"><CapturedByChip by={cb} /></td>
                    <td className="py-1.5 truncate max-w-[220px] hover:underline" title={l.address}>
                      <div className="truncate">{l.address || l.property_key}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{l.suburb || ""}</div>
                    </td>
                    <td className="py-1.5 tabular-nums">{fmtDate(l.first_seen_at)}</td>
                    <td className="py-1.5">
                      {l.classified_package_name
                        ? <Badge variant="outline" className="text-[10px] h-4 px-1">{l.classified_package_name.replace(" Package", "")}</Badge>
                        : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-emerald-700">{fmtMoney(l.quoted_price)}</td>
                    <td className="py-1.5 px-1 text-right" onClick={(e) => e.stopPropagation()}>
                      {l.source_url && (
                        <a href={l.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex" title="Open on REA">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CapturedByChip({ by }) {
  const map = {
    active: ["bg-emerald-100 text-emerald-800 border-emerald-200", "Active"],
    legacy: ["bg-slate-100   text-slate-700   border-slate-200",   "Legacy"],
    both:   ["bg-blue-100    text-blue-800    border-blue-200",    "Both"],
  };
  const [cls, label] = map[by] || map.active;
  return <Badge className={cn("text-[10px] h-4 px-1 whitespace-nowrap", cls)}>{label}</Badge>;
}

function MissedListingsTable({ listings, onOpenEntity }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <h3 className="text-sm font-semibold">Listings we missed</h3>
        <Badge variant="secondary" className="ml-auto text-xs">{listings.length}</Badge>
      </div>
      {listings.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">Nothing leaking — beautiful.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-center py-1.5 font-medium px-1" title="Enrichment status">Data</th>
                <th className="text-left py-1.5 font-medium">Address</th>
                <th className="text-left py-1.5 font-medium">First seen</th>
                <th className="text-left py-1.5 font-medium">Package</th>
                <th className="text-left py-1.5 font-medium">Tier</th>
                <th className="text-right py-1.5 font-medium">Quote</th>
                <th className="text-left py-1.5 font-medium"></th>
                <th className="text-right py-1.5 font-medium px-1">Link</th>
              </tr>
            </thead>
            <tbody>
              {listings.map(l => (
                <tr key={l.listing_id} className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: l.listing_id })}
                >
                  <td className="py-1.5 px-1 text-center" onClick={(e) => e.stopPropagation()}>
                    <EnrichmentBadge listing={{ detail_enriched_at: l.detail_enriched_at }} compact />
                  </td>
                  <td className="py-1.5 truncate max-w-[220px] hover:underline" title={l.address}>
                    <div className="truncate">{l.address || l.property_key}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{l.suburb || ""}</div>
                  </td>
                  <td className="py-1.5 tabular-nums">{fmtDate(l.first_seen_at)}</td>
                  <td className="py-1.5">
                    <QuoteProvenance listing={l} compact />
                  </td>
                  <td className="py-1.5">
                    {l.tier === "premium"
                      ? <Badge className="text-[10px] h-4 px-1 bg-purple-100 text-purple-800 border-purple-200">Prm</Badge>
                      : <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">Std</Badge>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(l.quoted_price)}</td>
                  <td className="py-1.5">
                    {l.quote_status === "fresh" && <Badge className="text-[10px] h-4 px-1 bg-emerald-100 text-emerald-800 border-emerald-200">fresh</Badge>}
                    {l.quote_status === "data_gap" && <Badge className="text-[10px] h-4 px-1 bg-amber-100 text-amber-800 border-amber-200">gap</Badge>}
                    {l.quote_status === "pending_enrichment" && <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">pending</Badge>}
                    {l.quote_status === "stale" && <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">stale</Badge>}
                  </td>
                  <td className="py-1.5 px-1 text-right" onClick={(e) => e.stopPropagation()}>
                    {l.source_url && (
                      <a href={l.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex" title="Open on REA">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// CSV export
// ══════════════════════════════════════════════════════════════════════════
function exportCsv(rows, mode) {
  if (!rows?.length) return;
  const commonCurrent = [
    { key: "current_listings",      label: "Current listings" },
    { key: "current_captured",      label: "Current captured" },
    { key: "current_missed",        label: "Current missed" },
    { key: "current_retention_pct", label: "Current retention %" },
    { key: "current_missed_value",  label: "Current missed $" },
  ];
  const commonSold = [
    { key: "sold_listings",      label: "Sold listings" },
    { key: "sold_captured",      label: "Sold captured" },
    { key: "sold_missed",        label: "Sold missed" },
    { key: "sold_retention_pct", label: "Sold retention %" },
    { key: "sold_missed_value",  label: "Sold missed $" },
  ];
  const commonTail = [
    { key: "projects_in_window", label: "Projects in window" },
    { key: "last_project_date",  label: "Last project" },
    { key: "last_listing_date",  label: "Last listing" },
  ];
  const cols = mode === "agent" ? [
    { key: "agent_rea_id",  label: "REA ID" },
    { key: "agent_name",    label: "Agent" },
    { key: "agency_name",   label: "Agency" },
    ...commonCurrent,
    ...commonSold,
    ...commonTail,
  ] : [
    { key: "agency_pulse_id", label: "Agency UUID" },
    { key: "agency_name",     label: "Agency" },
    { key: "rea_agency_id",   label: "REA ID" },
    { key: "agents_in_agency", label: "Agents" },
    ...commonCurrent,
    ...commonSold,
    ...commonTail,
  ];
  const csv = toCsv(rows, cols);
  const ts = new Date().toISOString().slice(0, 10);
  downloadCsv(csv, `pulse_retention_${mode}_${ts}.csv`);
}
