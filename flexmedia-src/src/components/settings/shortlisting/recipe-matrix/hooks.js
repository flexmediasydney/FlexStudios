/**
 * Recipe Matrix — react-query hooks.
 *
 * Each hook is a thin wrapper around the relevant Supabase query so the
 * UI components stay declarative.
 *
 *   useRecipeRefs()          — packages (with full tier jsonb + products[]),
 *                              priceTiers (Standard / Premium from
 *                              package_price_tiers), project_types,
 *                              products (with tier jsonb), slot_definitions.
 *   usePositionsForCell({pkg,priceTier,projectType}) — gallery_positions
 *                              for one matrix cell (with inheritance
 *                              metadata when the
 *                              resolve_gallery_positions_for_cell RPC is
 *                              available; falls back to direct SELECT
 *                              otherwise so the UI works pre-RPC).
 *   useAxisDistribution(axis) — dropdown values for a constraint axis.
 *   usePromotionSuggestions() — pending auto-promotion suggestions
 *                              (R2's mechanic; safe-empty when missing).
 *
 * All queries use a 60 s stale time — config data is low-mutation.
 *
 * Matrix axes (W11.6.28b — Joseph's correction):
 *   rows    = packages
 *   columns = price tiers (Standard / Premium) — package_price_tiers table
 *
 * Engine grade is NOT a matrix axis. It's per-round derived and only
 * steers Stage 4 voice anchor.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase, api } from "@/api/supabaseClient";
import {
  CONSTRAINT_AXES,
  SHOT_SCALE_VALUES,
  COMPRESSION_VALUES,
  LENS_CLASS_VALUES,
} from "./constants";

const STALE_MS = 60_000;

/**
 * Reference data for the matrix:
 *   packages   — id, name, products[] jsonb, standard_tier/premium_tier
 *                jsonb, tolerance bands, engine_mode_override. Target
 *                count derives from products[].quantity sum (or per-tier
 *                jsonb.image_count when present); there is no top-level
 *                `expected_count_target` column on `packages`.
 *   priceTiers — package_price_tiers rows (Standard / Premium). NEW in
 *                W11.6.28b — replaces engine grades on the column axis.
 *   project_types — id, name
 *   products   — id, name, standard_tier/premium_tier jsonb,
 *                engine_role, min_quantity, max_quantity. The tier jsonb
 *                lets us read per-product image_count for the sum-of-
 *                products target fallback.
 *   slot_definitions — the 10 active templates that power "Insert from
 *                      template" + the Advanced expander.
 */
export function useRecipeRefs() {
  return useQuery({
    queryKey: ["recipe-matrix-refs"],
    queryFn: async () => {
      // ── Packages (full tier jsonb + products[] for target derivation) ──
      // Hotfix 2026-05-02: removed `expected_count_target` from SELECT —
      // the column doesn't exist on `packages` (it's on shortlisting_rounds).
      // Target count derives from products[].quantity (sum) or tier
      // jsonb.image_count when present; constants.js#deriveCellTarget
      // owns that derivation.
      const packagesRes = await supabase
        .from("packages")
        .select(
          "id, name, products, standard_tier, premium_tier, expected_count_tolerance_below, expected_count_tolerance_above, engine_mode_override",
        )
        .eq("is_active", true)
        .order("name");

      // packages.engine_mode_override may not exist pre-mig 443; tolerate.
      let packages = packagesRes.data;
      if (packagesRes.error && /engine_mode_override/i.test(packagesRes.error.message || "")) {
        const fallback = await supabase
          .from("packages")
          .select(
            "id, name, products, standard_tier, premium_tier, expected_count_tolerance_below, expected_count_tolerance_above",
          )
          .eq("is_active", true)
          .order("name");
        if (fallback.error) throw new Error(fallback.error.message);
        packages = fallback.data;
      } else if (packagesRes.error) {
        throw new Error(packagesRes.error.message);
      }

      // ── Price tiers (column axis on the matrix) ─────────────────
      //
      // W11.6.28b: read from `package_price_tiers` (mig 446). This is the
      // canonical source of price-tier UUIDs for the matrix.
      // Pre-mig 446 fallback: synthesize the two known tiers with the
      // hardcoded UUIDs so the UI keeps rendering even when the table is
      // missing (this avoids a bricked Settings tab during a deploy gap).
      const STABLE_PRICE_TIER_UUIDS = {
        standard: "a0000000-0000-4000-a000-000000000001",
        premium: "a0000000-0000-4000-a000-000000000002",
      };
      let priceTiers;
      const ptRes = await supabase
        .from("package_price_tiers")
        .select("id, code, display_name, display_order")
        .order("display_order");
      if (ptRes.error) {
        if (
          /(does not exist|relation .* does not exist)/i.test(
            ptRes.error.message || "",
          )
        ) {
          // Pre-mig synthesis with stable UUIDs.
          priceTiers = [
            {
              id: STABLE_PRICE_TIER_UUIDS.standard,
              code: "standard",
              display_name: "Standard",
              display_order: 1,
            },
            {
              id: STABLE_PRICE_TIER_UUIDS.premium,
              code: "premium",
              display_name: "Premium",
              display_order: 2,
            },
          ];
        } else {
          throw new Error(ptRes.error.message);
        }
      } else {
        priceTiers = ptRes.data || [];
      }

      // ── Project types ───────────────────────────────────────────
      const projectTypesRes = await supabase
        .from("project_types")
        .select("id, name")
        .order("name");
      if (projectTypesRes.error) throw new Error(projectTypesRes.error.message);

      // ── Products (incl. tier jsonb for sum-of-products target fallback) ─
      const productsRes = await supabase
        .from("products")
        .select(
          "id, name, engine_role, standard_tier, premium_tier, min_quantity, max_quantity",
        )
        .eq("is_active", true)
        .order("name")
        .limit(500);
      if (productsRes.error) throw new Error(productsRes.error.message);

      // ── Slot definitions (templates) ────────────────────────────
      const slotsRes = await supabase
        .from("shortlisting_slot_definitions")
        .select(
          "slot_id, display_name, phase, eligible_room_types, max_images, min_images, version, is_active",
        )
        .eq("is_active", true)
        .order("phase")
        .order("slot_id");
      if (slotsRes.error) throw new Error(slotsRes.error.message);

      // De-duplicate slot rows to the latest version per slot_id.
      const slotByLatest = new Map();
      for (const s of slotsRes.data || []) {
        const existing = slotByLatest.get(s.slot_id);
        if (!existing || (s.version || 1) > (existing.version || 1)) {
          slotByLatest.set(s.slot_id, s);
        }
      }

      return {
        packages: packages || [],
        // W11.6.28b: matrix columns are price tiers, not engine grades.
        // `tiers` is kept for now as an alias of `priceTiers` so any
        // straggling consumer keeps compiling — it's deprecated and
        // should not be read in new code.
        priceTiers: priceTiers || [],
        tiers: priceTiers || [],
        projectTypes: projectTypesRes.data || [],
        products: productsRes.data || [],
        slots: Array.from(slotByLatest.values()),
      };
    },
    staleTime: STALE_MS,
  });
}

/**
 * Fetch the merged position list for one matrix cell, with inheritance
 * metadata when available.
 *
 * Tries the new RPC first; falls back to direct SELECTs on
 * `gallery_positions` against the `scope_type`/`scope_ref_id` model
 * (per mig 443) if the RPC isn't deployed yet.
 *
 * Cell scope_type vocabulary used here (W11.6.28b — price-tier axis):
 *   'package_x_price_tier' → ref_id=package_id, ref_id_2=price_tier_id
 *                            (cell)
 *   'price_tier'           → ref_id=price_tier_id  (tier defaults pseudo-row)
 *
 * `priceTierId` MUST be a UUID from package_price_tiers (mig 446).
 *
 * Returned shape:
 *   {
 *     positions: [{...gallery_positions row, is_overridden_at_cell,
 *                  inherited_from_scope}, …],
 *     scopeChain: [{ label, scope, override_count }, …]
 *   }
 */
export function usePositionsForCell({
  packageId,
  priceTierId,
  projectTypeId,
  productId,
  enabled = true,
}) {
  return useQuery({
    queryKey: [
      "recipe-matrix-positions",
      packageId || null,
      priceTierId || null,
      projectTypeId || null,
      productId || null,
    ],
    enabled: enabled && Boolean(priceTierId),
    queryFn: async () => {
      // Prefer the resolver RPC when available — it gives us the inheritance
      // chain in one round-trip.
      try {
        const data = await api.rpc("resolve_gallery_positions_for_cell", {
          p_package_id: packageId || null,
          p_price_tier_id: priceTierId,
          p_project_type_id: projectTypeId || null,
          p_product_id: productId || null,
        });
        if (data && (Array.isArray(data) || typeof data === "object")) {
          if (Array.isArray(data)) {
            return { positions: data, scopeChain: [] };
          }
          return {
            positions: data.positions || [],
            scopeChain: data.scopeChain || data.scope_chain || [],
          };
        }
      } catch (rpcErr) {
        // RPC not deployed yet, or schema isn't ready — fall through to
        // direct SELECT.
        if (
          !/(does not exist|404|not found|undefined function|unauthorized)/i.test(
            String(rpcErr?.message || rpcErr),
          )
        ) {
          throw rpcErr;
        }
      }

      // Fallback: direct SELECT against the scope_type / scope_ref_id model.
      // For the matrix cell (package × price_tier), scope_type is
      // 'package_x_price_tier' with scope_ref_id = package_id and
      // scope_ref_id_2 = price_tier_id. For the "Tier defaults" pseudo-row
      // (no package), scope_type = 'price_tier' with scope_ref_id =
      // price_tier_id and scope_ref_id_2 = NULL.
      const isDefaults = !packageId;
      const scopeType = isDefaults ? "price_tier" : "package_x_price_tier";
      let q = supabase
        .from("gallery_positions")
        .select("*")
        .eq("scope_type", scopeType);
      if (isDefaults) {
        q = q.eq("scope_ref_id", priceTierId).is("scope_ref_id_2", null);
      } else {
        q = q.eq("scope_ref_id", packageId).eq("scope_ref_id_2", priceTierId);
      }

      const res = await q.order("position_index");
      if (res.error) {
        if (/(does not exist|relation .* does not exist)/i.test(res.error.message || "")) {
          return { positions: [], scopeChain: [] };
        }
        throw new Error(res.error.message);
      }

      // BUG-2 FIX (QC v2 — 2026-05-02): the direct-SELECT fallback can't
      // distinguish a row authored AT this cell from a row INHERITED from a
      // broader scope (the scope_chain isn't materialised here — only the
      // RPC returns it). The previous build set
      //   is_overridden_at_cell: !isDefaults
      // for every row in the cell scope, which is wrong: an inherited row
      // would render as "overridden at cell" with the amber star icon.
      //
      // We now leave `is_overridden_at_cell` UNDEFINED in the fallback path.
      // PositionRow reads `position?.is_overridden_at_cell` as a truthy
      // check; undefined → no star. The RPC path (which DOES know the
      // chain) is the only producer of a definitive value.
      const positions = (res.data || []).map((row) => ({
        ...row,
        inherited_from_scope: scopeType,
      }));

      return {
        positions,
        scopeChain: [
          {
            label: isDefaults ? "Tier defaults" : "This cell",
            scope: scopeType,
            override_count: positions.length,
          },
        ],
      };
    },
    staleTime: 30_000,
  });
}

/**
 * Distribution of values for one constraint axis (used to populate the
 * dropdown options inside the position editor).
 *
 * Axes that aren't part of Hierarchy B (shot_scale / compression /
 * lens_class) short-circuit the RPC and return their finite vocab.
 */
export function useAxisDistribution(axisKey) {
  const axis = CONSTRAINT_AXES.find((a) => a.key === axisKey);
  return useQuery({
    queryKey: ["recipe-matrix-axis-distribution", axisKey],
    enabled: Boolean(axisKey),
    queryFn: async () => {
      if (!axis) return [];
      if (axis.pickerSource === "shot_scale") {
        return SHOT_SCALE_VALUES.map((v) => ({ value: v, n_compositions: null }));
      }
      if (axis.pickerSource === "compression") {
        return COMPRESSION_VALUES.map((v) => ({ value: v, n_compositions: null }));
      }
      if (axis.pickerSource === "lens_class") {
        return LENS_CLASS_VALUES.map((v) => ({ value: v, n_compositions: null }));
      }
      // taxonomy_b_axis_distribution returns rows of {value, n_compositions, pct}.
      try {
        const data = await api.rpc("taxonomy_b_axis_distribution", { p_axis: axisKey });
        return Array.isArray(data) ? data : [];
      } catch (err) {
        // Pre-mig: gracefully degrade to an empty list (the user can still
        // type a value once we expose a free-text fallback).
        if (/(invalid axis|unauthorized|does not exist)/i.test(String(err?.message || err))) {
          return [];
        }
        throw err;
      }
    },
    staleTime: STALE_MS,
  });
}

/**
 * Pending auto-promotion suggestions. R2's mechanic keeps a queue of
 * "this position is appearing organically — promote to a template"
 * candidates; the operator approves / rejects from the UI.
 *
 * BUG-3 FIX (QC v2 — 2026-05-02): the previous build queried
 * `gallery_position_template_suggestions` (wrong name) — R2's mig 444
 * actually created `shortlisting_position_template_suggestions`. We now
 * query the real table and remap its columns to the legacy shape the
 * AutoPromotionCard renders:
 *
 *   suggested_template_slot_id  ←  approved_template_slot_id (when set)
 *                                  fallback: proposed_template_label
 *   sample_count                ←  evidence_total_proposals
 *   created_at                  ←  created_at (unchanged)
 *   status                      ←  status (unchanged)
 *
 * This keeps the AutoPromotionCard component stable while the underlying
 * source-of-truth is mig 444's table.
 *
 * Pre-mig (fresh DB / RLS-blocked) the table is unreachable; return an
 * empty list so the notification card stays hidden.
 */
export function usePromotionSuggestions() {
  return useQuery({
    queryKey: ["recipe-matrix-promotion-suggestions"],
    queryFn: async () => {
      try {
        const res = await supabase
          .from("shortlisting_position_template_suggestions")
          .select(
            "id, proposed_template_label, approved_template_slot_id, evidence_total_proposals, evidence_round_count, created_at, status",
          )
          .eq("status", "pending")
          .order("evidence_total_proposals", { ascending: false })
          .limit(50);
        if (res.error) {
          if (
            /(does not exist|relation .* does not exist)/i.test(res.error.message || "")
          ) {
            return [];
          }
          throw new Error(res.error.message);
        }
        // Adapt the mig-444 shape to the existing AutoPromotionCard contract.
        return (res.data || []).map((row) => ({
          id: row.id,
          suggested_template_slot_id:
            row.approved_template_slot_id || row.proposed_template_label,
          sample_count: row.evidence_total_proposals,
          evidence_round_count: row.evidence_round_count,
          created_at: row.created_at,
          status: row.status,
        }));
      } catch (err) {
        if (/(does not exist|relation .* does not exist)/i.test(String(err?.message || err))) {
          return [];
        }
        throw err;
      }
    },
    staleTime: STALE_MS,
  });
}
