/**
 * Recipe Matrix — react-query hooks.
 *
 * Each hook is a thin wrapper around the relevant Supabase query so the
 * UI components stay declarative.
 *
 *   useRecipeRefs()          — packages, tiers, project_types, products,
 *                              slot_definitions (templates).
 *   usePositionsForCell({pkg,tier,projectType}) — gallery_positions for
 *                              one matrix cell (with inheritance metadata
 *                              when the resolve_gallery_positions_for_cell
 *                              RPC is available; falls back to direct
 *                              SELECT otherwise so the UI works pre-RPC).
 *   useAxisDistribution(axis) — dropdown values for a constraint axis.
 *   usePromotionSuggestions() — pending auto-promotion suggestions
 *                              (R2's mechanic; safe-empty when missing).
 *   useTierDefaultsCounts(refs) — per-tier expected_count_target so cells
 *                              can colour themselves green/amber.
 *
 * All queries use a 60 s stale time — config data is low-mutation.
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
 *   packages — rows with id, name, expected_count_target,
 *              expected_count_tolerance_below/_above, engine_mode_override
 *   tiers    — shortlisting_tiers (the post-rename table is
 *              `shortlisting_grades`; if R1's mig 443 has shipped we'll
 *              read that, otherwise fall back to `shortlisting_tiers`).
 *   project_types — id, name
 *   products — id, name
 *   slot_definitions — the 10 active templates that power "Insert from
 *                      template" + the Advanced expander.
 */
export function useRecipeRefs() {
  return useQuery({
    queryKey: ["recipe-matrix-refs"],
    queryFn: async () => {
      // ── Packages ─────────────────────────────────────────────────
      const packagesRes = await supabase
        .from("packages")
        .select(
          "id, name, expected_count_target, expected_count_tolerance_below, expected_count_tolerance_above, engine_mode_override",
        )
        .eq("is_active", true)
        .order("name");

      // packages.engine_mode_override may not exist pre-mig 443; tolerate.
      let packages = packagesRes.data;
      if (packagesRes.error && /engine_mode_override/i.test(packagesRes.error.message || "")) {
        const fallback = await supabase
          .from("packages")
          .select(
            "id, name, expected_count_target, expected_count_tolerance_below, expected_count_tolerance_above",
          )
          .eq("is_active", true)
          .order("name");
        if (fallback.error) throw new Error(fallback.error.message);
        packages = fallback.data;
      } else if (packagesRes.error) {
        throw new Error(packagesRes.error.message);
      }

      // ── Engine grades (column axis on the matrix) ───────────────
      //
      // Mig 443 renamed `shortlisting_tiers` → `shortlisting_grades` and
      // renamed the operator-facing display_name set to Volume / Refined /
      // Editorial. The `tier_code` column stayed (it's used for join
      // keys); only the table name + display_name changed.
      //
      // Pre-mig 443 fallback: read shortlisting_tiers if the renamed
      // table doesn't exist yet. We surface a normalised shape so the UI
      // never has to care which name the DB has.
      let tiers;
      const gradesRes = await supabase
        .from("shortlisting_grades")
        .select("id, tier_code, display_name")
        .eq("is_active", true)
        .order("display_order");
      if (gradesRes.error) {
        const tierRes = await supabase
          .from("shortlisting_tiers")
          .select("id, tier_code, display_name")
          .eq("is_active", true)
          .order("display_order");
        if (tierRes.error) throw new Error(tierRes.error.message);
        tiers = (tierRes.data || []).map((t) => ({
          id: t.id,
          code: t.tier_code,
          display_name: t.display_name,
        }));
      } else {
        tiers = (gradesRes.data || []).map((t) => ({
          id: t.id,
          code: t.tier_code,
          display_name: t.display_name,
        }));
      }

      // ── Project types ───────────────────────────────────────────
      const projectTypesRes = await supabase
        .from("project_types")
        .select("id, name")
        .order("name");
      if (projectTypesRes.error) throw new Error(projectTypesRes.error.message);

      // ── Products ────────────────────────────────────────────────
      const productsRes = await supabase
        .from("products")
        .select("id, name")
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
        tiers: tiers || [],
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
 * Cell scope_type vocabulary used here (mirrors mig 443 doc):
 *   'package_grade'   → ref_id=package_id, ref_id_2=grade_id (cell)
 *   'price_tier'      → ref_id=grade_id           (tier defaults pseudo-row)
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
      // 'package_grade' with scope_ref_id = package_id and
      // scope_ref_id_2 = grade_id. For the "Tier defaults" pseudo-row
      // (no package), scope_type = 'price_tier' with scope_ref_id =
      // grade_id and scope_ref_id_2 = NULL.
      const isDefaults = !packageId;
      const scopeType = isDefaults ? "price_tier" : "package_grade";
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

      const positions = (res.data || []).map((row) => ({
        ...row,
        is_overridden_at_cell: !isDefaults,
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
 * Pre-mig the table doesn't exist; return an empty list so the
 * notification card stays hidden.
 */
export function usePromotionSuggestions() {
  return useQuery({
    queryKey: ["recipe-matrix-promotion-suggestions"],
    queryFn: async () => {
      try {
        const res = await supabase
          .from("gallery_position_template_suggestions")
          .select("id, suggested_template_slot_id, sample_count, created_at, status")
          .eq("status", "pending")
          .order("sample_count", { ascending: false })
          .limit(50);
        if (res.error) {
          if (
            /(does not exist|relation .* does not exist)/i.test(res.error.message || "")
          ) {
            return [];
          }
          throw new Error(res.error.message);
        }
        return res.data || [];
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
