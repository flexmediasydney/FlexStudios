/**
 * EngineDashboard — Wave 11.6 / W11.7.7 admin dashboard
 *
 * Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md (Sections F-I)
 *
 * URL: /EngineDashboard
 *
 * Read-only widgets pulling from engine_run_audit, shortlisting_master_listings,
 * shortlisting_stage4_overrides, composition_classification_overrides.
 *
 * v1 widgets (5 highest-leverage):
 *   1. Cost-per-stage stacked summary (last 30 days, Shape D rounds only)
 *   2. Voice tier distribution (master_listings count by tier, last 30 days)
 *   3. Stage 4 self-correction events trend (count by week)
 *   4. Pending Stage 4 review queue size + stale-row warning
 *   5. Master listing quality flag rate (% rounds with forbidden_phrase_hits)
 *
 * Skipped at v1 (deferred):
 *   - Recent reclassifications log (W11.5 ships separately)
 *   - Canonical registry coverage (W12 ships separately; UI deferred)
 *   - Per-room-type override heatmap (existing W11.6 v1 widget; not Shape D-specific)
 *   - Drill-down navigation from chart cells (Phase 2)
 *   - CSV export (Phase 2)
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle,
  ChevronRight,
  Cpu,
  DollarSign,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

const DAYS_BACK = 30;

function fmtUsd(n) {
  if (n == null || !isFinite(Number(n))) return "$0.00";
  const v = Number(n);
  return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return d;
}

function weekKey(date) {
  return startOfWeek(date).toISOString().slice(0, 10);
}

// ── Widget 1: cost-per-stage summary ─────────────────────────────────────────
function CostSummaryWidget() {
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS_BACK);
    return d.toISOString();
  }, []);

  const auditQuery = useQuery({
    queryKey: ["engine_run_audit_cost_summary", DAYS_BACK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("engine_run_audit")
        .select(
          "round_id, engine_mode, total_cost_usd, stage1_total_cost_usd, " +
            "stage4_total_cost_usd, legacy_pass1_total_cost_usd, " +
            "legacy_pass2_total_cost_usd, vendor_used, completed_at, created_at",
        )
        .gte("created_at", cutoff)
        .not("total_cost_usd", "is", null)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60_000,
  });

  const summary = useMemo(() => {
    const rows = auditQuery.data || [];
    // mig 439: pass1/pass2 + twoPassCount stripped — Shape D is the only engine.
    let stage1Total = 0;
    let stage4Total = 0;
    let totalCost = 0;
    let shapeDCount = 0;
    for (const r of rows) {
      if (r.stage1_total_cost_usd) stage1Total += Number(r.stage1_total_cost_usd);
      if (r.stage4_total_cost_usd) stage4Total += Number(r.stage4_total_cost_usd);
      if (r.total_cost_usd) totalCost += Number(r.total_cost_usd);
      if ((r.engine_mode || "").startsWith("shape_d")) shapeDCount++;
    }
    return {
      stage1Total,
      stage4Total,
      totalCost,
      shapeDCount,
      avgPerRound: rows.length > 0 ? totalCost / rows.length : 0,
      totalRounds: rows.length,
    };
  }, [auditQuery.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-emerald-600" />
          Cost per stage (last {DAYS_BACK} days)
        </CardTitle>
        <CardDescription className="text-xs">
          Aggregate Gemini spend split by stage. Targets: Stage 1 ~$0.30, Stage 4 ~$3.50 per Shape D round.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {auditQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : auditQuery.error ? (
          <div className="text-sm text-destructive">
            Failed to load cost summary: {auditQuery.error.message}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="border rounded p-2">
                <div className="text-muted-foreground text-[10px]">Stage 1</div>
                <div className="font-mono text-sm font-semibold">
                  {fmtUsd(summary.stage1Total)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Shape D batched enrichment
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground text-[10px]">Stage 4</div>
                <div className="font-mono text-sm font-semibold">
                  {fmtUsd(summary.stage4Total)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Visual master synthesis
                </div>
              </div>
              <div className="border rounded p-2 bg-emerald-50 dark:bg-emerald-950/20">
                <div className="text-muted-foreground text-[10px]">Total</div>
                <div className="font-mono text-sm font-semibold">
                  {fmtUsd(summary.totalCost)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Avg/round: {fmtUsd(summary.avgPerRound)}
                </div>
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-3 pt-2 border-t">
              <span>
                {summary.totalRounds} rounds total
              </span>
              <span>·</span>
              <span>
                <span className="font-mono">{summary.shapeDCount}</span> Shape D
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Widget 2: voice tier distribution ────────────────────────────────────────
function VoiceTierWidget() {
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS_BACK);
    return d.toISOString();
  }, []);

  const tierQuery = useQuery({
    queryKey: ["voice_tier_distribution", DAYS_BACK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_master_listings")
        .select("property_tier, regeneration_count, voice_anchor_used, created_at")
        .gte("created_at", cutoff)
        .is("deleted_at", null)
        .limit(2000);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60_000,
  });

  const summary = useMemo(() => {
    const rows = tierQuery.data || [];
    const tiers = { premium: 0, standard: 0, approachable: 0 };
    let regenerated = 0;
    let overrideUsed = 0;
    for (const r of rows) {
      if (r.property_tier in tiers) tiers[r.property_tier] += 1;
      if ((r.regeneration_count || 0) > 0) regenerated += 1;
      if (r.voice_anchor_used === "override") overrideUsed += 1;
    }
    const total = rows.length;
    return {
      tiers,
      regenerated,
      overrideUsed,
      total,
      tierShare: {
        premium: total > 0 ? tiers.premium / total : 0,
        standard: total > 0 ? tiers.standard / total : 0,
        approachable: total > 0 ? tiers.approachable / total : 0,
      },
    };
  }, [tierQuery.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-600" />
          Voice tier distribution (last {DAYS_BACK} days)
        </CardTitle>
        <CardDescription className="text-xs">
          Master listings emitted per voice tier. Watch for tier-mismatch — e.g.
          Tier S package consistently emitting Approachable listings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tierQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : tierQuery.error ? (
          <div className="text-sm text-destructive">
            Failed to load voice tier data: {tierQuery.error.message}
          </div>
        ) : summary.total === 0 ? (
          <div className="text-sm text-muted-foreground italic">
            No master listings synthesised in the last {DAYS_BACK} days yet.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Stacked bar */}
            <div className="h-6 rounded overflow-hidden flex border">
              {summary.tiers.premium > 0 && (
                <div
                  className="bg-purple-300 dark:bg-purple-700"
                  style={{ width: `${summary.tierShare.premium * 100}%` }}
                  title={`Premium · ${summary.tiers.premium} (${fmtPct(summary.tierShare.premium)})`}
                />
              )}
              {summary.tiers.standard > 0 && (
                <div
                  className="bg-blue-300 dark:bg-blue-700"
                  style={{ width: `${summary.tierShare.standard * 100}%` }}
                  title={`Standard · ${summary.tiers.standard} (${fmtPct(summary.tierShare.standard)})`}
                />
              )}
              {summary.tiers.approachable > 0 && (
                <div
                  className="bg-emerald-300 dark:bg-emerald-700"
                  style={{ width: `${summary.tierShare.approachable * 100}%` }}
                  title={`Approachable · ${summary.tiers.approachable} (${fmtPct(summary.tierShare.approachable)})`}
                />
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="border rounded p-2">
                <div className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-purple-300 dark:bg-purple-700" />
                  Premium
                </div>
                <div className="font-mono text-sm font-semibold">
                  {summary.tiers.premium}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtPct(summary.tierShare.premium)}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-blue-300 dark:bg-blue-700" />
                  Standard
                </div>
                <div className="font-mono text-sm font-semibold">
                  {summary.tiers.standard}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtPct(summary.tierShare.standard)}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-[10px] flex items-center gap-1 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-emerald-300 dark:bg-emerald-700" />
                  Approachable
                </div>
                <div className="font-mono text-sm font-semibold">
                  {summary.tiers.approachable}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtPct(summary.tierShare.approachable)}
                </div>
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-3 pt-2 border-t">
              <span>
                {summary.total} total listings
              </span>
              <span>·</span>
              <span>
                <span className="font-mono">{summary.regenerated}</span> regenerated
              </span>
              <span>·</span>
              <span>
                <span className="font-mono">{summary.overrideUsed}</span> custom voice override
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Widget 3: Stage 4 self-correction trend ──────────────────────────────────
function Stage4SelfCorrectionWidget() {
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90); // 90-day trend
    return d.toISOString();
  }, []);

  const overrideQuery = useQuery({
    queryKey: ["stage4_override_trend", 90],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_stage4_overrides")
        .select("id, field, stage_1_value, stage_4_value, review_status, created_at")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60_000,
  });

  const summary = useMemo(() => {
    const rows = overrideQuery.data || [];
    const byWeek = new Map();
    const fieldCounts = new Map();
    let approved = 0;
    let pending = 0;
    let rejected = 0;
    for (const r of rows) {
      const k = weekKey(r.created_at);
      byWeek.set(k, (byWeek.get(k) || 0) + 1);
      fieldCounts.set(r.field, (fieldCounts.get(r.field) || 0) + 1);
      if (r.review_status === "approved") approved += 1;
      else if (r.review_status === "rejected") rejected += 1;
      else if (r.review_status === "pending_review") pending += 1;
    }
    const weeks = Array.from(byWeek.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12);
    const maxCount = weeks.reduce((m, [, c]) => Math.max(m, c), 1);
    const fields = Array.from(fieldCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return {
      total: rows.length,
      approved,
      rejected,
      pending,
      weeks,
      maxCount,
      fields,
      approveRate: rows.length > 0 ? approved / (approved + rejected || 1) : 0,
    };
  }, [overrideQuery.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-600" />
          Stage 4 self-correction events
        </CardTitle>
        <CardDescription className="text-xs">
          Stage 4's visual cross-comparison overrides of Stage 1 — last 90 days,
          weekly. High operator-confirm rate = corrections trustworthy.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {overrideQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : overrideQuery.error ? (
          <div className="text-sm text-destructive">
            Failed to load Stage 4 override data: {overrideQuery.error.message}
          </div>
        ) : summary.total === 0 ? (
          <div className="text-sm text-muted-foreground italic">
            No Stage 4 self-corrections yet.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Sparkline-style bars by week */}
            <div className="flex items-end gap-1 h-16 border-b border-l">
              {summary.weeks.map(([week, count]) => (
                <div
                  key={week}
                  className="flex-1 bg-blue-300 dark:bg-blue-800 rounded-t"
                  style={{ height: `${(count / summary.maxCount) * 100}%` }}
                  title={`${week}: ${count} corrections`}
                />
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="border rounded p-2">
                <div className="text-[10px] text-muted-foreground">Total</div>
                <div className="font-mono text-sm font-semibold">{summary.total}</div>
              </div>
              <div className="border rounded p-2 bg-amber-50 dark:bg-amber-950/20">
                <div className="text-[10px] text-muted-foreground">Pending</div>
                <div className="font-mono text-sm font-semibold">{summary.pending}</div>
              </div>
              <div className="border rounded p-2 bg-emerald-50 dark:bg-emerald-950/20">
                <div className="text-[10px] text-muted-foreground">Approved</div>
                <div className="font-mono text-sm font-semibold">{summary.approved}</div>
              </div>
              <div className="border rounded p-2 bg-red-50 dark:bg-red-950/20">
                <div className="text-[10px] text-muted-foreground">Rejected</div>
                <div className="font-mono text-sm font-semibold">{summary.rejected}</div>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground">
              Operator-confirm rate:{" "}
              <span className="font-mono font-medium">
                {fmtPct(summary.approveRate)}
              </span>{" "}
              · Top fields:{" "}
              {summary.fields.map(([f, c], i) => (
                <span key={f} className="font-mono">
                  {f} ({c}){i < summary.fields.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>

            <Link
              to="/Stage4Overrides"
              className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              Open review queue
              <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Widget 4: pending Stage 4 review queue size ─────────────────────────────
function PendingQueueWidget() {
  const queueQuery = useQuery({
    queryKey: ["stage4_pending_summary"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_stage4_overrides")
        .select("id, created_at, review_status")
        .eq("review_status", "pending_review")
        .order("created_at", { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const oldest = rows[0]?.created_at;
      const weekOld = rows.filter((r) => {
        if (!r.created_at) return false;
        return Date.now() - new Date(r.created_at).getTime() > 7 * 24 * 60 * 60 * 1000;
      }).length;
      return { total: rows.length, oldest, weekOld };
    },
    staleTime: 30_000,
  });

  const data = queueQuery.data || { total: 0, oldest: null, weekOld: 0 };

  return (
    <Card
      className={cn(
        data.weekOld > 0 && "border-amber-200 dark:border-amber-900",
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="h-4 w-4 text-blue-600" />
          Pending Stage 4 review queue
        </CardTitle>
      </CardHeader>
      <CardContent>
        {queueQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold tabular-nums">
                  {data.total}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  rows awaiting review
                </div>
              </div>
              {data.oldest && (
                <div className="text-right text-xs text-muted-foreground">
                  <div>Oldest pending</div>
                  <div className="font-medium text-foreground">
                    {formatDistanceToNow(new Date(data.oldest), {
                      addSuffix: true,
                    })}
                  </div>
                </div>
              )}
            </div>
            {data.weekOld > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {data.weekOld} row{data.weekOld === 1 ? "" : "s"} older than 7 days
                — review backlog growing
              </div>
            )}
            <Link
              to="/Stage4Overrides"
              className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              Triage now
              <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Widget 5: master listing quality flag rate ───────────────────────────────
function MasterListingQualityWidget() {
  const cutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - DAYS_BACK);
    return d.toISOString();
  }, []);

  const qualityQuery = useQuery({
    queryKey: ["master_listing_quality", DAYS_BACK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_master_listings")
        .select(
          "id, property_tier, word_count, word_count_computed, " +
            "reading_grade_level, reading_grade_level_computed, " +
            "forbidden_phrase_hits, quality_flags, regeneration_count, created_at",
        )
        .gte("created_at", cutoff)
        .is("deleted_at", null)
        .limit(2000);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60_000,
  });

  const summary = useMemo(() => {
    const rows = qualityQuery.data || [];
    let withForbidden = 0;
    let withQualityFlags = 0;
    let regenerated = 0;
    for (const r of rows) {
      if (Array.isArray(r.forbidden_phrase_hits) && r.forbidden_phrase_hits.length > 0) {
        withForbidden += 1;
      }
      if (r.quality_flags && Object.keys(r.quality_flags).length > 0) {
        withQualityFlags += 1;
      }
      if ((r.regeneration_count || 0) > 0) regenerated += 1;
    }
    const total = rows.length;
    return {
      total,
      withForbidden,
      withQualityFlags,
      regenerated,
      forbiddenRate: total > 0 ? withForbidden / total : 0,
      qualityFlagRate: total > 0 ? withQualityFlags / total : 0,
      regenRate: total > 0 ? regenerated / total : 0,
    };
  }, [qualityQuery.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Master listing quality flags (last {DAYS_BACK} days)
        </CardTitle>
        <CardDescription className="text-xs">
          % of listings tripping a forbidden phrase or quality flag. Trending up
          = voice rubrics need review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {qualityQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : qualityQuery.error ? (
          <div className="text-sm text-destructive">
            Failed to load quality data: {qualityQuery.error.message}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="border rounded p-2">
              <div className="text-[10px] text-muted-foreground">
                Forbidden phrase hit
              </div>
              <div
                className={cn(
                  "font-mono text-sm font-semibold",
                  summary.forbiddenRate > 0.1 && "text-red-600",
                )}
              >
                {fmtPct(summary.forbiddenRate)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {summary.withForbidden} / {summary.total}
              </div>
            </div>
            <div className="border rounded p-2">
              <div className="text-[10px] text-muted-foreground">
                Any quality flag
              </div>
              <div className="font-mono text-sm font-semibold">
                {fmtPct(summary.qualityFlagRate)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {summary.withQualityFlags} / {summary.total}
              </div>
            </div>
            <div className="border rounded p-2">
              <div className="text-[10px] text-muted-foreground">
                Regenerated
              </div>
              <div className="font-mono text-sm font-semibold">
                {fmtPct(summary.regenRate)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {summary.regenerated} / {summary.total}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function EngineDashboard() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <div>
          <h1 className="text-xl font-bold">Shape D engine dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Read-only operator surface for the W11.7 Shape D pipeline. Cost
            attribution, voice tier distribution, Stage 4 self-correction trend,
            and master listing quality monitoring.
          </p>
        </div>

        {/* Top row: pending queue (always visible) + cost summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PendingQueueWidget />
          <CostSummaryWidget />
        </div>

        {/* Second row: voice tier + master listing quality */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <VoiceTierWidget />
          <MasterListingQualityWidget />
        </div>

        {/* Bottom: Stage 4 trend (full width) */}
        <Stage4SelfCorrectionWidget />

        <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Deferred to v2:</span>{" "}
            recent reclassifications log (W11.5 dependency), canonical registry
            coverage (W12 dependency), per-room-type override heatmap, drill-down
            navigation from chart cells, CSV export. See{" "}
            <Link
              to="/SettingsShortlistingCommandCenter?tab=overrides-admin"
              className="underline"
            >
              W11.6 spec
            </Link>{" "}
            for the full v2 widget set.
          </CardContent>
        </Card>
      </div>
    </PermissionGuard>
  );
}
