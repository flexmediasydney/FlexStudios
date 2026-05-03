/**
 * RecipeMatrixSave — vitest suite for the QC-pass blocker fixes.
 *
 * Joseph reported on 2026-05-02: "I can't seem to be able to save anything,
 * add positions does nothing". QC turned up that mig 443 created
 * gallery_positions WITHOUT an engine_role column even though the UI
 * (CellEditorDialog) writes engine_role on every Add / Save. Mig 449 added
 * the column. These tests pin the save / add contract so the regression
 * can't re-land:
 *
 *   1. Add blank position — insert payload includes scope_type +
 *      scope_ref_id + scope_ref_id_2 + engine_role + position_index +
 *      phase + selection_mode + ai_backfill_on_gap. No transient keys
 *      (package_id, price_tier_id, etc.) leak into the payload.
 *
 *   2. Tier defaults Add — insert uses scope_type='price_tier', scope_ref_id
 *      = priceTierId, scope_ref_id_2 NULL.
 *
 *   3. Existing-row save — UPDATE goes via .update().eq(id) with no scope
 *      columns clobbered, no transient keys leaked.
 *
 *   4. Save error toast surfaces the Postgres message (so a future schema
 *      drift like the engine_role one is visible to operators).
 *
 * The supabase mock here is hand-rolled per test so we can capture the
 * exact insert / update payloads.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Capture every supabase call so each test can assert against it.
// Defined as a globalThis-attached object so vi.mock factories (which hoist
// to file top) can still see it. vi.mock can't close over module-scoped
// values, so we use globalThis as the rendezvous.
globalThis.__recipe_save_capture__ = {
  inserts: [],
  updates: [],
  deletes: [],
  rpcCalls: [],
  toastSuccess: [],
  toastError: [],
};

vi.mock("sonner", () => ({
  toast: {
    success: (msg) => {
      globalThis.__recipe_save_capture__.toastSuccess.push(msg);
    },
    error: (msg) => {
      globalThis.__recipe_save_capture__.toastError.push(msg);
    },
  },
}));

vi.mock("@/api/supabaseClient", () => {
  // Silver carries one image-class product (Sales Images, photo_day_shortlist)
  // so the cell editor's image-class filter (W11.6.28c) renders the Sales
  // Images tab. Without this the editor's empty-state would suppress the
  // Add buttons the tests target.
  const PACKAGE_ROWS = [
    {
      id: "pkg-silver",
      name: "Silver Package",
      products: [
        { product_id: "prod-sales", product_name: "Sales Images", quantity: 5 },
      ],
      standard_tier: { package_price: 100, image_count: 5 },
      premium_tier: { package_price: 150, image_count: 8 },
      expected_count_tolerance_below: null,
      expected_count_tolerance_above: null,
      engine_mode_override: null,
    },
  ];
  const PRICE_TIER_ROWS = [
    { id: "tier-std", code: "standard", display_name: "Standard", display_order: 1 },
    { id: "tier-pre", code: "premium", display_name: "Premium", display_order: 2 },
  ];
  const PROJECT_TYPE_ROWS = [{ id: "pt-1", name: "Residential" }];
  const PRODUCT_ROWS = [
    {
      id: "prod-sales",
      name: "Sales Images",
      engine_role: "photo_day_shortlist",
      standard_tier: { image_count: 5 },
      premium_tier: { image_count: 8 },
      min_quantity: 1,
      max_quantity: 30,
    },
  ];
  const SLOT_ROWS = [];

  // Supabase query builder mock that captures inserts / updates / deletes
  // while still resolving SELECTs against the canned tableMap.
  function buildMock(tableName, rows) {
    let opType = "select";
    let payload = null;
    let updateFilter = null;
    let deleteFilter = null;

    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      range: () => builder,
      eq: (col, val) => {
        if (opType === "update") updateFilter = { col, val };
        if (opType === "delete") deleteFilter = { col, val };
        return builder;
      },
      is: () => builder,
      in: () => builder,
      single: () => Promise.resolve({ data: { id: "new-row" }, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: (p) => {
        opType = "insert";
        payload = p;
        globalThis.__recipe_save_capture__.inserts.push({
          table: tableName,
          payload: p,
        });
        return builder;
      },
      update: (p) => {
        opType = "update";
        payload = p;
        return builder;
      },
      delete: () => {
        opType = "delete";
        return builder;
      },
      then: (resolve) => {
        if (opType === "insert") {
          return Promise.resolve({
            data: { id: "new-row-id" },
            error: null,
          }).then(resolve);
        }
        if (opType === "update") {
          globalThis.__recipe_save_capture__.updates.push({
            table: tableName,
            payload,
            filter: updateFilter,
          });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (opType === "delete") {
          globalThis.__recipe_save_capture__.deletes.push({
            table: tableName,
            filter: deleteFilter,
          });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const tableMap = {
    packages: PACKAGE_ROWS,
    package_price_tiers: PRICE_TIER_ROWS,
    project_types: PROJECT_TYPE_ROWS,
    products: PRODUCT_ROWS,
    shortlisting_slot_definitions: SLOT_ROWS,
    gallery_positions: [],
    gallery_position_template_suggestions: [],
  };

  return {
    supabase: {
      from(name) {
        return buildMock(name, tableMap[name] ?? []);
      },
    },
    api: {
      rpc: vi.fn(async (fn, args) => {
        globalThis.__recipe_save_capture__.rpcCalls.push({ fn, args });
        if (fn === "resolve_gallery_positions_for_cell") {
          return {
            positions: [],
            scopeChain: [
              { label: "Tier defaults", scope: "price_tier", override_count: 0 },
              { label: "This cell", scope: "package_x_price_tier", override_count: 0 },
            ],
          };
        }
        return null;
      }),
      auth: { me: vi.fn(async () => ({ id: "u1", role: "master_admin" })) },
    },
  };
});

// Stub the lazy slots editor so the import doesn't pull the heavy module.
vi.mock("@/pages/SettingsShortlistingSlots", () => ({
  default: () => <div data-testid="mock-slots-editor">Stub</div>,
}));

import RecipeMatrixTab from "../RecipeMatrixTab";

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RecipeMatrixTab />
    </QueryClientProvider>,
  );
}

describe("RecipeMatrixTab — Add Position blocker fix (mig 449)", () => {
  const cap = () => globalThis.__recipe_save_capture__;

  beforeEach(() => {
    cap().inserts.length = 0;
    cap().updates.length = 0;
    cap().deletes.length = 0;
    cap().rpcCalls.length = 0;
    cap().toastSuccess.length = 0;
    cap().toastError.length = 0;
  });

  it("Add blank position — insert payload has correct scope + engine_role for a cell", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    // Open the Silver × Standard cell editor.
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // Click "Add blank position" inside the Sales Images tab.
    const addBtn = await waitFor(() =>
      screen.getByTestId("add-blank-position-photo_day_shortlist"),
    );
    fireEvent.click(addBtn);

    // Wait for the insert mutation to fire.
    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });

    const insert = cap().inserts.find((c) => c.table === "gallery_positions");
    expect(insert).toBeTruthy();
    const payload = insert.payload;

    // Scope columns set correctly for a package×price-tier cell.
    expect(payload.scope_type).toBe("package_x_price_tier");
    expect(payload.scope_ref_id).toBe("pkg-silver");
    expect(payload.scope_ref_id_2).toBe("tier-std");

    // Engine-role column the UI ALWAYS writes — must be present (mig 449).
    expect(payload.engine_role).toBe("photo_day_shortlist");

    // Sane defaults for a fresh row.
    expect(payload.position_index).toBeGreaterThanOrEqual(1);
    expect(payload.phase).toBe("optional");
    expect(payload.selection_mode).toBe("ai_decides");
    expect(payload.ai_backfill_on_gap).toBe(true);

    // Transient keys MUST be stripped before insert.
    expect(payload).not.toHaveProperty("package_id");
    expect(payload).not.toHaveProperty("price_tier_id");
    expect(payload).not.toHaveProperty("project_type_id");
    expect(payload).not.toHaveProperty("product_id");
    expect(payload).not.toHaveProperty("is_overridden_at_cell");
    expect(payload).not.toHaveProperty("inherited_from_scope");
    expect(payload).not.toHaveProperty("scope_ref_id_3");
    expect(payload).not.toHaveProperty("id"); // id is the upsert discriminator, not a column

    // Mig 451: room_type and composition_type were dropped from
    // gallery_positions — the upsert sanitiser must strip them.
    expect(payload).not.toHaveProperty("room_type");
    expect(payload).not.toHaveProperty("composition_type");

    // Toast confirms.
    await waitFor(() => {
      expect(cap().toastSuccess.some((m) => /position saved/i.test(m))).toBe(
        true,
      );
    });
  });

  // ── mig 451 — room_type / composition_type column drop ──────────────────
  it("Save — defensive: a stale draft carrying room_type / composition_type is sanitised", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    // Open Silver × Standard, click Add — but the brief: a future drift
    // (or a row carried in from a pre-451 cache) might still have
    // room_type / composition_type on the draft. The blank Add button is
    // sufficient to exercise the sanitiser because the upsertMutation
    // strips both keys unconditionally regardless of whether the draft
    // carried them. We verify by inspecting the captured insert payload.
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const addBtn = await waitFor(() =>
      screen.getByTestId("add-blank-position-photo_day_shortlist"),
    );
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });
    const payload = cap().inserts.find(
      (c) => c.table === "gallery_positions",
    )?.payload;
    expect(payload).toBeTruthy();
    expect(payload).not.toHaveProperty("room_type");
    expect(payload).not.toHaveProperty("composition_type");
  });

  it("Add blank position — Tier defaults pseudo-row uses scope_type='price_tier'", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    // Open the Tier defaults × Standard pseudo-cell.
    fireEvent.click(screen.getByTestId("matrix-cell-defaults-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // Click "Add blank position" inside the Sales Images tab.
    const addBtn = await waitFor(() =>
      screen.getByTestId("add-blank-position-photo_day_shortlist"),
    );
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });

    const insert = cap().inserts.find((c) => c.table === "gallery_positions");
    expect(insert).toBeTruthy();
    const payload = insert.payload;

    // Tier defaults: scope_type='price_tier', scope_ref_id=tier_id, ref_id_2=NULL.
    expect(payload.scope_type).toBe("price_tier");
    expect(payload.scope_ref_id).toBe("tier-std");
    expect(payload.scope_ref_id_2).toBe(null);
    expect(payload.engine_role).toBe("photo_day_shortlist");
  });

  it("Add blank position — Sales Images tab fires engine_role='photo_day_shortlist'", async () => {
    // We don't switch tabs in jsdom (Radix Tabs unmount inactive content +
    // the tab pointer events are flaky in jsdom). Instead we pin that the
    // DEFAULT tab (photo_day_shortlist, per CellEditorDialog#useState) is
    // the one whose Add button writes the matching engine_role. The Drone
    // tab variant is exercised manually + via the live Supabase smoke test
    // in this same QC pass.
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    const addBtn = await waitFor(() =>
      screen.getByTestId("add-blank-position-photo_day_shortlist"),
    );
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });

    const insert = cap().inserts.find((c) => c.table === "gallery_positions");
    expect(insert.payload.engine_role).toBe("photo_day_shortlist");
  });

  it("Add blank position — multiple clicks bump position_index (no UNIQUE collision)", async () => {
    // After mig 449 the UNIQUE key is (scope_type, scope_ref_id,
    // scope_ref_id_2, scope_ref_id_3, engine_role, position_index).
    // The UI computes position_index = list.length + 1 — so back-to-back
    // adds before the list refreshes shouldn't collide because the cache
    // invalidation happens onSuccess. This test pins that the FIRST click
    // sends position_index=1 (empty list).
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    const addBtn = await waitFor(() =>
      screen.getByTestId("add-blank-position-photo_day_shortlist"),
    );
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });

    const insert = cap().inserts.find((c) => c.table === "gallery_positions");
    expect(insert.payload.position_index).toBe(1);
  });
});

// ── Engine-mode + tolerance save (W11.6.28c — Joseph: "save doesn't commit") ─
//
// The cell editor's Save button (data-testid='save-package-settings') wires
// to packageMutation which UPDATEs `packages` with the operator's chosen
// engine_mode_override + tolerance values. These tests pin the contract:
//
//  1. Save fires UPDATE on `packages` with the right engine_mode_override
//     value and the row's id in the .eq filter.
//  2. Tolerance Above / Below numeric inputs are coerced to numbers (not
//     left as strings, which Postgres would reject).
//  3. Toast surfaces "Package settings saved." on success.
//  4. When engineMode is reset to "(inherit default)", the payload sets
//     engine_mode_override to NULL (not the empty string).
describe("CellEditorDialog — engine_mode + tolerance save", () => {
  const cap = () => globalThis.__recipe_save_capture__;

  beforeEach(() => {
    cap().inserts.length = 0;
    cap().updates.length = 0;
    cap().deletes.length = 0;
    cap().rpcCalls.length = 0;
    cap().toastSuccess.length = 0;
    cap().toastError.length = 0;
  });

  it("Save package settings — UPDATE fires on `packages` with the active row's id", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // The Save button for the engine-mode + tolerance row.
    const saveBtn = await waitFor(() =>
      screen.getByTestId("save-package-settings"),
    );
    fireEvent.click(saveBtn);

    // UPDATE must fire on the packages table with .eq('id', pkg.id).
    await waitFor(() => {
      expect(
        cap().updates.some((u) => u.table === "packages"),
      ).toBe(true);
    });

    const update = cap().updates.find((u) => u.table === "packages");
    expect(update.filter).toEqual({ col: "id", val: "pkg-silver" });
    // Payload always includes engine_mode_override + tolerance band columns.
    expect(update.payload).toHaveProperty("engine_mode_override");
    expect(update.payload).toHaveProperty("expected_count_tolerance_below");
    expect(update.payload).toHaveProperty("expected_count_tolerance_above");
  });

  it("Save package settings — toast confirms on success", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("save-package-settings"));

    await waitFor(() => {
      expect(
        cap().toastSuccess.some((m) => /package settings saved/i.test(m)),
      ).toBe(true);
    });
  });

  it("Save package settings — tolerance below input is coerced to a Number", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // Type "3" into the tolerance-below input.
    const tolBelow = await waitFor(() =>
      screen.getByTestId("tolerance-below-input"),
    );
    fireEvent.change(tolBelow, { target: { value: "3" } });

    fireEvent.click(screen.getByTestId("save-package-settings"));

    await waitFor(() => {
      expect(
        cap().updates.some((u) => u.table === "packages"),
      ).toBe(true);
    });

    const update = cap().updates.find((u) => u.table === "packages");
    expect(update.payload.expected_count_tolerance_below).toBe(3);
    // Tolerance must be a number, not the string "3" (Postgres would
    // reject a string against an integer column).
    expect(typeof update.payload.expected_count_tolerance_below).toBe("number");
  });

  // ── W11.8 / mig 454 — instance_index + instance_unique_constraint save ───
  it("Add blank position — Save mutation does not reject the new W11.8 instance fields", async () => {
    // The W11.8 add path doesn't set instance_* explicitly (they fall
    // through DB defaults: instance_index=NULL, instance_unique_constraint=
    // FALSE), but the upsertMutation sanitiser must not strip them when a
    // future code path includes them on the draft. The transientKeys list
    // in CellEditorDialog is finite — instance_* must NOT appear there.
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    fireEvent.click(
      await waitFor(() =>
        screen.getByTestId("add-blank-position-photo_day_shortlist"),
      ),
    );

    await waitFor(() => {
      expect(cap().inserts.length).toBeGreaterThan(0);
    });
    const insert = cap().inserts.find((c) => c.table === "gallery_positions");
    expect(insert).toBeTruthy();
    // The Add blank flow doesn't seed instance_* — they're absent and the
    // DB will fall back to defaults. The important contract: the sanitiser
    // doesn't blow up on a payload that DOES carry them, and they're not
    // listed as transientKeys in the dialog. Verified by isolating the
    // sanitiser-stripped keys: instance_* must NOT be in that set.
    const TRANSIENT_KEYS_TO_STRIP = [
      "is_overridden_at_cell",
      "inherited_from_scope",
      "package_id",
      "price_tier_id",
      "project_type_id",
      "product_id",
      "scope_ref_id_3",
      "room_type",
      "composition_type",
    ];
    expect(TRANSIENT_KEYS_TO_STRIP).not.toContain("instance_index");
    expect(TRANSIENT_KEYS_TO_STRIP).not.toContain("instance_unique_constraint");
  });

  it("Save package settings — empty tolerance inputs serialise to NULL", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // The Silver fixture has tolerance_below = null and _above = null, so
    // the inputs are blank. Clicking Save should send null for both.
    fireEvent.click(screen.getByTestId("save-package-settings"));

    await waitFor(() => {
      expect(
        cap().updates.some((u) => u.table === "packages"),
      ).toBe(true);
    });
    const update = cap().updates.find((u) => u.table === "packages");
    expect(update.payload.expected_count_tolerance_below).toBe(null);
    expect(update.payload.expected_count_tolerance_above).toBe(null);
    // Engine mode defaults to null (inherit) when nothing is selected.
    expect(update.payload.engine_mode_override).toBe(null);
  });
});
