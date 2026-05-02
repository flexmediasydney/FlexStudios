/**
 * ShapeDEngineBanner — Wave 11.7.7 / W11.6 operator UX
 *
 * Round detail banner showing:
 *   - engine_mode (shape_d_full / shape_d_partial) — display only since
 *     mig 439 (Shape D is the only engine; legacy two_pass mode is retired)
 *   - voice tier picker (premium / standard / approachable)
 *   - engine_run_audit summary (cost per stage + vendor + total)
 *   - Stage 4 override count → links into the override review queue
 *   - Master listing review CTA when a master_listing exists
 *
 * Spec refs:
 *   - docs/design-specs/W11-7-7-master-listing-copy.md (master listing review)
 *   - docs/design-specs/W11-7-8-voice-tier-modulation.md (tier picker UX)
 *   - docs/design-specs/W11-6-rejection-reasons-dashboard.md (cost surface)
 *
 * Backend deps:
 *   - shortlisting_rounds.engine_mode + property_tier + property_voice_anchor_override
 *   - shortlisting_master_listings (counts only — full review on dedicated page)
 *   - shortlisting_stage4_overrides (count by review_status)
 *   - engine_run_audit (per-round rollup)
 *
 * Edge fns:
 *   - round-engine-controls (master_admin tier picker)
 *
 * Render strategy:
 *   The component renders when the round has engine_mode='shape_d_*' or when
 *   an engine_run_audit row exists.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, supabase } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Cpu,
  DollarSign,
  Loader2,
  Edit3,
  AlertTriangle,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Tier metadata for the picker. Sample voice from W11.7.8.
const TIERS = [
  {
    value: "premium",
    label: "Premium",
    description:
      "Belle Property / luxury magazine — restrained evocative prose, period + materials",
  },
  {
    value: "standard",
    label: "Standard",
    description:
      "Domain editorial — confident, warm, specific but accessible",
  },
  {
    value: "approachable",
    label: "Approachable",
    description: "Friendly plain-language — investor / first-home buyer",
  },
];

const ENGINE_MODE_TONE = {
  shape_d_full: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  shape_d_partial: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  shape_d_textfallback: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
};

const ENGINE_MODE_LABEL = {
  shape_d_full: "Shape D · full",
  shape_d_partial: "Shape D · partial",
  shape_d_textfallback: "Shape D · text fallback",
};

const ENGINE_MODE_FALLBACK_TONE =
  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";

function fmtUsd(n) {
  if (n == null || !isFinite(Number(n))) return "$0.00";
  const v = Number(n);
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtMs(ms) {
  if (ms == null || !isFinite(Number(ms))) return "—";
  const n = Number(ms);
  if (n < 1000) return `${n.toFixed(0)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

export default function ShapeDEngineBanner({ round, projectId }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();
  const [voiceOverrideOpen, setVoiceOverrideOpen] = useState(false);
  const [voiceOverrideText, setVoiceOverrideText] = useState(
    round?.property_voice_anchor_override || "",
  );

  const roundId = round?.id;
  // mig 439: 'two_pass' retired; default to shape_d_full when engine_mode is
  // missing on the round row (post-mig 439 every new round stamps shape_d_*).
  const engineMode = round?.engine_mode || "shape_d_full";
  const isShapeD = engineMode.startsWith("shape_d");

  // engine_run_audit rollup — single row per round.
  const auditQuery = useQuery({
    queryKey: ["engine_run_audit", roundId],
    queryFn: async () => {
      if (!roundId) return null;
      const { data, error } = await supabase
        .from("engine_run_audit")
        .select(
          "round_id, engine_mode, vendor_used, model_used, failover_triggered, " +
            "stages_completed, stages_failed, stage1_total_cost_usd, stage1_total_wall_ms, " +
            "stage4_total_cost_usd, stage4_total_wall_ms, " +
            // mig 439: legacy_pass1/pass2 cost columns no longer rendered
            // (every production row has them as 0 since the W11.7.10 sunset
            // and pass1/pass2 deletion this hour). Columns retained on the
            // table as immutable history.
            "total_cost_usd, total_wall_ms, error_summary, completed_at",
        )
        .eq("round_id", roundId)
        .maybeSingle();
      if (error && error.code !== "PGRST116") throw new Error(error.message);
      return data ?? null;
    },
    enabled: Boolean(roundId),
    staleTime: 30_000,
  });

  // Master listing existence + tier used (1 row per round).
  const masterListingQuery = useQuery({
    queryKey: ["shortlisting_master_listings", roundId],
    queryFn: async () => {
      if (!roundId) return null;
      const { data, error } = await supabase
        .from("shortlisting_master_listings")
        .select(
          "id, round_id, property_tier, voice_anchor_used, regeneration_count, " +
            "word_count, word_count_computed, reading_grade_level_computed, " +
            "forbidden_phrase_hits, quality_flags, created_at, regenerated_at",
        )
        .eq("round_id", roundId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error && error.code !== "PGRST116") throw new Error(error.message);
      return data ?? null;
    },
    enabled: Boolean(roundId),
    staleTime: 30_000,
  });

  // Stage 4 override counts for this round.
  const overrideCountsQuery = useQuery({
    queryKey: ["stage4_override_counts", roundId],
    queryFn: async () => {
      if (!roundId) return { pending: 0, approved: 0, rejected: 0, deferred: 0, total: 0 };
      const { data, error } = await supabase
        .from("shortlisting_stage4_overrides")
        .select("review_status")
        .eq("round_id", roundId);
      if (error) throw new Error(error.message);
      const counts = { pending_review: 0, approved: 0, rejected: 0, deferred: 0, total: 0 };
      for (const r of data || []) {
        counts.total += 1;
        if (r.review_status in counts) counts[r.review_status] += 1;
      }
      return counts;
    },
    enabled: Boolean(roundId),
    staleTime: 30_000,
  });

  // Patch engine controls (master_admin only)
  const patchControlsMutation = useMutation({
    mutationFn: async (patch) => {
      const result = await api.functions.invoke("round-engine-controls", {
        round_id: roundId,
        ...patch,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shortlisting_rounds", projectId] });
      queryClient.invalidateQueries({ queryKey: ["engine_run_audit", roundId] });
      toast.success("Engine controls updated.");
      setVoiceOverrideOpen(false);
    },
    onError: (err) => toast.error(`Update failed: ${err?.message || err}`),
  });

  const audit = auditQuery.data;
  const masterListing = masterListingQuery.data;
  const overrideCounts = overrideCountsQuery.data;

  // Decide whether to render. Renders for any shape_d_* mode or when an
  // engine_run_audit row exists (covers the rare post-mig-439 case of a
  // stranded legacy row that's never re-stamped).
  const shouldRender = isShapeD || audit;
  if (!shouldRender) return null;

  const stage1Cost = audit?.stage1_total_cost_usd;
  const stage4Cost = audit?.stage4_total_cost_usd;
  const totalCost = audit?.total_cost_usd;
  const stagesCompleted = Array.isArray(audit?.stages_completed) ? audit.stages_completed : [];
  const stagesFailed = Array.isArray(audit?.stages_failed) ? audit.stages_failed : [];
  const hasFailedStages = stagesFailed.length > 0;

  const overridePending = overrideCounts?.pending_review ?? 0;
  const overrideTotal = overrideCounts?.total ?? 0;

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 p-3 space-y-3">
      {/* Top row: engine mode + voice tier */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Cpu className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium">Shape D engine</span>
          <Badge
            className={cn(
              "text-[10px] h-5 px-1.5",
              ENGINE_MODE_TONE[engineMode] || ENGINE_MODE_FALLBACK_TONE,
            )}
          >
            {ENGINE_MODE_LABEL[engineMode] || engineMode}
          </Badge>
          {audit?.failover_triggered && (
            <Badge className="text-[10px] h-5 px-1.5 bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300">
              Failover
            </Badge>
          )}
          {hasFailedStages && (
            <Badge variant="destructive" className="text-[10px] h-5 px-1.5 inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {stagesFailed.length} stage{stagesFailed.length === 1 ? "" : "s"} failed
            </Badge>
          )}
        </div>

        {isMasterAdmin && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Voice tier picker */}
            <Select
              value={round?.property_tier || "standard"}
              onValueChange={(value) => patchControlsMutation.mutate({ property_tier: value })}
              disabled={patchControlsMutation.isPending}
            >
              <SelectTrigger className="h-8 text-xs w-[150px]">
                <SelectValue placeholder="Voice tier" />
              </SelectTrigger>
              <SelectContent>
                {TIERS.map((t) => (
                  <SelectItem key={t.value} value={t.value} className="text-xs">
                    <div className="flex flex-col">
                      <span className="font-medium">{t.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {t.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* mig 439: engine-mode toggle removed — Shape D is the only
                engine, so there's nothing to toggle. The badge above still
                shows the per-round shape_d_full / shape_d_partial state. */}

            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => {
                setVoiceOverrideText(round?.property_voice_anchor_override || "");
                setVoiceOverrideOpen(true);
              }}
            >
              <Edit3 className="h-3 w-3 mr-1" />
              {round?.property_voice_anchor_override ? "Edit voice override" : "Custom voice"}
            </Button>
          </div>
        )}
      </div>

      {/* Voice override badge if active */}
      {round?.property_voice_anchor_override && (
        <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1.5 border border-amber-200 dark:border-amber-900">
          <Sparkles className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="leading-relaxed">
            <span className="font-medium">Voice override active:</span>{" "}
            <span className="italic">
              "{(round.property_voice_anchor_override || "").slice(0, 200)}
              {(round.property_voice_anchor_override || "").length > 200 ? "…" : ""}"
            </span>
          </div>
        </div>
      )}

      {/* Audit summary line */}
      {audit && (
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap leading-relaxed">
          <DollarSign className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
          {stage1Cost != null && (
            <span>
              Stage 1{" "}
              <span className="font-mono font-medium text-foreground">
                {fmtUsd(stage1Cost)}
              </span>{" "}
              <span className="text-[10px]">({fmtMs(audit.stage1_total_wall_ms)})</span>
            </span>
          )}
          {stage4Cost != null && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>
                Stage 4{" "}
                <span className="font-mono font-medium text-foreground">
                  {fmtUsd(stage4Cost)}
                </span>{" "}
                <span className="text-[10px]">({fmtMs(audit.stage4_total_wall_ms)})</span>
              </span>
            </>
          )}
          {/* mig 439: legacy Pass 1/Pass 2 cost surfaces removed (the
              two-pass engine was sunset in W11.7.10 and the columns are 0
              on every production row). */}
          {totalCost != null && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>
                Total{" "}
                <span className="font-mono font-semibold text-foreground">
                  {fmtUsd(totalCost)}
                </span>
              </span>
            </>
          )}
          {audit.vendor_used && (
            <>
              <span className="text-muted-foreground">·</span>
              <span>
                Vendor: <span className="font-mono">{audit.vendor_used}</span>
                {audit.model_used ? <span className="text-[10px] ml-1">({audit.model_used})</span> : null}
              </span>
            </>
          )}
          {stagesCompleted.length > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-[10px]">
                Stages:{" "}
                {stagesCompleted.map((s) => (
                  <span key={s} className="font-mono mr-1">
                    {s} ✓
                  </span>
                ))}
                {stagesFailed.map((s) => (
                  <span key={s} className="font-mono mr-1 text-red-600 dark:text-red-400">
                    {s} ✗
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      )}

      {/* Action row: master listing + override queue links */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Master listing review CTA */}
        {masterListing ? (
          <Link
            to={`/MasterListingReview?round=${roundId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
          >
            <Edit3 className="h-3.5 w-3.5" />
            Review master listing
            {masterListing.regeneration_count > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] h-4">
                v{masterListing.regeneration_count + 1}
              </Badge>
            )}
            {Array.isArray(masterListing.forbidden_phrase_hits) &&
              masterListing.forbidden_phrase_hits.length > 0 && (
                <Badge variant="destructive" className="ml-1 text-[10px] h-4">
                  {masterListing.forbidden_phrase_hits.length} flag
                  {masterListing.forbidden_phrase_hits.length === 1 ? "" : "s"}
                </Badge>
              )}
            <ChevronRight className="h-3 w-3" />
          </Link>
        ) : (
          isShapeD && (
            <span className="text-xs text-muted-foreground italic">
              Master listing not yet generated
            </span>
          )
        )}

        {overrideTotal > 0 && (
          <Link
            to={`/Stage4Overrides?round=${roundId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {overridePending} pending Stage 4 review{overridePending === 1 ? "" : "s"}
            <span className="text-[10px] text-muted-foreground">
              ({overrideTotal} total)
            </span>
            <ChevronRight className="h-3 w-3" />
          </Link>
        )}

        {audit?.error_summary && (
          <div className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span title={audit.error_summary}>
              {audit.error_summary.length > 80
                ? audit.error_summary.slice(0, 80) + "…"
                : audit.error_summary}
            </span>
          </div>
        )}
      </div>

      {/* Voice override modal */}
      <Dialog open={voiceOverrideOpen} onOpenChange={setVoiceOverrideOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Custom voice override</DialogTitle>
            <DialogDescription>
              Free-text rubric replaces the tier preset block at the next regeneration.
              Forbidden patterns from the standard tier rubric still apply. Reading-grade
              and word-count targets default to the selected tier band.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="voice-override-textarea" className="text-xs">
              Rubric text (max 2000 chars)
            </Label>
            <Textarea
              id="voice-override-textarea"
              value={voiceOverrideText}
              onChange={(e) => setVoiceOverrideText(e.target.value.slice(0, 2000))}
              rows={10}
              className="font-mono text-xs"
              placeholder='e.g. "Warm but agent-led, not editorial — McGrath inner-west voice. Lead with bedroom count and one architectural note. Avoid period references."'
            />
            <div className="text-[10px] text-muted-foreground text-right">
              {voiceOverrideText.length} / 2000
            </div>
          </div>
          <DialogFooter>
            {round?.property_voice_anchor_override && (
              <Button
                variant="ghost"
                onClick={() => patchControlsMutation.mutate({ property_voice_anchor_override: null })}
                disabled={patchControlsMutation.isPending}
              >
                Clear override
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setVoiceOverrideOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                patchControlsMutation.mutate({
                  property_voice_anchor_override: voiceOverrideText.trim() || null,
                })
              }
              disabled={patchControlsMutation.isPending || voiceOverrideText.trim().length < 30}
            >
              {patchControlsMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Save override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
