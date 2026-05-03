/**
 * PositionRowInstance — vitest suite for W11.8 / mig 454.
 *
 * The recipe-matrix Position Editor gained two new constraint fields under
 * the existing "More constraints" expander:
 *
 *   - instance_index             — select (Any / 1st..4th detected)
 *   - instance_unique_constraint — checkbox (default false)
 *
 * Together they let operators target the Nth detected space_instance per
 * room type, and force coverage to spread across different physical rooms
 * when the same constraint tuple repeats. The backend (mig 454) added the
 * matching columns on `gallery_positions`; this UI threads values through
 * to the save payload via the existing draft → upsertMutation pipeline.
 *
 * These tests pin the behaviour close to the component:
 *   1. Both new fields render inside the More-constraints expander.
 *   2. Defaults: instance_index = null, instance_unique_constraint = false.
 *   3. Toggling "Force unique" from false → true marks the row dirty so
 *      the Save button enables.
 *   4. Saving threads instance_index + instance_unique_constraint into the
 *      onSave callback's draft.
 *
 * The hooks module is mocked away so useAxisDistribution returns no rows
 * — the existing 5 axes still render (with empty option lists), which
 * keeps the suite hermetic.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../recipe-matrix/hooks", () => ({
  useAxisDistribution: () => ({ data: [], isLoading: false }),
}));

import PositionRow from "../recipe-matrix/PositionRow";

function mountRow(positionOverrides = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const position = {
    id: "gp-test",
    package_id: null,
    price_tier_id: null,
    project_type_id: null,
    product_id: null,
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
    image_type: null,
    lens_class: null,
    orientation: null,
    instance_index: null,
    instance_unique_constraint: false,
    ...positionOverrides,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <PositionRow
        position={position}
        index={0}
        templates={[]}
        onSave={onSave}
        onDelete={onDelete}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSave, onDelete, position };
}

describe("PositionRow — W11.8 / mig 454 instance fields", () => {
  it("renders instance_index + instance_unique_constraint inside the More-constraints expander", async () => {
    mountRow();
    // Expand the row.
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    // Open the More expander.
    const moreToggle = await waitFor(() =>
      screen.getByTestId("more-constraints-toggle-0"),
    );
    fireEvent.click(moreToggle);

    // Both new controls appear inside the More section.
    await waitFor(() => {
      expect(
        screen.getByTestId("constraint-0-instance_index"),
      ).toBeTruthy();
    });
    expect(
      screen.getByTestId("constraint-0-instance_unique_constraint"),
    ).toBeTruthy();

    // The instance subsection is wrapped in its own grid for layout.
    expect(screen.getByTestId("constraints-more-instance-0")).toBeTruthy();
  });

  it("Instance dropdown defaults to 'Any' when instance_index is null", async () => {
    mountRow({ instance_index: null });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    const trigger = await waitFor(() =>
      screen.getByTestId("constraint-0-instance_index"),
    );
    // The Radix Select trigger's textContent shows the active option label.
    expect(trigger.textContent).toMatch(/Any/i);
  });

  it("renders the active instance_index label when set to a number", async () => {
    mountRow({ instance_index: 2 });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    const trigger = await waitFor(() =>
      screen.getByTestId("constraint-0-instance_index"),
    );
    expect(trigger.textContent).toMatch(/2nd detected/i);
  });

  it("renders the unique checkbox unchecked by default", async () => {
    mountRow({ instance_unique_constraint: false });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    const checkbox = await waitFor(() =>
      screen.getByTestId("constraint-0-instance_unique_constraint"),
    );
    // Radix Checkbox stores its state on the data-state attribute.
    expect(checkbox.getAttribute("data-state")).toBe("unchecked");
  });

  it("toggling Force-unique from false to true marks the Save button enabled (row dirty)", async () => {
    const { container } = mountRow({ instance_unique_constraint: false });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    // Save button is initially disabled (no edits).
    const saveBtn = await waitFor(() => screen.getByTestId("position-save-0"));
    expect(saveBtn.disabled).toBe(true);

    // Click the unique-instance checkbox.
    const checkbox = await waitFor(() =>
      screen.getByTestId("constraint-0-instance_unique_constraint"),
    );
    fireEvent.click(checkbox);

    // After the click, the Save button becomes enabled — the row is dirty.
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
  });

  it("clicking Save passes instance_unique_constraint=true into the onSave draft", async () => {
    const { onSave } = mountRow({ instance_unique_constraint: false });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    fireEvent.click(
      await waitFor(() =>
        screen.getByTestId("constraint-0-instance_unique_constraint"),
      ),
    );

    const saveBtn = await waitFor(() => screen.getByTestId("position-save-0"));
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0][0];
    expect(draft.instance_unique_constraint).toBe(true);
    // instance_index stayed at the default null (Any).
    expect(draft.instance_index).toBeNull();
  });

  it("preserves a non-default instance_index value through the save payload", async () => {
    // The dropdown interaction is flaky in jsdom, so we mount with a
    // pre-set instance_index, flip the unique checkbox to make the row
    // dirty, then verify both fields survive into the draft handed to
    // onSave. This pins that the draft carries instance_index forward
    // unchanged.
    const { onSave } = mountRow({
      instance_index: 3,
      instance_unique_constraint: false,
    });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    fireEvent.click(
      await waitFor(() => screen.getByTestId("more-constraints-toggle-0")),
    );

    fireEvent.click(
      await waitFor(() =>
        screen.getByTestId("constraint-0-instance_unique_constraint"),
      ),
    );

    const saveBtn = await waitFor(() => screen.getByTestId("position-save-0"));
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledTimes(1);
    const draft = onSave.mock.calls[0][0];
    expect(draft.instance_index).toBe(3);
    expect(draft.instance_unique_constraint).toBe(true);
  });

  it("More-constraints counter shows the new fields when active", async () => {
    mountRow({
      instance_index: 1,
      instance_unique_constraint: true,
    });
    fireEvent.click(screen.getByTestId("position-toggle-0"));
    const moreToggle = await waitFor(() =>
      screen.getByTestId("more-constraints-toggle-0"),
    );
    // 7 axes total in the More section now (5 existing + 2 new); two are
    // set on this fixture so the counter reads "2 / 7 set".
    expect(moreToggle.textContent).toMatch(/2 \/ 7 set/);
  });
});
