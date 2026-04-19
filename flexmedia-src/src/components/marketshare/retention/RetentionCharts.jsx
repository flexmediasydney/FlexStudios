/**
 * RetentionCharts — three CEO-grade visualisations for the Retention tab.
 *
 *   1. RetentionHeatmap   — months × top-N agents, cells = captured ratio.
 *   2. RetentionScatter   — projects (log) × missed-$ (log), point size ~ listings.
 *                           Identifies high-activity / low-capture outliers.
 *   3. LeakyBucketWaterfall — total in-scope listings peeled by captured vs missed
 *                           by package classification (stacked bars).
 *
 * Each chart is a small pure component; data is pre-shaped via prop hooks.
 */
import React, { useMemo } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, BarChart, Bar, Cell, LineChart, Line, Legend,
  ReferenceLine,
} from "recharts";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fmtMoney, fmtInt } from "./retentionFormat";

// ── 1. Heatmap ──────────────────────────────────────────────────────────────

/**
 * Props
 *   listings: [{ first_seen_at, is_captured, agent_rea_id, agent_name }]
 *   maxAgents?: 30
 */
export function RetentionHeatmap({ listings, maxAgents = 30, onOpenAgent }) {
  const { months, agents, cells } = useMemo(() => buildHeatmap(listings, maxAgents), [listings, maxAgents]);

  if (!listings?.length) {
    return <EmptyChart title="Capture heatmap" hint="No listings in this window." />;
  }

  const cellW = 28;
  const labelW = 160;
  const rowH = 18;

  return (
    <Card className="p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-sm font-semibold">Capture heatmap</h4>
        <span className="text-[11px] text-muted-foreground">
          Top {agents.length} agents × months — green = high capture rate, red = leaky
        </span>
      </div>
      <div className="overflow-x-auto">
        <div style={{ width: labelW + months.length * cellW }}>
          {/* Month header */}
          <div className="flex items-end mb-1" style={{ paddingLeft: labelW }}>
            {months.map((m) => (
              <div key={m.key} style={{ width: cellW }} className="text-[10px] text-muted-foreground text-center truncate">
                {m.label}
              </div>
            ))}
          </div>
          {/* Rows */}
          {agents.map((a) => (
            <div key={a.id} className="flex items-center" style={{ height: rowH }}>
              <button
                type="button"
                className={cn("text-[11px] truncate pr-2 text-left", onOpenAgent ? "hover:underline" : "")}
                style={{ width: labelW }}
                title={a.name}
                onClick={onOpenAgent ? () => onOpenAgent(a) : undefined}
              >
                {a.name}
              </button>
              {months.map((m) => {
                const c = cells[`${a.id}|${m.key}`];
                const bg = c ? heatColor(c.rate, c.n) : "transparent";
                const title = c
                  ? `${a.name} · ${m.label} — ${c.captured}/${c.n} captured (${c.rate.toFixed(0)}%)`
                  : `${a.name} · ${m.label} — no listings`;
                return (
                  <div
                    key={m.key}
                    style={{ width: cellW - 2, height: rowH - 2, background: bg, marginRight: 2, borderRadius: 2 }}
                    title={title}
                  />
                );
              })}
            </div>
          ))}
          {/* Legend */}
          <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
            <span>Low capture</span>
            <div className="flex h-2">
              {[0.0, 0.2, 0.4, 0.6, 0.8, 1.0].map((r) => (
                <div key={r} style={{ width: 22, background: heatColor(r * 100, 5) }} />
              ))}
            </div>
            <span>High capture</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function heatColor(ratePct, n) {
  if (!n) return "transparent";
  const r = Math.max(0, Math.min(100, ratePct)) / 100;
  // red(239,68,68) → amber(245,158,11) → emerald(16,185,129)
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  let rr, gg, bb;
  if (r < 0.5) {
    const t = r / 0.5;
    rr = lerp(239, 245, t); gg = lerp(68,  158, t); bb = lerp(68,  11,  t);
  } else {
    const t = (r - 0.5) / 0.5;
    rr = lerp(245, 16,  t); gg = lerp(158, 185, t); bb = lerp(11,  129, t);
  }
  // opacity scales with n (saturation of information)
  const alpha = Math.min(1, 0.35 + Math.log2(n + 1) * 0.2);
  return `rgba(${rr},${gg},${bb},${alpha.toFixed(2)})`;
}

function buildHeatmap(listings, maxAgents) {
  const byAgent = new Map();   // rea_id -> { id, name, total, months: Map }
  const monthSet = new Set();

  for (const l of (listings || [])) {
    if (!l.agent_rea_id) continue;
    const dt = new Date(l.first_seen_at);
    if (isNaN(dt)) continue;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    monthSet.add(key);
    let a = byAgent.get(l.agent_rea_id);
    if (!a) {
      a = { id: l.agent_rea_id, name: l.agent_name || l.agent_rea_id, total: 0, captured: 0, months: new Map() };
      byAgent.set(l.agent_rea_id, a);
    }
    a.total += 1;
    if (l.is_captured) a.captured += 1;
    const m = a.months.get(key) || { n: 0, captured: 0 };
    m.n += 1;
    if (l.is_captured) m.captured += 1;
    a.months.set(key, m);
  }

  const agents = [...byAgent.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxAgents);

  const months = [...monthSet].sort().map((k) => {
    const [y, m] = k.split("-").map(Number);
    return {
      key: k,
      label: new Date(y, m - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "2-digit" }),
    };
  });

  const cells = {};
  for (const a of agents) {
    for (const [mk, mv] of a.months.entries()) {
      const rate = mv.n > 0 ? 100 * mv.captured / mv.n : 0;
      cells[`${a.id}|${mk}`] = { ...mv, rate };
    }
  }
  return { months, agents, cells };
}

// ── 2. Scatter: high-activity / low-capture outliers ────────────────────────

/**
 * Props
 *   rows: [{ agent_rea_id, agent_name, projects_in_scope, listings_in_window,
 *            listings_missed, missed_opportunity_value, retention_rate_pct }]
 */
export function RetentionScatter({ rows, onOpenAgent }) {
  const data = useMemo(() => {
    return (rows || []).filter(r =>
      Number(r.listings_in_window) > 0 || Number(r.projects_in_scope) > 0
    ).map(r => ({
      x: Math.max(1, Number(r.projects_in_scope) || 0) + 1,          // +1 so log scale always works
      y: Math.max(1, Number(r.missed_opportunity_value) || 0) + 1,
      z: Math.max(4, Number(r.listings_in_window) || 1),
      name: r.agent_name,
      rea_id: r.agent_rea_id,
      agent_pulse_id: r.agent_pulse_id,
      missed: r.listings_missed,
      captured: r.listings_captured,
      rate: r.retention_rate_pct,
    }));
  }, [rows]);

  if (!data.length) return <EmptyChart title="Opportunity scatter" hint="No activity in this window." />;

  return (
    <Card className="p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-sm font-semibold">High-activity / low-capture outliers</h4>
        <span className="text-[11px] text-muted-foreground">
          Upper-right = biggest recovery targets. Point size = listings in window.
        </span>
      </div>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis
              type="number" dataKey="x" name="Projects in scope" scale="log" domain={[1, "auto"]}
              tick={{ fontSize: 10 }}
              label={{ value: "Projects in scope (log)", position: "insideBottom", offset: -8, fontSize: 10, fill: "#6b7280" }}
            />
            <YAxis
              type="number" dataKey="y" name="Missed $" scale="log" domain={[1, "auto"]}
              tick={{ fontSize: 10 }} tickFormatter={(v) => v > 1 ? fmtMoney(v) : "$0"}
              label={{ value: "Missed $ (log)", angle: -90, position: "insideLeft", offset: 10, fontSize: 10, fill: "#6b7280" }}
            />
            <ZAxis type="number" dataKey="z" range={[40, 400]} />
            <Tooltip content={<ScatterTooltip />} />
            <Scatter data={data} onClick={(pt) => onOpenAgent && onOpenAgent({ agent_rea_id: pt.rea_id, agent_name: pt.name, agent_pulse_id: pt.agent_pulse_id })}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.rate >= 70 ? "#10b981" : d.rate >= 40 ? "#f59e0b" : "#ef4444"} fillOpacity={0.75} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function ScatterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white border rounded shadow px-2 py-1 text-[11px]">
      <div className="font-semibold">{d.name}</div>
      <div className="text-muted-foreground">Projects: {fmtInt(d.x - 1)} · Listings: {fmtInt(d.z)}</div>
      <div className="text-muted-foreground">Missed: {fmtInt(d.missed)} · Captured: {fmtInt(d.captured)}</div>
      <div className="text-amber-700">Missed $: {fmtMoney(d.y - 1)}</div>
      <div>Retention: {Number(d.rate).toFixed(1)}%</div>
    </div>
  );
}

// ── 3. Leaky bucket waterfall by package ────────────────────────────────────

/**
 * Props
 *   listings: [{ is_captured, package }]
 */
export function LeakyBucketWaterfall({ listings }) {
  const data = useMemo(() => {
    const by = new Map();
    for (const l of listings || []) {
      const pkg = (l.package || "Unclassified").replace(" Package", "");
      let row = by.get(pkg);
      if (!row) { row = { package: pkg, captured: 0, missed: 0 }; by.set(pkg, row); }
      if (l.is_captured) row.captured += 1;
      else row.missed += 1;
    }
    return [...by.values()].sort((a, b) => (b.captured + b.missed) - (a.captured + a.missed));
  }, [listings]);

  if (!data.length) return <EmptyChart title="Leaky bucket by package" hint="No listings in this window." />;

  return (
    <Card className="p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-sm font-semibold">Leaky bucket by package</h4>
        <span className="text-[11px] text-muted-foreground">
          Where the listings flow — captured (green) vs missed (amber).
        </span>
      </div>
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="package" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(v, n) => [fmtInt(v), n === "captured" ? "Captured" : "Missed"]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="captured" stackId="a" fill="#10b981" name="Captured" />
            <Bar dataKey="missed"   stackId="a" fill="#f59e0b" name="Missed"   />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ── 4. Weekly capture trend (sparkline-style) ───────────────────────────────

/**
 * Props
 *   listings: [{ first_seen_at, is_captured }] across last 12 weeks (or longer, we'll slice)
 */
export function WeeklyCaptureTrend({ listings }) {
  const data = useMemo(() => {
    const now = new Date();
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const ws = new Date(now); ws.setHours(0,0,0,0); ws.setDate(ws.getDate() - (7 * i));
      const dow = ws.getDay(); ws.setDate(ws.getDate() - (dow === 0 ? 6 : dow - 1));
      const we = new Date(ws); we.setDate(ws.getDate() + 7);
      weeks.push({ ws, we, label: ws.toLocaleDateString("en-AU", { month: "short", day: "numeric" }), total: 0, captured: 0 });
    }
    for (const l of listings || []) {
      const dt = new Date(l.first_seen_at);
      const wk = weeks.find(w => dt >= w.ws && dt < w.we);
      if (!wk) continue;
      wk.total += 1;
      if (l.is_captured) wk.captured += 1;
    }
    return weeks.map(w => ({ label: w.label, rate: w.total > 0 ? (100 * w.captured / w.total) : 0, total: w.total }));
  }, [listings]);

  if (!listings?.length) return null;

  return (
    <Card className="p-3">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-sm font-semibold">Capture rate — last 12 weeks</h4>
        <span className="text-[11px] text-muted-foreground">% of in-scope listings with a project</span>
      </div>
      <div style={{ width: "100%", height: 120 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} />
            <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip
              contentStyle={{ fontSize: 11 }}
              formatter={(v, n, p) => [`${Number(v).toFixed(1)}% (n=${p.payload.total})`, "Capture rate"]}
            />
            <ReferenceLine y={70} stroke="#10b981" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="rate" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function EmptyChart({ title, hint }) {
  return (
    <Card className="p-3">
      <h4 className="text-sm font-semibold mb-1">{title}</h4>
      <div className="text-[11px] text-muted-foreground py-6 text-center">{hint}</div>
    </Card>
  );
}
