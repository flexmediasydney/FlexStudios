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
  BookOpen, Info, RefreshCw, Search, ArrowUpRight, ExternalLink,
  AlertTriangle, CheckCircle2, Clock, Database,
} from "lucide-react";
import { cn } from "@/lib/utils";
import EnrichmentBadge from "@/components/marketshare/EnrichmentBadge";
import DataFreshnessCard from "@/components/marketshare/DataFreshnessCard";

// ── Time window helpers ─────────────────────────────────────────────────────

const WINDOWS = [
  { value: "day",     label: "Today",       from: () => startOfDay(new Date()) },
  { value: "week",    label: "This week",   from: () => startOfWeek(new Date()) },
  { value: "month",   label: "This month",  from: () => startOfMonth(new Date()) },
  { value: "quarter", label: "This quarter",from: () => startOfQuarter(new Date()) },
  { value: "ytd",     label: "YTD",         from: () => startOfYear(new Date()) },
  { value: "12m",     label: "12m rolling", from: () => minusMonths(new Date(), 12) },
];

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
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

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === window) || WINDOWS[5];
    return { fromDate: wd.from(), toDate: new Date() };
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

  const { data: topMissed = [], isLoading: topLoading } = useQuery({
    queryKey: ["pulse_missed_top", fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_missed_top_n", {
        p_from: fromIso, p_to: toIso, p_limit: 50,
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
          onSuburbDrill={setSuburbFilter}
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
  onSuburbDrill,
}) {
  const qq = ms?.quote_quality || {};
  const hasPending = (qq.pending_enrichment || 0) > 0;

  // Client-side filter the top-missed table by selected package/tier/status
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
      {/* ── Headline stat cards (clickable) ──────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          icon={Target}
          color="text-emerald-600"
          bg="bg-emerald-50"
          label="Capture rate"
          value={fmtPct(ms?.capture_rate_pct)}
          sub={`${fmtInt(ms?.captured_listings)} of ${fmtInt(ms?.total_listings)} listings`}
          loading={msLoading}
          onClick={onNavigateTab ? (() => onNavigateTab("listings")) : null}
          drillHint="View all listings →"
        />
        <StatCard
          icon={DollarSign}
          color="text-amber-600"
          bg="bg-amber-50"
          label="Missed opportunity"
          value={fmtMoney(ms?.missed_opportunity_value)}
          sub={hasPending ? `+${fmtMoney((ms?.missed_opportunity_including_pending || 0) - (ms?.missed_opportunity_value || 0))} pending enrichment` : null}
          loading={msLoading}
          onClick={scrollToTable}
          drillHint="See top missed ↓"
        />
        <StatCard
          icon={TrendingUp}
          color="text-blue-600"
          bg="bg-blue-50"
          label="Total market value"
          value={fmtMoney(ms?.total_market_value)}
          sub={`Captured ${fmtMoney(ms?.captured_market_value)}`}
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

      {/* ── Top missed table (row + cell drill-throughs) ─────────────── */}
      <Card className="p-3" id="pulse-market-share-top-missed">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <ArrowUpRight className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold">Top missed opportunities</h3>
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
                    <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(row.quoted_price)}</td>
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

function PackageBadge({ name }) {
  if (!name) return <span className="text-muted-foreground">—</span>;
  const colorMap = {
    "Flex Package":        "bg-purple-100 text-purple-800 border-purple-200",
    "Dusk Video Package":  "bg-indigo-100 text-indigo-800 border-indigo-200",
    "Day Video Package":   "bg-blue-100 text-blue-800 border-blue-200",
    "AI Package":          "bg-cyan-100 text-cyan-800 border-cyan-200",
    "Gold Package":        "bg-amber-100 text-amber-800 border-amber-200",
    "Silver Package":      "bg-slate-100 text-slate-700 border-slate-200",
    "UNCLASSIFIABLE":      "bg-gray-100 text-gray-600 border-gray-200",
  };
  return <Badge variant="outline" className={cn("text-[10px] h-4 px-1", colorMap[name] || "")}>{name.replace(" Package", "")}</Badge>;
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
