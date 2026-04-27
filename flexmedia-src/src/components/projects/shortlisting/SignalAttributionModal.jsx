/**
 * SignalAttributionModal — Wave 10.3 P1-16
 *
 * Non-blocking modal shown after a `removed` or `swapped` override fires.
 * The override row is already inserted (optimistic UI write); this modal
 * collects the primary_signal_overridden value and PATCHes it onto the row
 * via the shortlisting-overrides edge function's `annotate` action.
 *
 * UX rules (from W10-3 design spec §3 + Q1 resolution):
 *   - Non-blocking: slides in but doesn't gate. The override is committed
 *     before the modal renders. If the editor dismisses without choosing,
 *     `primary_signal_overridden` stays NULL (a legitimate signal in itself
 *     — "editor was in flow, didn't want to interrupt with annotation").
 *   - Dismissable: Esc key, click-outside, or X button.
 *   - 14 curated signal options (Q2 resolution: not all 22 W11 keys —
 *     curated list keeps signal-quality high; promote frequent free-text
 *     answers via a future Settings page).
 *   - "Other (free text)" escape hatch: max 200 chars, trimmed, empty-after-
 *     trim collapses to NULL on the server.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

// 14 curated signal options + free-text "other" as the 15th entry. The values
// match the W11 universal-vision response keys (signal_scores.*) so analytics
// can correlate human-stated reasons with model-emitted scores. Order is
// roughly "most common first" per spec.
const SIGNAL_OPTIONS = [
  { value: "vertical_line_convergence", label: "Vertical lines / keystone" },
  { value: "horizon_level", label: "Horizon / level" },
  { value: "sharpness_primary_subject", label: "Sharpness / focus" },
  { value: "primary_subject_focus", label: "Primary subject focus" },
  { value: "window_blowout_area", label: "Window blowout / lighting" },
  { value: "shadow_crush_percentage", label: "Shadow detail" },
  { value: "ambient_artificial_balance", label: "Light balance" },
  { value: "composition_type_match", label: "Composition / framing" },
  { value: "three_wall_coverage", label: "Wall coverage (kitchen)" },
  { value: "sight_line_depth_layers", label: "Depth / sight lines" },
  { value: "styling_deliberateness", label: "Styling / staging" },
  { value: "clutter_severity", label: "Clutter / mess" },
  { value: "duplicate_or_near_dup", label: "Near-duplicate of better shot" },
  { value: "client_preference", label: "Client / agent preference" },
  { value: "other", label: "Other (free text)" },
];

const OTHER_VALUE = "other";
const FREE_TEXT_MAX_LEN = 200;

/**
 * @param {object} props
 * @param {boolean} props.open                 dialog open state
 * @param {function} props.onOpenChange        called with `false` on dismiss
 * @param {string|null} props.overrideId       UUID of the row to annotate; null
 *                                             when no annotation is pending
 * @param {string} [props.actionLabel]         "removed" | "swapped" — used in
 *                                             the dialog copy
 * @param {function} props.onSubmit            invoked with the chosen signal
 *                                             string (already trimmed; never
 *                                             returns the literal "other") OR
 *                                             null if the editor picked "other"
 *                                             with empty free-text. Async; the
 *                                             modal awaits it and shows a
 *                                             spinner during the request.
 */
export default function SignalAttributionModal({
  open,
  onOpenChange,
  overrideId,
  actionLabel = "override",
  onSubmit,
}) {
  const [selected, setSelected] = useState("");
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset internal state every time the modal opens for a new override.
  // Without this, the previous selection would bleed into the next modal,
  // which is a particularly nasty bug in tight review sessions where the
  // editor dismisses one and immediately drags another.
  useEffect(() => {
    if (open) {
      setSelected("");
      setFreeText("");
      setSubmitting(false);
    }
  }, [open, overrideId]);

  const handleDismiss = () => {
    if (submitting) return;
    onOpenChange?.(false);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (!selected) {
      // Empty-selection guard: editor must pick something to submit. If they
      // don't want to annotate at all, they dismiss the modal — that's a
      // separate code path which leaves the row's signal as NULL.
      return;
    }

    let signalToSend;
    if (selected === OTHER_VALUE) {
      const trimmed = freeText.trim();
      if (trimmed.length === 0) {
        // "Other" with empty text: treat as a non-annotation. Server will
        // collapse empty-after-trim to NULL anyway, but we save the round-
        // trip and just dismiss.
        onOpenChange?.(false);
        return;
      }
      signalToSend = trimmed.slice(0, FREE_TEXT_MAX_LEN);
    } else {
      signalToSend = selected;
    }

    setSubmitting(true);
    try {
      await onSubmit?.(signalToSend);
    } finally {
      setSubmitting(false);
      onOpenChange?.(false);
    }
  };

  // Don't even render the inner dialog content if there's no override id —
  // protects against a stale prop briefly flashing the modal during teardown.
  const hasContext = Boolean(overrideId);

  return (
    <Dialog open={open && hasContext} onOpenChange={handleDismiss}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What drove the {actionLabel}?</DialogTitle>
          <DialogDescription>
            Optional — helps the model learn which signal mattered. Skip with
            Esc if you'd rather keep moving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="signal-select" className="text-xs">
              Primary signal
            </Label>
            <Select value={selected} onValueChange={setSelected} disabled={submitting}>
              <SelectTrigger id="signal-select" className="text-sm">
                <SelectValue placeholder="Pick a reason…" />
              </SelectTrigger>
              <SelectContent>
                {SIGNAL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selected === OTHER_VALUE && (
            <div className="space-y-1.5">
              <Label htmlFor="signal-free-text" className="text-xs">
                Tell us briefly
              </Label>
              <Input
                id="signal-free-text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                maxLength={FREE_TEXT_MAX_LEN}
                placeholder="e.g. agent specifically requested a different angle"
                disabled={submitting}
                className="text-sm"
              />
              <div className="text-[10px] text-muted-foreground tabular-nums">
                {freeText.length} / {FREE_TEXT_MAX_LEN}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={handleDismiss} disabled={submitting} size="sm">
            Skip
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selected || submitting}
            size="sm"
          >
            {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Exported for tests + downstream wiring (Settings admin page can reference
// the canonical list when promoting free-text answers).
export { SIGNAL_OPTIONS };
