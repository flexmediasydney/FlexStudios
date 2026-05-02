/**
 * EditorShortlistDialog — Wave 14
 *
 * Modal opened from CalibrationSessionDetailTab when admin clicks an editor
 * shortlist progress row. Shows the editor's blind shortlist for one project
 * (picked stems + per-stem notes) and lets the operator submit the shortlist
 * on the editor's behalf when needed.
 *
 * Spec: docs/design-specs/W14-calibration-session.md §2 + §5.
 *
 * v1: lightweight viewer + manual stems entry. The full blind-selection UI
 * (Dropbox preview grid + per-stem [add] buttons) is its own surface and
 * lives outside the admin page — this dialog is the master_admin override
 * path for repair / spot-check.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function EditorShortlistDialog({
  open,
  onOpenChange,
  shortlistRow,
}) {
  const qc = useQueryClient();
  const [stemsText, setStemsText] = useState("");

  useEffect(() => {
    const stems = Array.isArray(shortlistRow?.editor_picked_stems)
      ? shortlistRow.editor_picked_stems
      : [];
    setStemsText(stems.join("\n"));
  }, [shortlistRow?.id, shortlistRow?.editor_picked_stems]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!shortlistRow?.id) throw new Error("No shortlist row selected");
      const stems = stemsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.entities.CalibrationEditorShortlist.update(shortlistRow.id, {
        editor_picked_stems: stems,
        status: "submitted",
        submitted_at: new Date().toISOString(),
      });
      return stems;
    },
    onSuccess: (stems) => {
      toast.success(`Editor shortlist submitted (${stems.length} stems).`);
      qc.invalidateQueries({
        queryKey: ["calibration-editor-shortlists"],
      });
      onOpenChange?.(false);
    },
    onError: (err) => {
      toast.error(`Submit failed: ${err?.message || String(err)}`);
    },
  });

  if (!shortlistRow) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="editor-shortlist-dialog">
        <DialogHeader>
          <DialogTitle>Editor shortlist — manual override</DialogTitle>
          <DialogDescription className="text-xs">
            Status:{" "}
            <span className="font-mono">{shortlistRow.status || "—"}</span>{" "}
            · submitted{" "}
            {shortlistRow.submitted_at
              ? new Date(shortlistRow.submitted_at).toLocaleString()
              : "not yet"}
            . Paste stem identifiers (one per line) to submit on the editor's
            behalf — typically used to repair a half-finished selection.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">Picked stems</Label>
          <Textarea
            value={stemsText}
            onChange={(e) => setStemsText(e.target.value)}
            rows={10}
            placeholder={"IMG_017\nIMG_034\nIMG_041"}
            data-testid="editor-stems-input"
            className="font-mono text-xs"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)}>
            Cancel
          </Button>
          <Button
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
            data-testid="editor-shortlist-submit"
          >
            {submit.isPending && (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            )}
            Submit on editor's behalf
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
