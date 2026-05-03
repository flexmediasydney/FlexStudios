/**
 * CellEditorDialog — modal editor for one matrix cell (or "Tier defaults").
 *
 * W11.6.28b: cell scope_type is now `package_x_price_tier` (was
 * `package_grade`). The Tier defaults pseudo-row stays at scope_type
 * `price_tier` with scope_ref_id = price_tier_id. See mig 443 + mig 446
 * + mig 447.
 *
 * Renders:
 *   1. Engine-grade pill (top — explanatory only; grade is per-round)
 *   2. Inheritance breadcrumb
 *   3. Per-cell target banner — X authored / Y target, with over-target
 *      warning when X > Y
 *   4. Per-cell engine_mode_override + tolerance band controls
 *   5. Engine-role tab strip with per-tab authored/target counts
 *   6. Position list for the active engine role with Add buttons
 *
 * The position editor itself is a child component (PositionRow) that
 * expands inline when ▶ is clicked.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Plus, Layers, Save, Info, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { IconTip } from "./Tip";
import PositionRow from "./PositionRow";
import {
  ENGINE_MODES,
  ENGINE_ROLES,
  IMAGE_SHORTLIST_ENGINE_ROLES,
  isImageShortlistEngineRole,
  deriveCellTarget,
  describeTargetBreakdown,
} from "./constants";
import { usePositionsForCell } from "./hooks";

export default function CellEditorDialog({
  open,
  onOpenChange,
  cell, // { kind: 'cell'|'defaults', packageId?, priceTierId, package?, tier, target? }
  // packages / tiers reserved for the prev/next jumper.
  packages: _packages,
  priceTiers: _priceTiers,
  tiers: _tiers,
  templates,
  productLookup,
  projectTypeId, // optional further-narrowing scope; null for now
  productId,
}) {
  const qc = useQueryClient();
  const [activeRole, setActiveRole] = useState("photo_day_shortlist");
  const [savingPositionId, setSavingPositionId] = useState(null);

  const isDefaults = cell?.kind === "defaults";

  const positionsQuery = usePositionsForCell({
    packageId: isDefaults ? null : cell?.packageId,
    priceTierId: cell?.priceTierId,
    projectTypeId,
    productId,
    enabled: open && Boolean(cell?.priceTierId),
  });

  const positions = positionsQuery.data?.positions || [];
  const scopeChain = positionsQuery.data?.scopeChain || [];

  // ── Engine-role tabs (image-shortlist filter, W11.6.28c) ────────────
  //
  // The Recipe Matrix authors per-position constraints for the IMAGE
  // shortlisting engine only. Other engine_roles (video / floorplan_qa /
  // agent_portraits) have separate processing pipelines and shouldn't
  // appear here. We only show tabs for image-class engine_roles
  // (photo_day_shortlist, photo_dusk_shortlist, drone_shortlist).
  //
  // Furthermore, we narrow the visible tabs to the engine_roles this
  // SPECIFIC package actually offers — based on the package's products[]
  // (e.g. Silver only ships Sales Images so it shouldn't render a Drone
  // Shots tab). Tier-defaults mode (no package) shows ALL image-class
  // tabs so operators can author cross-package defaults.
  const availableRoleKeys = useMemo(() => {
    if (isDefaults || !cell?.package) {
      return IMAGE_SHORTLIST_ENGINE_ROLES.slice();
    }
    const items = Array.isArray(cell.package.products) ? cell.package.products : [];
    const set = new Set();
    for (const item of items) {
      const prod = productLookup?.get?.(item.product_id);
      if (prod && isImageShortlistEngineRole(prod.engine_role)) {
        set.add(prod.engine_role);
      }
    }
    // Preserve the canonical display order from IMAGE_SHORTLIST_ENGINE_ROLES.
    return IMAGE_SHORTLIST_ENGINE_ROLES.filter((k) => set.has(k));
  }, [isDefaults, cell?.package, productLookup]);

  const visibleEngineRoles = useMemo(
    () => ENGINE_ROLES.filter((r) => availableRoleKeys.includes(r.key)),
    [availableRoleKeys],
  );

  // Re-anchor the active tab when the active package changes — otherwise
  // a tab that's not in availableRoleKeys for the new cell would render
  // an empty TabsContent with no content.
  useEffect(() => {
    if (visibleEngineRoles.length === 0) return;
    if (!visibleEngineRoles.find((r) => r.key === activeRole)) {
      setActiveRole(visibleEngineRoles[0].key);
    }
  }, [visibleEngineRoles, activeRole]);

  const positionsByRole = useMemo(() => {
    const out = {};
    for (const role of visibleEngineRoles) out[role.key] = [];
    for (const p of positions) {
      const role = p.engine_role || "photo_day_shortlist";
      if (!out[role]) out[role] = [];
      out[role].push(p);
    }
    for (const role of Object.keys(out)) {
      out[role].sort(
        (a, b) => (a.position_index ?? 0) - (b.position_index ?? 0),
      );
    }
    return out;
  }, [positions, visibleEngineRoles]);

  // ── Per-cell + per-engine-role target derivation ─────────────────────
  //
  // The cell-level target is the package's image_count for this tier, with
  // the sum-of-products fallback. Per-tab targets break that total down by
  // engine_role using the products' engine_role + the package's products[]
  // line items. This lets us render "5 authored / 12 target" for the Sales
  // Images tab specifically, instead of using the cell total everywhere.
  const cellTarget = useMemo(() => {
    if (!cell || isDefaults) return { value: null, source: "defaults", breakdown: [] };
    if (cell.target?.value != null) return cell.target;
    return deriveCellTarget(cell.package, cell.tier?.code, productLookup);
  }, [cell, isDefaults, productLookup]);

  const perRoleTargets = useMemo(() => {
    const out = {};
    for (const role of visibleEngineRoles) out[role.key] = null;
    if (isDefaults || !cell?.package) return out;

    const tierCode = cell.tier?.code || "standard";
    const items = Array.isArray(cell.package.products) ? cell.package.products : [];
    for (const item of items) {
      const prod = productLookup?.get?.(item.product_id);
      // Skip non-image-class products entirely — they don't belong in the
      // image-shortlist per-role budget (W11.6.28c).
      if (!prod || !isImageShortlistEngineRole(prod.engine_role)) continue;
      const role = prod.engine_role;
      // Per-product tier image_count if available.
      const tierKey = tierCode === "premium" ? "premium_tier" : "standard_tier";
      let qty = null;
      if (prod && prod[tierKey] && typeof prod[tierKey] === "object") {
        const ic =
          prod[tierKey].image_count ??
          prod[tierKey].images ??
          prod[tierKey].deliverable_count;
        if (Number.isFinite(Number(ic)) && Number(ic) > 0) qty = Number(ic);
      }
      if (qty == null && Number.isFinite(Number(item.quantity))) {
        qty = Number(item.quantity);
      }
      if (qty == null || qty === 0) continue;
      out[role] = (out[role] || 0) + qty;
    }
    return out;
  }, [cell, isDefaults, productLookup, visibleEngineRoles]);

  const cellAuthoredTotal = positions.length;
  const cellOverTarget =
    cellTarget?.value != null && cellAuthoredTotal > cellTarget.value;

  // ── Mutations ────────────────────────────────────────────────────
  //
  // Cell scope (W11.6.28b):
  //   - Tier defaults pseudo-row → scope_type = 'price_tier',
  //                                scope_ref_id = price_tier_id,
  //                                scope_ref_id_2 = NULL
  //   - Package × price tier cell → scope_type = 'package_x_price_tier',
  //                                 scope_ref_id = package_id,
  //                                 scope_ref_id_2 = price_tier_id
  const upsertMutation = useMutation({
    mutationFn: async (row) => {
      const scopePayload = isDefaults
        ? {
            scope_type: "price_tier",
            scope_ref_id: cell.priceTierId,
            scope_ref_id_2: null,
          }
        : {
            scope_type: "package_x_price_tier",
            scope_ref_id: cell.packageId,
            scope_ref_id_2: cell.priceTierId,
          };

      // Filter the row down to columns that actually exist on the table.
      const transientKeys = [
        "is_overridden_at_cell",
        "inherited_from_scope",
        "package_id",
        "price_tier_id",
        "project_type_id",
        "product_id",
        "scope_ref_id_3",
      ];
      const sanitised = { ...row };
      for (const k of transientKeys) delete sanitised[k];

      // BUG-4 FIX (QC v2 — 2026-05-02): empty `notes` strings round-trip
      // to NULL in the DB, but the textarea-driven draft can still produce
      // "" if a future change ever bypasses normalisePosition. Coerce here
      // defensively so the upsert payload is always canonical.
      if (sanitised.notes === "") sanitised.notes = null;

      const payload = { ...sanitised, ...scopePayload };
      const id = payload.id;
      delete payload.id;

      if (id) {
        const { error } = await supabase
          .from("gallery_positions")
          .update(payload)
          .eq("id", id);
        if (error) throw new Error(error.message);
        return { id };
      }
      const { data, error } = await supabase
        .from("gallery_positions")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    onMutate: (row) => setSavingPositionId(row?.id || "new"),
    onSettled: () => setSavingPositionId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recipe-matrix-positions"] });
      qc.invalidateQueries({ queryKey: ["recipe-matrix-cell-counts"] });
      toast.success("Position saved.");
    },
    onError: (err) => {
      toast.error(`Save failed: ${err?.message || err}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (row) => {
      if (!row?.id) return;
      const { error } = await supabase
        .from("gallery_positions")
        .delete()
        .eq("id", row.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recipe-matrix-positions"] });
      qc.invalidateQueries({ queryKey: ["recipe-matrix-cell-counts"] });
      toast.success("Position deleted.");
    },
    onError: (err) => toast.error(`Delete failed: ${err?.message || err}`),
  });

  // ── Engine-mode override + tolerance ────────────────────────────
  //
  // The dialog stays mounted across cell switches (RecipeMatrixTab toggles
  // `open` instead of unmounting), so useState would hold stale values
  // from the PREVIOUS cell. The useEffect below re-syncs whenever the
  // active cell changes — without it, opening Silver→Gold leaves Silver's
  // tolerance / engine_mode showing in the Gold dialog.
  const pkg = cell?.package || null;
  const [engineMode, setEngineMode] = useState(
    pkg?.engine_mode_override || "",
  );
  const [tolBelow, setTolBelow] = useState(
    pkg?.expected_count_tolerance_below ?? "",
  );
  const [tolAbove, setTolAbove] = useState(
    pkg?.expected_count_tolerance_above ?? "",
  );

  useEffect(() => {
    setEngineMode(pkg?.engine_mode_override || "");
    setTolBelow(pkg?.expected_count_tolerance_below ?? "");
    setTolAbove(pkg?.expected_count_tolerance_above ?? "");
    setActiveRole("photo_day_shortlist");
  }, [
    pkg?.id,
    pkg?.engine_mode_override,
    pkg?.expected_count_tolerance_below,
    pkg?.expected_count_tolerance_above,
  ]);

  const packageMutation = useMutation({
    mutationFn: async () => {
      if (!pkg?.id) return;
      const update = {};
      if (engineMode === "") update.engine_mode_override = null;
      else update.engine_mode_override = engineMode;
      update.expected_count_tolerance_below =
        tolBelow === "" ? null : Number(tolBelow);
      update.expected_count_tolerance_above =
        tolAbove === "" ? null : Number(tolAbove);
      const { error } = await supabase
        .from("packages")
        .update(update)
        .eq("id", pkg.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recipe-matrix-refs"] });
      toast.success("Package settings saved.");
    },
    onError: (err) => toast.error(`Save failed: ${err?.message || err}`),
  });

  const titleSuffix = isDefaults
    ? `Tier defaults — ${cell?.tier?.display_name || ""}`
    : `${cell?.package?.name || ""} × ${cell?.tier?.display_name || ""}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl max-h-[90vh] overflow-y-auto"
        data-testid="cell-editor-dialog"
        aria-describedby="cell-editor-description"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-blue-600" />
            {titleSuffix}
          </DialogTitle>
          <DialogDescription id="cell-editor-description">
            Author the constraint-based position list for this scope. Each
            position is a row in <code>gallery_positions</code>.
          </DialogDescription>
        </DialogHeader>

        {/* Engine grade explanatory pill — grade is NOT a matrix axis. */}
        <div
          className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-700"
          data-testid="engine-grade-pill"
        >
          <Info className="h-3.5 w-3.5 mt-0.5 text-slate-500 flex-shrink-0" />
          <div className="leading-snug">
            <strong>Engine grade</strong> (Volume / Refined / Editorial) is
            derived per-round from the shoot quality and steers Stage 4
            voice anchor. It does <em>not</em> affect slot allocation.
            Recipes are scoped to <code>package × price tier</code> only.
          </div>
        </div>

        {/* Cell-level authored/target banner with over-target warning. */}
        {!isDefaults && (
          <div
            className={
              "rounded-md border px-3 py-2 text-xs " +
              (cellOverTarget
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-blue-200 bg-blue-50 text-blue-900")
            }
            data-testid="cell-target-banner"
          >
            {cellOverTarget ? (
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-700 flex-shrink-0" />
                <div className="space-y-0.5">
                  <div className="font-semibold">
                    Over target: {cellAuthoredTotal} authored /{" "}
                    {cellTarget.value} target
                  </div>
                  <div>
                    This recipe authors {cellAuthoredTotal} positions but
                    the package target is {cellTarget.value}. The engine
                    will drop the {cellAuthoredTotal - cellTarget.value}{" "}
                    lowest-priority position
                    {cellAuthoredTotal - cellTarget.value === 1 ? "" : "s"}{" "}
                    (optional first, then conditional) to fit. To resolve:
                    remove {cellAuthoredTotal - cellTarget.value} position
                    {cellAuthoredTotal - cellTarget.value === 1 ? "" : "s"}{" "}
                    OR bump the package target.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-semibold tabular-nums">
                  {cellAuthoredTotal} authored / {cellTarget?.value ?? "—"} target
                </span>
                {cellTarget?.value != null && (
                  <span className="opacity-80">
                    — {describeTargetBreakdown(cellTarget)}
                  </span>
                )}
                {cellTarget?.value == null && (
                  <span className="opacity-80">
                    — package has no image_count or products quantities for
                    this tier; cell renders without a target gauge.
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Inheritance breadcrumb */}
        {scopeChain.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] mt-1" data-testid="scope-breadcrumb">
            <span className="text-muted-foreground">Inheriting from:</span>
            {scopeChain.map((s, i) => (
              <React.Fragment key={`${s.scope}-${i}`}>
                <Badge
                  variant={i === scopeChain.length - 1 ? "default" : "outline"}
                  className="font-normal"
                >
                  {s.label}
                  {s.override_count != null && (
                    <span className="ml-1 opacity-70">
                      ({s.override_count})
                    </span>
                  )}
                </Badge>
                {i < scopeChain.length - 1 && (
                  <span className="text-muted-foreground">→</span>
                )}
              </React.Fragment>
            ))}
            <IconTip
              text="Each step further narrows the scope. Overrides at this cell replace inherited rows by position_index. Engine grade is NOT in this chain — it's per-round derived."
            />
          </div>
        )}

        {/* Engine mode + tolerance row (only when editing a package cell) */}
        {!isDefaults && pkg && (
          <div className="rounded-md border bg-muted/30 p-3 grid grid-cols-3 gap-3 mt-2">
            <div>
              <Label className="text-xs flex items-center gap-1">
                Engine mode
                <IconTip
                  text={
                    ENGINE_MODES.find((m) => m.key === engineMode)?.blurb ||
                    "How the engine treats this recipe at round time. Inherits from package default when blank."
                  }
                />
              </Label>
              <Select
                value={engineMode || "__inherit__"}
                onValueChange={(v) =>
                  setEngineMode(v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger className="h-7 text-xs" data-testid="engine-mode-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">(inherit default)</SelectItem>
                  {ENGINE_MODES.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs flex items-center gap-1">
                Tolerance below
                <IconTip
                  text="How many positions short of the package target the round may be without flagging a health warning."
                />
              </Label>
              <Input
                type="number"
                className="h-7 text-xs"
                placeholder="—"
                value={tolBelow}
                onChange={(e) => setTolBelow(e.target.value)}
                data-testid="tolerance-below-input"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label className="text-xs flex items-center gap-1">
                  Tolerance above
                  <IconTip
                    text="How many positions over the package target the round may be without flagging a health warning."
                  />
                </Label>
                <Input
                  type="number"
                  className="h-7 text-xs"
                  placeholder="—"
                  value={tolAbove}
                  onChange={(e) => setTolAbove(e.target.value)}
                  data-testid="tolerance-above-input"
                />
              </div>
              <Button
                size="sm"
                className="h-7"
                onClick={() => packageMutation.mutate()}
                disabled={packageMutation.isPending}
                data-testid="save-package-settings"
              >
                <Save className="h-3 w-3 mr-1" />
                Save
              </Button>
            </div>
          </div>
        )}

        {/* Engine-role tabs + position list */}
        {visibleEngineRoles.length === 0 ? (
          // Package has no image-class products — render an empty state
          // explaining why no tabs appear (e.g. "Day Video Package" has only
          // video products, "Floor and Site Plan" only has floorplan_qa).
          <div
            className="rounded-md border border-amber-200 bg-amber-50/50 px-3 py-3 text-[12px] text-amber-900 mt-3"
            data-testid="cell-editor-empty-state"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-semibold mb-0.5">
                  No image-shortlist products in this package.
                </div>
                <div>
                  This authoring surface is for image shortlisting only
                  (Sales / Dusk / Drone). The package has no products with an
                  image-class engine_role assigned. Edit the package to add
                  one, or use a different authoring tool for video / floor
                  plan / portrait deliverables.
                </div>
              </div>
            </div>
          </div>
        ) : (
        <Tabs
          value={activeRole}
          onValueChange={setActiveRole}
          className="mt-3"
        >
          <TabsList className="h-auto flex flex-wrap">
            {visibleEngineRoles.map((role) => {
              const authoredCount = positionsByRole[role.key]?.length || 0;
              const tabTarget = perRoleTargets[role.key];
              const tabOver = tabTarget != null && authoredCount > tabTarget;
              return (
                <TabsTrigger
                  key={role.key}
                  value={role.key}
                  className="gap-2 text-xs"
                  data-testid={`engine-role-tab-${role.key}`}
                >
                  {role.label}
                  <Badge
                    variant={tabOver ? "destructive" : "secondary"}
                    className="text-[10px]"
                    data-testid={`engine-role-tab-${role.key}-count`}
                  >
                    {authoredCount}
                    {tabTarget != null ? `/${tabTarget}` : ""}
                  </Badge>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {visibleEngineRoles.map((role) => {
            const list = positionsByRole[role.key] || [];
            const tabAuthored = list.length;
            const tabTarget = perRoleTargets[role.key];
            const tabOver = tabTarget != null && tabAuthored > tabTarget;
            return (
              <TabsContent
                key={role.key}
                value={role.key}
                className="space-y-2 mt-3"
              >
                {/* Per-tab authored/target banner */}
                {!isDefaults && (
                  <div
                    className={
                      "rounded-md border px-2.5 py-1.5 text-[11px] " +
                      (tabOver
                        ? "border-amber-300 bg-amber-50 text-amber-900"
                        : "border-slate-200 bg-slate-50 text-slate-700")
                    }
                    data-testid={`engine-role-tab-banner-${role.key}`}
                  >
                    {tabOver ? (
                      <div className="flex items-start gap-1.5">
                        <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                        <span>
                          <strong>{tabAuthored} authored / {tabTarget} target</strong>{" "}
                          — this engine role is over budget. The engine will
                          drop {tabAuthored - tabTarget} lowest-priority
                          position{tabAuthored - tabTarget === 1 ? "" : "s"}{" "}
                          (optional first, then conditional) to fit.
                        </span>
                      </div>
                    ) : (
                      <span>
                        <strong className="tabular-nums">
                          {tabAuthored} authored / {tabTarget != null ? tabTarget : "—"} target
                        </strong>
                        {tabTarget == null && (
                          <span className="opacity-80 ml-1.5">
                            — no per-role budget for this engine role.
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}

                {positionsQuery.isLoading && (
                  <div className="text-xs text-muted-foreground">
                    Loading positions…
                  </div>
                )}
                {positionsQuery.error && (
                  <div className="text-xs text-rose-600">
                    {positionsQuery.error.message}
                  </div>
                )}
                {!positionsQuery.isLoading && list.length === 0 && (
                  <div className="text-xs text-muted-foreground italic">
                    No positions defined for this engine role yet. Use the
                    buttons below to add one.
                  </div>
                )}
                {list.map((p, idx) => (
                  <PositionRow
                    key={p.id || `new-${idx}`}
                    position={p}
                    index={idx}
                    templates={templates}
                    saving={savingPositionId === p.id}
                    onSave={(draft) =>
                      upsertMutation.mutate({
                        ...draft,
                        engine_role: role.key,
                        position_index:
                          draft.position_index ?? idx + 1,
                      })
                    }
                    onDelete={(row) => {
                      if (!row?.id) return;
                      if (window.confirm("Delete this position?")) {
                        deleteMutation.mutate(row);
                      }
                    }}
                  />
                ))}

                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      // Insert a blank position via the upsert mutation.
                      upsertMutation.mutate({
                        engine_role: role.key,
                        position_index: list.length + 1,
                        phase: "optional",
                        selection_mode: "ai_decides",
                        ai_backfill_on_gap: true,
                      });
                    }}
                    data-testid={`add-blank-position-${role.key}`}
                  >
                    <Plus className="h-3 w-3 mr-1.5" />
                    Add blank position
                  </Button>

                  <AddFromTemplateButton
                    templates={templates}
                    onPick={(slot) =>
                      upsertMutation.mutate({
                        engine_role: role.key,
                        position_index: list.length + 1,
                        template_slot_id: slot.slot_id,
                        phase:
                          slot.phase === 1
                            ? "mandatory"
                            : slot.phase === 2
                              ? "conditional"
                              : "optional",
                        selection_mode: "ai_decides",
                        ai_backfill_on_gap: true,
                        room_type:
                          Array.isArray(slot.eligible_room_types) &&
                          slot.eligible_room_types.length === 1
                            ? slot.eligible_room_types[0]
                            : null,
                      })
                    }
                    testIdPrefix={`add-from-template-${role.key}`}
                  />
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddFromTemplateButton({ templates, onPick, testIdPrefix }) {
  const [value, setValue] = useState("");
  return (
    <div className="inline-flex items-center gap-1.5">
      <Select
        value={value}
        onValueChange={(slotId) => {
          const t = templates.find((s) => s.slot_id === slotId);
          if (t) {
            onPick(t);
            setValue("");
          }
        }}
      >
        <SelectTrigger className="h-7 text-xs w-[220px]" data-testid={testIdPrefix}>
          <SelectValue placeholder="+ Add from template" />
        </SelectTrigger>
        <SelectContent>
          {templates.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No templates yet — open the Advanced expander to author one.
            </div>
          ) : (
            templates.map((t) => (
              <SelectItem key={t.slot_id} value={t.slot_id}>
                {t.display_name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
