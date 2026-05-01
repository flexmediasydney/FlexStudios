/**
 * ManualClassifyDialog — W15b.8
 *
 * master_admin override dialog for the per-listing photo_breakdown.
 *
 * Used when Gemini's auto-classification got things wrong and the operator
 * wants to lock in canonical counts (day/dusk/drone/floorplan/video). Writes
 * a manual_override row to pulse_listing_vision_extracts via the same edge
 * function W15b.1 invokes for force-refresh, but with `manual_override=true`
 * payload — the edge fn flips status to 'manually_overridden' and writes
 * manual_override_by + manual_override_reason.
 *
 * Built defensively: if the edge function isn't deployed yet (W15b.1 may not
 * have merged), the form catches the error and surfaces a toast — the dialog
 * UI is still useful as a "what would I set" preview.
 */
import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { api } from "@/api/supabaseClient";

const FIELDS = [
  { key: "day_count", label: "Day photos" },
  { key: "dusk_count", label: "Dusk photos" },
  { key: "drone_count", label: "Drone photos" },
  { key: "floorplan_count", label: "Floorplans" },
  { key: "detail_count", label: "Detail photos" },
  { key: "video_thumbnail_count", label: "Video thumbs" },
  { key: "agent_headshot_count", label: "Agent headshots" },
];

export default function ManualClassifyDialog({ open, onClose, extract, listingId, onSaved }) {
  const [counts, setCounts] = useState({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed defaults from current extract whenever it opens with a fresh extract.
  useEffect(() => {
    if (!open) return;
    const photo = extract?.photo_breakdown || {};
    const seeded = {};
    for (const f of FIELDS) {
      seeded[f.key] = Number(photo[f.key] ?? 0);
    }
    setCounts(seeded);
    setReason(extract?.manual_override_reason || "");
  }, [open, extract]);

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast.error("Override reason is required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        listing_id: listingId,
        manual_override: true,
        manual_override_reason: reason.trim(),
        photo_breakdown: counts,
      };
      const resp = await api.functions.invoke("pulse-listing-vision-extract", payload);
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) throw new Error(result?.error || "Manual override failed.");
      toast.success("Manual classification saved.");
      onSaved?.(result?.extract ?? null);
      onClose?.();
    } catch (err) {
      toast.error(`Failed: ${err?.message || "unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manually classify photo breakdown</DialogTitle>
          <DialogDescription>
            Override Gemini's per-image counts when the auto-classification got
            things wrong. Sets <code>status='manually_overridden'</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`mc-${f.key}`} className="text-[11px]">{f.label}</Label>
              <Input
                id={`mc-${f.key}`}
                type="number"
                min={0}
                value={counts[f.key] ?? 0}
                onChange={(e) =>
                  setCounts((prev) => ({
                    ...prev,
                    [f.key]: Math.max(0, Number(e.target.value || 0)),
                  }))
                }
                className="h-8 text-sm"
              />
            </div>
          ))}
        </div>

        <div className="space-y-1">
          <Label htmlFor="mc-reason" className="text-[11px]">Override reason</Label>
          <Textarea
            id="mc-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why are you overriding the auto-classification?"
            className="text-sm"
          />
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
