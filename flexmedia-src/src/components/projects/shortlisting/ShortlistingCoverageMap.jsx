/**
 * ShortlistingCoverageMap — Mig 465 engine-coverage report.
 *
 * REPLACES the legacy phase-based slot-lattice view.  The lattice
 * (`shortlisting_slot_definitions` + the phase 1/2/3 grouping) is no
 * longer authoritative after the editorial-engine migration: the engine
 * is now driven by `packages.products[].quantity` quotas + the
 * `shortlisting_engine_policy` editorial principles.  The Coverage tab
 * now mirrors that mental model.
 *
 * Four cards, top → bottom:
 *
 *   1. Contract fulfillment   — did we deliver what the package sold?
 *      Pulls quotas + fill_by_bucket from the editorial_picks_persisted
 *      event, renders a per-bucket progress rail (sales_images, dusk,
 *      aerial), surfaces over-fills + under-fills with reason chips.
 *
 *   2. Room coverage          — did the picks span the property?
 *      Sub-view A: distribution per space_type from
 *                  composition_classifications, with picks-vs-candidates.
 *      Sub-view B: common-rooms checklist driven by
 *                  policy.common_residential_rooms — green = picked,
 *                  amber = omitted with candidates, grey = no candidate.
 *      Reads the editorial_coverage_post_check event for the
 *      omitted-with-candidates list.
 *
 *   3. Quality & decisions    — were the picks strong, did operators agree?
 *      Editorial score histogram across all ai_proposed picks.  Operator
 *      action breakdown (ai_proposed / approved / swapped / removed /
 *      added_from_rejects).  Stage 4 visual-correction queue size.
 *
 *   4. Recipe transparency    — what's actually driving this round?
 *      Quota source (package_products vs fallback_ceiling), policy
 *      source (db vs default), policy snapshot (quality_floor + common
 *      rooms + dusk subjects), edit link to the policy editor.
 *
 * Legacy rounds (no editorial_picks_persisted event) get a simple
 * empty-state — there's no slot-lattice fallback.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Wand2,
  Sparkles,
  ChevronRight,
  Eye,
  Users,
  Wrench,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api, supabase } from "@/api/supabaseClient";
import { cn } from "@/lib/utils";

const QUOTA_BUCKET_LABELS = {
  sales_images: "Sales / Day",
  dusk_images: "Dusk",
  aerial_images: "Aerial",
};

const HUMAN_ACTION_LABELS = {
  ai_proposed: "AI proposed (untouched)",
  approved_as_proposed: "Approved",
  swapped: "Swapped",
  removed: "Removed",
  added_from_rejects: "Added from rejects",
};

// ─── Data hooks ────────────────────────────────────────────────────────────

function useEditorialEvent(roundId) {
  return useQuery({
    queryKey: ["editorial_picks_persisted", roundId],
    enabled: !!roundId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await api.client
        .from("shortlisting_events")
        .select("payload, created_at")
        .eq("round_id", roundId)
        .eq("event_type", "editorial_picks_persisted")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    },
  });
}

function useCoveragePostCheck(roundId) {
  return useQuery({
    queryKey: ["editorial_coverage_post_check", roundId],
    enabled: !!roundId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await api.client
        .from("shortlisting_events")
        .select("payload, created_at")
        .eq("round_id", roundId)
        .eq("event_type", "editorial_coverage_post_check")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    },
  });
}

function useRoundClassifications(roundId) {
  return useQuery({
    queryKey: ["coverage_classifications", roundId],
    enabled: !!roundId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("composition_classifications")
        .select("group_id, space_type, room_type, time_of_day")
        .eq("round_id", roundId);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
  });
}

function useRoundOverrides(roundId) {
  return useQuery({
    queryKey: ["coverage_overrides", roundId],
    enabled: !!roundId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_overrides")
        .select(
          "ai_proposed_slot_id, ai_proposed_group_id, ai_proposed_score, ai_proposed_analysis, human_action, slot_fit_score",
        )
        .eq("round_id", roundId);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
  });
}

function useGroupSpaceTypes(groupIds) {
  return useQuery({
    queryKey: ["coverage_group_space_types", groupIds.sort().join(",")],
    enabled: Array.isArray(groupIds) && groupIds.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("composition_classifications")
        .select("group_id, space_type, room_type")
        .in("group_id", groupIds);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
  });
}

function usePolicy() {
  return useQuery({
    queryKey: ["shortlisting_engine_policy_for_coverage"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_engine_policy")
        .select("policy, updated_at")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data?.policy || null;
    },
  });
}

function useStage4Queue(roundId) {
  return useQuery({
    queryKey: ["coverage_stage4_queue", roundId],
    enabled: !!roundId,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const { count, error } = await supabase
        .from("shortlisting_stage4_overrides")
        .select("id", { count: "exact", head: true })
        .eq("round_id", roundId)
        .eq("review_status", "pending_review");
      if (error) throw error;
      return count ?? 0;
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseEditorialEnvelope(rawAnalysis) {
  if (typeof rawAnalysis !== "string" || !rawAnalysis) return null;
  try {
    const parsed = JSON.parse(rawAnalysis);
    if (parsed && typeof parsed === "object") {
      return parsed.editorial || parsed;
    }
  } catch {
    // legacy rounds: rawAnalysis is just prose, no envelope
  }
  return null;
}

function bucketTone(picked, requested) {
  if (requested <= 0) return "text-muted-foreground";
  const ratio = picked / requested;
  if (ratio >= 1) return "text-emerald-700 dark:text-emerald-300";
  if (ratio >= 0.75) return "text-amber-700 dark:text-amber-300";
  return "text-rose-700 dark:text-rose-300";
}

function bucketBarTone(picked, requested) {
  if (requested <= 0) return "bg-muted";
  const ratio = picked / requested;
  if (ratio >= 1) return "bg-emerald-500/70";
  if (ratio >= 0.75) return "bg-amber-500/70";
  return "bg-rose-500/70";
}

function snakeToTitle(s) {
  if (!s || typeof s !== "string") return s;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ShortlistingCoverageMap({ roundId, round }) {
  const editorialQuery = useEditorialEvent(roundId);
  const postCheckQuery = useCoveragePostCheck(roundId);
  const classificationsQuery = useRoundClassifications(roundId);
  const overridesQuery = useRoundOverrides(roundId);
  const policyQuery = usePolicy();
  const stage4QueueQuery = useStage4Queue(roundId);

  const overrides = overridesQuery.data || [];
  const pickedGroupIds = useMemo(
    () =>
      overrides
        .filter((o) => o.human_action === "ai_proposed" && !!o.ai_proposed_group_id)
        .map((o) => o.ai_proposed_group_id),
    [overrides],
  );
  const pickedSpaceTypesQuery = useGroupSpaceTypes(pickedGroupIds);

  const editorialPayload = editorialQuery.data?.payload || null;
  const postCheckPayload = postCheckQuery.data?.payload || null;
  const policy = policyQuery.data || null;
  const stage4QueuePending = stage4QueueQuery.data ?? 0;

  // ── Layer 1 — Quota fulfillment ────────────────────────────────────────
  const quotaRows = useMemo(() => {
    if (!editorialPayload) return [];
    const requested = editorialPayload.quotas_requested || {};
    const filled = editorialPayload.fill_by_bucket || {};
    return Object.entries(requested).map(([bucket, req]) => {
      const picked = filled[bucket] ?? 0;
      return {
        bucket,
        label: QUOTA_BUCKET_LABELS[bucket] || snakeToTitle(bucket),
        requested: req,
        picked,
        ratio: req > 0 ? picked / req : 0,
      };
    });
  }, [editorialPayload]);

  const totalRequested = quotaRows.reduce((acc, r) => acc + (r.requested ?? 0), 0);
  const totalPicked = editorialPayload?.total_picks ?? quotaRows.reduce((acc, r) => acc + r.picked, 0);
  const totalRatioPct = totalRequested > 0
    ? Math.min(200, Math.round((totalPicked / totalRequested) * 100))
    : 0;

  // ── Layer 2 — Room coverage ────────────────────────────────────────────
  const classifications = classificationsQuery.data || [];
  const candidateRoomCounts = useMemo(() => {
    const m = new Map();
    for (const c of classifications) {
      const key = c.space_type || c.room_type;
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [classifications]);

  const pickedRoomCounts = useMemo(() => {
    const m = new Map();
    for (const r of pickedSpaceTypesQuery.data || []) {
      const key = r.space_type || r.room_type;
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [pickedSpaceTypesQuery.data]);

  const distributionRows = useMemo(() => {
    const allKeys = new Set([
      ...candidateRoomCounts.keys(),
      ...pickedRoomCounts.keys(),
    ]);
    return Array.from(allKeys)
      .map((k) => ({
        room: k,
        picked: pickedRoomCounts.get(k) ?? 0,
        candidates: candidateRoomCounts.get(k) ?? 0,
      }))
      .sort((a, b) => b.picked - a.picked || b.candidates - a.candidates);
  }, [candidateRoomCounts, pickedRoomCounts]);

  const commonRoomsList = Array.isArray(policy?.common_residential_rooms)
    ? policy.common_residential_rooms
    : [];
  const omittedCommonRooms = Array.isArray(postCheckPayload?.omitted_common_rooms)
    ? postCheckPayload.omitted_common_rooms
    : [];
  const omittedSet = new Set(omittedCommonRooms.map((r) => r.toLowerCase()));

  const commonRoomsChecklist = useMemo(() => {
    return commonRoomsList.map((room) => {
      const norm = room.toLowerCase();
      const candidatesAvail = candidateRoomCounts.get(norm) ?? 0;
      const picked = pickedRoomCounts.get(norm) ?? 0;
      let state;
      if (picked > 0) state = "covered";
      else if (omittedSet.has(norm) || candidatesAvail > 0) state = "omitted";
      else state = "no_candidate";
      return { room, picked, candidatesAvail, state };
    });
  }, [commonRoomsList, candidateRoomCounts, pickedRoomCounts, omittedSet]);

  // ── Layer 3 — Quality + decisions ──────────────────────────────────────
  const editorialScores = useMemo(() => {
    return overrides
      .map((o) => {
        const env = parseEditorialEnvelope(o.ai_proposed_analysis);
        const score = env && typeof env.editorial_score === "number"
          ? env.editorial_score
          : (typeof o.slot_fit_score === "number" ? o.slot_fit_score : null);
        return score;
      })
      .filter((n) => typeof n === "number" && Number.isFinite(n));
  }, [overrides]);

  const scoreHistogram = useMemo(() => {
    const buckets = [
      { label: "9–10", min: 9, max: 10.01, n: 0 },
      { label: "7–9", min: 7, max: 9, n: 0 },
      { label: "5–7", min: 5, max: 7, n: 0 },
      { label: "<5", min: 0, max: 5, n: 0 },
    ];
    for (const s of editorialScores) {
      const b = buckets.find((x) => s >= x.min && s < x.max);
      if (b) b.n += 1;
    }
    return buckets;
  }, [editorialScores]);

  const medianScore = useMemo(() => {
    if (editorialScores.length === 0) return null;
    const sorted = [...editorialScores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }, [editorialScores]);

  const actionBreakdown = useMemo(() => {
    const m = {};
    for (const o of overrides) {
      const a = o.human_action || "unknown";
      m[a] = (m[a] ?? 0) + 1;
    }
    return m;
  }, [overrides]);

  // ── Render gates ───────────────────────────────────────────────────────
  const isLoading =
    editorialQuery.isLoading ||
    postCheckQuery.isLoading ||
    classificationsQuery.isLoading ||
    overridesQuery.isLoading ||
    policyQuery.isLoading;

  if (isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-20 bg-muted rounded" />
        <div className="h-32 bg-muted rounded" />
        <div className="h-32 bg-muted rounded" />
      </div>
    );
  }

  // No editorial event for this round → legacy round, no slot-lattice
  // fallback (per Joseph 2026-05-04: "i dont care for the legacy slot
  // view, just remove it fully").  Render an explicit empty-state so
  // operators understand why the report is blank.
  if (!editorialPayload) {
    return (
      <Card data-testid="coverage-no-editorial-event">
        <CardContent className="p-6 text-sm text-muted-foreground space-y-2">
          <div className="font-medium text-foreground">
            No editorial-engine run found for this round
          </div>
          <p>
            The Coverage report draws from the editorial-engine output
            (mig 465+).  This round was either shortlisted before the
            editorial engine landed, OR Stage 4 hasn't run yet.
          </p>
          <p>
            Re-run Stage 4 to populate this view.
          </p>
        </CardContent>
      </Card>
    );
  }

  const quotaSource = editorialPayload.quota_source;
  const policySource = editorialPayload.policy_source;

  return (
    <div className="space-y-3" data-testid="coverage-report">
      {/* ── Card 1 — Contract fulfillment ─────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Contract fulfillment
              </div>
              <div className="text-sm font-medium">
                {round?.package_type || "Package"} · {totalPicked} of {totalRequested} delivered
                <span
                  className={cn(
                    "ml-2 font-mono tabular-nums",
                    bucketTone(totalPicked, totalRequested),
                  )}
                >
                  {totalRatioPct}%
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  "gap-1",
                  quotaSource === "package_products"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-amber-700 dark:text-amber-300",
                )}
              >
                <Database className="w-3 h-3" />
                {quotaSource === "package_products"
                  ? "Quota: package products"
                  : "Quota: ceiling fallback"}
              </Badge>
              {medianScore != null && (
                <Badge variant="secondary" className="font-mono">
                  Median {medianScore.toFixed(1)}
                </Badge>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {quotaRows.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No shortlistable quotas resolved.
              </div>
            ) : (
              quotaRows.map((row) => {
                const pct = row.requested > 0
                  ? Math.min(110, Math.round((row.picked / row.requested) * 100))
                  : 0;
                return (
                  <div key={row.bucket} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">{row.label}</span>
                      <span className={cn("font-mono tabular-nums", bucketTone(row.picked, row.requested))}>
                        {row.picked} / {row.requested}
                        {row.picked > row.requested ? (
                          <span className="ml-1 text-blue-700 dark:text-blue-300">
                            (+{row.picked - row.requested})
                          </span>
                        ) : row.picked < row.requested ? (
                          <span className="ml-1 text-rose-700 dark:text-rose-300">
                            (-{row.requested - row.picked})
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn("h-full transition-all", bucketBarTone(row.picked, row.requested))}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {editorialPayload.coverage_notes ? (
            <div className="rounded-md border border-amber-200/40 bg-amber-50/40 dark:bg-amber-950/20 p-2 text-xs">
              <div className="flex items-start gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                    Engine notes
                  </div>
                  <p className="text-amber-900/85 dark:text-amber-100/85 whitespace-pre-wrap leading-snug">
                    {editorialPayload.coverage_notes}
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Card 2 — Room coverage ─────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Room coverage
            </div>
          </div>

          {/* Common-rooms checklist (hint, not gate) */}
          {commonRoomsChecklist.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[11px] text-muted-foreground">
                Common AU residential rooms (from policy):
              </div>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {commonRoomsChecklist.map((row) => (
                  <li
                    key={row.room}
                    className="flex items-center gap-1.5 text-xs"
                    data-testid={`common-room-${row.room}`}
                  >
                    {row.state === "covered" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : row.state === "omitted" ? (
                      <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                    ) : (
                      <span className="w-3.5 h-3.5 rounded-full bg-muted shrink-0" />
                    )}
                    <span className={cn(
                      row.state === "covered" && "text-foreground",
                      row.state === "omitted" && "text-amber-800 dark:text-amber-300",
                      row.state === "no_candidate" && "text-muted-foreground",
                    )}>
                      {snakeToTitle(row.room)}
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      ({row.picked}/{row.candidatesAvail})
                    </span>
                  </li>
                ))}
              </ul>
              <div className="text-[10px] text-muted-foreground">
                <CheckCircle2 className="w-3 h-3 inline-block mr-0.5 text-emerald-600 dark:text-emerald-400" /> picked ·
                <AlertCircle className="w-3 h-3 inline-block ml-1 mr-0.5 text-amber-600 dark:text-amber-400" /> candidate available, omitted ·
                <span className="w-3 h-3 inline-block ml-1 mr-0.5 align-middle rounded-full bg-muted" /> no candidate
              </div>
            </div>
          ) : null}

          {/* Distribution: picks per space_type */}
          {distributionRows.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[11px] text-muted-foreground">
                Distribution per space_type (picked / candidates):
              </div>
              <ul className="space-y-0.5 max-h-72 overflow-y-auto">
                {distributionRows.map((row) => {
                  const pct = row.candidates > 0
                    ? Math.round((row.picked / row.candidates) * 100)
                    : 0;
                  return (
                    <li
                      key={row.room}
                      className="flex items-center justify-between gap-2 text-xs py-0.5"
                    >
                      <span className="font-medium truncate">{snakeToTitle(row.room)}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-blue-500/60"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="font-mono tabular-nums text-[11px] w-12 text-right">
                          {row.picked}/{row.candidates}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Card 3 — Quality + decisions ───────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Quality &amp; operator decisions
            </div>
            {stage4QueuePending > 0 ? (
              <Badge variant="outline" className="gap-1 text-orange-700 dark:text-orange-300">
                <Wrench className="w-3 h-3" />
                {stage4QueuePending} stage 4 correction{stage4QueuePending === 1 ? "" : "s"} pending
              </Badge>
            ) : null}
          </div>

          {/* Editorial score histogram */}
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">
              Editorial score distribution ({editorialScores.length} picks scored)
            </div>
            {editorialScores.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No editorial scores recorded.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {scoreHistogram.map((b) => {
                  const pct = editorialScores.length > 0
                    ? Math.round((b.n / editorialScores.length) * 100)
                    : 0;
                  return (
                    <li
                      key={b.label}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="w-10 font-mono tabular-nums text-muted-foreground">
                        {b.label}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            "h-full",
                            b.label === "9–10"
                              ? "bg-emerald-500/70"
                              : b.label === "7–9"
                              ? "bg-lime-500/70"
                              : b.label === "5–7"
                              ? "bg-amber-500/70"
                              : "bg-rose-500/70",
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-mono tabular-nums text-[11px]">
                        {b.n}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Operator action breakdown */}
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Users className="w-3 h-3" /> Operator decisions
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {Object.entries(HUMAN_ACTION_LABELS).map(([key, label]) => {
                const n = actionBreakdown[key] ?? 0;
                if (n === 0 && key !== "ai_proposed" && key !== "approved_as_proposed") {
                  // suppress always-zero rows for clarity, but keep the
                  // primary two visible so operators see the scale
                  return null;
                }
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className={cn(
                      "font-mono tabular-nums",
                      n > 0 ? "text-foreground" : "text-muted-foreground",
                    )}>
                      {n}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* ── Card 4 — Recipe transparency ───────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Recipe &amp; policy in use
            </div>
            <Link
              to="/SettingsShortlistingCommandCenter?tab=recipes"
              className="text-xs text-blue-600 dark:text-blue-300 hover:underline flex items-center gap-0.5"
            >
              Edit policy
              <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <ul className="text-xs space-y-1">
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Quota source</span>
              <span className="font-mono">
                {quotaSource === "package_products" ? (
                  <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                    <Database className="w-3 h-3" /> Package products ({round?.package_type || "—"})
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> Fallback to package_ceiling
                  </span>
                )}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Editorial policy</span>
              <span className="font-mono">
                {policySource === "db" ? (
                  <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                    <Database className="w-3 h-3" /> DB-saved
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
                    <Wand2 className="w-3 h-3" /> In-code default
                  </span>
                )}
              </span>
            </li>
            {policy?.quality_floor != null ? (
              <li className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Quality floor</span>
                <span className="font-mono">{policy.quality_floor.toFixed(1)}</span>
              </li>
            ) : null}
            {Array.isArray(policy?.common_residential_rooms) && policy.common_residential_rooms.length > 0 ? (
              <li className="text-xs">
                <div className="text-muted-foreground mb-0.5">Common rooms</div>
                <div className="flex flex-wrap gap-1">
                  {policy.common_residential_rooms.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </li>
            ) : null}
            {Array.isArray(policy?.dusk_subjects) && policy.dusk_subjects.length > 0 ? (
              <li className="text-xs">
                <div className="text-muted-foreground mb-0.5">Dusk subjects</div>
                <div className="flex flex-wrap gap-1">
                  {policy.dusk_subjects.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
