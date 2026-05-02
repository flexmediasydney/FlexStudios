/**
 * AutoPromotionCard — pending position-template suggestion review queue.
 *
 * R2's auto-promotion mechanic watches gallery_positions traffic and
 * proposes new templates when a constraint tuple keeps appearing
 * organically. This card surfaces the queue at the top of the Recipes
 * tab; clicking it opens a modal with approve / reject / merge actions.
 *
 * Empty state (no pending suggestions): the card is not rendered at all
 * (the parent decides based on `suggestions.length === 0`).
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import { IconTip } from "./Tip";

export default function AutoPromotionCard({ suggestions = [] }) {
  const [open, setOpen] = useState(false);
  if (!suggestions || suggestions.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="auto-promotion-card"
        className="w-full flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3 hover:bg-amber-100 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <div>
            <div className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
              {suggestions.length} template suggestion
              {suggestions.length === 1 ? "" : "s"} pending review
              <IconTip
                className="text-amber-700"
                text="The engine watches recurring gallery_position constraint tuples and proposes them as templates. Approve to add to the slot library; reject to ignore the pattern."
              />
            </div>
            <div className="text-xs text-amber-800">
              Click to review and approve / reject / merge.
            </div>
          </div>
        </div>
        <Badge variant="secondary" className="bg-amber-100 text-amber-900">
          Review
        </Badge>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-2xl"
          data-testid="auto-promotion-dialog"
        >
          <DialogHeader>
            <DialogTitle>Pending template suggestions</DialogTitle>
            <DialogDescription>
              These constraint tuples appeared often enough in live recipes
              to be candidates for promotion to slot templates. Approve adds
              the template to the library; reject ignores the pattern;
              merge folds the suggestion into an existing template.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs font-medium border-b pb-1.5">
              <div className="col-span-4">Suggested slot id</div>
              <div className="col-span-2">Sample size</div>
              <div className="col-span-3">Created</div>
              <div className="col-span-3 text-right">Actions</div>
            </div>
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-12 text-xs items-center"
                data-testid={`promotion-suggestion-${s.id}`}
              >
                <div className="col-span-4 font-mono text-[11px]">
                  {s.suggested_template_slot_id}
                </div>
                <div className="col-span-2">{s.sample_count ?? "—"}</div>
                <div className="col-span-3 text-muted-foreground">
                  {s.created_at
                    ? new Date(s.created_at).toLocaleDateString()
                    : "—"}
                </div>
                <div className="col-span-3 flex justify-end gap-1.5">
                  <Button size="sm" variant="outline" disabled>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" disabled>
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground pt-3 border-t">
            Approve / reject actions wire to R2's edge function once mig 444
            ships. The queue itself is read-only here in the meantime.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
