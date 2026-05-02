/**
 * MergeCandidateDialog — W12.B merge UX for the discovery queue.
 *
 * Opens when the operator selects ≥1 pending candidates and clicks "Merge into".
 * Asks for the target_canonical_id (looked up by canonical_id text or row UUID)
 * and POSTs `merge_candidates` to the object-registry-admin edge fn.
 *
 * Wraps the standard Dialog primitive — caller passes selection + close handler.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, GitMerge } from "lucide-react";

export default function MergeCandidateDialog({
  open,
  onOpenChange,
  candidateIds,
  onSubmit,
  busy,
}) {
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setTarget("");
      setNotes("");
    }
  }, [open]);

  const count = (candidateIds || []).length;
  const isValid = target.trim().length > 0 && count > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-violet-600" />
            Merge candidate{count === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Merging <span className="font-mono tabular-nums">{count}</span> pending
            candidate{count === 1 ? "" : "s"} into an existing canonical.
            observation_count is summed onto the target's <code className="text-[10px]">market_frequency</code>.
          </p>
          <div>
            <Label htmlFor="merge_target" className="text-[10px] uppercase tracking-wide">
              target canonical_id <span className="text-red-500">*</span>
            </Label>
            <Input
              id="merge_target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="kitchen_island | UUID"
              className="font-mono text-xs h-8 mt-1"
              data-testid="merge-target-input"
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Accepts <code>canonical_id</code> text or a row UUID. Edge fn resolves either.
            </p>
          </div>
          <div>
            <Label htmlFor="merge_notes" className="text-[10px] uppercase tracking-wide">
              notes (optional)
            </Label>
            <Textarea
              id="merge_notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="why these belong to the target — for audit"
              className="text-xs mt-1 min-h-[50px]"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSubmit({
                target_canonical_id: target.trim(),
                notes: notes.trim(),
              })
            }
            disabled={busy || !isValid}
            data-testid="merge-submit-button"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <GitMerge className="h-3.5 w-3.5 mr-1" />
            )}
            Merge {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
