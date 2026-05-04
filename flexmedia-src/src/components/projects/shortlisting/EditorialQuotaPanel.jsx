/**
 * EditorialQuotaPanel — Mig 465 swimlane indicator showing the global
 * fallback recipe in plain English: which package, what per-bucket quotas
 * the engine resolved from the package products, and which editorial
 * policy is currently active.
 *
 * Replaces the legacy SwimlaneSlotCounter ("Phase 1: 2/5 · Phase 2: 4/13")
 * which described an ABSTRACTED slot lattice that doesn't match what the
 * engine is actually doing post-mig 465.  Operators care about:
 *
 *   1. What deliverable did the package promise?  (e.g. 25 sales + 4 dusk)
 *   2. Where did that quota come from?  (resolved from packages.products,
 *      vs fell back to ceiling because the package was unrecognised)
 *   3. How close did the engine come to filling it?  (24/25 sales etc)
 *   4. What policy is informing the editorial picks?  (DB-saved policy,
 *      vs hard-coded default — important for ops to spot rounds run before
 *      mig 465 vs after)
 *   5. Did the engine self-flag any coverage warnings?
 *
 * Data source: the latest `editorial_picks_persisted` shortlisting_events
 * row for this round.  Stage 4 emits it on every editorial-engine run
 * with a payload containing exactly those fields, so this panel is a
 * pure read-and-render — no client-side quota resolution needed.
 *
 * Backwards compat: when no editorial event exists (legacy rounds before
 * mig 465 lands, OR rounds where the package has no shortlistable
 * products), the panel renders a "Legacy slot lattice" notice with the
 * old SwimlaneSlotCounter as a fallback.  Same visual real estate, no
 * surprise to the operator.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle2, AlertCircle, Info, Database, Wand2 } from "lucide-react";
import { api } from "@/api/supabaseClient";
import { SwimlaneSlotCounter } from "./SwimlaneToolbar";

const QUOTA_BUCKET_LABELS = {
  sales_images: "Sales / Day",
  dusk_images: "Dusk",
  aerial_images: "Aerial",
};

const SOURCE_LABELS = {
  package_products: {
    label: "Package products",
    description:
      "Quota resolved automatically from the project's package — the engine read packages.products[].quantity and classified each product into a quota bucket.",
    tone: "text-emerald-700 dark:text-emerald-300",
    icon: <Database className="w-3 h-3" aria-hidden="true" />,
  },
  fallback_ceiling: {
    label: "Fallback (ceiling)",
    description:
      "The package products couldn't be classified into shortlistable buckets, so the engine fell back to the round's package_ceiling and treated the entire ceiling as 'sales_images'. Open the package in /SettingsPriceMatrix to make sure its product names match the recognised list.",
    tone: "text-amber-700 dark:text-amber-300",
    icon: <AlertCircle className="w-3 h-3" aria-hidden="true" />,
  },
};

const POLICY_LABELS = {
  db: {
    label: "Editorial policy: DB",
    description:
      "Editorial policy was loaded from shortlisting_engine_policy.id=1 (the operator-editable singleton row). Edit at /SettingsShortlistingCommandCenter?tab=recipes.",
    tone: "text-emerald-700 dark:text-emerald-300",
    icon: <Database className="w-3 h-3" aria-hidden="true" />,
  },
  default: {
    label: "Editorial policy: in-code default",
    description:
      "The DB row was unavailable (RLS denial, missing row, or jsonb shape mismatch) so Stage 4 fell back to the hard-coded DEFAULT_POLICY in engineEditorialPolicy.ts. Manage at /SettingsShortlistingCommandCenter?tab=recipes.",
    tone: "text-amber-700 dark:text-amber-300",
    icon: <Wand2 className="w-3 h-3" aria-hidden="true" />,
  },
};

/**
 * Pull the latest `editorial_picks_persisted` event for the round.  Returns
 * null when the round hasn't run on the editorial engine yet (legacy rounds
 * pre-mig 465, or rounds where the package has no shortlistable buckets).
 */
function useLatestEditorialEvent(roundId) {
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

export function EditorialQuotaPanel({
  roundId,
  packageType,
  proposedSlotIds,
  packageCeiling,
}) {
  const { data: event, isLoading } = useLatestEditorialEvent(roundId);
  const { data: postCheckEvent } = useCoveragePostCheck(roundId);

  const payload = event?.payload || null;
  const omittedRooms = Array.isArray(postCheckEvent?.payload?.omitted_common_rooms)
    ? postCheckEvent.payload.omitted_common_rooms
    : [];
  const quotasRequested = payload?.quotas_requested || null;
  const fillByBucket = payload?.fill_by_bucket || {};
  const quotaSource = payload?.quota_source || null;
  const policySource = payload?.policy_source || null;
  const coverageNotes = typeof payload?.coverage_notes === "string"
    ? payload.coverage_notes.trim()
    : "";
  const totalPicks = typeof payload?.total_picks === "number" ? payload.total_picks : null;

  const bucketEntries = useMemo(() => {
    if (!quotasRequested) return [];
    return Object.entries(quotasRequested).map(([bucket, requested]) => {
      const picked = fillByBucket[bucket] ?? 0;
      const fillRatio = requested > 0 ? picked / requested : 0;
      let tone = "text-muted-foreground";
      if (fillRatio === 0) tone = "text-muted-foreground";
      else if (fillRatio < 1) tone = "text-amber-700 dark:text-amber-300";
      else if (fillRatio === 1) tone = "text-emerald-700 dark:text-emerald-300";
      else tone = "text-blue-700 dark:text-blue-300";
      return {
        bucket,
        requested,
        picked,
        tone,
        label: QUOTA_BUCKET_LABELS[bucket] || bucket,
      };
    });
  }, [quotasRequested, fillByBucket]);

  // Backwards-compat fallback: legacy round (no editorial event) → render
  // the original phase-based SwimlaneSlotCounter so the operator still sees
  // SOMETHING.  The header chip identifies the mode so it's never ambiguous.
  if (!isLoading && !event) {
    return (
      <Card data-testid="editorial-quota-panel-legacy">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <Badge variant="outline" className="text-amber-700 dark:text-amber-300">
              <Info className="w-3 h-3 mr-1" aria-hidden="true" />
              Legacy slot lattice
            </Badge>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground cursor-help underline decoration-dotted">
                    why?
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  No editorial-engine run found for this round (no
                  `editorial_picks_persisted` event). The round was either
                  shortlisted before the editorial engine landed (mig 465),
                  OR its package had no shortlistable products. Falling
                  back to the legacy phase-based slot counter.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <SwimlaneSlotCounter
            proposedSlotIds={proposedSlotIds}
            packageCeiling={packageCeiling}
          />
        </CardContent>
      </Card>
    );
  }

  const sourceMeta = quotaSource ? SOURCE_LABELS[quotaSource] : null;
  const policyMeta = policySource ? POLICY_LABELS[policySource] : null;

  return (
    <Card data-testid="editorial-quota-panel">
      <CardContent className="p-3 space-y-3">
        {/* Top row: package + quota source */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-medium uppercase tracking-wide text-muted-foreground">
            Engine recipe
          </span>
          {packageType ? (
            <Badge variant="secondary" className="font-medium">
              {packageType}
            </Badge>
          ) : null}
          {sourceMeta ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className={`gap-1 cursor-help ${sourceMeta.tone}`}>
                    {sourceMeta.icon}
                    {sourceMeta.label}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {sourceMeta.description}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {policyMeta ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className={`gap-1 cursor-help ${policyMeta.tone}`}>
                    {policyMeta.icon}
                    {policyMeta.label}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {policyMeta.description}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>

        {/* Per-bucket fill */}
        {bucketEntries.length > 0 ? (
          <div
            className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex items-center gap-3 flex-wrap"
            data-testid="editorial-quota-fill"
          >
            <span className="font-medium uppercase tracking-wide text-muted-foreground">
              Quota fill
            </span>
            {bucketEntries.map((entry, idx) => (
              <div key={entry.bucket} className="flex items-center gap-3">
                {idx > 0 ? <span className="text-muted-foreground">·</span> : null}
                <BucketBadge entry={entry} />
              </div>
            ))}
            {typeof totalPicks === "number" ? (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {totalPicks} total
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Post-check: common rooms with candidates that were omitted */}
        {omittedRooms.length > 0 ? (
          <div className="flex items-start gap-2 text-xs">
            <AlertCircle
              className="w-3.5 h-3.5 mt-0.5 text-amber-700 dark:text-amber-300 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <span className="font-medium uppercase tracking-wide text-muted-foreground">
                Coverage post-check
              </span>
              <p className="text-muted-foreground">
                Common AU room
                {omittedRooms.length > 1 ? "s" : ""} with candidates but{" "}
                <span className="font-medium">omitted from picks</span>:{" "}
                {omittedRooms.map((r, i) => (
                  <span key={r}>
                    {i > 0 ? ", " : ""}
                    <code className="text-[11px]">{r}</code>
                  </span>
                ))}
                . Operator review recommended — the engine may have had a
                reason, or this might be an oversight.
              </p>
            </div>
          </div>
        ) : null}

        {/* Coverage notes (model self-flags shortfalls in this string) */}
        {coverageNotes.length > 0 ? (
          <div className="flex items-start gap-2 text-xs">
            <AlertCircle
              className="w-3.5 h-3.5 mt-0.5 text-amber-700 dark:text-amber-300 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <span className="font-medium uppercase tracking-wide text-muted-foreground">
                Engine notes
              </span>
              <p className="text-muted-foreground whitespace-pre-line">
                {coverageNotes}
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BucketBadge({ entry }) {
  const complete = entry.picked >= entry.requested && entry.requested > 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{entry.label}</span>
      <span
        className={`font-mono text-xs ${entry.tone}`}
        data-testid={`bucket-${entry.bucket}`}
        data-filled={entry.picked}
        data-expected={entry.requested}
      >
        {entry.picked}/{entry.requested}
      </span>
      {complete ? (
        <CheckCircle2
          className="w-3 h-3 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

export default EditorialQuotaPanel;
