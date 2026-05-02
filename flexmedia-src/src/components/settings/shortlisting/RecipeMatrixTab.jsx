/**
 * RecipeMatrixTab — Wave 11.6.28 (replaces SlotRecipesTab + the slots /
 * standards subtabs in the IA).
 *
 * Operator-friendly authoring surface for the constraint-based
 * `gallery_positions` model. Joseph wanted to think in terms of
 * "10 positions for Silver Standard: 2 kitchens, 1 master bedroom, …"
 * rather than the old engine-internal slot taxonomy.
 *
 * Top-level layout:
 *   1. Help banner + slide-out drawer for deeper docs
 *   2. Auto-promotion review queue card (R2's mechanic; hidden when empty)
 *   3. The Matrix (rows = packages, cols = price tiers, click cell to edit)
 *   4. Advanced — Slot Templates expander (collapsed by default)
 *
 * Cell editing happens in a Dialog (CellEditorDialog) so the matrix stays
 * the persistent surface and the URL doesn't churn.
 *
 * This component is the default export and stands alone — the umbrella
 * pulls it in via React.lazy.
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, BookOpen } from "lucide-react";

import HelpDrawer from "./recipe-matrix/HelpDrawer";
import MatrixGrid from "./recipe-matrix/MatrixGrid";
import CellEditorDialog from "./recipe-matrix/CellEditorDialog";
import AdvancedSlotTemplates from "./recipe-matrix/AdvancedSlotTemplates";
import AutoPromotionCard from "./recipe-matrix/AutoPromotionCard";
import { useRecipeRefs, usePromotionSuggestions } from "./recipe-matrix/hooks";

export default function RecipeMatrixTab() {
  const refsQuery = useRecipeRefs();
  const promotionsQuery = usePromotionSuggestions();

  const [helpOpen, setHelpOpen] = useState(false);
  const [activeCell, setActiveCell] = useState(null);

  // Cell-counts query: one bulk SELECT to populate every cell's badge in
  // one round-trip. Reads scope_type / scope_ref_id / scope_ref_id_2
  // (the mig 443 schema) and bucket-keys results by:
  //   "{package_id}|{grade_id}"        for package_grade rows (cells)
  //   "__defaults__|{grade_id}"        for price_tier rows (tier defaults)
  // Other scope_types are ignored at this surface — they show up only
  // inside the cell editor's inheritance breadcrumb.
  const cellCountsQuery = useQuery({
    queryKey: ["recipe-matrix-cell-counts"],
    queryFn: async () => {
      const res = await supabase
        .from("gallery_positions")
        .select("scope_type, scope_ref_id, scope_ref_id_2");
      if (res.error) {
        // Pre-mig 443 — gallery_positions may not exist yet.
        if (
          /(does not exist|relation .* does not exist)/i.test(
            res.error.message || "",
          )
        ) {
          return {};
        }
        throw new Error(res.error.message);
      }
      const counts = {};
      for (const r of res.data || []) {
        let key = null;
        if (r.scope_type === "package_grade") {
          key = `${r.scope_ref_id}|${r.scope_ref_id_2}`;
        } else if (r.scope_type === "price_tier") {
          key = `__defaults__|${r.scope_ref_id}`;
        }
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    },
    staleTime: 30_000,
  });

  const refs = refsQuery.data;

  // Per-tier expected target — used for cell health colouring. Today the
  // engine treats `expected_count_target` as a per-package metric; the
  // matrix surface uses the package's own target as the column-tier
  // expected. (Tier-specific targets are a follow-up; surfacing the
  // package number is the right interim default.)
  const expectedTargets = useMemo(() => {
    if (!refs) return {};
    const out = {};
    for (const t of refs.tiers || []) out[t.id] = null;
    return out;
  }, [refs]);

  if (refsQuery.isLoading) {
    return (
      <Skeleton
        className="h-64 w-full"
        data-testid="recipe-matrix-skeleton"
      />
    );
  }

  if (refsQuery.error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-rose-600">
          Failed to load reference data: {refsQuery.error.message}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="recipe-matrix-tab">
      {/* Help banner */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 flex items-start gap-2.5">
        <Sparkles className="h-4 w-4 mt-0.5 text-blue-600 flex-shrink-0" />
        <div className="flex-1 leading-relaxed">
          A <strong>recipe</strong> defines which gallery <strong>positions</strong>{" "}
          the engine targets for a given (package × grade) cell. Click a cell to
          edit. Each position has constraints (room, shot scale, compression,
          etc.) — leave constraints blank to let the engine pick.
          <div className="mt-1 text-blue-800/90">
            <strong>Engine grade</strong> (Volume / Refined / Editorial) is the
            quality bar the recipe targets and is derived per-round from the
            property's shoot quality. The grade also steers the Stage 4 voice
            anchor downstream.
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setHelpOpen(true)}
          className="h-7 text-blue-900 hover:bg-blue-100"
          data-testid="open-help-drawer"
        >
          <BookOpen className="h-3.5 w-3.5 mr-1" />
          Deep reference
        </Button>
      </div>

      {/* Auto-promotion review queue (hidden when empty) */}
      <AutoPromotionCard suggestions={promotionsQuery.data || []} />

      {/* Matrix */}
      <MatrixGrid
        packages={refs.packages}
        tiers={refs.tiers}
        cellCounts={cellCountsQuery.data || {}}
        expectedTargets={expectedTargets}
        loading={cellCountsQuery.isLoading}
        onCellClick={(cell) => setActiveCell(cell)}
      />

      {/* Advanced — Slot Templates (collapsed by default) */}
      <AdvancedSlotTemplates slots={refs.slots} />

      {/* Cell editor (modal) */}
      <CellEditorDialog
        open={Boolean(activeCell)}
        onOpenChange={(o) => {
          if (!o) setActiveCell(null);
        }}
        cell={activeCell}
        packages={refs.packages}
        tiers={refs.tiers}
        templates={refs.slots}
      />

      {/* Help drawer (deeper docs) */}
      <HelpDrawer open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
