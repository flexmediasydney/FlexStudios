/**
 * AgentMarketShareSection — Per-agent Market Share + Retention card.
 *
 * Surfaces the FlexStudios Market Share engine inside the CRM Agent detail
 * page (PersonDetails.jsx) and the Industry Pulse AgentSlideout. Reads from
 * the pulse_listing_missed_opportunity substrate via 2 RPCs:
 *   • pulse_get_agent_retention(p_agent_rea_id, p_from, p_to) — headline
 *     aggregation + missed/captured listing lists.
 *   • pulse_get_agent_retention_monthly(p_agent_rea_id, p_from, p_to) —
 *     12-month sparkline feed (captured-rate by month).
 *
 * Two visual modes:
 *   • Full (default)   — stat row + trend chart + package breakdown + full
 *                        missed-listing table + CTAs (CSV, open in CRM, email).
 *   • Compact          — 5-stat row + top 3 missed rows (for slideouts).
 *
 * Visual convention: matches PulseMarketShare.jsx in tone / icons / colors.
 * Amber = missed, emerald = captured, purple = premium.
 */
import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, DollarSign, Target, Package as PkgIcon,
  AlertTriangle, CheckCircle2, ExternalLink, Download, Mail, UserSquare2,
  ListChecks, LineChart as LineChartIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import {
  LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import QuoteProvenance from "@/components/marketshare/QuoteProvenance";

// ── Time window helpers (matches PulseMarketShare.jsx) ──────────────────────

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
function fmtPct(v) { if (v == null) return "—"; return `${Number(v).toFixed(1)}%`; }
function fmtDate(v) {
  if (!v) return "—";
  try { return new Date(v).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "2-digit" }); }
  catch { return "—"; }
}

// ── CSV export (small local helper — avoids cross-component dep) ────────────

function exportMissedCsv(filename, rows) {
  const header = ["address", "suburb", "first_seen_at", "package", "tier", "quoted_price", "quote_status", "source_url"];
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => escape(r[h])).join(","));
  const csv = "\uFEFF" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Badges ──────────────────────────────────────────────────────────────────

function RetentionBadge({ pct }) {
  const p = Number(pct || 0);
  if (p >= 70) return <Badge className="text-[10px] h-5 px-1.5 bg-emerald-100 text-emerald-800 border-emerald-200">{p.toFixed(1)}%</Badge>;
  if (p >= 40) return <Badge className="text-[10px] h-5 px-1.5 bg-amber-100 text-amber-800 border-amber-200">{p.toFixed(1)}%</Badge>;
  return <Badge className="text-[10px] h-5 px-1.5 bg-red-100 text-red-800 border-red-200">{p.toFixed(1)}%</Badge>;
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
  return (
    <Badge variant="outline" className={cn("text-[10px] h-4 px-1", colorMap[name] || "")}>
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

// ── Main component ──────────────────────────────────────────────────────────

export default function AgentMarketShareSection({
  agentReaId,
  agentPulseId,
  onOpenEntity,
  compact = false,
}) {
  const [window, setWindow] = useState("12m");
  const [packageFilter, setPackageFilter] = useState(null);

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === window) || WINDOWS[5];
    return { fromDate: wd.from(), toDate: new Date() };
  }, [window]);

  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  // ── Headline aggregation + lists ───────────────────────────────────────
  const { data: retention, isLoading } = useQuery({
    queryKey: ["pulse_agent_retention", agentReaId, fromIso, toIso],
    queryFn: async () => {
      if (!agentReaId) return null;
      const { data, error } = await api._supabase.rpc("pulse_get_agent_retention", {
        p_agent_rea_id: agentReaId,
        p_from: fromIso,
        p_to: toIso,
      });
      if (error) throw error;
      return data;
    },
    enabled: !!agentReaId,
    staleTime: 60_000,
  });

  // ── 12-month sparkline (always last 12 full months + current-month-to-date) ──
  // trendFrom = start of the month 11 months ago (inclusive lower bound).
  // trendTo   = start of next month (exclusive upper bound) → generate_series in
  //             the RPC produces 12 month buckets inclusive of the current month.
  const trendFromIso = useMemo(() => startOfMonth(minusMonths(new Date(), 11)).toISOString(), []);
  const trendToIso = useMemo(() => startOfMonth(minusMonths(new Date(), -1)).toISOString(), []);

  const { data: monthly = [] } = useQuery({
    queryKey: ["pulse_agent_retention_monthly", agentReaId, trendFromIso, trendToIso],
    queryFn: async () => {
      if (!agentReaId) return [];
      const { data, error } = await api._supabase.rpc("pulse_get_agent_retention_monthly", {
        p_agent_rea_id: agentReaId,
        p_from: trendFromIso,
        p_to: trendToIso,
      });
      if (error) throw error;
      return data || [];
    },
    enabled: !!agentReaId && !compact,
    staleTime: 60_000,
  });

  // ── Agent email (CTA) — best-effort single lookup ──────────────────────
  const { data: agentEmail } = useQuery({
    queryKey: ["pulse_agent_email", agentReaId],
    queryFn: async () => {
      if (!agentReaId) return null;
      const { data, error } = await api._supabase
        .from("pulse_agents")
        .select("email")
        .eq("rea_agent_id", agentReaId)
        .maybeSingle();
      if (error) return null;
      return data || null;
    },
    enabled: !!agentReaId && !compact,
    staleTime: 5 * 60_000,
  });

  const d = retention || {};
  const missed = Array.isArray(d.missed_listings) ? d.missed_listings : [];

  // ── Package breakdown (derived from missed listings) ───────────────────
  const packageBreakdown = useMemo(() => {
    const map = new Map();
    for (const row of missed) {
      const pkg = row.package || "UNCLASSIFIABLE";
      const cur = map.get(pkg) || { package: pkg, count: 0, value: 0 };
      cur.count += 1;
      cur.value += Number(row.quoted_price || 0);
      map.set(pkg, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [missed]);

  const filteredMissed = useMemo(() => {
    if (!packageFilter) return missed;
    return missed.filter(r => (r.package || "UNCLASSIFIABLE") === packageFilter);
  }, [missed, packageFilter]);

  const scrollToTable = () => {
    const el = document.getElementById(`agent-ms-missed-table-${agentReaId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!agentReaId) return null;

  // ── Compact mode (slideout) ────────────────────────────────────────────
  if (compact) {
    return (
      <div className="space-y-3">
        {/* Window pill selector — compact */}
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5 w-fit">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindow(w.value)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded transition-colors",
                window === w.value
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        <StatRow d={d} isLoading={isLoading} compact />

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Top missed ({missed.length})
          </div>
          {missed.length === 0 ? (
            <div className="text-xs text-muted-foreground py-3 text-center border rounded">
              No missed listings in this window
            </div>
          ) : (
            <div className="space-y-1">
              {missed.slice(0, 3).map(row => (
                <button
                  key={row.listing_id}
                  className="w-full flex items-center gap-2 text-xs py-1.5 px-2 rounded border hover:bg-muted/40 text-left"
                  onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: row.listing_id })}
                  title="Open listing"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{row.address || "—"}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {row.suburb || ""} · <PackageBadge name={row.package} />
                    </div>
                  </div>
                  <div className="text-right tabular-nums font-medium text-amber-700">
                    <QuoteProvenance listingId={row.listing_id}>
                      {fmtMoney(row.quoted_price)}
                    </QuoteProvenance>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Full mode ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Window pill selector */}
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

        <div className="flex items-center gap-1.5 ml-auto">
          {missed.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => exportMissedCsv(
                `agent_missed_${agentReaId}_${new Date().toISOString().slice(0, 10)}.csv`,
                missed,
              )}
              title="Export missed listings to CSV"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          )}
          {agentPulseId && (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
              <Link
                to={createPageUrl("IndustryPulse") + `?tab=agents&pulse_id=${agentPulseId}`}
                title="Open agent in Industry Pulse"
              >
                <UserSquare2 className="h-3.5 w-3.5" /> Open in Pulse
              </Link>
            </Button>
          )}
          {agentEmail?.email && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
            >
              <a href={`mailto:${agentEmail.email}`} title={`Email ${agentEmail.email}`}>
                <Mail className="h-3.5 w-3.5" /> Email
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* Stat row (5 cards) */}
      <StatRow d={d} isLoading={isLoading} />

      {/* Trend chart + package breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <LineChartIcon className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold">Capture rate — 12m</h3>
            <span className="text-[10px] text-muted-foreground ml-auto">monthly %</span>
          </div>
          <TrendChart monthly={monthly} />
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <PkgIcon className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Missed by package</h3>
            {packageBreakdown.length > 0 && (
              <span className="text-[10px] text-muted-foreground ml-auto">click to filter ↓</span>
            )}
          </div>
          {packageBreakdown.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">
              {isLoading ? "Loading…" : "No missed listings in this window"}
            </div>
          ) : (
            <div className="space-y-1.5">
              {(() => {
                const maxValue = Math.max(1, ...packageBreakdown.map(r => r.value));
                return packageBreakdown.map((row) => {
                  const isActive = packageFilter === row.package;
                  return (
                    <button
                      key={row.package}
                      className={cn(
                        "w-full text-left rounded px-1 py-0.5 transition-colors",
                        "cursor-pointer hover:bg-muted/60",
                        isActive && "bg-amber-50 ring-1 ring-amber-200",
                      )}
                      onClick={() => {
                        setPackageFilter(isActive ? null : row.package);
                        scrollToTable();
                      }}
                    >
                      <div className="flex items-center text-xs gap-2">
                        <span className="font-medium truncate flex-1">{row.package.replace(" Package", "")}</span>
                        <span className="text-muted-foreground tabular-nums">{fmtInt(row.count)}</span>
                        <span className="tabular-nums w-16 text-right font-medium">{fmtMoney(row.value)}</span>
                      </div>
                      <div className="h-1 bg-muted rounded overflow-hidden">
                        <div
                          className={cn("h-full", isActive ? "bg-amber-500" : "bg-amber-400")}
                          style={{ width: `${(row.value / maxValue) * 100}%` }}
                        />
                      </div>
                    </button>
                  );
                });
              })()}
            </div>
          )}
        </Card>
      </div>

      {/* Missed listings table */}
      <Card className="p-3" id={`agent-ms-missed-table-${agentReaId}`}>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <ListChecks className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold">Missed opportunities</h3>
          {packageFilter && (
            <Badge
              className="text-[10px] h-5 bg-amber-100 text-amber-800 border-amber-200 gap-0.5 cursor-pointer"
              onClick={() => setPackageFilter(null)}
            >
              pkg: {packageFilter.replace(" Package", "")} ×
            </Badge>
          )}
          <Badge variant="secondary" className="ml-auto text-xs">
            {filteredMissed.length} of {missed.length} listings
          </Badge>
        </div>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading…</div>
        ) : filteredMissed.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {packageFilter ? "No missed listings match this package" : "No missed opportunities in this window"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1.5 font-medium px-2">#</th>
                  <th className="text-left py-1.5 font-medium">Address</th>
                  <th className="text-left py-1.5 font-medium">Suburb</th>
                  <th className="text-left py-1.5 font-medium">First seen</th>
                  <th className="text-left py-1.5 font-medium">Package</th>
                  <th className="text-left py-1.5 font-medium">Tier</th>
                  <th className="text-right py-1.5 font-medium">Quote</th>
                  <th className="text-right py-1.5 font-medium px-2">Link</th>
                </tr>
              </thead>
              <tbody>
                {filteredMissed.map((row, i) => (
                  <tr
                    key={row.listing_id}
                    className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: row.listing_id })}
                    title="Click to open listing"
                  >
                    <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="py-1.5 truncate max-w-[260px] font-medium hover:underline" title={row.address}>
                      {row.address || "—"}
                    </td>
                    <td className="py-1.5 text-muted-foreground">{row.suburb || "—"}</td>
                    <td className="py-1.5 text-muted-foreground tabular-nums">{fmtDate(row.first_seen_at)}</td>
                    <td className="py-1.5"><PackageBadge name={row.package} /></td>
                    <td className="py-1.5"><TierBadge tier={row.tier} /></td>
                    <td
                      className="py-1.5 text-right tabular-nums font-medium text-amber-700"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <QuoteProvenance listingId={row.listing_id}>
                        {fmtMoney(row.quoted_price)}
                      </QuoteProvenance>
                    </td>
                    <td className="py-1.5 px-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {row.source_url ? (
                        <a
                          href={row.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-0.5"
                          title="Open on source portal"
                        >
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

// ── StatRow ─────────────────────────────────────────────────────────────────

function StatRow({ d, isLoading, compact }) {
  const cards = [
    { icon: Target,        label: "Total",     value: fmtInt(d.total_listings),        color: "text-slate-600",  bg: "bg-slate-50" },
    { icon: CheckCircle2,  label: "Captured",  value: fmtInt(d.captured),              color: "text-emerald-600", bg: "bg-emerald-50" },
    { icon: AlertTriangle, label: "Missed",    value: fmtInt(d.missed),                color: "text-amber-600",   bg: "bg-amber-50" },
    {
      icon: TrendingUp,
      label: "Retention",
      valueNode: d.retention_rate_pct != null
        ? <RetentionBadge pct={d.retention_rate_pct} />
        : <span className="text-muted-foreground">—</span>,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    { icon: DollarSign,    label: "Missed $",  value: fmtMoney(d.missed_opportunity_value), color: "text-amber-600", bg: "bg-amber-50" },
  ];
  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-5" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5")}>
      {cards.map((c, i) => (
        <Card key={i} className={cn("p-2.5", compact && "p-2")}>
          <div className="flex items-start gap-2">
            <div className={cn("w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0", c.bg)}>
              <c.icon className={cn("h-3.5 w-3.5", c.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{c.label}</div>
              <div className={cn("text-base font-semibold tabular-nums truncate", isLoading && "opacity-50")}>
                {isLoading ? "…" : (c.valueNode || c.value)}
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────

function TrendChart({ monthly }) {
  const data = useMemo(() => {
    return (monthly || []).map(m => {
      const total = Number(m.total_listings || 0);
      const captured = Number(m.captured || 0);
      const pct = total > 0 ? (captured / total) * 100 : null;
      const month = new Date(m.month);
      return {
        month,
        label: month.toLocaleDateString("en-AU", { month: "short" }),
        captureRate: pct,
        total,
        captured,
        missed: Number(m.missed || 0),
      };
    });
  }, [monthly]);

  const hasAnyData = data.some(d => d.total > 0);

  if (!hasAnyData) {
    return (
      <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">
        No listing activity in the last 12 months
      </div>
    );
  }

  return (
    <div className="h-[120px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}%`}
            width={36}
          />
          <Tooltip content={<TrendTooltip />} />
          <Line
            type="monotone"
            dataKey="captureRate"
            stroke="#059669"
            strokeWidth={2}
            dot={{ r: 2, fill: "#059669" }}
            activeDot={{ r: 3 }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendTooltip({ active, payload }) {
  if (!active || !payload || !payload[0]) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-background border border-border rounded shadow-md p-2 text-[11px]">
      <div className="font-semibold">
        {p.month.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}
      </div>
      <div className="text-muted-foreground">
        {p.captureRate == null ? "No listings" : `${p.captureRate.toFixed(1)}% captured`}
      </div>
      <div className="text-muted-foreground">
        {p.captured} captured · {p.missed} missed
      </div>
    </div>
  );
}
