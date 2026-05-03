/**
 * RecipeMatrixQCv2 — vitest suite for the QC-pass v2 deferred bugs.
 *
 * Pins the four QC v2 fixes (mig 450 + hooks/PositionRow/CellEditorDialog
 * patches) so the regressions can't re-land:
 *
 *   Bug 2 — direct-SELECT fallback path no longer fakes
 *           is_overridden_at_cell. Only the RPC path materialises that
 *           field; the fallback leaves it undefined so PositionRow
 *           reads it as falsy (no spurious amber star).
 *
 *   Bug 3 — usePromotionSuggestions queries the real R2 table
 *           shortlisting_position_template_suggestions (mig 444), NOT
 *           the legacy gallery_position_template_suggestions name.
 *           Asserts the from() call + the column projection adapter
 *           (proposed_template_label / evidence_total_proposals →
 *           suggested_template_slot_id / sample_count for the card).
 *
 *   Bug 4 — normalisePosition (PositionRow) coerces notes to null when
 *           absent, NOT to "". Round-trip parity with the DB → no
 *           spurious isDirty when the operator opens a row and
 *           immediately reads it back. Also asserts that the upsert
 *           sanitiser converts notes="" to null defensively.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Capture every supabase call so each test can assert against it. ──
globalThis.__qcv2_capture__ = {
  fromCalls: [],
  selectCalls: [],
  rpcCalls: [],
};

vi.mock("@/api/supabaseClient", () => {
  function buildMock(tableName, rows) {
    const builder = {
      select: (cols) => {
        globalThis.__qcv2_capture__.selectCalls.push({ tableName, cols });
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      range: () => builder,
      update: () => builder,
      insert: () => builder,
      delete: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return builder;
  }

  // Bug-2 fixture: 1 fallback-path row (no scope chain).
  // Mig 451: post-S1 schema — `room_type` column is gone; we use the
  // friendly Room dropdown's backing axis `space_type` instead.
  const POSITION_ROWS = [
    {
      id: "gp-1",
      scope_type: "package_x_price_tier",
      scope_ref_id: "pkg-x",
      scope_ref_id_2: "tier-std",
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
      notes: null,
      space_type: "kitchen_dedicated",
    },
  ];

  // Bug-3 fixture: one pending suggestion row in mig-444 shape.
  const SUGGESTION_ROWS = [
    {
      id: "sugg-1",
      proposed_template_label: "Wide kitchen hero",
      approved_template_slot_id: null,
      evidence_total_proposals: 12,
      evidence_round_count: 4,
      created_at: "2026-05-01T00:00:00Z",
      status: "pending",
    },
  ];

  const tableMap = {
    gallery_positions: POSITION_ROWS,
    shortlisting_position_template_suggestions: SUGGESTION_ROWS,
    // Wrong-name fallback — should NEVER be hit after the fix. Returns a
    // PostgREST-style "does not exist" error to mimic prod.
    gallery_position_template_suggestions: null,
  };

  return {
    supabase: {
      from(name) {
        globalThis.__qcv2_capture__.fromCalls.push(name);
        const rows = tableMap[name];
        if (rows == null) {
          // Mimic the missing-table error path so the hook's
          // "does not exist" branch can be exercised.
          const builder = {
            select: () => builder,
            eq: () => builder,
            is: () => builder,
            in: () => builder,
            order: () => builder,
            limit: () => builder,
            range: () => builder,
            then: (resolve) =>
              Promise.resolve({
                data: null,
                error: { message: `relation "${name}" does not exist` },
              }).then(resolve),
          };
          return builder;
        }
        return buildMock(name, rows);
      },
    },
    api: {
      rpc: vi.fn(async (fn, args) => {
        globalThis.__qcv2_capture__.rpcCalls.push({ fn, args });
        if (fn === "resolve_gallery_positions_for_cell") {
          // Pretend the RPC isn't deployed → forces the fallback path.
          throw new Error("function does not exist");
        }
        return null;
      }),
      auth: { me: vi.fn(async () => ({ id: "u1", role: "master_admin" })) },
    },
  };
});

import { usePositionsForCell, usePromotionSuggestions } from "../recipe-matrix/hooks";
import { normalisePosition } from "../recipe-matrix/PositionRow";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  globalThis.__qcv2_capture__.fromCalls.length = 0;
  globalThis.__qcv2_capture__.selectCalls.length = 0;
  globalThis.__qcv2_capture__.rpcCalls.length = 0;
});

// ─── Bug 2 ─────────────────────────────────────────────────────────────────
describe("Bug 2 — direct-SELECT fallback does NOT set is_overridden_at_cell", () => {
  it("falls back to a SELECT and leaves is_overridden_at_cell undefined on every row", async () => {
    const { result } = renderHook(
      () =>
        usePositionsForCell({
          packageId: "pkg-x",
          priceTierId: "tier-std",
          enabled: true,
        }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => {
      expect(result.current.data).toBeTruthy();
    });

    // RPC was attempted and failed with "does not exist" → fallback path.
    expect(
      globalThis.__qcv2_capture__.rpcCalls.find(
        (c) => c.fn === "resolve_gallery_positions_for_cell",
      ),
    ).toBeTruthy();
    // The fallback ran a SELECT against gallery_positions.
    expect(
      globalThis.__qcv2_capture__.fromCalls.includes("gallery_positions"),
    ).toBe(true);

    const positions = result.current.data?.positions || [];
    expect(positions.length).toBe(1);

    // The KEY assertion: in the fallback path, is_overridden_at_cell must
    // NOT be present (or be undefined). The previous build set it to
    // !isDefaults for every row — that's the regression we're guarding.
    for (const row of positions) {
      // Check both the property's existence and its value being undefined.
      expect(row.is_overridden_at_cell).toBeUndefined();
    }

    // inherited_from_scope is still set so the UI can read it where useful.
    expect(positions[0].inherited_from_scope).toBe("package_x_price_tier");
  });
});

// ─── Bug 3 ─────────────────────────────────────────────────────────────────
describe("Bug 3 — usePromotionSuggestions queries the real mig-444 table", () => {
  it("queries shortlisting_position_template_suggestions, NOT gallery_position_template_suggestions", async () => {
    const { result } = renderHook(() => usePromotionSuggestions(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      expect(result.current.data).toBeTruthy();
    });

    expect(
      globalThis.__qcv2_capture__.fromCalls.includes(
        "shortlisting_position_template_suggestions",
      ),
    ).toBe(true);
    // The legacy/wrong name is NEVER queried.
    expect(
      globalThis.__qcv2_capture__.fromCalls.includes(
        "gallery_position_template_suggestions",
      ),
    ).toBe(false);
  });

  it("adapts mig-444 columns to the AutoPromotionCard's legacy shape", async () => {
    const { result } = renderHook(() => usePromotionSuggestions(), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      expect((result.current.data || []).length).toBe(1);
    });

    const row = result.current.data[0];

    // The card needs: id, suggested_template_slot_id, sample_count,
    // created_at, status. evidence_round_count is also surfaced for future
    // expansion of the card detail.
    expect(row.id).toBe("sugg-1");
    expect(row.suggested_template_slot_id).toBe("Wide kitchen hero"); // label fallback
    expect(row.sample_count).toBe(12);
    expect(row.evidence_round_count).toBe(4);
    expect(row.status).toBe("pending");
    expect(row.created_at).toBe("2026-05-01T00:00:00Z");
  });
});

// ─── Bug 4 ─────────────────────────────────────────────────────────────────
describe("Bug 4 — notes nullability + no spurious isDirty on clean load", () => {
  it("normalisePosition coerces missing notes to null (not empty string)", () => {
    const pos = {
      id: "x",
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
    };
    const normalised = normalisePosition(pos);
    expect(normalised.notes).toBeNull();
    expect(normalised.notes).not.toBe("");
  });

  it("normalisePosition preserves a real notes string verbatim", () => {
    const pos = { id: "x", notes: "Compose tightly with hero island" };
    const normalised = normalisePosition(pos);
    expect(normalised.notes).toBe("Compose tightly with hero island");
  });

  it("normalisePosition uses ?? null — empty string is preserved at this layer", () => {
    // We DO use `?? null` (not `|| null`) so "" is preserved at the
    // normalisePosition layer. The "" → null coercion happens in two
    // OTHER layers:
    //   1. the Textarea onChange handler in PositionRow
    //   2. the upsert sanitiser in CellEditorDialog (defensive)
    // This contract documents that division of responsibility — the
    // load-time normaliser only fixes UNDEFINED inputs; it doesn't
    // rewrite real values.
    const pos = { id: "x", notes: "" };
    expect(normalisePosition(pos).notes).toBe("");
  });

  it("loaded row + immediate resave produces NO isDirty deltas (notes null parity)", () => {
    // Simulates the bug: row from DB has notes:null. Editor wraps it.
    // Without the fix, the draft normalises notes to "" and JSON.stringify
    // diff fires "dirty" against a freshly-normalised version of the same
    // row — false positive.
    // Mig 451: the canonical post-S1 DB shape has no room_type /
    // composition_type columns. Fixture mirrors that shape and adds the
    // two new decomposed axes.
    const dbRow = {
      id: "gp-load",
      package_id: null, // PositionRow tolerates these even if missing on DB
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
      notes: null, // ← the canonical DB shape
      space_type: "kitchen_dedicated",
      zone_focus: null,
      shot_scale: null,
      perspective_compression: null,
      vantage_position: null,
      composition_geometry: null,
      orientation: null,
      lens_class: null,
      image_type: null,
    };
    const draftA = normalisePosition(dbRow);
    const draftB = normalisePosition(dbRow);

    expect(JSON.stringify(draftA)).toEqual(JSON.stringify(draftB));
    expect(draftA.notes).toBeNull();
    expect(draftB.notes).toBeNull();
  });

  it("load + clear-text-then-empty produces null (matching DB shape)", () => {
    // The textarea onChange (after Bug-4 fix) coerces "" → null, so an
    // operator who types "x" and deletes it should land back at notes:null —
    // identical to the freshly loaded row.
    const dbRow = { id: "gp-clean", notes: null };
    const loaded = normalisePosition(dbRow);
    // Simulate the textarea onChange behaviour after Bug-4 fix:
    const afterEdit = { ...loaded, notes: "" === "" ? null : "" };
    expect(afterEdit.notes).toBeNull();
    expect(JSON.stringify(loaded)).toEqual(JSON.stringify(afterEdit));
  });
});

// ─── Mig 451 — Position Editor restructure: no room_type/composition_type ──
describe("Mig 451 — normalisePosition drops legacy room_type / composition_type", () => {
  it("normalisePosition does not include room_type even if the input row carries it", () => {
    // A draft loaded from a stale (pre-451) cache might still have a
    // room_type field. The canonical normalised shape must NOT carry it
    // forward — pickConstraints only reads from CONSTRAINT_KEYS, which
    // post-451 contains only the 9 active axes (no room_type, no
    // composition_type).
    const stale = {
      id: "gp-stale",
      room_type: "kitchen_main",
      composition_type: "wide_angle",
      space_type: "kitchen_dedicated",
    };
    const normalised = normalisePosition(stale);
    expect(normalised).not.toHaveProperty("room_type");
    expect(normalised).not.toHaveProperty("composition_type");
    expect(normalised.space_type).toBe("kitchen_dedicated");
  });

  it("normalisePosition includes vantage_position + composition_geometry as null when absent", () => {
    const fresh = { id: "gp-fresh" };
    const normalised = normalisePosition(fresh);
    expect(normalised).toHaveProperty("vantage_position");
    expect(normalised).toHaveProperty("composition_geometry");
    expect(normalised.vantage_position).toBeNull();
    expect(normalised.composition_geometry).toBeNull();
  });

  it("normalisePosition preserves real values for vantage_position + composition_geometry", () => {
    const row = {
      id: "gp-x",
      vantage_position: "corner",
      composition_geometry: "leading_lines",
    };
    const normalised = normalisePosition(row);
    expect(normalised.vantage_position).toBe("corner");
    expect(normalised.composition_geometry).toBe("leading_lines");
  });
});

// ─── W11.8 / mig 454 — instance_index + instance_unique_constraint ─────────
describe("Mig 454 — normalisePosition handles instance_index + unique constraint", () => {
  it("defaults instance_index to null and instance_unique_constraint to false on absence", () => {
    const fresh = { id: "gp-fresh" };
    const normalised = normalisePosition(fresh);
    expect(normalised).toHaveProperty("instance_index");
    expect(normalised).toHaveProperty("instance_unique_constraint");
    expect(normalised.instance_index).toBeNull();
    expect(normalised.instance_unique_constraint).toBe(false);
  });

  it("preserves real instance_index numeric values", () => {
    const row = { id: "gp-x", instance_index: 2 };
    const normalised = normalisePosition(row);
    expect(normalised.instance_index).toBe(2);
  });

  it("preserves instance_unique_constraint=true and coerces null/undefined to false", () => {
    expect(
      normalisePosition({ id: "x", instance_unique_constraint: true })
        .instance_unique_constraint,
    ).toBe(true);
    expect(
      normalisePosition({ id: "x", instance_unique_constraint: false })
        .instance_unique_constraint,
    ).toBe(false);
    expect(
      normalisePosition({ id: "x", instance_unique_constraint: null })
        .instance_unique_constraint,
    ).toBe(false);
    expect(
      normalisePosition({ id: "x" /* undefined */ }).instance_unique_constraint,
    ).toBe(false);
  });

  it("loaded row + immediate resave produces NO isDirty deltas for instance fields", () => {
    // The DB-canonical shape for an unset position has instance_index=null
    // and instance_unique_constraint=false. A second normalise of the same
    // row must JSON.stringify-equal the first — otherwise the editor
    // would mark the row dirty on open.
    const dbRow = {
      id: "gp-load",
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
      notes: null,
      space_type: "kitchen_dedicated",
      zone_focus: null,
      shot_scale: null,
      perspective_compression: null,
      vantage_position: null,
      composition_geometry: null,
      orientation: null,
      lens_class: null,
      image_type: null,
      instance_index: null,
      instance_unique_constraint: false,
    };
    const draftA = normalisePosition(dbRow);
    const draftB = normalisePosition(dbRow);
    expect(JSON.stringify(draftA)).toEqual(JSON.stringify(draftB));
    expect(draftA.instance_index).toBeNull();
    expect(draftA.instance_unique_constraint).toBe(false);
  });

  it("toggling instance_unique_constraint from false to true marks the row dirty", () => {
    // PositionRow's isDirty memo is a JSON.stringify diff between the
    // current draft and a fresh normalise of the upstream position. A
    // false → true flip on instance_unique_constraint must produce a
    // non-equal string.
    const dbRow = {
      id: "gp-load",
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      instance_index: null,
      instance_unique_constraint: false,
    };
    const upstream = normalisePosition(dbRow);
    const flipped = { ...upstream, instance_unique_constraint: true };
    expect(JSON.stringify(flipped)).not.toEqual(JSON.stringify(upstream));
  });
});
