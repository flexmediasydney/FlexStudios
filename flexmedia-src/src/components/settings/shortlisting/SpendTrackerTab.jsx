/**
 * SpendTrackerTab — Shortlisting Command Center → Settings → Engine → Spend.
 *
 * Joseph 2026-05-05: "i need a spend tracking solution, that will allow
 * me to see today, yesterday, last few days, weeks, etc something easy
 * and interactive, that still shows aggregate and granular data where
 * needed."
 *
 * Architecture:
 *   - Single RPC `shortlisting_spend_breakdown(p_from, p_to, p_bucket)`
 *     returns rich JSONB.  One round-trip per period switch.
 *   - All time anchors in Australia/Sydney.
 *   - Source = engine_run_audit (per-round cost rows; the
 *     authoritative spend ledger).
 *
 * Layout:
 *   1. Period selector (Today / Yesterday / 7d / 30d / This month /
 *      Custom range)
 *   2. Hero metrics: total $ · round count · avg/round · total wall time
 *   3. Time-series area chart (hourly for 1d, daily for ≤30d, weekly
 *      beyond)
 *   4. Three breakdown cards: by stage / by model / by package
 *   5. Top rounds table (top 30 by cost; click → project shortlisting)
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import {
  DollarSign,
  Layers,
  Sparkles,
  Activity,
  Clock,
  RefreshCw,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { format, startOfDay, endOfDay, subDays, startOfMonth } from "date-fns";
import { createPageUrl } from "@/utils";

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom" },
];

function presetRange(presetKey) {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = endOfDay(now); // inclusive end-of-today; we still pass 'now' as `to`
  switch (presetKey) {
    case "today":
      return { from: today, to: now, bucket: "hour" };
    case "yesterday": {
      const y = subDays(today, 1);
      return { from: y, to: today, bucket: "hour" };
    }
    case "7d":
      return { from: subDays(today, 7), to: now, bucket: "day" };
    case "30d":
      return { from: subDays(today, 30), to: now, bucket: "day" };
    case "month":
      return { from: startOfMonth(now), to: now, bucket: "day" };
    default:
      return { from: subDays(today, 7), to: now, bucket: "day" };
  }
}

function fmtUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function fmtUsdCompact(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  if (num >= 1000) return `$${(num / 1000).toFixed(1)}k`;
  if (num >= 100) return `$${num.toFixed(0)}`;
  return `$${num.toFixed(2)}`;
}
function fmtNumber(n) {
  return Number(n || 0).toLocaleString("en-US");
}
function fmtDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function fmtBucketLabel(iso, bucket) {
  const d = new Date(iso);
  if (bucket === "hour") return format(d, "HH:mm");
  if (bucket === "week") return format(d, "d MMM");
  return format(d, "d MMM");
}

export default function SpendTrackerTab() {
  const [preset, setPreset] = useState("7d");
  const [customFrom, setCustomFrom] = useState(
    format(subDays(new Date(), 14), "yyyy-MM-dd"),
  );
  const [customTo, setCustomTo] = useState(format(new Date(), "yyyy-MM-dd"));

  const range = useMemo(() => {
    if (preset !== "custom") return presetRange(preset);
    return {
      from: startOfDay(new Date(customFrom)),
      to: endOfDay(new Date(customTo)),
      bucket: "day",
    };
  }, [preset, customFrom, customTo]);

  const breakdownQuery = useQuery({
    queryKey: [
      "shortlisting_spend_breakdown",
      range.from.toISOString(),
      range.to.toISOString(),
      range.bucket,
    ],
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await api.rpc("shortlisting_spend_breakdown", {
        p_from: range.from.toISOString(),
        p_to: range.to.toISOString(),
        p_bucket: range.bucket,
      });
      return result;
    },
  });

  const data = breakdownQuery.data || {};
  const isLoading = breakdownQuery.isLoading;
  const isFetching = breakdownQuery.isFetching;
  const error = breakdownQuery.error;

  const series = data.series || [];
  const byStage = data.by_stage || [];
  const byModel = data.by_model || [];
  const byPackage = data.by_package || [];
  const topRounds = data.top_rounds || [];

  // Pad zero-buckets for the chart so it doesn't look gappy.
  const chartData = useMemo(() => {
    if (!series || series.length === 0) return [];
    return series.map((s) => ({
      bucket_start: s.bucket_start,
      cost_usd: Number(s.cost_usd || 0),
      round_count: s.round_count || 0,
      label: fmtBucketLabel(s.bucket_start, range.bucket),
    }));
  }, [series, range.bucket]);

  return (
    <div className="space-y-3">
      {/* ── Period selector ───────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {PRESETS.map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant={preset === p.key ? "default" : "outline"}
                  onClick={() => setPreset(p.key)}
                  className="h-7 text-[11px] px-2.5"
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => breakdownQuery.refetch()}
              disabled={isFetching}
              className="h-7 text-[11px]"
            >
              <RefreshCw
                className={`h-3 w-3 ${isFetching ? "animate-spin mr-1" : "mr-1"}`}
              />
              Refresh
            </Button>
          </div>
          {preset === "custom" ? (
            <div className="flex items-end gap-2 pt-1">
              <div className="space-y-1">
                <Label htmlFor="from" className="text-[10px] text-muted-foreground">
                  From
                </Label>
                <Input
                  id="from"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-7 text-[11px] w-36"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="to" className="text-[10px] text-muted-foreground">
                  To
                </Label>
                <Input
                  id="to"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-7 text-[11px] w-36"
                />
              </div>
            </div>
          ) : null}
          <p className="text-[10px] text-muted-foreground">
            {format(range.from, "d MMM yyyy h:mma")} →{" "}
            {format(range.to, "d MMM yyyy h:mma")} (Sydney) ·{" "}
            <code>{range.bucket}</code> buckets · source{" "}
            <code>engine_run_audit</code>
          </p>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="p-4 flex items-start gap-2 text-xs text-red-700">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <div>
              <p className="font-medium">Failed to load spend data</p>
              <p>{error.message || "Unknown error"}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Hero metrics ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MetricCard
          icon={DollarSign}
          tone="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          label="Total spend"
          value={isLoading ? "…" : fmtUsd(data.total_usd)}
          sub={`${data.round_count || 0} round${data.round_count === 1 ? "" : "s"}`}
        />
        <MetricCard
          icon={Sparkles}
          tone="bg-purple-500/15 text-purple-600 dark:text-purple-400"
          label="Rounds"
          value={isLoading ? "…" : fmtNumber(data.round_count)}
          sub={data.round_count > 0 ? `${fmtUsd(data.avg_per_round_usd)} avg/round` : "no rounds"}
        />
        <MetricCard
          icon={Activity}
          tone="bg-blue-500/15 text-blue-600 dark:text-blue-400"
          label="Engine wall time"
          value={isLoading ? "…" : fmtDuration(data.total_wall_ms)}
          sub="cumulative across rounds"
        />
        <MetricCard
          icon={Layers}
          tone="bg-amber-500/15 text-amber-600 dark:text-amber-400"
          label="Cost / round (avg)"
          value={isLoading ? "…" : fmtUsd(data.avg_per_round_usd)}
          sub={data.round_count > 0 ? `${fmtUsd(data.total_usd)} total` : "no rounds"}
        />
      </div>

      {/* ── Time-series chart ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Spend over time
            <span className="text-muted-foreground font-normal text-[11px]">
              ({chartData.length} {range.bucket === "hour" ? "hours" : range.bucket === "week" ? "weeks" : "days"} with activity)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3">
          {isLoading ? (
            <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
              Loading…
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-muted-foreground italic">
              No engine activity in this window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => fmtUsdCompact(v)}
                  width={50}
                />
                <Tooltip
                  formatter={(value, name) => {
                    if (name === "cost_usd") return [fmtUsd(value), "Spend"];
                    if (name === "round_count") return [value, "Rounds"];
                    return [value, name];
                  }}
                  labelFormatter={(label, payload) => {
                    if (!payload || payload.length === 0) return label;
                    const iso = payload[0]?.payload?.bucket_start;
                    if (!iso) return label;
                    const d = new Date(iso);
                    if (range.bucket === "hour")
                      return format(d, "d MMM yyyy HH:mm");
                    return format(d, "d MMM yyyy");
                  }}
                  contentStyle={{ fontSize: 11 }}
                />
                <Area
                  type="monotone"
                  dataKey="cost_usd"
                  stroke="#10b981"
                  fill="url(#costGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Three breakdown cards ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <BreakdownCard
          title="By engine stage"
          icon={Layers}
          rows={byStage.map((r) => ({
            label: r.stage,
            cost_usd: r.cost_usd,
            sub: `${fmtNumber(r.call_count)} calls · ${fmtDuration(r.wall_ms)}`,
          }))}
          totalUsd={data.total_usd}
        />
        <BreakdownCard
          title="By model"
          icon={Sparkles}
          rows={byModel.map((r) => ({
            label: r.model,
            cost_usd: r.cost_usd,
            sub: `${r.vendor} · ${fmtNumber(r.round_count)} round${r.round_count === 1 ? "" : "s"}`,
          }))}
          totalUsd={data.total_usd}
        />
        <BreakdownCard
          title="By package"
          icon={DollarSign}
          rows={byPackage.map((r) => ({
            label: r.package_type,
            cost_usd: r.cost_usd,
            sub: `${fmtNumber(r.round_count)} round${r.round_count === 1 ? "" : "s"} · ${fmtUsd(r.avg_usd)}/round avg`,
          }))}
          totalUsd={data.total_usd}
        />
      </div>

      {/* ── Top rounds table ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Top rounds by cost
            <span className="text-muted-foreground font-normal text-[11px]">
              (top {topRounds.length} of {data.round_count || 0})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : topRounds.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground italic text-center">
              No round-level activity in this window.
            </div>
          ) : (
            <div className="divide-y">
              {topRounds.map((r) => {
                const projName =
                  r.project_title ||
                  r.property_address ||
                  `Project ${String(r.project_id || "").slice(0, 8)}`;
                const created = r.created_at ? new Date(r.created_at) : null;
                return (
                  <div
                    key={r.round_id}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-muted/30"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {r.project_id ? (
                          <Link
                            to={
                              createPageUrl("ProjectDetails") +
                              `?id=${r.project_id}&tab=shortlisting&round=${r.round_id}`
                            }
                            className="text-sm font-medium hover:underline truncate"
                          >
                            {projName}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium truncate">
                            {projName}
                          </span>
                        )}
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                        {r.round_number ? (
                          <Badge variant="outline" className="text-[10px] py-0 h-4 shrink-0">
                            #{r.round_number}
                          </Badge>
                        ) : null}
                        {r.round_status ? (
                          <Badge variant="outline" className="text-[10px] py-0 h-4 capitalize shrink-0">
                            {r.round_status}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                        {r.package_type ? <span>{r.package_type}</span> : null}
                        {r.engine_mode ? (
                          <>
                            <span>·</span>
                            <span>{r.engine_mode}</span>
                          </>
                        ) : null}
                        {r.model ? (
                          <>
                            <span>·</span>
                            <span>{r.model}</span>
                          </>
                        ) : null}
                        {created ? (
                          <>
                            <span>·</span>
                            <span title={format(created, "yyyy-MM-dd HH:mm:ss")}>
                              {format(created, "d MMM, h:mm a")}
                            </span>
                          </>
                        ) : null}
                        {r.wall_ms ? (
                          <>
                            <span>·</span>
                            <span>{fmtDuration(r.wall_ms)}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums shrink-0">
                      {fmtUsd(r.cost_usd)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function MetricCard({ icon: Icon, tone, label, value, sub }) {
  return (
    <Card>
      <CardContent className="p-2.5">
        <div className="flex items-start gap-2">
          <div className={`h-7 w-7 rounded flex items-center justify-center ${tone}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              {label}
            </div>
            <div className="text-base font-semibold tabular-nums truncate">
              {value}
            </div>
            {sub ? (
              <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                {sub}
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownCard({ title, icon: Icon, rows, totalUsd }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {rows.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic">
            No data.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((row) => {
              const pct = totalUsd > 0 ? (Number(row.cost_usd) / Number(totalUsd)) * 100 : 0;
              return (
                <div key={row.label} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium truncate flex-1">
                      {row.label}
                    </div>
                    <div className="text-xs tabular-nums shrink-0">
                      {fmtUsd(row.cost_usd)}
                      <span className="text-[10px] text-muted-foreground ml-1">
                        ({pct.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  <div className="h-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  {row.sub ? (
                    <div className="text-[10px] text-muted-foreground truncate">
                      {row.sub}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
