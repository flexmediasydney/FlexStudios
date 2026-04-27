/**
 * AgencyMarketShareSection — Agency-level Market Share + Retention panel.
 *
 * Used in two surfaces:
 *   • OrgDetails.jsx → Market Share tab (full layout, compact=false)
 *   • PulseAgencyIntel.jsx → AgencySlideout → Market Share card (compact)
 *
 * Pulls live data from three agency RPCs (added in mig 167):
 *   • pulse_get_agency_retention
 *   • pulse_get_agency_retention_monthly
 *   • pulse_get_agency_growth_headroom
 *
 * Props:
 *   agencyPulseId  - uuid of the pulse_agencies row for this org
 *   onOpenEntity   - (optional) fn({type, id}) — drill into agent/listing slideouts
 *   compact        - compact mode shows 5-stat row + top 3 agents + top 3 missed
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Target, DollarSign, TrendingUp, Users, Award,
  Package as PkgIcon, ArrowUpRight, ExternalLink, Sparkles,
  BarChart3, RefreshCw, AlertTriangle,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { cn } from "@/lib/utils";
import QuoteProvenance from "@/components/marketshare/QuoteProvenance";
import { useActivePackages } from "@/hooks/useActivePackages";

// ── Time windows (mirror PulseMarketShare) ─────────────────────────────────

const WINDOWS = [
  { value: "day",     label: "Today",        from: () => startOfDay(new Date()) },
  { value: "week",    label: "This week",    from: () => startOfWeek(new Date()) },
  { value: "month",   label: "This month",   from: () => startOfMonth(new Date()) },
  { value: "quarter", label: "This quarter", from: () => startOfQuarter(new Date()) },
  { value: "ytd",     label: "YTD",          from: () => startOfYear(new Date()) },
  { value: "12m",     label: "12m rolling",  from: () => minusMonths(new Date(), 12) },
];

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = x.getDay(); x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1)); return x; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfQuarter(d) { return new Date(d.getFullYear(), Math.floor(d.getMonth()/3)*3, 1); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function minusMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() - n); return x; }

// ── Formatters ─────────────────────────────────────────────────────────────

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
function fmtMonth(d) { if (!d) return ""; const dt = new Date(d); return dt.toLocaleString("en-AU", { month: "short", year: "2-digit" }); }

// ── Main ───────────────────────────────────────────────────────────────────

export default function AgencyMarketShareSection({
  agencyPulseId,
  onOpenEntity,
  compact = false,
}) {
  const [windowSel, setWindowSel] = useState(compact ? "12m" : "12m");

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === windowSel) || WINDOWS[5];
    return { fromDate: wd.from(), toDate: new Date() };
  }, [windowSel]);
  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  const enabled = !!agencyPulseId;

  // ── RPCs ───────────────────────────────────────────────────────────────
  const { data: retention, isLoading: rLoading, refetch } = useQuery({
    queryKey: ["pulse_agency_retention", agencyPulseId, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_agency_retention", {
        p_agency_pulse_id: agencyPulseId, p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data;
    },
    enabled,
    staleTime: 60_000,
  });

  const { data: monthly = [], isLoading: mLoading } = useQuery({
    queryKey: ["pulse_agency_retention_monthly", agencyPulseId, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_agency_retention_monthly", {
        p_agency_pulse_id: agencyPulseId, p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data || [];
    },
    enabled: enabled && !compact,
    staleTime: 60_000,
  });

  const { data: headroom } = useQuery({
    queryKey: ["pulse_agency_headroom", agencyPulseId, fromIso, toIso, 50],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_agency_growth_headroom", {
        p_agency_pulse_id: agencyPulseId, p_from: fromIso, p_to: toIso, p_target_capture_pct: 50,
      });
      if (error) throw error;
      return data;
    },
    enabled,
    staleTime: 60_000,
  });

  const r = retention || {};
  const totalListings = Number(r.total_listings || 0);
  const isEmpty = !rLoading && totalListings === 0;

  // ── Shared chunks ──────────────────────────────────────────────────────
  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
        {WINDOWS.map((w) => (
          <button
            key={w.value}
            onClick={() => setWindowSel(w.value)}
            className={cn(
              "text-xs px-2 py-0.5 rounded transition-colors",
              windowSel === w.value
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            {w.label}
          </button>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="h-7 gap-1 ml-auto" onClick={() => refetch()}>
        <RefreshCw className={cn("h-3.5 w-3.5", rLoading && "animate-spin")} />
      </Button>
    </div>
  );

  if (!enabled) {
    return (
      <div className="text-xs text-muted-foreground p-3 bg-muted/30 rounded border border-dashed">
        This organisation isn't linked to a pulse_agencies record — Market Share intelligence requires a REA-linked agency.
      </div>
    );
  }

  const statRow = (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
      <StatMini
        icon={BarChart3}
        label="Listings"
        value={fmtInt(r.total_listings)}
        loading={rLoading}
      />
      <StatMini
        icon={Target}
        color="text-emerald-600"
        bg="bg-emerald-50"
        label="Captured"
        value={fmtInt(r.captured)}
        loading={rLoading}
      />
      <StatMini
        icon={AlertTriangle}
        color="text-amber-600"
        bg="bg-amber-50"
        label="Missed"
        value={fmtInt(r.missed)}
        loading={rLoading}
      />
      <StatMini
        icon={TrendingUp}
        color="text-blue-600"
        bg="bg-blue-50"
        label="Retention %"
        value={fmtPct(r.retention_rate_pct)}
        loading={rLoading}
      />
      <StatMini
        icon={DollarSign}
        color="text-amber-700"
        bg="bg-amber-50"
        label="Missed $"
        value={fmtMoney(r.missed_opportunity_value)}
        loading={rLoading}
        sub={r.missed_opportunity_including_pending && Number(r.missed_opportunity_including_pending) > Number(r.missed_opportunity_value || 0)
          ? `+${fmtMoney(Number(r.missed_opportunity_including_pending) - Number(r.missed_opportunity_value || 0))} pending`
          : null}
      />
    </div>
  );

  const agents = Array.isArray(r.agents) ? r.agents : [];
  const topMissed = Array.isArray(r.top_missed_listings) ? r.top_missed_listings : [];

  // ── Compact mode ──────────────────────────────────────────────────────
  if (compact) {
    return (
      <div className="space-y-3">
        {header}
        {statRow}
        {!isEmpty && (
          <>
            <AgentMiniTable
              agents={agents.slice(0, 3)}
              onOpenEntity={onOpenEntity}
            />
            <TopMissedMiniTable
              listings={topMissed.slice(0, 3)}
              onOpenEntity={onOpenEntity}
            />
          </>
        )}
        {isEmpty && (
          <div className="text-xs text-muted-foreground p-3 bg-muted/20 rounded text-center">
            No listings from this agency in the selected window.
          </div>
        )}
      </div>
    );
  }

  // ── Full mode ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {header}
      {statRow}

      {/* Growth headroom card */}
      {headroom && Number(headroom.additional_revenue || 0) > 0 && (
        <GrowthHeadroomCard headroom={headroom} />
      )}

      {isEmpty ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No listings from this agency in the selected window.
          </p>
        </Card>
      ) : (
        <>
          {/* Agent roster */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Agents — ranked by missed $</h3>
              <Badge variant="secondary" className="ml-auto text-xs">{agents.length}</Badge>
            </div>
            {agents.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center">No agent-level data in window</div>
            ) : (
              <AgentTable agents={agents} onOpenEntity={onOpenEntity} />
            )}
          </Card>

          {/* By-package + By-tier */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Breakdown
              title="By package"
              icon={PkgIcon}
              rows={r.by_package || []}
              labelKey="package"
            />
            <Breakdown
              title="By tier"
              icon={Award}
              rows={r.by_tier || []}
              labelKey="tier"
            />
          </div>

          {/* Monthly trend */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Monthly trend</h3>
              {mLoading && <span className="text-[10px] text-muted-foreground ml-auto">loading…</span>}
            </div>
            <MonthlyTrendChart monthly={monthly} />
          </Card>

          {/* Top missed listings */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpRight className="h-4 w-4 text-amber-600" />
              <h3 className="text-sm font-semibold">Top missed listings</h3>
              <Badge variant="secondary" className="ml-auto text-xs">{topMissed.length}</Badge>
            </div>
            {topMissed.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center">No missed opportunities in window</div>
            ) : (
              <TopMissedTable listings={topMissed} onOpenEntity={onOpenEntity} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function StatMini({ icon: Icon, color = "text-muted-foreground", bg = "bg-muted/40", label, value, sub, loading }) {
  return (
    <Card className="p-2">
      <div className="flex items-start gap-2">
        <div className={cn("w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0", bg)}>
          <Icon className={cn("h-3.5 w-3.5", color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-muted-foreground truncate">{label}</div>
          <div className={cn("text-sm font-semibold tabular-nums", loading && "opacity-50")}>
            {loading ? "…" : value}
          </div>
          {sub && <div className="text-[10px] text-muted-foreground truncate" title={sub}>{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

function GrowthHeadroomCard({ headroom }) {
  const addlRev = Number(headroom.additional_revenue || 0);
  const perMonth = Number(headroom.per_month_avg || 0);
  const needed = Number(headroom.additional_captures_needed || 0);
  return (
    <Card className="p-3 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/20 dark:to-transparent">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
          <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">Growth headroom</h3>
          <p className="text-xs text-emerald-800 dark:text-emerald-300 mt-0.5">
            If we captured <b>{fmtPct(headroom.target_capture_pct)}</b> of this agency's listings
            (currently at <b>{fmtPct(headroom.current_capture_pct)}</b>), we'd unlock{" "}
            <b className="tabular-nums">{fmtMoney(addlRev)}</b> additional revenue
            {perMonth > 0 && (<> — about <b className="tabular-nums">{fmtMoney(perMonth)}/month</b> on average</>)}.
          </p>
          {needed > 0 && (
            <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80 mt-1">
              That's <b>{fmtInt(needed)}</b> more bookings in the window.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function AgentTable({ agents, onOpenEntity }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1.5 font-medium px-2">#</th>
            <th className="text-left py-1.5 font-medium">Agent</th>
            <th className="text-right py-1.5 font-medium">Listings</th>
            <th className="text-right py-1.5 font-medium">Captured</th>
            <th className="text-right py-1.5 font-medium">Missed</th>
            <th className="text-right py-1.5 font-medium">Retention</th>
            <th className="text-right py-1.5 font-medium px-2">Missed $</th>
            <th className="py-1.5 font-medium w-8"></th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => {
            const clickable = !!(onOpenEntity && a.agent_pulse_id);
            return (
              <tr
                key={a.agent_pulse_id || a.agent_rea_id || i}
                className={cn(
                  "border-b last:border-b-0",
                  clickable && "hover:bg-muted/40 cursor-pointer"
                )}
                onClick={clickable ? () => onOpenEntity({ type: "agent", id: a.agent_pulse_id }) : undefined}
                title={clickable ? "Open agent slideout" : undefined}
              >
                <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="py-1.5">
                  <div className="flex items-center gap-2">
                    {a.profile_image ? (
                      <img src={a.profile_image} alt="" className="h-5 w-5 rounded-full object-cover" />
                    ) : (
                      <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                        {(a.agent_name || "?").split(" ").map(w => w[0]).slice(0,2).join("")}
                      </div>
                    )}
                    <span className="font-medium truncate max-w-[180px]" title={a.agent_name}>
                      {a.agent_name || "—"}
                    </span>
                  </div>
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtInt(a.total_listings)}</td>
                <td className="py-1.5 text-right tabular-nums text-emerald-700">{fmtInt(a.captured)}</td>
                <td className="py-1.5 text-right tabular-nums text-amber-700">{fmtInt(a.missed)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtPct(a.retention_rate_pct)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium text-amber-700 px-2">
                  {fmtMoney(a.missed_opportunity_value)}
                </td>
                <td className="py-1.5 text-right">
                  {clickable && <ArrowUpRight className="h-3 w-3 text-muted-foreground inline-block" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentMiniTable({ agents, onOpenEntity }) {
  if (!agents || agents.length === 0) return null;
  return (
    <Card className="p-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Top agents by missed $</span>
      </div>
      <div className="space-y-1">
        {agents.map((a) => {
          const clickable = !!(onOpenEntity && a.agent_pulse_id);
          return (
            <button
              key={a.agent_pulse_id || a.agent_rea_id}
              onClick={clickable ? () => onOpenEntity({ type: "agent", id: a.agent_pulse_id }) : undefined}
              disabled={!clickable}
              className={cn(
                "w-full flex items-center gap-2 rounded px-1.5 py-1 text-left",
                clickable ? "hover:bg-muted/60 cursor-pointer" : ""
              )}
            >
              {a.profile_image ? (
                <img src={a.profile_image} alt="" className="h-5 w-5 rounded-full object-cover" />
              ) : (
                <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                  {(a.agent_name || "?").split(" ").map(w => w[0]).slice(0,2).join("")}
                </div>
              )}
              <span className="text-xs font-medium truncate flex-1">{a.agent_name || "—"}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{fmtInt(a.missed)} missed</span>
              <span className="text-xs font-medium text-amber-700 tabular-nums w-16 text-right">
                {fmtMoney(a.missed_opportunity_value)}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function Breakdown({ title, icon: Icon, rows, labelKey }) {
  const sorted = [...(rows || [])].sort((a, b) => (b.value || 0) - (a.value || 0));
  const maxValue = Math.max(1, ...sorted.map(r => r.value || 0));
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {sorted.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No data in window</div>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((row, i) => {
            const label = row[labelKey] || "—";
            return (
              <div key={i} className="space-y-0.5">
                <div className="flex items-center text-xs gap-2">
                  <span className="font-medium truncate flex-1">{label}</span>
                  <span className="text-muted-foreground tabular-nums">{fmtInt(row.listings)}</span>
                  <span className="tabular-nums w-16 text-right font-medium">{fmtMoney(row.value)}</span>
                </div>
                <div className="h-1 bg-muted rounded overflow-hidden">
                  <div className="h-full bg-amber-400" style={{ width: `${(row.value/maxValue)*100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function MonthlyTrendChart({ monthly }) {
  const data = useMemo(() => {
    return (monthly || []).map(m => ({
      month: fmtMonth(m.month),
      total: Number(m.total || 0),
      captured: Number(m.captured || 0),
      missed: Number(m.missed || 0),
      retention_pct: Number(m.total) > 0 ? Math.round(100.0 * Number(m.captured) / Number(m.total) * 100) / 100 : 0,
    }));
  }, [monthly]);

  if (!data.length) {
    return <div className="text-xs text-muted-foreground py-6 text-center">No monthly data in window</div>;
  }

  return (
    <div className="w-full h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="month" fontSize={11} tick={{ fill: "currentColor" }} />
          <YAxis yAxisId="left" fontSize={11} tick={{ fill: "currentColor" }} />
          <YAxis yAxisId="right" orientation="right" fontSize={11} tick={{ fill: "currentColor" }} unit="%" />
          <Tooltip
            contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
            formatter={(v, name) => name === "retention_pct" ? [`${v}%`, "Retention"] : [v, name]}
          />
          <Line yAxisId="left" type="monotone" dataKey="captured" stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} name="Captured" />
          <Line yAxisId="left" type="monotone" dataKey="missed" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} name="Missed" />
          <Line yAxisId="right" type="monotone" dataKey="retention_pct" stroke="#3b82f6" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2 }} name="Retention %" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopMissedTable({ listings, onOpenEntity }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1.5 font-medium px-2">#</th>
            <th className="text-left py-1.5 font-medium">Address</th>
            <th className="text-left py-1.5 font-medium">Suburb</th>
            <th className="text-left py-1.5 font-medium">Package</th>
            <th className="text-left py-1.5 font-medium">Tier</th>
            <th className="text-right py-1.5 font-medium">Quote</th>
            <th className="text-left py-1.5 font-medium">Agent</th>
            <th className="text-right py-1.5 font-medium px-2">Link</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((row, i) => {
            const clickable = !!(onOpenEntity && row.listing_id);
            return (
              <tr
                key={row.listing_id || i}
                className={cn("border-b last:border-b-0", clickable && "hover:bg-muted/40 cursor-pointer")}
                onClick={clickable ? () => onOpenEntity({ type: "listing", id: row.listing_id }) : undefined}
              >
                <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="py-1.5 truncate max-w-[220px] font-medium" title={row.address}>{row.address || "—"}</td>
                <td className="py-1.5 text-muted-foreground truncate max-w-[120px]">{row.suburb || "—"}</td>
                <td className="py-1.5">
                  <PackageBadge name={row.classified_package_name} />
                </td>
                <td className="py-1.5">
                  <TierBadge tier={row.resolved_tier} />
                </td>
                <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">
                  <QuoteProvenance listingId={row.listing_id}>
                    {fmtMoney(row.quoted_price)}
                  </QuoteProvenance>
                </td>
                <td className="py-1.5 truncate max-w-[150px]">
                  {row.agent_pulse_id && onOpenEntity ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenEntity({ type: "agent", id: row.agent_pulse_id }); }}
                      className="hover:underline font-medium truncate"
                    >{row.agent_name || "—"}</button>
                  ) : (
                    <span className="font-medium">{row.agent_name || "—"}</span>
                  )}
                </td>
                <td className="py-1.5 px-2 text-right" onClick={(e) => e.stopPropagation()}>
                  {row.source_url ? (
                    <a href={row.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TopMissedMiniTable({ listings, onOpenEntity }) {
  if (!listings || listings.length === 0) return null;
  return (
    <Card className="p-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <ArrowUpRight className="h-3.5 w-3.5 text-amber-600" />
        <span className="text-xs font-medium">Top missed listings</span>
      </div>
      <div className="space-y-1">
        {listings.map((row) => {
          const clickable = !!(onOpenEntity && row.listing_id);
          return (
            <div
              key={row.listing_id}
              onClick={clickable ? () => onOpenEntity({ type: "listing", id: row.listing_id }) : undefined}
              className={cn(
                "flex items-center gap-2 rounded px-1.5 py-1 text-xs",
                clickable && "hover:bg-muted/60 cursor-pointer"
              )}
            >
              <span className="font-medium truncate flex-1" title={row.address}>{row.address || "—"}</span>
              <span className="text-[10px] text-muted-foreground truncate hidden sm:inline max-w-[100px]">
                {row.agent_name || ""}
              </span>
              <span className="font-medium text-amber-700 tabular-nums w-16 text-right">
                <QuoteProvenance listingId={row.listing_id}>
                  {fmtMoney(row.quoted_price)}
                </QuoteProvenance>
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Inline badges (same look as PulseMarketShare) ──────────────────────────

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
  // tag it visually so ops can spot drift.
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
