/**
 * CalibrationDashboard — Wave 14 operator surface for engine drift.
 *
 * Spec: docs/design-specs/W14-structured-calibration.md
 *
 * URL: /CalibrationDashboard
 * Permission: master_admin only (calibration is owner-gated; admin can view
 * the existing EngineDashboard for the same data shape).
 *
 * Layout:
 *   1. Summary header card    — latest run, $ spent, pass/fail chips per criterion
 *   2. Action bar             — Re-run (same seed) + Download CSV
 *   3. Per-project table      — colour-coded score consistency / slot agreement / overrides
 *   4. Drift table (top-10)   — links to project's shortlisting subtab
 *   5. Voice anchor stability — per-tier breakdown (text panel)
 *
 * Style mirrors DispatcherPanel.jsx: slate-tinted cards, tabular-nums, compact
 * type. No animation, no charts (the metrics are integers + percents — a
 * coloured table is the right surface).
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  XCircle,
  Loader2,
  Activity,
  Hourglass,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function fmtNum(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "$0.00";
  return `$${Number(n).toFixed(2)}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

/** Colour pill for a numeric metric vs an acceptance band. */
function metricTone({ value, kind }) {
  if (value == null) return "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
  switch (kind) {
    case "score_delta":
      // <0.3 green / 0.3-0.5 amber / >0.5 red
      if (value < 0.3) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
      if (value < 0.5) return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "slot_agreement":
      // >=0.80 green / 0.65-0.80 amber / <0.65 red
      if (value >= 0.80) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
      if (value >= 0.65) return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "override_rate":
      // 0.02-0.08 green; <0.02 amber (under-correcting); >0.08 amber/red
      if (value >= 0.02 && value <= 0.08) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
      if (value > 0.12) return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "regression_pct":
      // <0.02 green / 0.02-0.05 amber / >0.05 red
      if (value < 0.02) return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
      if (value < 0.05) return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    default:
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}

const CRITERION_LABELS = {
  median_score_delta: "Score consistency",
  median_slot_agreement: "Slot agreement",
  median_override_rate: "Override rate",
  median_regression_pct: "Regression rate",
  master_listing_oob_rate: "Listing in-band",
};

// ─── Query hooks ────────────────────────────────────────────────────────────

function useLatestRun() {
  return useQuery({
    queryKey: ["calibration_latest_run"],
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("engine_calibration_run_summaries")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data || null;
    },
    staleTime: 15_000,
    refetchInterval: (data) => (data?.status === "running" ? 10_000 : false),
  });
}

function usePerProjectRows(runId) {
  return useQuery({
    queryKey: ["calibration_per_project", runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("engine_calibration_runs")
        .select(
          "id, run_id, project_id, round_id, status, started_at, finished_at, " +
            "score_consistency_jsonb, slot_agreement_pct, slot_diff_jsonb, " +
            "override_count, override_rate, regression_count, regression_pct, " +
            "regression_detail_jsonb, master_listing_in_band, word_count_now, " +
            "reading_grade_level_now, tone_anchor_now, cost_usd, error_message",
        )
        .eq("run_id", runId);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 15_000,
  });
}

function useProjectTitles(projectIds) {
  return useQuery({
    queryKey: ["calibration_project_titles", projectIds.sort().join(",")],
    enabled: projectIds.length > 0,
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("projects")
        .select("id, title, property_address, property_tier")
        .in("id", projectIds);
      if (error) throw new Error(error.message);
      const map = {};
      for (const p of data || []) map[p.id] = p;
      return map;
    },
    staleTime: 60_000,
  });
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CriterionChip({ name, passed, value, kind }) {
  const Icon = passed ? CheckCircle2 : passed === false ? XCircle : Hourglass;
  const tone = passed
    ? "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900"
    : passed === false
    ? "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900"
    : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-medium",
        tone,
      )}
      title={`${name}: ${value ?? "—"}`}
    >
      <Icon className="h-3 w-3 flex-shrink-0" />
      <span>{name}</span>
      <span className="font-mono tabular-nums opacity-80">
        {kind === "pct" ? fmtPct(value) : fmtNum(value)}
      </span>
    </div>
  );
}

function SummaryHeader({ run }) {
  if (!run) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No calibration runs yet. Trigger one via the dispatcher API or by hitting
          <code className="mx-1 px-1 bg-slate-100 dark:bg-slate-800 rounded">/functions/v1/shortlisting-calibration-runner</code>.
        </CardContent>
      </Card>
    );
  }
  const failedSet = new Set(run.failed_criteria || []);
  const passes = run.acceptance_pass;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5 text-slate-600 dark:text-slate-300" />
              Latest calibration · {run.run_id}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Started {fmtTime(run.started_at)} · {run.sample_mode === "auto_sample" ? `auto-sample (seed=${run.seed ?? "?"})` : "operator-picked"}
              {run.finished_at ? ` · finished ${fmtTime(run.finished_at)}` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              className={cn(
                "text-xs",
                run.status === "running"
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  : run.status === "completed"
                  ? passes
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              {run.status === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {run.status?.toUpperCase() || "—"}
              {run.status === "completed" && (passes ? " · PASS" : " · FAIL")}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Top stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="border rounded p-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Projects</div>
            <div className="font-mono text-base font-semibold tabular-nums">
              {run.n_projects_completed} / {run.n_projects_dispatched}
            </div>
            <div className="text-[10px] text-muted-foreground">completed / dispatched</div>
          </div>
          <div className="border rounded p-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Cost</div>
            <div className="font-mono text-base font-semibold tabular-nums">
              {fmtUsd(run.total_cost_usd)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {run.n_projects_completed > 0
                ? `${fmtUsd(Number(run.total_cost_usd) / run.n_projects_completed)} avg`
                : "—"}
            </div>
          </div>
          <div className="border rounded p-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Voice stability</div>
            <div className="font-mono text-base font-semibold tabular-nums">
              {fmtPct(run.voice_anchor_stability)}
            </div>
            <div className="text-[10px] text-muted-foreground">tone anchor</div>
          </div>
          <div className="border rounded p-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Failed</div>
            <div className="font-mono text-base font-semibold tabular-nums text-red-600 dark:text-red-400">
              {run.n_projects_failed ?? 0}
            </div>
            <div className="text-[10px] text-muted-foreground">snapshots missing</div>
          </div>
        </div>

        {/* Acceptance criteria chips */}
        <div className="flex flex-wrap gap-2">
          <CriterionChip
            name={CRITERION_LABELS.median_score_delta}
            passed={
              run.median_score_delta == null
                ? null
                : !failedSet.has("median_score_delta")
            }
            value={run.median_score_delta}
            kind="num"
          />
          <CriterionChip
            name={CRITERION_LABELS.median_slot_agreement}
            passed={
              run.median_slot_agreement == null
                ? null
                : !failedSet.has("median_slot_agreement")
            }
            value={run.median_slot_agreement}
            kind="pct"
          />
          <CriterionChip
            name={CRITERION_LABELS.median_override_rate}
            passed={
              run.median_override_rate == null
                ? null
                : !failedSet.has("median_override_rate")
            }
            value={run.median_override_rate}
            kind="pct"
          />
          <CriterionChip
            name={CRITERION_LABELS.median_regression_pct}
            passed={
              run.median_regression_pct == null
                ? null
                : !failedSet.has("median_regression_pct")
            }
            value={run.median_regression_pct}
            kind="pct"
          />
          <CriterionChip
            name={CRITERION_LABELS.master_listing_oob_rate}
            passed={
              run.master_listing_oob_rate == null
                ? null
                : !failedSet.has("master_listing_oob_rate")
            }
            value={run.master_listing_oob_rate}
            kind="pct"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ActionBar({ run, perProjectRows, projectMap }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const reRunMutation = useMutation({
    mutationFn: async () => {
      const seed = run?.seed != null ? Number(run.seed) : undefined;
      const projectIds = Array.from(
        new Set((perProjectRows || []).map((r) => r.project_id).filter(Boolean)),
      );
      const body =
        seed != null
          ? { auto_sample: true, seed, n: run.n_projects_requested || projectIds.length || 5 }
          : { project_ids: projectIds };
      const result = await api.functions.invoke("shortlisting-calibration-runner", body);
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "Re-run failed");
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      toast.success("Calibration re-run dispatched");
      queryClient.invalidateQueries({ queryKey: ["calibration_latest_run"] });
    },
    onError: (err) => {
      toast.error(`Re-run failed: ${err?.message || err}`);
    },
  });

  const downloadCsv = () => {
    if (!perProjectRows || perProjectRows.length === 0) {
      toast.error("No rows to export");
      return;
    }
    setBusy(true);
    try {
      const headers = [
        "project_id",
        "project_title",
        "property_tier",
        "status",
        "score_max_axis_max",
        "slot_agreement_pct",
        "override_count",
        "override_rate",
        "regression_count",
        "regression_pct",
        "master_listing_in_band",
        "word_count_now",
        "reading_grade_level_now",
        "tone_anchor_now",
        "cost_usd",
      ];
      const lines = [headers.join(",")];
      for (const r of perProjectRows) {
        const proj = projectMap?.[r.project_id];
        const cells = [
          r.project_id,
          quoteCsv(proj?.title ?? proj?.property_address ?? ""),
          proj?.property_tier ?? "",
          r.status ?? "",
          fmtNum(r.score_consistency_jsonb?.max_axis_max),
          r.slot_agreement_pct ?? "",
          r.override_count ?? "",
          r.override_rate ?? "",
          r.regression_count ?? "",
          r.regression_pct ?? "",
          r.master_listing_in_band == null ? "" : (r.master_listing_in_band ? "true" : "false"),
          r.word_count_now ?? "",
          r.reading_grade_level_now ?? "",
          quoteCsv(r.tone_anchor_now ?? ""),
          r.cost_usd ?? "",
        ];
        lines.push(cells.join(","));
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${run?.run_id ?? "calibration"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        size="sm"
        variant="default"
        disabled={!run || reRunMutation.isPending}
        onClick={() => reRunMutation.mutate()}
        className="h-8 text-xs"
        title={
          run?.seed != null
            ? `Re-run with seed=${run.seed} (reproducible sample)`
            : "Re-run with the same project_ids"
        }
      >
        {reRunMutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
        )}
        Re-run
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!perProjectRows?.length || busy}
        onClick={downloadCsv}
        className="h-8 text-xs"
      >
        <Download className="h-3.5 w-3.5 mr-1" />
        CSV
      </Button>
    </div>
  );
}

function quoteCsv(s) {
  if (s == null) return "";
  const t = String(s);
  if (t.includes(",") || t.includes('"') || t.includes("\n")) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

function PerProjectTable({ rows, projectMap }) {
  if (!rows || rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No per-project rows yet. The runner is still warming up — check back in a few minutes.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Per-project ({rows.length})</CardTitle>
        <CardDescription className="text-xs">
          Each row = one project's most-recent Shape D round, re-run during this calibration.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-900/40 border-y border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Δ score</th>
                <th className="px-3 py-2 font-medium text-right">Slot agreement</th>
                <th className="px-3 py-2 font-medium text-right">Overrides</th>
                <th className="px-3 py-2 font-medium text-right">Regressions</th>
                <th className="px-3 py-2 font-medium text-right">Listing</th>
                <th className="px-3 py-2 font-medium text-right">Cost</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const proj = projectMap?.[r.project_id] || {};
                const titleStr = proj.title || proj.property_address || r.project_id?.slice(0, 8);
                const scoreMax = r.score_consistency_jsonb?.max_axis_max ?? null;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-slate-100 dark:border-slate-900/50 hover:bg-slate-50/50 dark:hover:bg-slate-900/30"
                  >
                    <td className="px-3 py-2 font-medium truncate max-w-[24ch]" title={titleStr}>
                      {titleStr}
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">
                      {proj.property_tier || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "completed" ? (
                        <Badge className="text-[10px] h-5 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                          Done
                        </Badge>
                      ) : r.status === "failed" ? (
                        <Badge className="text-[10px] h-5 bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300">
                          Failed
                        </Badge>
                      ) : r.status === "running" ? (
                        <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                          <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                          Running
                        </Badge>
                      ) : (
                        <Badge className="text-[10px] h-5 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                          {r.status}
                        </Badge>
                      )}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", metricTone({ value: scoreMax, kind: "score_delta" }))}>
                      {fmtNum(scoreMax)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", metricTone({ value: r.slot_agreement_pct, kind: "slot_agreement" }))}>
                      {fmtPct(r.slot_agreement_pct)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", metricTone({ value: r.override_rate, kind: "override_rate" }))}>
                      {r.override_count ?? "—"} ({fmtPct(r.override_rate)})
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono tabular-nums", metricTone({ value: r.regression_pct, kind: "regression_pct" }))}>
                      {r.regression_count ?? "—"} ({fmtPct(r.regression_pct)})
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {r.master_listing_in_band === true ? (
                        <Badge className="text-[10px] h-5 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                          {r.word_count_now}w
                        </Badge>
                      ) : r.master_listing_in_band === false ? (
                        <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                          OOB · {r.word_count_now}w
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {fmtUsd(r.cost_usd)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to={`/ProjectDetails?id=${r.project_id}&tab=shortlisting`}
                        title="Open project's shortlisting subtab"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function DriftTable({ rows, projectMap }) {
  // Score each row by the "worst-axis" rank, take top 10.
  const ranked = useMemo(() => {
    const enriched = (rows || []).map((r) => {
      const scoreMax = Number(r.score_consistency_jsonb?.max_axis_max ?? 0);
      const slotMiss = r.slot_agreement_pct == null ? 0 : 1 - Number(r.slot_agreement_pct);
      const overrideExcess = Math.max(0, Number(r.override_rate ?? 0) - 0.08);
      const regressionExcess = Math.max(0, Number(r.regression_pct ?? 0) - 0.02);
      const driftScore = Math.max(scoreMax, slotMiss, overrideExcess * 5, regressionExcess * 5);
      return { ...r, driftScore };
    });
    return enriched.sort((a, b) => b.driftScore - a.driftScore).slice(0, 10);
  }, [rows]);

  if (!ranked || ranked.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingDown className="h-4 w-4 text-amber-600" />
          Top drift offenders
        </CardTitle>
        <CardDescription className="text-xs">
          Highest combined deltas (score + slot + override + regression). Click to drill down.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-slate-100 dark:divide-slate-900/50">
          {ranked.map((r, i) => {
            const proj = projectMap?.[r.project_id] || {};
            const titleStr = proj.title || proj.property_address || r.project_id?.slice(0, 8);
            return (
              <li key={r.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                <span className="w-5 text-muted-foreground tabular-nums text-right">{i + 1}</span>
                <Link
                  to={`/ProjectDetails?id=${r.project_id}&tab=shortlisting`}
                  className="font-medium hover:underline truncate flex-1"
                >
                  {titleStr}
                </Link>
                <span className="text-muted-foreground tabular-nums">
                  Δ {fmtNum(r.score_consistency_jsonb?.max_axis_max)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  · slots {fmtPct(r.slot_agreement_pct)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  · ovr {fmtPct(r.override_rate)}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function VoiceAnchorPanel({ run, perProjectRows, projectMap }) {
  const tonesByTier = useMemo(() => {
    const map = { premium: new Map(), standard: new Map(), approachable: new Map() };
    for (const r of perProjectRows || []) {
      const tier = projectMap?.[r.project_id]?.property_tier;
      if (!tier || !map[tier]) continue;
      const anchor = (r.tone_anchor_now ?? "").trim().toLowerCase();
      if (!anchor) continue;
      map[tier].set(anchor, (map[tier].get(anchor) ?? 0) + 1);
    }
    return map;
  }, [perProjectRows, projectMap]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-blue-600" />
          Voice anchor self-report
        </CardTitle>
        <CardDescription className="text-xs">
          What tier-anchored tone did the model say it was using? Higher overall stability =
          fewer improvised voices across regen runs.
          {run?.voice_anchor_stability != null && (
            <> Current overall: <span className="font-mono">{fmtPct(run.voice_anchor_stability)}</span></>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(["premium", "standard", "approachable"]).map((tier) => {
          const entries = Array.from(tonesByTier[tier]?.entries() ?? []);
          if (entries.length === 0) return null;
          entries.sort((a, b) => b[1] - a[1]);
          return (
            <div key={tier} className="border rounded p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                {tier} ({entries.reduce((s, [, c]) => s + c, 0)} rounds, {entries.length} distinct anchors)
              </div>
              <ul className="space-y-1">
                {entries.slice(0, 5).map(([anchor, count]) => (
                  <li key={anchor} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate flex-1 text-muted-foreground italic">"{anchor}"</span>
                    <span className="font-mono tabular-nums">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function CalibrationDashboard() {
  // PermissionGuard at the bottom enforces master_admin; no in-page check needed.
  const latestRunQuery = useLatestRun();
  const run = latestRunQuery.data;
  const perProjectQuery = usePerProjectRows(run?.run_id);
  const perProjectRows = perProjectQuery.data || [];
  const projectIds = useMemo(
    () => Array.from(new Set(perProjectRows.map((r) => r.project_id))),
    [perProjectRows],
  );
  const projectTitlesQuery = useProjectTitles(projectIds);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-bold">Engine calibration dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Wave 14 — measure Shape D consistency, slot stability, and regression rate across
              historical projects. The runner re-fires Stage 1 + Stage 4 on a stratified sample,
              diffs against the prior run, and surfaces drift here.
            </p>
          </div>
          <ActionBar
            run={run}
            perProjectRows={perProjectRows}
            projectMap={projectTitlesQuery.data}
          />
        </div>

        {latestRunQuery.isLoading && !run ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <SummaryHeader run={run} />
        )}

        {/* Acceptance fail banner */}
        {run?.status === "completed" && run.acceptance_pass === false && (
          <Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20">
            <CardContent className="p-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="font-semibold text-red-900 dark:text-red-200">
                  Calibration failed acceptance
                </div>
                <div className="text-xs text-red-800 dark:text-red-300 mt-0.5">
                  Failed criteria: {(run.failed_criteria || []).join(", ") || "—"}. Drill into
                  the top-drift table below for the worst offenders.
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {perProjectQuery.isLoading && !perProjectRows.length ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <PerProjectTable rows={perProjectRows} projectMap={projectTitlesQuery.data} />
        )}

        <DriftTable rows={perProjectRows} projectMap={projectTitlesQuery.data} />

        <VoiceAnchorPanel
          run={run}
          perProjectRows={perProjectRows}
          projectMap={projectTitlesQuery.data}
        />

        <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Calibration spec:</span>{" "}
            See <code>docs/design-specs/W14-structured-calibration.md</code> for the
            sampling strategy, acceptance bands, and cost model. Triggering the runner is
            master_admin-gated; rights to read this dashboard are master_admin-only.
          </CardContent>
        </Card>
      </div>
    </PermissionGuard>
  );
}
