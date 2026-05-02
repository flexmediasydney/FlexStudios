/**
 * RecipeMatrixTab — Wave 11.6.28 (replaces SlotRecipesTab + the slots /
 * standards subtabs in the IA).
 *
 * Operator-friendly authoring surface for the constraint-based
 * `gallery_positions` model. Joseph wanted to think in terms of
 * "10 positions for Silver Standard: 2 kitchens, 1 master bedroom, …"
 * rather than the old engine-internal slot taxonomy.
 *
 * W11.6.28b correction: the matrix axes are package × PRICE TIER
 * (Standard / Premium), NOT engine grade. Engine grade is per-round
 * derived and only steers Stage 4 voice anchor.
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

  // Cell-counts query: one bulk SELECT to populate every cell's authored
  // count badge in one round-trip. Reads scope_type / scope_ref_id /
  // scope_ref_id_2 (the mig 443 schema) and bucket-keys results by:
  //   "{package_id}|{price_tier_id}"  for package_x_price_tier rows (cells)
  //   "__defaults__|{price_tier_id}"  for price_tier rows (tier defaults)
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
        if (r.scope_type === "package_x_price_tier") {
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

  // Lookup map for products — used by the matrix to derive per-cell targets
  // (sum of products[].quantity falling back to per-product tier
  // image_count).
  const productLookup = useMemo(() => {
    const m = new Map();
    for (const p of refs?.products || []) m.set(p.id, p);
    return m;
  }, [refs?.products]);

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
      {/* Help banner — W11.6.28b copy (price tier axis + dual-number
          authored/target explanation). */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 flex items-start gap-2.5">
        <Sparkles className="h-4 w-4 mt-0.5 text-blue-600 flex-shrink-0" />
        <div className="flex-1 leading-relaxed space-y-1">
          <div className="font-semibold">
            Recipe Matrix — what each cell means
          </div>
          <div>
            Each cell defines the gallery <strong>positions</strong> the
            engine targets for one (package × price tier). Click a cell to
            edit. The matrix axes are:
            <ul className="list-disc pl-5 mt-1">
              <li><strong>Rows</strong> = packages (Silver, Gold, AI, …)</li>
              <li><strong>Columns</strong> = price tier (Standard / Premium)</li>
            </ul>
          </div>
          <div>
            Each cell shows <strong>AUTHORED / TARGET</strong>.{" "}
            <strong>AUTHORED</strong> = positions you've explicitly defined
            in this recipe. <strong>TARGET</strong> = images the package
            contractually delivers. The gap is filled by AI when{" "}
            <code>engine_mode = recipe_with_ai_backfill</code> (default).
            Over-target authoring (X &gt; Y) drops lowest-priority
            positions to fit.
          </div>
          <div className="text-blue-800/90 mt-1">
            <strong>Engine grade</strong> (Volume / Refined / Editorial) is
            derived per-round from the shoot quality and steers the Stage 4
            voice anchor. It does <em>not</em> affect slot allocation —
            recipes apply equally regardless of grade.
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
        priceTiers={refs.priceTiers || refs.tiers}
        productLookup={productLookup}
        cellCounts={cellCountsQuery.data || {}}
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
        priceTiers={refs.priceTiers || refs.tiers}
        templates={refs.slots}
        productLookup={productLookup}
      />

      {/* Help drawer (deeper docs) */}
      <HelpDrawer open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
