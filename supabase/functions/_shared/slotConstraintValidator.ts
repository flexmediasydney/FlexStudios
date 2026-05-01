/**
 * slotConstraintValidator.ts — Wave 11.6.7 P1-4 + P1-5 pure helper.
 *
 * Applies the new W11.6.7 slot constraints to Stage 4's slot_decisions[]:
 *
 *   P1-4: lens_class_constraint
 *     - When slot.lens_class_constraint is non-null, reject decisions whose
 *       winner's classification.lens_class != that value.
 *
 *   P1-5: eligible_composition_types
 *     - When slot.eligible_composition_types[] is non-empty, reject decisions
 *       whose winner's classification.composition_type ∉ list.
 *
 *   P1-5: same_room_as_slot
 *     - When slot.same_room_as_slot is non-null, the winner of THIS slot must
 *       have the SAME composition_groups.room_type as the winner of the
 *       linked slot (e.g. bathroom_detail must come from the same physical
 *       room as bathroom_main).
 *
 * Each rejection produces a stage_4_overrides[] row (field='slot_decision',
 * stage_4_value='rejected', reason explains the constraint violated). The
 * caller (Stage 4 persistSlotDecisions) drops the offending winner from the
 * persistence batch — the slot stays empty for human triage.
 *
 * Pure: no DB calls. The caller hands in resolved slot definitions +
 * classifications keyed by group_id + the linked slot_id of every constraint
 * target. Returns:
 *   - acceptedDecisions: the input decisions minus rejected ones
 *   - rejections: stage_4_overrides[] rows the orchestrator should append
 *
 * Spec: docs/WAVE_7_BACKLOG.md L203-235.
 */

export interface SlotDefinitionConstraints {
  /** UUID of the slot definition row. NOT slot_id (the canonical text). */
  id: string;
  /** Canonical slot identifier (used in slot_decisions[].slot_id). */
  slot_id: string;
  lens_class_constraint?: string | null;
  eligible_composition_types?: string[] | null;
  same_room_as_slot?: string | null;
}

export interface ClassificationContext {
  /** group_id is the FK target. */
  group_id: string;
  lens_class: string | null;
  composition_type: string | null;
  /** Pulled from composition_groups via join — needed for same_room_as_slot. */
  room_type: string | null;
}

export interface SlotDecisionInput {
  slot_id: string;
  winner_group_id: string | null;
  winner_stem: string | null;
  /** Original decision payload — opaque to the validator, returned verbatim
   *  on accepted decisions. */
  raw: Record<string, unknown>;
}

export interface StageFourOverrideRow {
  stem: string;
  field: 'slot_decision';
  stage_1_value: string | null;
  stage_4_value: 'rejected';
  reason: string;
}

export interface ValidateOpts {
  decisions: SlotDecisionInput[];
  /** Slot definitions keyed by slot_id (canonical). */
  slotsBySlotId: Map<string, SlotDefinitionConstraints>;
  /** Classifications keyed by group_id. */
  classificationsByGroupId: Map<string, ClassificationContext>;
}

export interface ValidateResult {
  acceptedDecisions: SlotDecisionInput[];
  rejections: StageFourOverrideRow[];
}

/**
 * Run all three constraints in a single pass, with same_room_as_slot resolved
 * from the OTHER slot's accepted winner. The lens-class + composition-type
 * checks run independently per decision; the same_room check needs the linked
 * slot's winner room_type, which is computed from the input batch. Slots
 * pointing to a slot that wasn't decided in this batch are skipped (no
 * rejection, but a warning is implicit — we leave that to the caller).
 */
export function validateSlotConstraints(
  opts: ValidateOpts,
): ValidateResult {
  const { decisions, slotsBySlotId, classificationsByGroupId } = opts;

  // Build a winner-by-slot_id index from the incoming batch so the
  // same_room_as_slot check can resolve the linked slot's room_type.
  // Map slot_id → the WINNER's group_id (or null if missing).
  const winnerGroupBySlotId = new Map<string, string | null>();
  for (const d of decisions) {
    winnerGroupBySlotId.set(d.slot_id, d.winner_group_id);
  }

  // Build a slot_id → slot_definition.id index (for resolving same_room_as_slot
  // FK target back to a slot_id).
  const slotIdById = new Map<string, string>();
  for (const slot of slotsBySlotId.values()) {
    slotIdById.set(slot.id, slot.slot_id);
  }

  const accepted: SlotDecisionInput[] = [];
  const rejections: StageFourOverrideRow[] = [];

  for (const d of decisions) {
    const slot = slotsBySlotId.get(d.slot_id);
    if (!slot) {
      // Unknown slot — let the caller's existing slot_id alias check
      // handle it. Pass through as accepted; the persistence layer will
      // either drop or warn on its own enum check.
      accepted.push(d);
      continue;
    }

    const winnerGroupId = d.winner_group_id;
    const cls = winnerGroupId ? classificationsByGroupId.get(winnerGroupId) : null;

    // Lens-class constraint (P1-4)
    if (slot.lens_class_constraint && winnerGroupId && cls) {
      if (cls.lens_class !== slot.lens_class_constraint) {
        rejections.push({
          stem: d.winner_stem || winnerGroupId,
          field: 'slot_decision',
          stage_1_value: cls.lens_class ?? null,
          stage_4_value: 'rejected',
          reason:
            `slot ${d.slot_id} requires lens_class='${slot.lens_class_constraint}' ` +
            `but winner has lens_class='${cls.lens_class ?? 'null'}'`,
        });
        continue;
      }
    }

    // Composition-type allow-list constraint (P1-5)
    if (
      Array.isArray(slot.eligible_composition_types) &&
      slot.eligible_composition_types.length > 0 &&
      winnerGroupId &&
      cls
    ) {
      const allowed = slot.eligible_composition_types;
      if (!cls.composition_type || !allowed.includes(cls.composition_type)) {
        rejections.push({
          stem: d.winner_stem || winnerGroupId,
          field: 'slot_decision',
          stage_1_value: cls.composition_type ?? null,
          stage_4_value: 'rejected',
          reason:
            `slot ${d.slot_id} requires composition_type ∈ [${allowed.join(',')}] ` +
            `but winner has composition_type='${cls.composition_type ?? 'null'}'`,
        });
        continue;
      }
    }

    // same_room_as_slot constraint (P1-5)
    if (slot.same_room_as_slot && winnerGroupId && cls) {
      const linkedSlotId = slotIdById.get(slot.same_room_as_slot);
      if (linkedSlotId) {
        const linkedWinnerGroupId = winnerGroupBySlotId.get(linkedSlotId);
        if (linkedWinnerGroupId) {
          const linkedCls = classificationsByGroupId.get(linkedWinnerGroupId);
          if (linkedCls && linkedCls.room_type !== cls.room_type) {
            rejections.push({
              stem: d.winner_stem || winnerGroupId,
              field: 'slot_decision',
              stage_1_value: cls.room_type ?? null,
              stage_4_value: 'rejected',
              reason:
                `slot ${d.slot_id} must share room_type with linked slot ` +
                `'${linkedSlotId}' (which has room_type='${linkedCls.room_type ?? 'null'}'), ` +
                `but winner has room_type='${cls.room_type ?? 'null'}'`,
            });
            continue;
          }
        }
        // Linked slot has no winner in this batch — skip the check (don't
        // reject; it's a soft constraint when the anchor isn't decided).
      }
      // Linked slot missing from the slot_definitions index — skip (slot
      // was deleted; FK is ON DELETE SET NULL but maybe the row hasn't
      // propagated yet). Treat as if no constraint.
    }

    accepted.push(d);
  }

  return { acceptedDecisions: accepted, rejections };
}
