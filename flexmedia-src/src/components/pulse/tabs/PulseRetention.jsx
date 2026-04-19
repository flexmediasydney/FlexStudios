/**
 * PulseRetention — Client Retention dashboard (Industry Pulse subtab).
 *
 * Complements the Market Share engine with a per-agent view: for each agent
 * we have a CRM relationship with (or track for retention), show their active
 * listings vs the projects we booked, flag the gap.
 *
 * Data model:
 *   • List view: pulse_get_top_agents_retention(from, to, limit) — ranked by
 *     missed_opportunity_value desc.
 *   • Drill view: pulse_get_agent_retention(agent_rea_id, from, to) — captured
 *     vs missed listings, per-listing detail.
 *
 * Different from Market Share tab:
 *   • Market Share = top-down (whole-market view)
 *   • Retention    = bottom-up (per-agent accountability)
 */
import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Users, AlertTriangle, TrendingDown, CheckCircle2, ArrowLeft,
  ExternalLink, Search, RefreshCw, DollarSign, Target,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Time window (reuse same 6 windows as Market Share) ──────────────────────
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
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtInt(v) { return v == null ? "—" : Number(v).toLocaleString(); }
function fmtPct(v) { return v == null ? "—" : `${Number(v).toFixed(1)}%`; }
function fmtDate(d) { if (!d) return "—"; try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); } catch { return "—"; } }

// ── Main ────────────────────────────────────────────────────────────────────
export default function PulseRetention({ onOpenEntity, onNavigateTab }) {
  const [window, setWindow] = useState("12m");
  const [search, setSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState(null); // { agent_rea_id, agent_name, agency_name }

  const { fromDate, toDate } = useMemo(() => {
    const wd = WINDOWS.find(w => w.value === window) || WINDOWS[5];
    return { fromDate: wd.from(), toDate: new Date() };
  }, [window]);
  const fromIso = fromDate.toISOString();
  const toIso = toDate.toISOString();

  const { data: agents = [], isLoading, refetch } = useQuery({
    queryKey: ["pulse_top_agents_retention", fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_top_agents_retention", {
        p_from: fromIso, p_to: toIso, p_limit: 100, p_min_listings: 3,
      });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60_000,
  });

  const filtered = useMemo(() => {
    if (!search) return agents;
    const q = search.toLowerCase();
    return agents.filter(a => (a.agent_name || "").toLowerCase().includes(q) || (a.agency_name || "").toLowerCase().includes(q));
  }, [agents, search]);

  if (selectedAgent) {
    return (
      <AgentDrillView
        agent={selectedAgent}
        fromIso={fromIso}
        toIso={toIso}
        onBack={() => setSelectedAgent(null)}
        windowLabel={WINDOWS.find(w => w.value === window)?.label}
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
              onClick={() => setWindow(w.value)}
              className={cn(
                "text-xs px-2.5 py-1 rounded transition-colors",
                window === w.value ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >{w.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter agent/agency" className="h-8 text-xs w-56 pl-7" />
          </div>
          <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* ── Summary strip ────────────────────────────────────────── */}
      <SummaryStrip agents={filtered} />

      {/* ── Agent list ───────────────────────────────────────────── */}
      <Card className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Agents ranked by missed opportunity</h3>
          <Badge variant="secondary" className="ml-auto text-xs">{filtered.length} agents</Badge>
        </div>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading agents…</div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">No agents match filter</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1.5 font-medium px-2">#</th>
                  <th className="text-left py-1.5 font-medium">Agent</th>
                  <th className="text-left py-1.5 font-medium">Agency</th>
                  <th className="text-right py-1.5 font-medium">Listings</th>
                  <th className="text-right py-1.5 font-medium">Captured</th>
                  <th className="text-right py-1.5 font-medium">Missed</th>
                  <th className="text-right py-1.5 font-medium">Retention</th>
                  <th className="text-right py-1.5 font-medium px-2">Missed $</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a, i) => (
                  <tr
                    key={a.agent_rea_id}
                    className="border-b last:border-b-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => setSelectedAgent(a)}
                    title="Click row to drill into this agent's listings"
                  >
                    <td className="py-1.5 px-2 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="py-1.5 font-medium truncate max-w-[180px]">
                      <span className="hover:underline" title={a.agent_name}>{a.agent_name || "—"}</span>
                    </td>
                    <td className="py-1.5 text-muted-foreground truncate max-w-[200px]" title={a.agency_name}>
                      {a.agency_name || "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtInt(a.total_listings)}</td>
                    <td className="py-1.5 text-right tabular-nums text-emerald-700">{fmtInt(a.captured)}</td>
                    <td className="py-1.5 text-right tabular-nums text-amber-700">{fmtInt(a.missed)}</td>
                    <td className="py-1.5 text-right tabular-nums"><RetentionBadge pct={Number(a.retention_rate_pct)} /></td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium text-amber-700">{fmtMoney(a.missed_opportunity_value)}</td>
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

function SummaryStrip({ agents }) {
  const totals = useMemo(() => {
    return agents.reduce((acc, a) => {
      acc.listings += Number(a.total_listings) || 0;
      acc.captured += Number(a.captured) || 0;
      acc.missed += Number(a.missed) || 0;
      acc.missedValue += Number(a.missed_opportunity_value) || 0;
      return acc;
    }, { listings: 0, captured: 0, missed: 0, missedValue: 0 });
  }, [agents]);
  const rate = totals.listings > 0 ? (100 * totals.captured / totals.listings) : 0;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <StatMini icon={Users}            label="Agents"           value={fmtInt(agents.length)}    color="text-slate-600"  bg="bg-slate-50" />
      <StatMini icon={Target}           label="Avg retention %"  value={fmtPct(rate)}             color="text-emerald-600" bg="bg-emerald-50" />
      <StatMini icon={AlertTriangle}    label="Missed listings"  value={fmtInt(totals.missed)}    color="text-amber-600"   bg="bg-amber-50" />
      <StatMini icon={DollarSign}       label="Missed $"         value={fmtMoney(totals.missedValue)} color="text-amber-600" bg="bg-amber-50" />
    </div>
  );
}

function StatMini({ icon: Icon, label, value, color, bg }) {
  return (
    <Card className="p-2.5">
      <div className="flex items-start gap-2">
        <div className={cn("w-7 h-7 rounded flex items-center justify-center", bg)}>
          <Icon className={cn("h-3.5 w-3.5", color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-muted-foreground">{label}</div>
          <div className="text-sm font-semibold tabular-nums">{value}</div>
        </div>
      </div>
    </Card>
  );
}

function RetentionBadge({ pct }) {
  if (pct >= 80) return <Badge className="text-[10px] h-4 px-1 bg-emerald-100 text-emerald-800 border-emerald-200">{pct.toFixed(0)}%</Badge>;
  if (pct >= 50) return <Badge className="text-[10px] h-4 px-1 bg-amber-100 text-amber-800 border-amber-200">{pct.toFixed(0)}%</Badge>;
  if (pct > 0)   return <Badge className="text-[10px] h-4 px-1 bg-red-100 text-red-800 border-red-200">{pct.toFixed(0)}%</Badge>;
  return <Badge className="text-[10px] h-4 px-1 bg-red-100 text-red-800 border-red-200">0%</Badge>;
}

// ── Drill view ──────────────────────────────────────────────────────────────

function AgentDrillView({ agent, fromIso, toIso, onBack, windowLabel, onOpenEntity }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ["pulse_agent_retention", agent.agent_rea_id, fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_agent_retention", {
        p_agent_rea_id: agent.agent_rea_id, p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });

  const d = detail || {};
  const missed = Array.isArray(d.missed_listings) ? d.missed_listings : [];
  const captured = Array.isArray(d.captured_listings) ? d.captured_listings : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />Back
        </Button>
        <div className="text-xs text-muted-foreground">{windowLabel}</div>
      </div>

      <Card className="p-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Users className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            {agent.agent_pulse_id && onOpenEntity ? (
              <button
                className="text-lg font-semibold truncate hover:underline text-left"
                onClick={() => onOpenEntity({ type: "agent", id: agent.agent_pulse_id })}
                title="Open agent slideout"
              >{agent.agent_name}</button>
            ) : (
              <div className="text-lg font-semibold truncate">{agent.agent_name}</div>
            )}
            <div className="text-xs text-muted-foreground truncate">
              {agent.agency_pulse_id && onOpenEntity ? (
                <button
                  className="hover:underline hover:text-foreground"
                  onClick={() => onOpenEntity({ type: "agency", id: agent.agency_pulse_id })}
                  title="Open agency slideout"
                >{agent.agency_name}</button>
              ) : agent.agency_name}
            </div>
            <div className="text-[11px] text-muted-foreground">REA agent ID: <code>{agent.agent_rea_id}</code></div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Missed $</div>
            <div className="text-xl font-semibold text-amber-700 tabular-nums">{fmtMoney(d.missed_opportunity_value)}</div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatMini icon={Target}         label="Total listings"   value={fmtInt(d.total_listings)}    color="text-slate-600"  bg="bg-slate-50" />
        <StatMini icon={CheckCircle2}   label="Captured"         value={fmtInt(d.captured)}          color="text-emerald-600" bg="bg-emerald-50" />
        <StatMini icon={AlertTriangle}  label="Missed"           value={fmtInt(d.missed)}            color="text-amber-600"   bg="bg-amber-50" />
        <StatMini icon={TrendingDown}   label="Retention %"      value={fmtPct(d.retention_rate_pct)} color="text-amber-600"  bg="bg-amber-50" />
      </div>

      {isLoading ? (
        <Card className="p-8 text-xs text-muted-foreground text-center">Loading detail…</Card>
      ) : (
        <>
          <ListingTable title="Missed listings" rows={missed} kind="missed" onOpenEntity={onOpenEntity} />
          <ListingTable title="Captured listings" rows={captured} kind="captured" onOpenEntity={onOpenEntity} />
        </>
      )}
    </div>
  );
}

function ListingTable({ title, rows, kind, onOpenEntity }) {
  const color = kind === "missed" ? "text-amber-600" : "text-emerald-600";
  const Icon = kind === "missed" ? AlertTriangle : CheckCircle2;
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn("h-4 w-4", color)} />
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary" className="ml-auto text-xs">{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">None in window</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1.5 font-medium px-2">Address</th>
                <th className="text-left py-1.5 font-medium">Suburb</th>
                <th className="text-left py-1.5 font-medium">First seen</th>
                <th className="text-left py-1.5 font-medium">Package</th>
                {kind === "missed" && <>
                  <th className="text-left py-1.5 font-medium">Tier</th>
                  <th className="text-right py-1.5 font-medium">Quote</th>
                  <th className="text-left py-1.5 font-medium">Status</th>
                </>}
                <th className="text-right py-1.5 font-medium px-2">Link</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.listing_id}
                  className={cn("border-b last:border-b-0 hover:bg-muted/40", onOpenEntity && "cursor-pointer")}
                  onClick={() => onOpenEntity && onOpenEntity({ type: "listing", id: r.listing_id })}
                  title={onOpenEntity ? "Click to open listing slideout" : undefined}
                >
                  <td className="py-1.5 px-2 truncate max-w-[200px] hover:underline" title={r.address}>{r.address || "—"}</td>
                  <td className="py-1.5 text-muted-foreground">{r.suburb || "—"}</td>
                  <td className="py-1.5 tabular-nums">{fmtDate(r.first_seen_at)}</td>
                  <td className="py-1.5">
                    {r.package ? <Badge variant="outline" className="text-[10px] h-4 px-1">{r.package.replace(" Package","")}</Badge> : "—"}
                  </td>
                  {kind === "missed" && <>
                    <td className="py-1.5">
                      {r.tier === "premium"
                        ? <Badge className="text-[10px] h-4 px-1 bg-purple-100 text-purple-800 border-purple-200">Prm</Badge>
                        : <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">Std</Badge>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-amber-700">{fmtMoney(r.quoted_price)}</td>
                    <td className="py-1.5">
                      {r.quote_status === "fresh" && <Badge className="text-[10px] h-4 px-1 bg-emerald-100 text-emerald-800 border-emerald-200">fresh</Badge>}
                      {r.quote_status === "data_gap" && <Badge className="text-[10px] h-4 px-1 bg-amber-100 text-amber-800 border-amber-200">gap</Badge>}
                      {r.quote_status === "pending_enrichment" && <Badge className="text-[10px] h-4 px-1 bg-slate-100 text-slate-700 border-slate-200">pending</Badge>}
                    </td>
                  </>}
                  <td className="py-1.5 px-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {r.source_url && (
                      <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex" title="Open on REA">
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
