/**
 * SettingsShortlistingStandards — Wave 6 Phase 7 SHORTLIST
 *
 * Stream B tier-anchor editor. master_admin only.
 *
 * Three tier cards (S, P, A) shown side-by-side with score anchors
 * 5.0 / 8.0 / 9.5. Each card edits the descriptor (the prose passed to
 * the Stream B grader as a calibration anchor).
 *
 * Versioning contract: on save, INSERT a new row with version+1 and
 * is_active = true, then UPDATE the prior row to is_active = false. We
 * never overwrite descriptors in place — preserves audit history.
 *
 * Per tier, a "Show history" expander lets the admin browse prior
 * descriptors (read-only) to compare drift across versions.
 */

import { useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Award,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Save,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Tier display config (S < P < A by score anchor) ─────────────────────────
const TIER_VISUAL = {
  S: {
    label: "Tier S — Standard",
    accent: "border-slate-300 dark:border-slate-700",
    headerTone:
      "bg-slate-100 text-slate-800 dark:bg-slate-900/60 dark:text-slate-200",
    description:
      "Floor of acceptable quality. Anything below is rejected from shortlisting.",
  },
  P: {
    label: "Tier P — Premium",
    accent: "border-blue-300 dark:border-blue-800",
    headerTone:
      "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200",
    description:
      "Strong commercial-grade composition with no obvious flaws.",
  },
  A: {
    label: "Tier A — Aspirational",
    accent: "border-amber-300 dark:border-amber-800",
    headerTone:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
    description: "Hero-tier composition — magazine-worthy lighting and framing.",
  },
};

const TIER_ORDER = ["S", "P", "A"];

function fmtTimestamp(iso) {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "PP HH:mm");
  } catch {
    return "—";
  }
}

// ── Tier card ───────────────────────────────────────────────────────────────
function TierCard({ tier, activeRow, history, onSave, isSaving }) {
  const visual = TIER_VISUAL[tier] || {};
  const initialDescriptor = activeRow?.descriptor || "";
  const [draft, setDraft] = useState(initialDescriptor);
  const [showHistory, setShowHistory] = useState(false);

  // Reset draft when the underlying active row changes (e.g. after a save).
  // We track the row id we last synced from to avoid clobbering local edits.
  const [syncedFromId, setSyncedFromId] = useState(activeRow?.id || null);
  if (activeRow?.id !== syncedFromId) {
    setSyncedFromId(activeRow?.id || null);
    setDraft(activeRow?.descriptor || "");
  }

  const isDirty = (draft || "") !== (initialDescriptor || "");
  const tooShort = !draft || draft.trim().length < 20;

  const handleSave = () => {
    if (tooShort) {
      toast.error("Descriptor must be at least 20 characters.");
      return;
    }
    onSave({
      currentRow: activeRow,
      newDescriptor: draft.trim(),
    });
  };

  return (
    <Card className={cn("border-2", visual.accent)}>
      <CardHeader className={cn("pb-3 rounded-t-lg", visual.headerTone)}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="h-4 w-4" />
              {visual.label}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5 opacity-80">
              {visual.description}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums leading-none">
              {Number(activeRow?.score_anchor ?? 0).toFixed(1)}
            </div>
            <div className="text-[10px] uppercase tracking-wide opacity-70">
              score anchor
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          className="text-xs leading-relaxed font-mono"
          placeholder="Stream B calibration descriptor. Be concrete — this prose anchors the grader."
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Badge variant="secondary" className="text-[10px]">
              v{activeRow?.version ?? "?"}
            </Badge>
            <span>updated {fmtTimestamp(activeRow?.updated_at)}</span>
            <span className="tabular-nums">
              · {(draft || "").length} chars
            </span>
          </div>
          <Button
            onClick={handleSave}
            disabled={!isDirty || isSaving || tooShort}
            size="sm"
            title={
              !isDirty
                ? "No changes to save"
                : tooShort
                  ? "Descriptor too short"
                  : "Save as new version"
            }
          >
            {isSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Save new version
              </>
            )}
          </Button>
        </div>

        {/* History expander */}
        <div className="border-t pt-2">
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="text-[11px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {showHistory ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <History className="h-3 w-3" />
            History ({history.length} prior version
            {history.length === 1 ? "" : "s"})
          </button>
          {showHistory && (
            <div className="mt-2 space-y-2">
              {history.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic">
                  No prior versions yet.
                </p>
              ) : (
                history.map((h) => (
                  <div
                    key={h.id}
                    className="rounded border border-dashed border-border/60 p-2 text-[11px] space-y-1"
                  >
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="text-[9px]">
                        v{h.version}
                      </Badge>
                      <span>{fmtTimestamp(h.updated_at)}</span>
                    </div>
                    <pre className="whitespace-pre-wrap font-mono leading-snug text-[10.5px]">
                      {h.descriptor}
                    </pre>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function SettingsShortlistingStandards() {
  const queryClient = useQueryClient();

  const anchorsQuery = useQuery({
    queryKey: ["shortlisting_stream_b_anchors_all"],
    queryFn: () =>
      api.entities.ShortlistingStreamBAnchor.list("-version", 200),
  });

  const allRows = anchorsQuery.data || [];

  // Group by tier; sort each tier desc by version.
  const byTier = useMemo(() => {
    const m = new Map();
    for (const r of allRows) {
      if (!m.has(r.tier)) m.set(r.tier, []);
      m.get(r.tier).push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    }
    return m;
  }, [allRows]);

  const saveMutation = useMutation({
    mutationFn: async ({ tier, currentRow, newDescriptor }) => {
      const nextVersion = (currentRow?.version ?? 0) + 1;
      const newRow = await api.entities.ShortlistingStreamBAnchor.create({
        tier,
        score_anchor: currentRow?.score_anchor,
        descriptor: newDescriptor,
        version: nextVersion,
        is_active: true,
      });
      if (currentRow?.id) {
        try {
          await api.entities.ShortlistingStreamBAnchor.update(currentRow.id, {
            is_active: false,
          });
        } catch (err) {
          // Roll back insert.
          try {
            await api.entities.ShortlistingStreamBAnchor.delete(newRow.id);
          } catch {
            /* ignore */
          }
          throw new Error(
            `Failed to deactivate previous version: ${err.message}`,
          );
        }
      }
      return newRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_stream_b_anchors_all"],
      });
      toast.success("Anchor saved — new version active.");
    },
    onError: (err) => toast.error(`Save failed: ${err.message}`),
  });

  const handleSave = useCallback(
    ({ tier }) =>
      ({ currentRow, newDescriptor }) =>
        saveMutation.mutate({ tier, currentRow, newDescriptor }),
    [saveMutation],
  );

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Award className="h-6 w-6 text-primary" />
            Stream B Standards
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Calibration anchors for the Stream B (aesthetic) grader. The
            descriptors below define what an S, P, and A composition looks like
            in prose — they steer the grader's score distribution. Edits create
            a new version; prior versions are preserved.
          </p>
        </div>

        {anchorsQuery.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[420px] w-full" />
            ))}
          </div>
        ) : anchorsQuery.error ? (
          <Card>
            <CardContent className="p-4 text-xs text-red-600">
              Failed to load anchors: {anchorsQuery.error.message}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {TIER_ORDER.map((tier) => {
              const versions = byTier.get(tier) || [];
              const activeRow =
                versions.find((v) => v.is_active === true) || versions[0] || null;
              const history = versions.filter(
                (v) => v.id !== activeRow?.id,
              );
              if (!activeRow) {
                return (
                  <Card key={tier}>
                    <CardContent className="p-4 text-xs text-muted-foreground italic">
                      No anchor configured for tier {tier}.
                    </CardContent>
                  </Card>
                );
              }
              return (
                <TierCard
                  key={tier}
                  tier={tier}
                  activeRow={activeRow}
                  history={history}
                  onSave={handleSave({ tier })}
                  isSaving={saveMutation.isPending}
                />
              );
            })}
          </div>
        )}
      </div>
    </PermissionGuard>
  );
}
