/**
 * SettingsEngineOverridePatterns — W11.6.10 admin dashboard.
 *
 * Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md
 * URL: /SettingsEngineOverridePatterns
 * Permission: master_admin / admin.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AlertTriangle, ChevronRight, DollarSign, Sparkles, TrendingUp, Activity, ListChecks, Database, Layers, Pin } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtUsd(n){if(n==null||!Number.isFinite(Number(n)))return "$0.00";const v=Number(n);if(v<0.01)return `$${v.toFixed(4)}`;if(v<1)return `$${v.toFixed(3)}`;return `$${v.toFixed(2)}`;}
function fmtPct(n){if(n==null||!Number.isFinite(Number(n)))return "—";return `${(Number(n)*100).toFixed(1)}%`;}
function fmtSec(n){if(n==null||!Number.isFinite(Number(n)))return "—";const v=Number(n);if(v<60)return `${v.toFixed(1)}s`;return `${(v/60).toFixed(1)}m`;}
function heatColor(rate){if(rate==null)return "bg-slate-50 text-slate-400";if(rate>=0.15)return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-200";if(rate>=0.05)return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200";}

export function useAnalyticsPayload({dateRangeDays,packageFilter,tierFilter}){
  return useQuery({
    queryKey:["engine_override_analytics",dateRangeDays,packageFilter,tierFilter],
    queryFn: async () => {
      const r = await api.functions.invoke("engine-override-analytics",{date_range_days:dateRangeDays,package_filter:packageFilter||undefined,tier_filter:tierFilter||undefined});
      if(r?.error) throw new Error(r.error.message||r.error.body?.error||"fetch failed");
      return r?.data ?? r;
    },
    staleTime:60000, keepPreviousData:true,
  });
}

function KpiCards({kpis,daysBack}){
  const cards=[
    {label:"Total overrides",value:kpis?.total_overrides??0,hint:`last ${daysBack} days`,icon:AlertTriangle,tone:"text-blue-600"},
    {label:"Override rate",value:fmtPct(kpis?.override_rate),hint:"of AI proposals",icon:Activity,tone:kpis?.override_rate>0.15?"text-red-600":"text-blue-600"},
    {label:"Avg review duration",value:fmtSec(kpis?.avg_review_duration_seconds),hint:"operator friction signal",icon:TrendingUp,tone:"text-slate-600"},
    {label:"Confirmed-with-review",value:fmtPct(kpis?.confirmed_with_review_pct),hint:"% reviewed >30s",icon:ListChecks,tone:"text-emerald-600"},
  ];
  return (<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{cards.map(c=>(
    <Card key={c.label}><CardContent className="p-3">
      <div className="flex items-center justify-between"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</div><c.icon className={cn("h-3.5 w-3.5",c.tone)}/></div>
      <div className="text-xl font-bold tabular-nums mt-1">{c.value}</div>
      <div className="text-[10px] text-muted-foreground">{c.hint}</div>
    </CardContent></Card>
  ))}</div>);
}

function FiltersBar({dateRangeDays,setDateRangeDays,packageFilter,setPackageFilter,tierFilter,setTierFilter}){
  return (<Card><CardContent className="p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
    <div><Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Date range</Label>
      <Select value={String(dateRangeDays)} onValueChange={v=>setDateRangeDays(Number(v))}>
        <SelectTrigger className="h-8 text-xs mt-1"><SelectValue/></SelectTrigger>
        <SelectContent>
          <SelectItem value="7" className="text-xs">Last 7 days</SelectItem>
          <SelectItem value="30" className="text-xs">Last 30 days</SelectItem>
          <SelectItem value="90" className="text-xs">Last 90 days</SelectItem>
          <SelectItem value="180" className="text-xs">Last 6 months</SelectItem>
          <SelectItem value="365" className="text-xs">Last year</SelectItem>
        </SelectContent>
      </Select></div>
    <div><Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Package</Label>
      <Select value={packageFilter||"all"} onValueChange={v=>setPackageFilter(v==="all"?"":v)}>
        <SelectTrigger className="h-8 text-xs mt-1"><SelectValue placeholder="All packages"/></SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">All packages</SelectItem>
          <SelectItem value="Gold Package" className="text-xs">Gold Package</SelectItem>
          <SelectItem value="Silver Package" className="text-xs">Silver Package</SelectItem>
          <SelectItem value="Bronze Package" className="text-xs">Bronze Package</SelectItem>
        </SelectContent>
      </Select></div>
    <div><Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Property tier</Label>
      <Select value={tierFilter||"all"} onValueChange={v=>setTierFilter(v==="all"?"":v)}>
        <SelectTrigger className="h-8 text-xs mt-1"><SelectValue placeholder="All tiers"/></SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">All tiers</SelectItem>
          <SelectItem value="premium" className="text-xs">Premium</SelectItem>
          <SelectItem value="standard" className="text-xs">Standard</SelectItem>
          <SelectItem value="approachable" className="text-xs">Approachable</SelectItem>
        </SelectContent>
      </Select></div>
  </CardContent></Card>);
}

function InsufficientPlaceholder({daysUntilReady,sectionName}){
  return (<div className="rounded-md bg-slate-50 dark:bg-slate-900/30 border border-dashed border-slate-200 dark:border-slate-800 p-4 text-center">
    <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Insufficient data</div>
    <div className="text-xs text-muted-foreground mt-1">{sectionName} needs more history. Re-render in {daysUntilReady} day{daysUntilReady===1?"":"s"}.</div>
  </div>);
}

function SectionACohortGrid({data}){
  const rowKeys = useMemo(()=>{const s=new Set();for(const c of data?.cells||[])s.add(c.room_type);return Array.from(s).sort();},[data]);
  const colKeys = useMemo(()=>{const s=new Set();for(const c of data?.cells||[])s.add(`${c.property_tier}|${c.engine_role}`);return Array.from(s).sort();},[data]);
  const cellMap = useMemo(()=>{const m=new Map();for(const c of data?.cells||[])m.set(`${c.room_type}|${c.property_tier}|${c.engine_role}`,c);return m;},[data]);
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><Pin className="h-4 w-4 text-blue-600"/>Section A — Override-rate cohort grid</CardTitle>
    <CardDescription className="text-xs">Override rate per (room_type × property_tier × engine_role). Green &lt;5%; amber 5-15%; red &gt;15%.</CardDescription>
  </CardHeader><CardContent>
    {(data?.cells||[]).length===0 ? <div className="text-sm text-muted-foreground italic">No proposals in window.</div> : (
      <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead><tr><th className="text-left p-1 font-medium text-muted-foreground">Room type</th>
          {colKeys.map(c=><th key={c} className="text-center p-1 font-medium text-muted-foreground capitalize">{c.replace("|"," · ").replace("shape_d","Shape D")}</th>)}
        </tr></thead>
        <tbody>{rowKeys.map(row=>(<tr key={row}>
          <td className="p-1 font-medium capitalize">{row.replace(/_/g," ")}</td>
          {colKeys.map(c=>{const [tier,role]=c.split("|");const cell=cellMap.get(`${row}|${tier}|${role}`);return (
            <td key={c} className={cn("p-1 text-center tabular-nums font-mono rounded",cell?heatColor(cell.rate):"bg-slate-50 text-slate-300")} title={cell?`${cell.total_overrides}/${cell.total_proposals} overrides`:"—"}>
              {cell?`${(cell.rate*100).toFixed(0)}%`:"—"}
              {cell?<div className="text-[9px] opacity-75">n={cell.total_proposals}</div>:null}
            </td>);})}
        </tr>))}</tbody>
      </table></div>
    )}
  </CardContent></Card>);
}

function SectionBTimeline({data}){
  const points=data?.points||[];
  const max=Math.max(0.001,...points.map(p=>p.override_rate));
  const showInsuff=data?.insufficient && data?.days_until_ready>0;
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-blue-600"/>Section B — Override-rate timeline</CardTitle>
    <CardDescription className="text-xs">Daily override rate split by source: stage1 corrections vs stage4 visual overrides.</CardDescription>
  </CardHeader><CardContent>
    {showInsuff ? <InsufficientPlaceholder daysUntilReady={data.days_until_ready} sectionName="The override-rate timeline"/> : (
      <div className="space-y-3">
        <div className="flex items-end gap-[2px] h-20 border-b border-l">{points.map(p=>{
          const tot=(p.stage1_corrections||0)+(p.stage4_visual_overrides||0);
          const h=max>0?(p.override_rate/max)*100:0;
          return (<div key={p.date} className="flex-1 flex flex-col-reverse" title={`${p.date}: ${(p.override_rate*100).toFixed(1)}% (${tot}/${p.total_proposals})`}>
            <div className="bg-blue-400 dark:bg-blue-700" style={{height:`${h}%`,minHeight:tot>0?1:0}}/>
          </div>);
        })}</div>
        <div className="flex justify-between text-[9px] text-muted-foreground"><span>{points[0]?.date}</span><span>today</span></div>
      </div>
    )}
  </CardContent></Card>);
}

function SectionCTierConfigTracker({data,daysBack}){
  const events=data?.events||[];
  const showInsuff=data?.insufficient && data?.days_until_ready>0;
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-amber-600"/>Section C — Tier-config events</CardTitle>
    <CardDescription className="text-xs">Each activation marks a tick; correlate with rate changes.</CardDescription>
  </CardHeader><CardContent>
    {showInsuff ? <InsufficientPlaceholder daysUntilReady={data.days_until_ready} sectionName="The tier-config impact tracker"/>
      : events.length===0 ? <div className="text-sm text-muted-foreground italic">No tier_config activations in the last {daysBack} days.</div>
      : (<ul className="text-xs space-y-1.5">{events.map(e=>(
        <li key={`${e.tier_id}-${e.version}-${e.activated_at}`} className="border-l-2 border-amber-400 pl-2">
          <div className="flex items-center gap-2">
            <span className="font-mono tabular-nums">{(e.activated_at||"").slice(0,10)}</span>
            <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">v{e.version}</Badge>
            <span className="text-muted-foreground font-mono">{e.tier_id.slice(0,8)}</span>
          </div>
          {e.notes ? <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{e.notes}</div> : null}
        </li>
      ))}</ul>)}
    <div className="mt-3 text-[11px]">
      <Link to="/SettingsShortlistingCommandCenter?tab=engine-settings" className="text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
        Open Engine Settings<ChevronRight className="h-3 w-3"/></Link>
    </div>
  </CardContent></Card>);
}

function SectionDProblemRounds({data}){
  const rows=data?.rows||[];
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-red-600"/>Section D — Top problem rounds</CardTitle>
    <CardDescription className="text-xs">Highest override-rate rounds (≥3 proposals).</CardDescription>
  </CardHeader><CardContent>
    {rows.length===0 ? <div className="text-sm text-muted-foreground italic">No outlier rounds.</div> : (
      <table className="w-full text-xs"><thead><tr className="text-[10px] uppercase text-muted-foreground">
        <th className="text-left p-1">Project</th><th className="text-left p-1">Package</th><th className="text-left p-1">Tier</th>
        <th className="text-right p-1">Rate</th><th className="text-right p-1">n</th><th className="text-left p-1">Common signals</th><th className="text-right p-1">Action</th>
      </tr></thead><tbody>{rows.slice(0,10).map(r=>(
        <tr key={r.round_id} className="border-t">
          <td className="p-1"><Link to={`/ShortlistingCommandCenter?round_id=${r.round_id}`} className="text-blue-700 dark:text-blue-400 hover:underline">{r.project_title||r.property_address||r.project_id.slice(0,8)}</Link></td>
          <td className="p-1">{r.package}</td><td className="p-1">{r.tier}</td>
          <td className={cn("p-1 text-right font-mono tabular-nums",r.override_rate>=0.4 && "text-red-600",r.override_rate>=0.15 && r.override_rate<0.4 && "text-amber-600")}>{fmtPct(r.override_rate)}</td>
          <td className="p-1 text-right text-muted-foreground tabular-nums">{r.total_proposals}</td>
          <td className="p-1"><span className="text-[10px] text-muted-foreground">{(r.common_signals||[]).join(", ")||"—"}</span></td>
          <td className="p-1 text-right"><Button variant="outline" size="sm" className="h-6 text-[10px]">Schedule W14</Button></td>
        </tr>))}</tbody></table>
    )}
  </CardContent></Card>);
}

function SectionEReclassPatterns({data}){
  const patterns=data?.patterns||[];
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><Layers className="h-4 w-4 text-purple-600"/>Section E — Reclassification patterns</CardTitle>
    <CardDescription className="text-xs">Stage 1 → human room_type corrections grouped by source.</CardDescription>
  </CardHeader><CardContent>
    {data?.degraded ? (
      <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs">
        <div className="font-medium text-amber-800 dark:text-amber-300">W11.6.9 not yet shipped</div>
        <div className="text-muted-foreground mt-1">composition_classification_overrides not readable yet.</div>
      </div>
    ) : patterns.length===0 ? <div className="text-sm text-muted-foreground italic">No reclassifications in window.</div>
    : (<table className="w-full text-xs"><thead><tr className="text-[10px] uppercase text-muted-foreground">
        <th className="text-left p-1">AI value</th><th className="text-left p-1">Human value</th><th className="text-left p-1">Source</th><th className="text-right p-1">Count</th>
      </tr></thead><tbody>{patterns.slice(0,15).map((p,i)=>(
        <tr key={i} className="border-t">
          <td className="p-1 font-mono">{p.ai_value}</td>
          <td className="p-1 font-mono">{p.human_value}</td>
          <td className="p-1"><Badge className={cn("text-[10px] h-5",p.override_source==="stage1_correction"?"bg-blue-100 text-blue-800":"bg-purple-100 text-purple-800")}>{p.override_source}</Badge></td>
          <td className="p-1 text-right tabular-nums">{p.count}</td>
        </tr>))}</tbody></table>)}
  </CardContent></Card>);
}

function SectionFStage4Corrections({data}){
  const patterns=data?.patterns||[];
  const trend=data?.trend||[];
  const trendMax=Math.max(1,...trend.map(t=>t.count));
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-blue-600"/>Section F — Stage 4 self-corrections (Shape D)</CardTitle>
    <CardDescription className="text-xs">High operator-confirm rate = trustworthy.</CardDescription>
  </CardHeader><CardContent className="space-y-4">
    {patterns.length===0 && trend.length===0 ? <div className="text-sm text-muted-foreground italic">No Stage 4 corrections yet.</div> : (<>
      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trend (weekly)</div>
        <div className="flex items-end gap-1 h-12 border-b border-l">
          {trend.map(t=><div key={t.week} className="flex-1 bg-blue-300 dark:bg-blue-800 rounded-t" style={{height:`${(t.count/trendMax)*100}%`}} title={`${t.week}: ${t.count}`}/>)}
        </div>
      </div>
      <table className="w-full text-xs"><thead><tr className="text-[10px] uppercase text-muted-foreground">
        <th className="text-left p-1">Field</th><th className="text-left p-1">Stage 1 → Stage 4</th><th className="text-right p-1">Count</th><th className="text-right p-1">Confirm rate</th>
      </tr></thead><tbody>{patterns.slice(0,10).map((p,i)=>(
        <tr key={i} className="border-t">
          <td className="p-1 font-mono">{p.field}</td>
          <td className="p-1 font-mono"><span className="text-muted-foreground">{p.stage1_value}</span><span className="mx-1">→</span><span>{p.stage4_value}</span></td>
          <td className="p-1 text-right tabular-nums">{p.count}</td>
          <td className={cn("p-1 text-right tabular-nums",p.operator_confirm_rate>=0.7 && "text-emerald-600",p.operator_confirm_rate<0.5 && p.approved+p.rejected>0 && "text-red-600")}>
            {p.approved+p.rejected===0 ? <span className="text-muted-foreground">pending</span> : fmtPct(p.operator_confirm_rate)}
          </td>
        </tr>))}</tbody></table>
      <Link to="/Stage4Overrides" className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
        Open Stage 4 review queue<ChevronRight className="h-3 w-3"/></Link>
    </>)}
  </CardContent></Card>);
}

function SectionGVoiceTier({data}){
  const tiers=["premium","standard","approachable"];
  const total=data?.total??0;
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4 text-amber-600"/>Section G — Voice tier distribution</CardTitle>
    <CardDescription className="text-xs">% rounds per property_tier + voice_anchor_used breakdown.</CardDescription>
  </CardHeader><CardContent>
    {total===0 ? <div className="text-sm text-muted-foreground italic">No master listings synthesised yet.</div> : (
      <div className="space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">By tier</div>
          <div className="h-6 rounded overflow-hidden flex border">
            {tiers.map(t=>{const v=data?.tier_share?.[t]||0;if(v===0)return null;
              const cls=t==="premium"?"bg-purple-300 dark:bg-purple-700":t==="standard"?"bg-blue-300 dark:bg-blue-700":"bg-emerald-300 dark:bg-emerald-700";
              return (<div key={t} className={cls} style={{width:`${v*100}%`}} title={`${t}: ${data.by_tier[t]||0} (${fmtPct(v)})`}/>);
            })}
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] mt-1.5">
            {tiers.map(t=><div key={t} className="text-muted-foreground"><span className="capitalize font-medium text-foreground">{t}</span>: {data?.by_tier?.[t]||0} ({fmtPct(data?.tier_share?.[t]||0)})</div>)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Voice anchor</div>
          <ul className="text-[11px] space-y-0.5">{Object.entries(data?.by_anchor||{}).map(([k,v])=>(
            <li key={k} className="flex justify-between">
              <span className="capitalize">{k.replace(/_/g," ")}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{v} · {fmtPct(v/total)}</span>
            </li>))}</ul>
        </div>
      </div>
    )}
  </CardContent></Card>);
}

function SectionHRegistryCoverage({data}){
  const counts=data?.counts;
  const top=data?.top_unresolved||[];
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4 text-purple-600"/>Section H — Canonical registry coverage</CardTitle>
    <CardDescription className="text-xs">Discovery queue health + observation resolution rate.</CardDescription>
  </CardHeader><CardContent>
    {data?.degraded ? (
      <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs">
        <div className="font-medium text-amber-800 dark:text-amber-300">W11.6.11 not yet shipped</div>
        <div className="text-muted-foreground mt-1">object_registry_candidates not readable yet.</div>
      </div>
    ) : !counts ? <div className="text-sm text-muted-foreground italic">No registry data.</div> : (
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="border rounded p-2 bg-amber-50/50 dark:bg-amber-950/20"><div className="text-[10px] text-muted-foreground">Pending review</div><div className="font-mono text-base font-semibold">{counts.pending}</div></div>
          <div className="border rounded p-2 bg-emerald-50/50 dark:bg-emerald-950/20"><div className="text-[10px] text-muted-foreground">Promoted</div><div className="font-mono text-base font-semibold">{counts.promoted}</div></div>
          <div className="border rounded p-2 bg-red-50/50 dark:bg-red-950/20"><div className="text-[10px] text-muted-foreground">Rejected</div><div className="font-mono text-base font-semibold">{counts.rejected}</div></div>
          <div className="border rounded p-2 bg-slate-50"><div className="text-[10px] text-muted-foreground">Deferred</div><div className="font-mono text-base font-semibold">{counts.deferred}</div></div>
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-3 pt-2 border-t">
          <span>Canonical objects (active): <span className="font-mono">{counts.total_canonical}</span></span>
          <span>·</span>
          <span>Observations resolved: <span className="font-mono">{counts.resolved_observations}/{counts.total_observations}</span> ({fmtPct(counts.resolved_pct)})</span>
        </div>
        {top.length>0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-2 mb-1">Top 10 unresolved labels</div>
            <ul className="text-xs space-y-0.5">{top.map(u=>(
              <li key={u.label} className="flex justify-between border-b border-dashed border-slate-100 dark:border-slate-800 py-0.5">
                <span className="font-mono text-foreground">{u.display_name}</span>
                <Link to={`/SettingsObjectRegistryDiscovery?search=${encodeURIComponent(u.label)}`} className="font-mono tabular-nums text-blue-700 dark:text-blue-400 hover:underline">{u.count}× → promote</Link>
              </li>))}</ul>
          </div>
        ) : null}
        <Link to="/SettingsObjectRegistryDiscovery" className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
          Open discovery queue<ChevronRight className="h-3 w-3"/></Link>
      </div>
    )}
  </CardContent></Card>);
}

function SectionICostPerStage({data}){
  const summary=data?.summary;
  const stacked=data?.stacked||[];
  const showInsuff=data?.insufficient && data?.days_until_ready>0;
  const totalMax=Math.max(0.001,...stacked.map(p=>p.total_usd));
  return (<Card><CardHeader className="pb-2">
    <CardTitle className="text-base flex items-center gap-2"><DollarSign className="h-4 w-4 text-emerald-600"/>Section I — Cost-per-stage attribution</CardTitle>
    <CardDescription className="text-xs">Stage 1 batch enrichment vs Stage 4 master synthesis. p50/p95/p99 per round.</CardDescription>
  </CardHeader><CardContent>
    {showInsuff ? <InsufficientPlaceholder daysUntilReady={data.days_until_ready} sectionName="Cost trend chart"/>
    : !summary ? <div className="text-sm text-muted-foreground italic">No engine_run_audit rows.</div>
    : (<div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">Stage 1 total</div><div className="font-mono text-sm font-semibold">{fmtUsd(summary.stage1_total)}</div></div>
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">Stage 4 total</div><div className="font-mono text-sm font-semibold">{fmtUsd(summary.stage4_total)}</div></div>
          <div className="border rounded p-2 bg-emerald-50/50 dark:bg-emerald-950/20">
            <div className="text-[10px] text-muted-foreground">Total spend</div>
            <div className="font-mono text-sm font-semibold">{fmtUsd(summary.total)}</div>
            <div className="text-[10px] text-muted-foreground">Shape D: {fmtUsd(summary.shape_d_total)} ({summary.shape_d_count} rounds)</div>
          </div>
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">Per-round avg</div><div className="font-mono text-sm font-semibold">{fmtUsd(summary.per_round_avg)}</div></div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">p50</div><div className="font-mono text-sm">{fmtUsd(summary.per_round_p50)}</div></div>
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">p95</div><div className="font-mono text-sm">{fmtUsd(summary.per_round_p95)}</div></div>
          <div className="border rounded p-2"><div className="text-[10px] text-muted-foreground">p99</div><div className="font-mono text-sm">{fmtUsd(summary.per_round_p99)}</div></div>
        </div>
        {stacked.length>0 ? (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Daily spend (stacked: stage1 + stage4)</div>
            <div className="flex items-end gap-1 h-16 border-b border-l">{stacked.map(p=>{
              const tH=(p.total_usd/totalMax)*100;
              const sH=(p.stage1_usd/totalMax)*100;
              return (<div key={p.date} className="flex-1 flex flex-col-reverse" title={`${p.date}: ${fmtUsd(p.total_usd)} total · S1 ${fmtUsd(p.stage1_usd)} · S4 ${fmtUsd(p.stage4_usd)} · ${p.round_count} rounds`}>
                <div className="bg-blue-400 dark:bg-blue-700" style={{height:`${sH}%`}}/>
                <div className="bg-purple-400 dark:bg-purple-700" style={{height:`${Math.max(0,tH-sH)}%`}}/>
              </div>);
            })}</div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-400 dark:bg-blue-700"/>Stage 1</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-purple-400 dark:bg-purple-700"/>Stage 4</span>
            </div>
          </div>
        ) : null}
      </div>)}
  </CardContent></Card>);
}

export default function SettingsEngineOverridePatterns(){
  const [dateRangeDays,setDateRangeDays]=useState(30);
  const [packageFilter,setPackageFilter]=useState("");
  const [tierFilter,setTierFilter]=useState("");
  const {data,isLoading,error,refetch,isFetching}=useAnalyticsPayload({dateRangeDays,packageFilter,tierFilter});
  const sections=data?.sections;
  return (<PermissionGuard require={["master_admin","admin"]}>
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">Engine override patterns</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Master_admin analytics surface. Spot patterns in operator overrides, Stage 4 self-corrections,
            voice tier drift, canonical registry coverage, and per-stage cost.
          </p>
          {data?.as_of ? (
            <div className="text-[11px] text-muted-foreground mt-1">
              Last refreshed {new Date(data.as_of).toLocaleString()} · {data.elapsed_ms}ms aggregate ·{" "}
              {data.meta?.total_rounds_in_window||0} rounds, {data.meta?.total_classifications_in_window||0} proposals
            </div>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={()=>refetch()} disabled={isFetching} className="text-xs">
          {isFetching?"Refreshing…":"Refresh"}
        </Button>
      </div>
      <FiltersBar
        dateRangeDays={dateRangeDays} setDateRangeDays={setDateRangeDays}
        packageFilter={packageFilter} setPackageFilter={setPackageFilter}
        tierFilter={tierFilter} setTierFilter={setTierFilter}/>
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Skeleton className="h-32 w-full"/><Skeleton className="h-32 w-full"/><Skeleton className="h-32 w-full"/><Skeleton className="h-32 w-full"/>
        </div>
      ) : error ? (
        <Card className="border-red-200 bg-red-50/40 dark:bg-red-950/20">
          <CardContent className="p-4 text-sm text-red-800 dark:text-red-300">Failed to load analytics: {String(error.message||error)}</CardContent>
        </Card>
      ) : data && !data.ok ? (
        <Card className="border-amber-200"><CardContent className="p-4 text-sm">Backend returned ok=false.</CardContent></Card>
      ) : (<>
        <KpiCards kpis={data?.kpis} daysBack={dateRangeDays}/>
        <SectionACohortGrid data={sections?.A_cohort_grid}/>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2"><SectionBTimeline data={sections?.B_timeline}/></div>
          <SectionCTierConfigTracker data={sections?.C_tier_config_events} daysBack={dateRangeDays}/>
        </div>
        <SectionDProblemRounds data={sections?.D_problem_rounds}/>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <SectionEReclassPatterns data={sections?.E_reclassification_patterns}/>
          <SectionFStage4Corrections data={sections?.F_stage4_self_corrections}/>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <SectionGVoiceTier data={sections?.G_voice_tier_distribution}/>
          <SectionHRegistryCoverage data={sections?.H_canonical_registry_coverage}/>
        </div>
        <SectionICostPerStage data={sections?.I_cost_per_stage}/>
        {data?.fetch_errors ? (
          <Card className="border-amber-200 bg-amber-50/40 dark:bg-amber-950/20">
            <CardContent className="p-3 text-xs text-amber-800 dark:text-amber-300">
              <strong>Partial-fetch warnings:</strong>
              <ul className="mt-1 space-y-0.5">{Object.entries(data.fetch_errors).map(([k,v])=>(<li key={k}><span className="font-mono">{k}</span>: {String(v)}</li>))}</ul>
            </CardContent>
          </Card>
        ) : null}
      </>)}
    </div>
  </PermissionGuard>);
}

export {fmtUsd, fmtPct, fmtSec, heatColor};
