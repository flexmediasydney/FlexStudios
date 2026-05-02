/**
 * DisagreementRow — Wave 14
 *
 * Single editor-vs-AI disagreement row inside the calibration detail tab.
 * Renders slot/stem context + AI score + editor reasoning + primary_signal_diff,
 * with Approve / Reject buttons that update the calibration_decisions row's
 * resolution status (a per-row note on whether the AI's call should propagate
 * back into the few-shot library + tier-weight tuning corpus).
 *
 * Spec: docs/design-specs/W14-calibration-session.md §3.
 *
 * Approve = "AI was right; promote this row to validated → confirms current
 *            engine signal weights."
 * Reject  = "Editor was right; the AI's pick is the wrong one; this becomes a
 *            negative training signal."
 *
 * Approve/reject mutate calibration_decisions.reasoning_categories with a
 * `resolution=approved|rejected` chip (no schema change required — we use
 * the existing TEXT[] column to record the human-in-the-loop verdict).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

const RESOLVED_TAG_APPROVED = "resolution_approved";
const RESOLVED_TAG_REJECTED = "resolution_rejected";

function deriveResolution(categories) {
  if (!Array.isArray(categories)) return null;
  if (categories.includes(RESOLVED_TAG_APPROVED)) return "approved";
  if (categories.includes(RESOLVED_TAG_REJECTED)) return "rejected";
  return null;
}

function withResolution(categories, resolution) {
  const next = (categories || []).filter(
    (c) => c !== RESOLVED_TAG_APPROVED && c !== RESOLVED_TAG_REJECTED,
  );
  if (resolution === "approved") next.push(RESOLVED_TAG_APPROVED);
  if (resolution === "rejected") next.push(RESOLVED_TAG_REJECTED);
  return next;
}

export default function DisagreementRow({ decision, sessionId }) {
  const qc = useQueryClient();
  const resolution = deriveResolution(decision.reasoning_categories);

  const setResolution = useMutation({
    mutationFn: async ({ next }) => {
      const updated = withResolution(decision.reasoning_categories, next);
      await api.entities.CalibrationDecision.update(decision.id, {
        reasoning_categories: updated,
      });
      return next;
    },
    onSuccess: (next) => {
      toast.success(next === "approved" ? "AI's call approved" : "Editor's pick kept");
      qc.invalidateQueries({ queryKey: ["calibration-decisions", sessionId] });
    },
    onError: (err) => {
      toast.error(`Update failed: ${err?.message || String(err)}`);
    },
  });

  const aiScore =
    typeof decision.ai_score === "number"
      ? decision.ai_score.toFixed(2)
      : "—";

  return (
    <div
      className="border rounded p-2 text-xs space-y-1 bg-card"
      data-testid={`disagreement-${decision.id}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <Badge variant="outline" className="text-[10px] font-mono">
          {decision.slot_id}
        </Badge>
        <span className="font-mono opacity-70 truncate">
          {decision.stem || "no stem"}
        </span>
        <span className="text-muted-foreground">
          AI: <strong>{decision.ai_decision}</strong> · Editor:{" "}
          <strong>{decision.editor_decision}</strong>
        </span>
        <span className="text-muted-foreground tabular-nums ml-auto">
          AI score {aiScore}
        </span>
      </div>
      {decision.primary_signal_diff && (
        <div className="text-[11px]">
          <span className="text-muted-foreground">Primary signal diff:</span>{" "}
          <Badge variant="secondary" className="text-[10px] font-mono">
            {decision.primary_signal_diff}
          </Badge>
        </div>
      )}
      {decision.editor_reasoning && (
        <div className="text-[11px] italic text-muted-foreground border-l-2 border-amber-300/60 pl-2">
          “{decision.editor_reasoning}”
        </div>
      )}
      {decision.ai_analysis_excerpt && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            AI analysis excerpt
          </summary>
          <p className="mt-1 ml-2 leading-snug whitespace-pre-wrap">
            {decision.ai_analysis_excerpt}
          </p>
        </details>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <Button
          size="sm"
          variant={resolution === "approved" ? "default" : "outline"}
          className="h-6 px-2 text-[10px]"
          disabled={setResolution.isPending || resolution === "approved"}
          onClick={() => setResolution.mutate({ next: "approved" })}
          data-testid={`approve-decision-${decision.id}`}
        >
          {setResolution.isPending && resolution !== "approved" ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mr-1" />
          )}
          Approve AI
        </Button>
        <Button
          size="sm"
          variant={resolution === "rejected" ? "destructive" : "ghost"}
          className="h-6 px-2 text-[10px]"
          disabled={setResolution.isPending || resolution === "rejected"}
          onClick={() => setResolution.mutate({ next: "rejected" })}
          data-testid={`reject-decision-${decision.id}`}
        >
          <XCircle className="h-3 w-3 mr-1" />
          Reject AI
        </Button>
        {resolution && (
          <Badge
            variant="secondary"
            className="text-[10px]"
            data-testid={`resolution-${decision.id}`}
          >
            {resolution === "approved" ? "Approved" : "Rejected"}
          </Badge>
        )}
      </div>
    </div>
  );
}
