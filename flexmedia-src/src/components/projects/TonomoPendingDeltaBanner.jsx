import React, { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, X, Plus, Minus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";

function parsePendingDelta(raw) {
  if (!raw) return null;
  // jsonb storage of a JSON.stringify()'d object can yield nested string-in-string.
  // Parse up to 3 times until we hit a real object.
  let v = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" ? v : null;
}

function formatDateShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-AU", {
      timeZone: "Australia/Sydney",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Banner surfacing a Tonomo-proposed product/package delta that was stashed
 * because the project has a manual-edit lock. Admins can Apply (accept the
 * delta) or Dismiss (keep current products).
 *
 * Props:
 *   - project: project row with tonomo_pending_delta
 *   - canEdit: user has permission to apply/dismiss
 *   - onResolved: () => void — called after successful apply/dismiss so
 *     the parent refreshes the project
 *   - compact: if true, render as a smaller inline card (used on dashboards)
 */
export default function TonomoPendingDeltaBanner({ project, canEdit = false, onResolved, compact = false }) {
  const [busy, setBusy] = useState(false);
  const delta = useMemo(() => parsePendingDelta(project?.tonomo_pending_delta), [project?.tonomo_pending_delta]);

  if (!delta) return null;
  const diff = delta.diff || {};
  const added = diff.added_products || [];
  const removed = diff.removed_products || [];
  const qtyChanged = diff.qty_changed || [];
  const addedPkgs = diff.added_packages || [];
  const removedPkgs = diff.removed_packages || [];

  const hasChanges =
    added.length + removed.length + qtyChanged.length + addedPkgs.length + removedPkgs.length > 0;
  if (!hasChanges) return null;

  async function invoke(action) {
    if (busy) return;
    setBusy(true);
    const label = action === "apply" ? "Applying" : "Dismissing";
    const toastId = toast.loading(`${label} Tonomo delta...`);
    try {
      const { data, error } = await api.functions.invoke("applyTonomoDelta", {
        project_id: project.id,
        action,
      });
      if (error) throw new Error(error.message || "Failed");
      if (!data?.ok) throw new Error(data?.error || "Failed");
      toast.success(action === "apply" ? "Tonomo delta applied. Pricing is recalculating." : "Tonomo delta dismissed.", { id: toastId });
      refetchEntityList("Project");
      refetchEntityList("ProjectActivity");
      refetchEntityList("ProjectTask");
      onResolved?.();
    } catch (err) {
      toast.error(err?.message || "Failed to update pending delta", { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  const summaryLine = [
    added.length > 0 && `${added.length} added`,
    removed.length > 0 && `${removed.length} removed`,
    qtyChanged.length > 0 && `${qtyChanged.length} qty change${qtyChanged.length > 1 ? "s" : ""}`,
    addedPkgs.length > 0 && `${addedPkgs.length} package${addedPkgs.length > 1 ? "s" : ""} added`,
    removedPkgs.length > 0 && `${removedPkgs.length} package${removedPkgs.length > 1 ? "s" : ""} removed`,
  ]
    .filter(Boolean)
    .join(" · ");

  const detectedAt = formatDateShort(delta.detected_at);
  const eventType = delta.source_event_type || "change";

  return (
    <div
      className={[
        "rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800",
        compact ? "p-3" : "p-4",
      ].join(" ")}
      role="alert"
      aria-label="Tonomo pending delta"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              Tonomo updated this booking, but a manual-edit lock is on
            </span>
            <Badge variant="outline" className="border-amber-300 dark:border-amber-800 text-amber-800 bg-white/60 dark:bg-transparent dark:text-amber-200 text-[10px] uppercase tracking-wide">
              {eventType}
            </Badge>
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
            {summaryLine}
            {detectedAt ? ` · detected ${detectedAt}` : null}
          </p>

          {!compact && (added.length > 0 || addedPkgs.length > 0) && (
            <ul className="mt-3 space-y-1">
              {added.map((a) => (
                <li key={`add-${a.product_id}`} className="flex items-center gap-2 text-xs">
                  <Plus className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-emerald-800 dark:text-emerald-300 font-medium">{a.product_name}</span>
                  {a.quantity && a.quantity > 1 && (
                    <span className="text-emerald-600 dark:text-emerald-400">× {a.quantity}</span>
                  )}
                </li>
              ))}
              {addedPkgs.map((a) => (
                <li key={`addpkg-${a.package_id}`} className="flex items-center gap-2 text-xs">
                  <Plus className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-emerald-800 dark:text-emerald-300 font-medium">
                    Package: {a.package_name}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {!compact && (removed.length > 0 || removedPkgs.length > 0) && (
            <ul className="mt-2 space-y-1">
              {removed.map((r) => (
                <li key={`rem-${r.product_id}`} className="flex items-center gap-2 text-xs">
                  <Minus className="h-3.5 w-3.5 text-red-600" />
                  <span className="text-red-800 dark:text-red-300 line-through">{r.product_name}</span>
                </li>
              ))}
              {removedPkgs.map((r) => (
                <li key={`rempkg-${r.package_id}`} className="flex items-center gap-2 text-xs">
                  <Minus className="h-3.5 w-3.5 text-red-600" />
                  <span className="text-red-800 dark:text-red-300 line-through">
                    Package: {r.package_name}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {!compact && qtyChanged.length > 0 && (
            <ul className="mt-2 space-y-1">
              {qtyChanged.map((q) => (
                <li key={`qty-${q.product_id}`} className="flex items-center gap-2 text-xs">
                  <Pencil className="h-3.5 w-3.5 text-amber-600" />
                  <span className="text-amber-900 dark:text-amber-200 font-medium">{q.product_name}</span>
                  <span className="text-amber-700 dark:text-amber-400">
                    qty {q.from} → {q.to}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 mt-4">
            {canEdit ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => invoke("apply")}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  Apply Tonomo's changes
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => invoke("dismiss")}>
                  <X className="h-4 w-4 mr-1.5" />
                  Dismiss
                </Button>
              </>
            ) : (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                Admin approval required to apply or dismiss.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
