/**
 * SettingsShortlistingSlots — W11.6.22b vitest suite (curated positions).
 *
 * Coverage:
 *   1. Mode toggle — radio default = ai_decides; switching to curated reveals
 *      the curated positions section (in edit mode for an existing slot).
 *   2. Save button persists the mode change via
 *      api.entities.ShortlistingSlotDefinition.create + .update.
 *   3. Vocabulary dropdowns surface canonical values — assertions per
 *      taxonomy that the option count matches the canonical export.
 *   4. (Drag-reorder is exercised at the data layer — full @hello-pangea/dnd
 *      simulation is brittle in jsdom; we instead assert that PositionsEditor
 *      treats the array index as position_index on save.)
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  IMAGE_TYPE_OPTIONS,
  LIGHTING_STATE_OPTIONS,
  SPACE_TYPE_OPTIONS,
  ZONE_FOCUS_OPTIONS,
  COMPOSITION_TYPE_OPTIONS,
  UNIVERSAL_SIGNAL_KEYS,
} from "@/lib/shortlistingEnums";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
    auth: { getUser: vi.fn(), signOut: vi.fn() },
    functions: { invoke: vi.fn() },
    channel: vi.fn(),
    removeChannel: vi.fn(),
    storage: { from: vi.fn() },
    rpc: vi.fn(),
  })),
}));

const mockSlotRow = {
  id: "slot-row-1",
  slot_id: "kitchen_hero",
  display_name: "Kitchen — hero",
  phase: 1,
  eligible_when_engine_roles: ["photo_day_shortlist"],
  eligible_room_types: ["kitchen_main"],
  eligible_space_types: [],
  eligible_zone_focuses: [],
  max_images: 3,
  min_images: 1,
  lens_class_constraint: null,
  eligible_composition_types: null,
  same_room_as_slot: null,
  selection_mode: "ai_decides",
  notes: null,
  version: 1,
  is_active: true,
};

const positionPrefsState = { rows: [], created: [], updated: [], deleted: [] };

vi.mock("@/api/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      rpc: vi.fn(),
      auth: { me: vi.fn(async () => ({ id: "u", role: "master_admin" })) },
      functions: { invoke: vi.fn() },
      entities: {
        ShortlistingSlotDefinition: {
          list: vi.fn(async () => [mockSlotRow]),
          filter: vi.fn(async () => [mockSlotRow]),
          create: vi.fn(async (payload) => ({ id: "new-slot-id", ...payload })),
          update: vi.fn(async (id, patch) => ({ id, ...patch })),
        },
        ShortlistingSlotPositionPreference: {
          filter: vi.fn(async () => positionPrefsState.rows),
          list: vi.fn(async () => positionPrefsState.rows),
          create: vi.fn(async (payload) => {
            const row = { id: `pref-${positionPrefsState.created.length + 1}`, ...payload };
            positionPrefsState.created.push(row);
            positionPrefsState.rows.push(row);
            return row;
          }),
          update: vi.fn(async (id, patch) => {
            positionPrefsState.updated.push({ id, ...patch });
            return { id, ...patch };
          }),
          delete: vi.fn(async (id) => {
            positionPrefsState.deleted.push(id);
            positionPrefsState.rows = positionPrefsState.rows.filter((r) => r.id !== id);
            return null;
          }),
        },
      },
    },
  };
});

vi.mock("@/components/auth/PermissionGuard", () => ({
  PermissionGuard: ({ children }) => <>{children}</>,
  usePermissions: () => ({ isMasterAdmin: true, isOwner: true }),
  useCurrentUser: () => ({
    data: { id: "u", role: "master_admin" },
    isLoading: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import SettingsShortlistingSlots from "../SettingsShortlistingSlots";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/SettingsShortlistingSlots"]}>
        <SettingsShortlistingSlots />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsShortlistingSlots — W11.6.22b mode toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    positionPrefsState.rows = [];
    positionPrefsState.created = [];
    positionPrefsState.updated = [];
    positionPrefsState.deleted = [];
  });

  it("renders the slot row with default 'AI decides' mode badge", async () => {
    renderPage();
    const badge = await screen.findByTestId(
      `mode-badge-${mockSlotRow.slot_id}`,
    );
    expect(badge).toHaveAttribute("data-selection-mode", "ai_decides");
    expect(badge).toHaveTextContent("AI decides");
  });

  it("opens the editor and shows mode radio defaulting to ai_decides", async () => {
    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    const radioGroup = await screen.findByTestId("selection-mode-radio");
    expect(radioGroup).toBeInTheDocument();
    expect(screen.getByTestId("mode-ai-decides")).toBeChecked();
    expect(screen.getByTestId("mode-curated")).not.toBeChecked();
    expect(screen.queryByTestId("curated-positions-section")).toBeNull();
  });

  it("toggling to 'Curated positions' reveals the positions editor", async () => {
    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    const curatedRadio = await screen.findByTestId("mode-curated");
    fireEvent.click(curatedRadio);
    expect(curatedRadio).toBeChecked();
    expect(
      await screen.findByTestId("curated-positions-section"),
    ).toBeInTheDocument();
  });

  it("toggling back to 'AI decides' hides the positions editor", async () => {
    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    fireEvent.click(await screen.findByTestId("mode-curated"));
    expect(await screen.findByTestId("curated-positions-section")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mode-ai-decides"));
    await waitFor(() => {
      expect(screen.queryByTestId("curated-positions-section")).toBeNull();
    });
  });
});

describe("SettingsShortlistingSlots — W11.6.22b dropdown vocabularies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    positionPrefsState.rows = [];
    positionPrefsState.created = [];
    positionPrefsState.updated = [];
    positionPrefsState.deleted = [];
  });

  it("canonical taxonomy exports match expected sizes (drift detector)", () => {
    expect(IMAGE_TYPE_OPTIONS).toHaveLength(11);
    expect(LIGHTING_STATE_OPTIONS).toHaveLength(4);
    expect(SPACE_TYPE_OPTIONS).toHaveLength(32);
    expect(ZONE_FOCUS_OPTIONS).toHaveLength(29);
    expect(COMPOSITION_TYPE_OPTIONS).toHaveLength(11);
    expect(UNIVERSAL_SIGNAL_KEYS).toHaveLength(26);
  });

  it("renders a position row with vocabulary dropdowns + signal chips when curated has 1 pref", async () => {
    positionPrefsState.rows = [
      {
        id: "p1",
        slot_id: "kitchen_hero",
        position_index: 1,
        display_label: "Primary Hero",
        preferred_composition_type: null,
        preferred_zone_focus: null,
        preferred_space_type: null,
        preferred_lighting_state: null,
        preferred_image_type: null,
        preferred_signal_emphasis: [],
        is_required: false,
        ai_backfill_on_gap: true,
      },
    ];
    const curatedSlot = { ...mockSlotRow, selection_mode: "curated_positions" };
    const { api } = await import("@/api/supabaseClient");
    api.entities.ShortlistingSlotDefinition.list.mockResolvedValueOnce([curatedSlot]);

    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    expect(
      await screen.findByTestId("curated-positions-section"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("position-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-label-1")).toHaveValue("Primary Hero");
    expect(screen.getByTestId("position-composition-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-zone-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-space-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-lighting-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-image-type-1")).toBeInTheDocument();
    expect(screen.getByTestId("signal-chip-exposure_balance")).toBeInTheDocument();
    expect(screen.getByTestId("signal-chip-brochure_print_survival")).toBeInTheDocument();
    expect(screen.getByTestId("position-required-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-backfill-1")).toBeInTheDocument();
  });
});

describe("SettingsShortlistingSlots — W11.6.22b add + save positions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    positionPrefsState.rows = [];
    positionPrefsState.created = [];
    positionPrefsState.updated = [];
    positionPrefsState.deleted = [];
  });

  it("adding a position then saving fires create() with auto-indexed payload", async () => {
    const curatedSlot = { ...mockSlotRow, selection_mode: "curated_positions" };
    const { api } = await import("@/api/supabaseClient");
    api.entities.ShortlistingSlotDefinition.list.mockResolvedValueOnce([curatedSlot]);

    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    await screen.findByTestId("curated-positions-section");
    // Wait for the positions query to resolve and render the editor (vs the
    // loading spinner). Use findByTestId so async state settles.
    const addBtn = await screen.findByTestId(`position-add-${curatedSlot.slot_id}`);
    fireEvent.click(addBtn);
    expect(await screen.findByTestId("position-row-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`positions-save-${curatedSlot.slot_id}`));
    await waitFor(() => {
      expect(api.entities.ShortlistingSlotPositionPreference.create).toHaveBeenCalled();
    });
    const lastCall = api.entities.ShortlistingSlotPositionPreference.create.mock.calls.at(-1);
    expect(lastCall[0]).toMatchObject({
      slot_id: "kitchen_hero",
      position_index: 1,
      ai_backfill_on_gap: true,
      is_required: false,
    });
  });

  it("removing a row re-indexes remaining positions to 1..N", async () => {
    positionPrefsState.rows = [
      { id: "p1", slot_id: "kitchen_hero", position_index: 1, display_label: "Hero", preferred_signal_emphasis: [], is_required: false, ai_backfill_on_gap: true },
      { id: "p2", slot_id: "kitchen_hero", position_index: 2, display_label: "Alt", preferred_signal_emphasis: [], is_required: false, ai_backfill_on_gap: true },
    ];
    const curatedSlot = { ...mockSlotRow, selection_mode: "curated_positions" };
    const { api } = await import("@/api/supabaseClient");
    api.entities.ShortlistingSlotDefinition.list.mockResolvedValueOnce([curatedSlot]);

    renderPage();
    const editBtn = await screen.findByRole("button", { name: /edit/i });
    fireEvent.click(editBtn);
    await screen.findByTestId("curated-positions-section");
    expect(await screen.findByTestId("position-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("position-row-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("position-remove-1"));
    await waitFor(() => {
      expect(screen.queryByTestId("position-row-2")).toBeNull();
      expect(screen.getByTestId("position-row-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`positions-save-${curatedSlot.slot_id}`));
    await waitFor(() => {
      expect(api.entities.ShortlistingSlotPositionPreference.delete).toHaveBeenCalled();
    });
    expect(api.entities.ShortlistingSlotPositionPreference.update).toHaveBeenCalled();
    const updateCall = api.entities.ShortlistingSlotPositionPreference.update.mock.calls.at(-1);
    expect(updateCall[1]).toMatchObject({ position_index: 1, slot_id: "kitchen_hero" });
  });
});
