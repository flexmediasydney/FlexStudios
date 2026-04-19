/**
 * LegacyMarketShareReport - "What if" view that diffs Market Share as computed
 * with active-CRM-only captures versus active + legacy (historical imports).
 *
 * Powered by RPC pulse_get_legacy_market_share_comparison(p_from, p_to) from
 * migration 189. Renders:
 *   - Side-by-side capture rate / missed-$ cards with deltas
 *   - Monthly capture-rate timeline with dual lines (active vs all)
 *   - Top "only-captured-by-legacy" agents / agencies — past relationships
 *     worth re-engaging
 *
 * Route: /Reports/LegacyMarketShare
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Archive, DollarSign, Target, TrendingUp, ArrowLeft, RefreshCw,
  Users, Building2, AlertTriangle, CheckCircle2,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Legend,
} from "recharts";
import { cn } from "@/lib/utils";

const WINDOWS = [
  { value: "3m",  label: "3 months",    months: 3  },
  { value: "6m",  label: "6 months",    months: 6  },
  { value: "12m", label: "12 months",   months: 12 },
  { value: "24m", label: "24 months",   months: 24 },
  { value: "all", label: "All time",    months: 120 },
];

function fmtMoney(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtInt(v) { return v == null ? "—" : Number(v).toLocaleString(); }
function fmtPct(v) { return v == null ? "—" : `${Number(v).toFixed(2)}%`; }
function fmtSigned(n, formatter = fmtInt) {
  const v = Number(n) || 0;
  if (v === 0) return formatter(0);
  const prefix = v > 0 ? "+" : "";
  return `${prefix}${formatter(v)}`;
}

export default function LegacyMarketShareReport() {
  const [windowKey, setWindowKey] = useState("12m");

  const { fromIso, toIso, label } = useMemo(() => {
    const w = WINDOWS.find(x => x.value === windowKey) || WINDOWS[2];
    const to = new Date();
    const from = new Date(to);
    from.setMonth(from.getMonth() - w.months);
    return { fromIso: from.toISOString(), toIso: to.toISOString(), label: w.label };
  }, [windowKey]);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["pulse_legacy_comparison", fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_legacy_market_share_comparison", {
        p_from: fromIso, p_to: toIso,
      });
      if (error) throw error;
      return data || {};
    },
    staleTime: 60_000,
  });

  const d = data || {};
  const active = d.active_only || {};
  const both   = d.active_plus_legacy || {};
  const delta  = d.delta || {};
  const timeline = Array.isArray(d.timeline) ? d.timeline : [];
  const topAgents = Array.isArray(d.top_legacy_only_agents) ? d.top_legacy_only_agents : [];
  const topAgencies = Array.isArray(d.top_legacy_only_agencies) ? d.top_legacy_only_agencies : [];

  const legacyOnlyCount = Number(delta.legacy_only_captured) || 0;
  const captureDeltaPct = Number(delta.capture_rate_delta_pct) || 0;

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-md bg-slate-100 flex items-center justify-center flex-shrink-0">
          <Archive className="h-5 w-5 text-slate-700" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold">Historical market share</h1>
          <p className="text-sm text-muted-foreground">
            How legacy Pipedrive projects reshape the picture — live CRM captures vs CRM + historical imports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/IndustryPulse?tab=market-share" className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted">
            <ArrowLeft className="h-3 w-3" />Market Share
          </a>
          <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", (isLoading || isFetching) && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Window */}
      <div className="flex items-center gap-1 rounded-md border bg-card p-0.5 w-fit">
        {WINDOWS.map(w => (
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

      {isLoading ? (
        <Card className="p-8 text-sm text-muted-foreground text-center">Loading comparison…</Card>
      ) : (
        <>
          {/* ── 2-column diff ─────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <SnapshotCard
              title="Active CRM only"
              subtitle="Pre-legacy-import reality"
              snapshot={active}
              accent="blue"
            />
            <SnapshotCard
              title="Active + Legacy"
              subtitle="With historical Pipedrive + imported projects"
              snapshot={both}
              accent="emerald"
              highlight
            />
          </div>

          {/* ── Delta strip ───────────────────────────────────────── */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Delta — what the legacy import unlocks</h2>
              <span className="ml-auto text-[11px] text-muted-foreground">{label}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <DeltaCard
                label="Capture rate"
                value={`${fmtPct(active.capture_rate_pct)} → ${fmtPct(both.capture_rate_pct)}`}
                delta={`${captureDeltaPct >= 0 ? "+" : ""}${Number(captureDeltaPct).toFixed(2)} pts`}
                positive={captureDeltaPct > 0}
              />
              <DeltaCard
                label="Captured listings"
                value={`${fmtInt(active.captured_listings)} → ${fmtInt(both.captured_listings)}`}
                delta={`${fmtSigned(delta.captured_delta)} captures`}
                positive={(Number(delta.captured_delta) || 0) > 0}
              />
              <DeltaCard
                label="Missed $"
                value={`${fmtMoney(active.missed_opportunity_value)} → ${fmtMoney(both.missed_opportunity_value)}`}
                delta={`${fmtSigned(-(Number(delta.missed_value_delta) || 0), fmtMoney)} missed $`}
                positive={(Number(delta.missed_value_delta) || 0) > 0}
              />
              <DeltaCard
                label="Legacy-only captures"
                value={fmtInt(legacyOnlyCount)}
                delta={legacyOnlyCount > 0
                  ? `${fmtMoney(delta.legacy_only_value)} in historical value`
                  : "No legacy-only matches"}
                positive={legacyOnlyCount > 0}
                neutral={legacyOnlyCount === 0}
              />
            </div>
          </Card>

          {/* ── Timeline chart ───────────────────────────────────── */}
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Monthly capture rate — active vs all</h2>
              <span className="ml-auto text-[11px] text-muted-foreground">{timeline.length} months</span>
            </div>
            {timeline.length === 0 ? (
              <div className="text-xs text-muted-foreground py-8 text-center">
                No monthly data in this window.
              </div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timeline} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="month" fontSize={10} />
                    <YAxis fontSize={10} tickFormatter={(v) => `${v}%`} domain={[0, 'auto']} />
                    <Tooltip
                      formatter={(value, name) => [`${Number(value).toFixed(2)}%`, name]}
                      labelStyle={{ fontSize: 11 }}
                      contentStyle={{ fontSize: 11 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="active_rate_pct" stroke="#2563eb" name="Active only" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="both_rate_pct"   stroke="#059669" name="Active + legacy" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* ── Legacy-only agents + agencies ────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <LegacyOnlyTable
              title="Top agents — only captured by legacy"
              icon={Users}
              rows={topAgents}
              subtitle="Past relationships worth re-engaging — captured via historical imports, not in active CRM."
              type="agent"
            />
            <LegacyOnlyTable
              title="Top agencies — only captured by legacy"
              icon={Building2}
              rows={topAgencies}
              subtitle="Agency-level past relationships to revisit."
              type="agency"
            />
          </div>

          {/* Footer info */}
          <Card className="p-3 bg-muted/40">
            <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                Legacy captures are matched by normalized <code className="px-1">property_key</code>. Rows are imported
                into <code className="px-1">legacy_projects</code> by the admin wizard at Settings → Legacy Import, then
                surfaced here after the substrate recompute (automatic nightly; manual trigger available post-import).
                When an agent appears here but not in the live Active agency list, they're a prime candidate for outreach.
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function SnapshotCard({ title, subtitle, snapshot, accent, highlight }) {
  const accentMap = {
    blue:    { ring: "ring-blue-200",    bar: "bg-blue-500",    text: "text-blue-700",    bg: "bg-blue-50" },
    emerald: { ring: "ring-emerald-200", bar: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50" },
  };
  const a = accentMap[accent] || accentMap.blue;
  return (
    <Card className={cn("p-4", highlight && `ring-1 ${a.ring}`)}>
      <div className="flex items-center gap-2 mb-3">
        <div className={cn("w-8 h-8 rounded-md flex items-center justify-center", a.bg)}>
          <Target className={cn("h-4 w-4", a.text)} />
        </div>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-2">
        <MetricRow label="Capture rate" value={fmtPct(snapshot.capture_rate_pct)} big accent={a} />
        <MetricRow label="Captured listings" value={fmtInt(snapshot.captured_listings)} />
        <MetricRow label="Missed listings"   value={fmtInt(snapshot.missed_listings)} />
        <MetricRow label="Missed opportunity $" value={fmtMoney(snapshot.missed_opportunity_value)} />
        <MetricRow label="Total listings"    value={fmtInt(snapshot.total_listings)} muted />
      </div>
    </Card>
  );
}

function MetricRow({ label, value, big, muted, accent }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("text-[11px] text-muted-foreground flex-1", muted && "opacity-70")}>{label}</span>
      <span className={cn(
        "tabular-nums font-medium",
        big ? "text-2xl" : "text-sm",
        big && accent?.text,
      )}>{value}</span>
    </div>
  );
}

function DeltaCard({ label, value, delta, positive, neutral }) {
  const toneText = neutral ? "text-muted-foreground" : positive ? "text-emerald-700" : "text-amber-700";
  const toneBg   = neutral ? "bg-muted/40" : positive ? "bg-emerald-50" : "bg-amber-50";
  return (
    <div className={cn("p-2 rounded border", toneBg)}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5 truncate" title={value}>{value}</div>
      <div className={cn("text-[11px] tabular-nums", toneText)}>{delta}</div>
    </div>
  );
}

function LegacyOnlyTable({ title, icon: Icon, rows, subtitle, type }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="secondary" className="ml-auto text-xs">{rows.length}</Badge>
      </div>
      {subtitle && <p className="text-[11px] text-muted-foreground mb-2">{subtitle}</p>}
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          No legacy-only {type === "agent" ? "agents" : "agencies"} in this window.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-1.5 font-medium px-1">#</th>
                <th className="text-left py-1.5 font-medium">{type === "agent" ? "Agent" : "Agency"}</th>
                {type === "agent" && <th className="text-left py-1.5 font-medium">Agency</th>}
                <th className="text-right py-1.5 font-medium">Legacy captures</th>
                <th className="text-right py-1.5 font-medium px-1">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={(r.agent_rea_id || r.agency_rea_id || i) + "_" + i} className="border-b last:border-b-0 hover:bg-muted/40">
                  <td className="py-1.5 px-1 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="py-1.5 font-medium truncate max-w-[220px]" title={r.agent_name || r.agency_name}>
                    {r.agent_name || r.agency_name || "—"}
                  </td>
                  {type === "agent" && (
                    <td className="py-1.5 text-muted-foreground truncate max-w-[200px]" title={r.agency_name}>{r.agency_name || "—"}</td>
                  )}
                  <td className="py-1.5 text-right tabular-nums font-medium text-slate-700">{fmtInt(r.legacy_captures)}</td>
                  <td className="py-1.5 text-right tabular-nums px-1">{fmtMoney(r.legacy_capture_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
