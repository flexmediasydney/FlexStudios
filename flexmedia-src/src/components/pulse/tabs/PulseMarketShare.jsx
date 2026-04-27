/**
 * PulseMarketShare — Market Share dashboard (Industry Pulse subtab).
 *
 * Reads from the pulse_listing_missed_opportunity substrate via 4 RPCs:
 *   • pulse_get_market_share(from, to, suburb)       — headline aggregation
 *   • pulse_get_missed_top_n(from, to, limit)        — top-N drill table
 *   • pulse_get_quote_source_mix(from, to)           — Legend cascade counters
 *   • pulse_get_agent_retention (used elsewhere for ClientRetention)
 *
 * Surfaces:
 *   • Capture rate %        (we did the project / total listings in window)
 *   • Missed opportunity $  (what we would have charged)
 *   • Total market value    (sum of asking_price across window)
 *   • By package / by tier  (breakdowns)
 *   • Top 50 missed         (drill-through table)
 *   • Legend subtab         (rules engine explanation + live source mix)
 *
 * Time windows: daily, weekly, monthly, quarterly, YTD, 12-month rolling.
 */
import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TrendingUp, DollarSign, Target, Package as PkgIcon, Award,
  BookOpen, RefreshCw, Search, ArrowUpRight, ExternalLink,
  AlertTriangle, CheckCircle2, Clock, Database, Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EnrichmentBadge from "@/components/marketshare/EnrichmentBadge";
import DataFreshnessCard from "@/components/marketshare/DataFreshnessCard";
import { useActivePackages } from "@/hooks/useActivePackages";

// ── Time window helpers ─────────────────────────────────────────────────────

// Each window is a half-open interval [from, to). `to` defaults to startOfTomorrow
// (not `new Date()`) so TODAY is fully included on the sold dimension — the
// RPC's sold_date filter uses `AT TIME ZONE 'Australia/Sydney'::date` and
// exclusive upper bound, so `to = now` would silently drop today's rows.
// Yesterday is an explicit closed-ish window [yesterday 00:00, today 00:00).
const WINDOWS = [
  { value: "day",       label: "Today",        from: () => startOfDay(new Date()),             to: () => startOfTomorrow() },
  { value: "yesterday", label: "Yesterday",    from: () => startOfYesterday(),                 to: () => startOfDay(new Date()) },
  { value: "week",      label: "This week",    from: () => startOfWeek(new Date()),            to: () => startOfTomorrow() },
  { value: "month",     label: "This month",   from: () => startOfMonth(new Date()),           to: () => startOfTomorrow() },
  { value: "quarter",   label: "This quarter", from: () => startOfQuarter(new Date()),         to: () => startOfTomorrow() },
  { value: "ytd",       label: "YTD",          from: () => startOfYear(new Date()),            to: () => startOfTomorrow() },
  { value: "12m",       label: "12m rolling",  from: () => minusMonths(new Date(), 12),        to: () => startOfTomorrow() },
];

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfYesterday() { const x = startOfDay(new Date()); x.setDate(x.getDate() - 1); return x; }
function startOfTomorrow() { const x = startOfDay(new Date()); x.setDate(x.getDate() + 1); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = x.getDay(); x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1)); return x; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfQuarter(d) { return new Date(d.getFullYear(), Math.floor(d.getMonth()/3)*3, 1); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function minusMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() - n); return x; }

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtMoney(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtInt(v) { if (v == null) return "—"; return Number(v).toLocaleString(); }
function fmtPct(v) { if (v == null) return "—"; return `${Number(v).toFixed(2)}%`; }

// ── Main ────────────────────────────────────────────────────────────────────

export default function PulseMarketShare({ onOpenEntity, onNavigateTab }) {
  const [window, setWindow] = useState("12m");
  const [view, setView] = useState("dashboard"); // "dashboard" | "legend"
  const [suburbFilter, setSuburbFilter] = useState("");
  // QoL drill-throughs: filter top-missed table by package / tier / quote_status
  // clicked from the breakdowns + stat cards above it.
  const [packageFilter, setPackageFilter] = useState(null);
  const [tierFilter, setTierFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  // Legacy import visibility — toggle the Top Missed table between
  // "only uncaptured by any source" (default) and "all listings" (audit mode).
  const [captureVisibility, setCaptureVisibility] = useState("uncaptured"); // "uncaptured" | "all"

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === window) || WINDOWS[WINDOWS.length - 1];
    return {
      fromDate: wd.from(),
      toDate: typeof wd.to === 'function' ? wd.to() : new Date(),
    };
  }, [window]);

  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  // ── RPC queries ────────────────────────────────────────────────────────
  const { data: marketShare, isLoading: msLoading, refetch: refetchMS } = useQuery({
    queryKey: ["pulse_market_share", fromIso, toIso, suburbFilter || null],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_market_share", {
        p_from: fromIso, p_to: toIso, p_suburb: suburbFilter || null,
      });
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });

  // Dimension toggle: Current (for_sale) vs Sold. Mirrors Retention tab's
  // dual-dimension model. The RPC's top-level fields still reflect "current"
  // for back-compat, but the UI now lets users flip into the Sold dimension
  // via `ms.current` / `ms.sold` sub-objects + the p_dimension arg on the
  // top-missed RPC.
  const [dimension, setDimension] = useState("current"); // "current" | "sold"
  const { data: topMissed = [], isLoading: topLoading } = useQuery({
    queryKey: ["pulse_missed_top", fromIso, toIso, dimension],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_missed_top_n", {
        p_from: fromIso, p_to: toIso, p_limit: 50, p_dimension: dimension,
      });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
    enabled: view === "dashboard",
  });

  const { data: sourceMix, isLoading: mixLoading } = useQuery({
    queryKey: ["pulse_source_mix", fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_quote_source_mix", {
        p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
    enabled: view === "legend",
  });

  const ms = marketShare || {};

  return (
    <div className="space-y-4">
      {/* ── Header: window + view toggle + refresh ─────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindow(w.value)}
              className={cn(
                "text-xs px-2.5 py-1 rounded transition-colors",
                window === w.value
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={suburbFilter}
              onChange={(e) => setSuburbFilter(e.target.value)}
              placeholder="Filter suburb"
              className="h-8 text-xs w-40 pl-7"
            />
          </div>
          <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => refetchMS()}>
            <RefreshCw className={cn("h-3.5 w-3.5", msLoading && "animate-spin")} />
          </Button>
          <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
            <button
              onClick={() => setView("dashboard")}
              className={cn(
                "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
                view === "dashboard" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >
              <TrendingUp className="h-3 w-3" />Dashboard
            </button>
            <button
              onClick={() => setView("legend")}
              className={cn(
                "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
                view === "legend" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >
              <BookOpen className="h-3 w-3" />Legend
            </button>
          </div>
        </div>
      </div>

      {/* Data freshness — always visible at top of dashboard so users know
          what % of the numbers below are from enriched listings vs scrape-
          only rows. Compact variant inline under the control bar. */}
      <DataFreshnessCard compact className="px-1" />

      {view === "dashboard" ? (
        <DashboardView
          ms={ms}
          topMissed={topMissed}
          topLoading={topLoading}
          msLoading={msLoading}
          onOpenEntity={onOpenEntity}
          onNavigateTab={onNavigateTab}
          packageFilter={packageFilter}
          setPackageFilter={setPackageFilter}
          tierFilter={tierFilter}
          setTierFilter={setTierFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          captureVisibility={captureVisibility}
          setCaptureVisibility={setCaptureVisibility}
          onSuburbDrill={setSuburbFilter}
          dimension={dimension}
          setDimension={setDimension}
        />
      ) : (
        <LegendView sourceMix={sourceMix} mixLoading={mixLoading} ms={ms} />
      )}
    </div>
  );
}

// ── Dashboard view ──────────────────────────────────────────────────────────

function DashboardView({
  ms, topMissed, topLoading, msLoading,
  onOpenEntity, onNavigateTab,
  packageFilter, setPackageFilter,
  tierFilter, setTierFilter,
  statusFilter, setStatusFilter,
  captureVisibility, setCaptureVisibility,
  onSuburbDrill,
  dimension, setDimension,
}) {
  const qq = ms?.quote_quality || {};
  const hasPending = (qq.pending_enrichment || 0) > 0;

  // Dual-dimension data from migration 190. Back-compat fields at top level
  // still mirror "current" so older callers keep working.
  const cur  = ms?.current || {};
  const sold = ms?.sold || {};
  const isCurrent = dimension === "current";

  // Select the active dimension's numbers for the headline row.
  const dim = isCurrent ? cur : sold;
  const capturedActive  = Number(dim?.captured_active ?? ms?.captured_listings_active ?? 0);
  const capturedLegacy  = Number(dim?.captured_legacy ?? ms?.captured_listings_legacy ?? 0);
  const capturedTotal   = Number(dim?.captured_listings ?? ms?.captured_listings_total ?? ms?.captured_listings ?? 0);
  const legacyOnly      = Math.max(0, capturedTotal - capturedActive);
  const totalListings   = Number(dim?.total_listings ?? ms?.total_listings ?? 0);
  const captureRatePct  = Number(dim?.capture_rate_pct ?? ms?.capture_rate_pct ?? 0);
  const missedVal       = Number(isCurrent
    ? (dim?.missed_opportunity_value ?? ms?.missed_opportunity_value ?? 0)
    : (sold?.missed_sold_value ?? 0));
  const totalMarketVal  = isCurrent
    ? Number(dim?.total_market_value ?? ms?.total_market_value ?? 0)
    : Number(sold?.total_sold_value ?? 0);
  const capturedMarketVal = isCurrent
    ? Number(dim?.captured_market_value ?? ms?.captured_market_value ?? 0)
    : Number(sold?.captured_sold_value ?? 0);

  // Client-side filter the top-missed table by selected package/tier/status.
  // When captureVisibility === 'uncaptured' (default) we still show the RPC's
  // top-missed set; when 'all' we display them plus a label noting that the
  // RPC payload is uncaptured-only (flip to the Listings tab for everything).
  const filteredTopMissed = useMemo(() => {
    return (topMissed || []).filter((row) => {
      if (packageFilter && row.classified_package_name !== packageFilter) return false;
      if (tierFilter && row.resolved_tier !== tierFilter) return false;
      // Top-missed rows all come from fresh/data_gap (RPC excludes pending),
      // so statusFilter only subdivides those.
      if (statusFilter === "data_gap" && !row.data_gap_flag) return false;
      return true;
    });
  }, [topMissed, packageFilter, tierFilter, statusFilter]);

  // Scroll-into-view helper for stat cards → top missed table
  const scrollToTable = () => {
    const el = document.getElementById("pulse-market-share-top-missed");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const hasActiveFilter = !!(packageFilter || tierFilter || statusFilter);
  const clearFilters = () => { setPackageFilter(null); setTierFilter(null); setStatusFilter(null); };

  return (
    <div className="space-y-4">
      {/* ── Dimension toggle: Current (for sale) vs Sold ─────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <button
            onClick={() => setDimension("current")}
            className={cn(
              "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
              isCurrent ? "bg-blue-600 text-white font-medium" : "text-muted-foreground hover:bg-muted"
            )}
            title="For-sale listings, first_seen_at in window"
          >
            <ArrowUpRight className="h-3 w-3" />Current (for sale)
          </button>
          <button
            onClick={() => setDimension("sold")}
            className={cn(
              "text-xs px-2.5 py-1 rounded transition-colors flex items-center gap-1",
              !isCurrent ? "bg-purple-600 text-white font-medium" : "text-muted-foreground hover:bg-muted"
            )}
            title="Sold listings, sold_date in window"
          >
            <CheckCircle2 className="h-3 w-3" />Sold
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {isCurrent ? "Active buy-side market — what we're capturing in real time" : "Transacted market — what we shot vs what sold"}
        </span>
      </div>

      {/* ── Dimension comparison strip — shows both at once so users can see the split ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <DimensionCard
          active={isCurrent}
          color="blue"
          onClick={() => setDimension("current")}
          label="Current (for sale)"
          listings={Number(cur.total_listings || 0)}
          captured={Number(cur.captured_listings || 0)}
          capturedActive={Number(cur.captured_active || 0)}
          capturedLegacy={Number(cur.captured_legacy || 0)}
          rate={Number(cur.capture_rate_pct || 0)}
          missedValue={Number(cur.missed_opportunity_value || 0)}
          loading={msLoading}
        />
        <DimensionCard
          active={!isCurrent}
          color="purple"
          onClick={() => setDimension("sold")}
          label="Sold"
          listings={Number(sold.total_listings || 0)}
          captured={Number(sold.captured_listings || 0)}
          capturedActive={Number(sold.captured_active || 0)}
          capturedLegacy={Number(sold.captured_legacy || 0)}
          rate={Number(sold.capture_rate_pct || 0)}
          missedValue={Number(sold.missed_sold_value || 0)}
          loading={msLoading}
          valueLabel="Sold value missed"
        />
      </div>

      {/* ── Focused KPIs for the active dimension ───────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Target}
          color="text-emerald-600"
          bg="bg-emerald-50"
          label={`Capture rate · ${isCurrent ? "Current" : "Sold"}`}
          value={fmtPct(captureRatePct)}
          sub={capturedLegacy > 0
            ? `${fmtInt(capturedActive)} active · ${fmtInt(capturedLegacy)} legacy of ${fmtInt(totalListings)}`
            : `${fmtInt(capturedTotal)} of ${fmtInt(totalListings)} listings`}
          loading={msLoading}
          onClick={onNavigateTab ? (() => onNavigateTab("listings")) : null}
          drillHint="View all listings →"
        />
        <StatCard
          icon={Archive}
          color="text-slate-600"
          bg="bg-slate-100"
          label="Legacy-only captures"
          value={fmtInt(legacyOnly)}
          sub={legacyOnly > 0
            ? "Historical projects (pre-CRM) matched by address — imported from Pipedrive / other sources."
            : "No legacy projects matched in this window."}
          loading={msLoading}
        />
        <StatCard
          icon={DollarSign}
          color="text-amber-600"
          bg="bg-amber-50"
          label={isCurrent ? "Missed opportunity" : "Sold value missed"}
          value={fmtMoney(missedVal)}
          sub={isCurrent && hasPending
            ? `+${fmtMoney((ms?.missed_opportunity_including_pending || 0) - (ms?.missed_opportunity_value || 0))} pending enrichment`
            : (!isCurrent ? "Sum of sold_price for listings we didn't shoot" : null)}
          loading={msLoading}
          onClick={scrollToTable}
          drillHint="See top missed ↓"
        />
        <StatCard
          icon={TrendingUp}
          color="text-blue-600"
          bg="bg-blue-50"
          label={isCurrent ? "Total market value" : "Total sold value"}
          value={fmtMoney(totalMarketVal)}
          sub={`Captured ${fmtMoney(capturedMarketVal)}`}
          loading={msLoading}
        />
      </div>

      {/* ── Quote quality strip (clickable segments) ─────────────────── */}
      <QuoteQualityStrip
        qq={qq}
        total={ms?.total_listings}
        statusFilter={statusFilter}
        onSelectStatus={(s) => { setStatusFilter(s === statusFilter ? null : s); scrollToTable(); }}
      />

      {/* ── Breakdowns: by_package + by_tier (clickable rows) ────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Breakdown
          title="By package"
          icon={PkgIcon}
          rows={ms?.by_package || []}
          valueKey="value" countKey="listings" labelKey="package"
          activeValue={packageFilter}
          onSelect={(val) => { setPackageFilter(val === packageFilter ? null : val); scrollToTable(); }}
        />
        <Breakdown
          title="By tier"
          icon={Award}
          rows={ms?.by_tier || []}
          valueKey="value" countKey="listings" labelKey="tier"
          activeValue={tierFilter}
          onSelect={(val) => { setTierFilter(val === tierFilter ? null : val); scrollToTable(); }}
        />
      </div>

      {/* ── By capture source (active vs legacy vs missed) ──────────── */}
      <CaptureSourceBreakdown
        ms={ms}
        capturedActive={capturedActive}
        capturedLegacy={capturedLegacy}
        breakdownRows={ms?.captured_by_source_breakdown}
      />

      {/* ── Link to the "what-if" legacy comparison report ──────────── */}
      <Card className="p-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-md bg-slate-100 flex items-center justify-center flex-shrink-0">
          <Archive className="h-4 w-4 text-slate-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Legacy market share "what-if" view</div>
          <div className="text-[11px] text-muted-foreground">
            Side-by-side diff: active-only vs active+legacy. Surfaces past relationships worth re-engaging.
          </div>
        </div>
        <a href="/Reports/LegacyMarketShare"
           className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted">
          Open report <ArrowUpRight className="h-3 w-3" />
        </a>
      </Card>

      {/* ── Top missed table (row + cell drill-throughs) ─────────────── */}
      <Card className="p-3" id="pulse-market-share-top-missed">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <ArrowUpRight className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold">
            Top missed opportunities
            <Badge className={cn(
              "ml-2 text-[10px] h-4 px-1",
              isCurrent ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-purple-100 text-purple-800 border-purple-200"
            )}>
              {isCurrent ? "Current" : "Sold"}
            </Badge>
          </h3>
          <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-[10px]"
               title="Top missed shows uncaptured-only by default. Flip to include rows now captured by legacy imports for audit.">
            <button
              onClick={() => setCaptureVisibility && setCaptureVisibility("uncaptured")}
              className={cn(
                "px-1.5 py-0.5 rounded",
                captureVisibility === "uncaptured" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              )}
            >Not captured</button>
            <button
              onClick={() => setCaptureVisibility && setCaptureVisibility("all")}
              className={cn(
                "px-1.5 py-0.5 rounded",
                captureVisibility === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              )}
            >All listings</button>
          </div>
          {hasActiveFilter && (
            <div className="flex items-center gap-1 flex-wrap">
              {packageFilter && (
                <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 border-amber-200 gap-0.5 cursor-pointer" onClick={() => setPackageFilter(null)}>
                  pkg: {packageFilter.replace(" Package","")} ×
                </Badge>
              )}
              {tierFilter && (
                <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 border-amber-200 gap-0.5 cursor-pointer" onClick={() => setTierFilter(null)}>
                  tier: {tierFilter} ×
                </Badge>
              )}
              {statusFilter && (
                <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 border-amber-200 gap-0.5 cursor-pointer" onClick={() => setStatusFilter(null)}>
                  status: {statusFilter} ×
                </Badge>
              )}
              <button className="text-[11px] text-muted-foreground hover:text-foreground underline" onClick={clearFilters}>clear all</button>
            </div>
          )}
          <Badge variant="secondary" className="ml-auto text-xs">{filteredTopMissed.length} of {topMissed.length} listings</Badge>
        </div>
        {topLoading ? (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading…</div>
        ) : filteredTopMissed.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {hasActiveFilter ? "No listings match the active filters" : "No missed opportunities in this window"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1.5 font-medium px-2">#</th>
                  <th className="text-center py-1.5 font-medium" title="Enrichment status — fresh / pending / stale">Data</th>
                  <th className="text-left py-1.5 font-medium">Address</th>
                  <th className="text-left py-1.5 font-medium">Suburb</th>
                  <th className="text-left py-1.5 font-medium">Package</th>
                  <th className="text-left py-1.5 font-medium">Tier</th>
                  <th className="text-right py-1.5 font-medium">Photos</th>
                  <th className="text-right py-1.5 font-medium">Quote</th>
                  <th className="text-left py-1.5 font-medium">Agent / Agency</th>
                  <th className="text-right py-1.5 font-medium px-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {filteredTopMissed.map((row, i) => (
                  <tr
                    key={row.listing_id}
                    className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: row.listing_id })}
                    title="Click to open listing slideout"
                  >
                    <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                      <EnrichmentBadge listing={{ detail_enriched_at: row.detail_enriched_at }} compact />
                    </td>
                    <td className="py-1.5 truncate max-w-[220px] font-medium hover:underline" title={row.address}>{row.address || "—"}</td>
                    <td className="py-1.5 text-muted-foreground">
                      {row.suburb ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onSuburbDrill && onSuburbDrill(row.suburb); }}
                          className="hover:text-foreground hover:underline"
                          title={`Filter by suburb: ${row.suburb}`}
                        >{row.suburb}</button>
                      ) : "—"}
                    </td>
                    <td className="py-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); setPackageFilter(row.classified_package_name); }}
                        title={`Filter by package: ${row.classified_package_name}`}
                      ><PackageBadge name={row.classified_package_name} /></button>
                    </td>
                    <td className="py-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); setTierFilter(row.resolved_tier); }}
                        title={`Filter by tier: ${row.resolved_tier}`}
                      ><TierBadge tier={row.resolved_tier} /></button>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{row.photo_count ?? "—"}</td>
                    {/* In "current" dimension: quoted_price; in "sold": sold_price (actual transacted amount we missed). */}
                    <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">
                      {isCurrent
                        ? fmtMoney(row.quoted_price)
                        : (row.sold_price != null ? fmtMoney(row.sold_price) : "—")}
                    </td>
                    <td className="py-1.5 truncate max-w-[220px]">
                      {row.agent_pulse_id && onOpenEntity ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onOpenEntity({ type: "agent", id: row.agent_pulse_id }); }}
                          className="hover:underline font-medium"
                          title="Open agent slideout"
                        >{row.agent_name || "—"}</button>
                      ) : (
                        <span className="font-medium">{row.agent_name || "—"}</span>
                      )}
                      {row.agency_name && (
                        row.agency_pulse_id && onOpenEntity ? (
                          <>{" · "}
                            <button
                              onClick={(e) => { e.stopPropagation(); onOpenEntity({ type: "agency", id: row.agency_pulse_id }); }}
                              className="text-muted-foreground hover:text-foreground hover:underline"
                              title="Open agency slideout"
                            >{row.agency_name}</button>
                          </>
                        ) : (
                          <span className="text-muted-foreground"> · {row.agency_name}</span>
                        )
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {row.source_url ? (
                        <a href={row.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5" title="Open on REA">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Supporting subcomponents ────────────────────────────────────────────────

// ── Dimension card — compact side-by-side comparison (Current vs Sold) ─
// Click to swap the active dimension. Shows the 4 key numbers per side so
// users can contrast them at a glance without toggling.
function DimensionCard({ active, color, label, listings, captured, capturedActive, capturedLegacy, rate, missedValue, loading, onClick, valueLabel }) {
  const palette = {
    blue:   { bar: "bg-blue-500",   ring: "ring-blue-500",   text: "text-blue-700",   bg: "bg-blue-50" },
    purple: { bar: "bg-purple-500", ring: "ring-purple-500", text: "text-purple-700", bg: "bg-purple-50" },
  }[color] || { bar: "bg-slate-500", ring: "ring-slate-400", text: "text-slate-700", bg: "bg-slate-50" };
  const missedListings = Math.max(0, listings - captured);
  const capturedPct = listings > 0 ? (100 * captured / listings) : 0;
  return (
    <Card
      className={cn(
        "p-3 cursor-pointer transition-all",
        active ? `ring-2 ${palette.ring} shadow-sm` : "hover:shadow-md",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn("text-xs font-semibold", palette.text)}>{label}</span>
        {active && <Badge variant="secondary" className="text-[9px] h-4 ml-auto">Active</Badge>}
      </div>
      <div className="grid grid-cols-4 gap-2 mb-2">
        <MiniStat label="Listings" value={loading ? "…" : fmtInt(listings)} />
        <MiniStat label="Captured" value={loading ? "…" : fmtInt(captured)} color="text-emerald-700" />
        <MiniStat label="Rate" value={loading ? "…" : `${rate.toFixed(2)}%`} />
        <MiniStat label={valueLabel || "Missed $"} value={loading ? "…" : fmtMoney(missedValue)} color="text-amber-700" />
      </div>
      {/* Captured split bar (active vs legacy) */}
      {listings > 0 && (
        <div>
          <div className="h-1.5 rounded bg-muted overflow-hidden flex">
            <div className="bg-emerald-500" style={{ width: `${(100 * capturedActive / listings).toFixed(2)}%` }} title={`Active ${capturedActive}`} />
            <div className="bg-slate-400"   style={{ width: `${(100 * capturedLegacy / listings).toFixed(2)}%` }} title={`Legacy ${capturedLegacy}`} />
            <div className="bg-amber-400"   style={{ width: `${(100 * missedListings / listings).toFixed(2)}%` }} title={`Missed ${missedListings}`} />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
            <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />active {capturedActive}</span>
            <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />legacy {capturedLegacy}</span>
            <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />missed {missedListings}</span>
            <span className="ml-auto tabular-nums">{capturedPct.toFixed(2)}% captured</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums truncate", color)}>{value}</div>
    </div>
  );
}

function StatCard({ icon: Icon, color, bg, label, value, sub, loading, onClick, drillHint }) {
  const clickable = !!onClick;
  return (
    <Card
      className={cn("p-3", clickable && "cursor-pointer hover:shadow-md transition-shadow")}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-start gap-3">
        <div className={cn("w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0", bg)}>
          <Icon className={cn("h-4 w-4", color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            {label}
            {clickable && drillHint && <span className="text-[10px] text-muted-foreground/70">· {drillHint}</span>}
          </div>
          <div className={cn("text-xl font-semibold tabular-nums", loading && "opacity-50")}>
            {loading ? "…" : value}
          </div>
          {sub && <div className="text-[11px] text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

function QuoteQualityStrip({ qq, total, statusFilter, onSelectStatus }) {
  const fresh = qq.fresh || 0;
  const dataGap = qq.data_gap || 0;
  const pending = qq.pending_enrichment || 0;
  const t = Math.max(total || 0, fresh + dataGap + pending, 1);
  const chipClass = (key) =>
    cn(
      "flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer transition-colors",
      statusFilter === key ? "bg-muted font-medium" : "hover:bg-muted/60"
    );
  return (
    <Card className="p-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Quote quality</span>
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">{fmtInt(total)} total · click a chip to filter the table ↓</span>
      </div>
      <div className="flex h-2 rounded overflow-hidden bg-muted">
        <div className="bg-emerald-400 cursor-pointer" style={{ width: `${(fresh/t)*100}%` }} title={`Fresh: ${fresh}`} onClick={() => onSelectStatus && onSelectStatus("fresh")} />
        <div className="bg-amber-400 cursor-pointer" style={{ width: `${(dataGap/t)*100}%` }} title={`Data gap: ${dataGap}`} onClick={() => onSelectStatus && onSelectStatus("data_gap")} />
        <div className="bg-slate-300 cursor-pointer" style={{ width: `${(pending/t)*100}%` }} title={`Pending: ${pending}`} onClick={() => onSelectStatus && onSelectStatus("pending_enrichment")} />
      </div>
      <div className="flex items-center gap-1 mt-1.5 text-[11px]">
        <button className={chipClass("fresh")} onClick={() => onSelectStatus && onSelectStatus("fresh")}>
          <CheckCircle2 className="h-3 w-3 text-emerald-700" /><span className="text-emerald-700">Fresh {fmtInt(fresh)}</span>
        </button>
        <button className={chipClass("data_gap")} onClick={() => onSelectStatus && onSelectStatus("data_gap")}>
          <AlertTriangle className="h-3 w-3 text-amber-700" /><span className="text-amber-700">Data gap {fmtInt(dataGap)}</span>
        </button>
        <button className={chipClass("pending_enrichment")} onClick={() => onSelectStatus && onSelectStatus("pending_enrichment")}>
          <Clock className="h-3 w-3 text-slate-600" /><span className="text-slate-600">Pending {fmtInt(pending)}</span>
        </button>
      </div>
    </Card>
  );
}

function Breakdown({ title, icon: Icon, rows, valueKey, countKey, labelKey, activeValue, onSelect }) {
  const sorted = [...(rows || [])].sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  const maxValue = Math.max(1, ...sorted.map(r => r[valueKey] || 0));
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {onSelect && <span className="text-[10px] text-muted-foreground ml-auto">click row to filter ↓</span>}
      </div>
      {sorted.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No data in window</div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((row, i) => {
            const label = row[labelKey] || "—";
            const isActive = activeValue === label;
            const clickable = !!onSelect;
            return (
              <button
                key={i}
                className={cn(
                  "w-full space-y-0.5 text-left rounded px-1 py-0.5 transition-colors",
                  clickable && "cursor-pointer hover:bg-muted/60",
                  isActive && "bg-amber-50 ring-1 ring-amber-200"
                )}
                onClick={() => onSelect && onSelect(label)}
                disabled={!clickable}
              >
                <div className="flex items-center text-xs gap-2">
                  <span className="font-medium truncate flex-1">{label}</span>
                  <span className="text-muted-foreground tabular-nums">{fmtInt(row[countKey])}</span>
                  <span className="tabular-nums w-16 text-right font-medium">{fmtMoney(row[valueKey])}</span>
                </div>
                <div className="h-1 bg-muted rounded overflow-hidden">
                  <div className={cn("h-full", isActive ? "bg-amber-500" : "bg-amber-400")} style={{ width: `${(row[valueKey]/maxValue)*100}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * CaptureSourceBreakdown — after legacy import lands, visualize how the total
 * market splits between projects captured by the live CRM, captured only via
 * imported legacy projects, and still missed. Consumes `ms.captured_by_source_breakdown`
 * (added by agent 3's RPC extension) with graceful fallback to the top-level
 * counters if the field is missing.
 */
function CaptureSourceBreakdown({ ms, capturedActive, capturedLegacy, breakdownRows }) {
  const total = Number(ms?.total_listings) || 0;
  const missedListings = Math.max(0, total - Number(ms?.captured_listings_total ?? (capturedActive + capturedLegacy)));
  const missedValue    = Number(ms?.missed_opportunity_value) || 0;

  // Prefer the RPC-provided breakdown if present (future-proof — shape may
  // carry more granular breakdown eventually), else synthesize from scalars.
  const rows = Array.isArray(breakdownRows) && breakdownRows.length > 0
    ? breakdownRows
    : [
      { label: "Active captures", count: capturedActive, value: 0,
        tone: "emerald", note: "Listings we quoted or delivered" },
      { label: "Legacy captures", count: capturedLegacy, value: 0,
        tone: "slate", note: "Historical projects matched by address" },
      { label: "Missed",          count: missedListings,  value: missedValue,
        tone: "amber",  note: "Still uncaptured by any source" },
    ];

  const maxN = Math.max(1, ...rows.map(r => Number(r.count) || 0));
  const toneBar = {
    emerald: "bg-emerald-400",
    slate:   "bg-slate-400",
    amber:   "bg-amber-400",
    blue:    "bg-blue-400",
  };
  const toneText = {
    emerald: "text-emerald-700",
    slate:   "text-slate-600",
    amber:   "text-amber-700",
    blue:    "text-blue-700",
  };

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Archive className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">By capture source</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">active vs legacy vs missed — %% of {fmtInt(total)}</span>
      </div>
      <div className="space-y-2">
        {rows.map((row, i) => {
          const count = Number(row.count) || 0;
          const pct = total > 0 ? (100 * count / total) : 0;
          return (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center text-xs gap-2">
                <span className={cn("font-medium flex-1 truncate", toneText[row.tone] || "")}>{row.label}</span>
                <span className="text-muted-foreground tabular-nums">{fmtInt(count)} listings</span>
                <span className="tabular-nums w-16 text-right font-medium">{fmtMoney(row.value)}</span>
                <span className="tabular-nums w-12 text-right text-muted-foreground">{pct.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded overflow-hidden">
                <div className={cn("h-full", toneBar[row.tone] || "bg-primary")} style={{ width: `${(count / maxN) * 100}%` }} />
              </div>
              {row.note && <div className="text-[10px] text-muted-foreground">{row.note}</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// Wave 7 P1-11.b: package badge colors. The set of valid package names comes
// from the live `packages` table via useActivePackages — packages must NEVER
// be hardcoded as an authoritative enum in the frontend (Joseph's
// architectural correction, 2026-04-27). PACKAGE_COLOR_OVERRIDES retains the
// deliberate color choices for the launch packages (Gold→amber, Silver→slate
// etc.); any package present in the live DB but not listed here gets a
// deterministic palette color via name hash so it renders consistently across
// renders + sessions.
const PACKAGE_COLOR_OVERRIDES = {
  "Flex Package":        "bg-purple-100 text-purple-800 border-purple-200",
  "Dusk Video Package":  "bg-indigo-100 text-indigo-800 border-indigo-200",
  "Day Video Package":   "bg-blue-100 text-blue-800 border-blue-200",
  "AI Package":          "bg-cyan-100 text-cyan-800 border-cyan-200",
  "Gold Package":        "bg-amber-100 text-amber-800 border-amber-200",
  "Silver Package":      "bg-slate-100 text-slate-700 border-slate-200",
};
const PACKAGE_PALETTE_FALLBACK = [
  "bg-rose-100 text-rose-800 border-rose-200",
  "bg-emerald-100 text-emerald-800 border-emerald-200",
  "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  "bg-teal-100 text-teal-800 border-teal-200",
];
const UNCLASSIFIABLE_BADGE_CLASS = "bg-gray-100 text-gray-600 border-gray-200";

function packageBadgeClass(name) {
  if (PACKAGE_COLOR_OVERRIDES[name]) return PACKAGE_COLOR_OVERRIDES[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PACKAGE_PALETTE_FALLBACK[Math.abs(h) % PACKAGE_PALETTE_FALLBACK.length];
}

function PackageBadge({ name }) {
  // Wave 7 P1-11.b: subscribe to live packages so the badge participates in
  // the dynamic-packages architecture — when a name is unknown to the live
  // catalog (legacy/renamed package surfaced from the engine substrate) we
  // tag it visually so ops can spot drift. Active live packages render with
  // their override color or a deterministic palette color.
  const { names: livePackageNames } = useActivePackages();
  if (!name) return <span className="text-muted-foreground">—</span>;
  if (name === "UNCLASSIFIABLE") {
    return <Badge variant="outline" className={cn("text-[10px] h-4 px-1", UNCLASSIFIABLE_BADGE_CLASS)}>{name}</Badge>;
  }
  const isLegacy = livePackageNames.length > 0 && !livePackageNames.includes(name);
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] h-4 px-1", packageBadgeClass(name), isLegacy && "border-dashed")}
      title={isLegacy ? `${name} (not in live packages — legacy/renamed)` : undefined}
    >
      {name.replace(" Package", "")}
    </Badge>
  );
}

function TierBadge({ tier }) {
  if (!tier) return <span className="text-muted-foreground">—</span>;
  return tier === "premium"
    ? <Badge className="text-[10px] h-4 px-1 bg-purple-100 text-purple-800 border-purple-200">Prm</Badge>
    : <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">Std</Badge>;
}

// ── Legend view ─────────────────────────────────────────────────────────────

function LegendView({ sourceMix, mixLoading, ms }) {
  const sm = sourceMix || {};
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start gap-3 mb-3">
          <BookOpen className="h-5 w-5 text-primary mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold">How Market Share is calculated</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every active for_sale listing in our region gets a "missed opportunity" quote. The engine classifies the listing
              against our 6 real packages, resolves the tier via cascade, and computes what we would have charged if we'd won
              that listing. Below is every rule in the current model.
            </p>
          </div>
        </div>
      </Card>

      <LegendSection title="1. Classification" icon={PkgIcon}>
        <p className="text-xs text-muted-foreground mb-2">
          Each listing's media counts and asking price are matched against these rules (top-down, first match wins).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1 font-medium">#</th>
                <th className="text-left py-1 font-medium">Package</th>
                <th className="text-left py-1 font-medium">Photos</th>
                <th className="text-left py-1 font-medium">Floorplan</th>
                <th className="text-left py-1 font-medium">Video</th>
                <th className="text-left py-1 font-medium">Other</th>
                <th className="text-left py-1 font-medium">Std $</th>
                <th className="text-left py-1 font-medium">Prm $</th>
              </tr>
            </thead>
            <tbody>
              <LegendRow n="1" pkg="Flex"       photos="≥30" fp="✓" video="✓" other="asking > $8M" std="—"     prm="$4,500" />
              <LegendRow n="2" pkg="Dusk Video" photos="≥26" fp="✓" video="✓" other="—"            std="$2,250" prm="$3,750" />
              <LegendRow n="3" pkg="Day Video"  photos="≥1"  fp="✓" video="✓" other="—"            std="$1,450" prm="$2,750" />
              <LegendRow n="4" pkg="Gold"       photos=">10" fp="✓" video="—" other="—"            std="$550"   prm="$1,100" />
              <LegendRow n="5" pkg="Silver"     photos="≤10" fp="✓" video="—" other="—"            std="$450"   prm="$700" />
              <LegendRow n="6" pkg="UNCLASSIFIABLE" photos="—" fp="—" video="—" other="no floorplan" std="item-sum" prm="item-sum" />
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Overflow photos above package base × Sales Images unit price ($25 std / $50 prm per photo, 5 included).
          UNCLASSIFIABLE → Σ(Sales Images + Floorplan if present + Drone if video present).
        </p>
      </LegendSection>

      <LegendSection title="2. Tier resolution cascade" icon={Award}>
        <ol className="text-xs space-y-1.5">
          <li><b>T1. Agent's price_matrix.default_tier</b> — if set, stop.</li>
          <li><b>T2. Billable entity (agency/org) price_matrix.default_tier</b> — if set, stop. (Resolved via pulse_agency → linked_agency_id → price_matrices.entity_id.)</li>
          <li><b>T3. Proximity inheritance (any-package)</b> — same property → same suburb → radial 2/5/10/20/50km. First project hit's pricing_tier wins.</li>
          <li><b>T4. Default</b> — standard.</li>
        </ol>
        {!mixLoading && sm.tier_source && (
          <div className="mt-3 pt-3 border-t">
            <div className="text-xs font-medium mb-1.5">Live mix (this window):</div>
            <SourceMixList obj={sm.tier_source} />
          </div>
        )}
      </LegendSection>

      <LegendSection title="3. Price resolution cascade" icon={DollarSign}>
        <ol className="text-xs space-y-1.5">
          <li><b>P1. Billable entity price_matrix exists</b> — apply per-package override if any, else blanket discount on global package base at resolved tier, plus overflow photos at matrix's product override / blanket / global rate.</li>
          <li><b>P2. Proximity cascade (interleaved)</b> — each ring (suburb → 2/5/10/20/50km radial) checks for a same-package project first; if found, inherit its calculated_price (discounts baked in). Else inherit tier only and use global package default.</li>
          <li><b>P3. Global default</b> — package base price at resolved tier. Flags as data_gap if no projects nearby.</li>
          <li><b>P4. Item-sum (UNCLASSIFIABLE)</b> — Σ atomic products at resolved tier. Sales Images base + overflow × unit + Floorplan + Drone (if video).</li>
        </ol>
        {!mixLoading && sm.pricing_method && (
          <div className="mt-3 pt-3 border-t">
            <div className="text-xs font-medium mb-1.5">Live mix (this window):</div>
            <SourceMixList obj={sm.pricing_method} />
          </div>
        )}
      </LegendSection>

      <LegendSection title="4. Edge cases &amp; caveats" icon={AlertTriangle}>
        <ul className="text-xs space-y-1.5">
          <li><b>Auction / "Contact Agent" listings</b> — no numeric price parseable → Flex $8M gate fails → falls to Dusk Video or lower.</li>
          <li><b>"Address available on request"</b> — property_key unreliable → same-property ring skipped; proximity still works via lat/lon when present.</li>
          <li><b>REA photo cap of 34</b> — every listing with 34 photos may actually have more. A <code>photos_capped_at_34</code> flag is stored for audit.</li>
          <li><b>Enrichment dependency</b> — listings without <code>detail_enriched_at</code> show <code>quote_status = pending_enrichment</code> and are excluded from the headline missed-$ total until enriched (pulse-detail-enrich runs every 5 min).</li>
          <li><b>Data gaps</b> — listings hitting ring 9 (no project within 50km) are flagged <code>data_gap = true</code>. Concentration in one region signals we need more nearby work.</li>
        </ul>
      </LegendSection>

      <LegendSection title="5. Qualifying project statuses" icon={CheckCircle2}>
        <p className="text-xs text-muted-foreground mb-2">
          The proximity cascade only inherits from projects where status is one of:
        </p>
        <div className="flex gap-1.5 flex-wrap">
          <Badge variant="outline" className="text-[11px]">delivered</Badge>
          <Badge variant="outline" className="text-[11px]">scheduled</Badge>
          <Badge variant="outline" className="text-[11px]">ready_for_partial</Badge>
          <Badge variant="outline" className="text-[11px]">to_be_scheduled</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">Leads (<code>goal_not_started</code>, <code>goal_active</code>) are excluded — we haven't committed to them yet.</p>
      </LegendSection>

      <LegendSection title="6. Quote freshness" icon={Clock}>
        <ul className="text-xs space-y-1.5">
          <li><b>fresh</b> — computed from current enrichment; inputs match. Counted in headline $.</li>
          <li><b>data_gap</b> — no nearby projects found. Still counted in $, flagged visually.</li>
          <li><b>pending_enrichment</b> — listing not yet enriched. Excluded from headline $ until enriched.</li>
          <li><b>stale</b> — media/price changed since last compute. Next cron tick re-computes.</li>
        </ul>
        <p className="text-[11px] text-muted-foreground mt-2">Compute worker runs every 10 min, 500 listings per tick. Mark-stale trigger on pulse_listings auto-flags changes.</p>
      </LegendSection>

      <LegendSection title="7. Legacy projects (historical imports)" icon={Archive}>
        <p className="text-xs text-muted-foreground mb-2">
          Historical project data (pre-CRM era) is imported from external sources into the
          <code className="px-1">legacy_projects</code> table and participates in the "captured"
          predicate alongside live <code>projects</code> rows. Match key is <code>property_key</code>
          (address normalized). This lets Market Share credit us for work the current CRM has
          no record of.
        </p>
        <ul className="text-xs space-y-1.5">
          <li><b>Sources</b> — Pipedrive deals archive is the primary feeder. Other one-shot imports
            (CSV uploads of legacy Base44 jobs, manual retro-entries) land in the same table tagged by <code>source</code>.</li>
          <li><b>Date range</b> — whatever the import carries. Projects without a <code>completed_date</code>
            still match by address but do not contribute to time-windowed reports.</li>
          <li><b>captured_by</b> — each listing is tagged <code>active</code>, <code>legacy</code>, <code>both</code>, or <code>null</code>
            (not captured). The headline capture rate counts all four as captured except <code>null</code>.</li>
          <li><b>Recompute</b> — after a large import, admins can trigger
            <code className="px-1">pulseRecomputeLegacy</code> from Settings → Legacy Import to propagate
            the new captured status to already-computed substrate rows. A nightly cron
            (<code>pulse-legacy-recompute</code>) mops up any drift.</li>
          <li><b>"Only-captured-by-legacy"</b> agents/agencies surface on <code>/Reports/LegacyMarketShare</code>
            — these are past relationships worth re-engaging.</li>
        </ul>
      </LegendSection>
    </div>
  );
}

function LegendSection({ title, icon: Icon, children }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </Card>
  );
}

function LegendRow({ n, pkg, photos, fp, video, other, std, prm }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-1 text-muted-foreground">{n}</td>
      <td className="py-1 font-medium">{pkg}</td>
      <td className="py-1 tabular-nums">{photos}</td>
      <td className="py-1">{fp}</td>
      <td className="py-1">{video}</td>
      <td className="py-1 text-muted-foreground">{other}</td>
      <td className="py-1 tabular-nums">{std}</td>
      <td className="py-1 tabular-nums">{prm}</td>
    </tr>
  );
}

function SourceMixList({ obj }) {
  const total = Object.values(obj).reduce((a, b) => a + (b || 0), 0) || 1;
  const rows = Object.entries(obj).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return (
    <div className="space-y-1">
      {rows.map(([key, n]) => (
        <div key={key} className="flex items-center gap-2 text-[11px]">
          <code className="text-muted-foreground min-w-[180px]">{key}</code>
          <div className="flex-1 h-1 bg-muted rounded overflow-hidden">
            <div className="h-full bg-primary/70" style={{ width: `${(n/total)*100}%` }} />
          </div>
          <span className="tabular-nums w-10 text-right">{n.toLocaleString()}</span>
          <span className="text-muted-foreground w-10 text-right">{((n/total)*100).toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}
