// ─────────────────────────────────────────────────────────────────────────────
// Wave 11.5 — human_override capture trigger contract tests (mig 409)
//
// Spec: docs/design-specs/W11-5-human-reclassification-capture.md
// Migration: supabase/migrations/409_w11_5_human_override_observations.sql
//
// These are **contract** tests — they document the exact row shape that the
// `trg_class_override_capture` and `trg_shortlist_override_capture` triggers
// produce in `raw_attribute_observations`. They run as a Deno test that hits
// a live Supabase project via the service role; against a fresh round/group
// fixture they assert:
//
//   1. composition_classification_overrides INSERT (room_type/composition/
//      vantage/score) → 3 raw_attribute_observations rows (score not emitted),
//      each with source_type='human_override', confidence=1.0, attributes
//      JSON containing override_id + field + ai_value + human_value.
//
//   2. override_source='stage4_visual_override' is SKIPPED (engine-emitted,
//      not human).
//
//   3. shortlisting_overrides INSERT with primary_signal_overridden → one
//      observation row anchored on ai_proposed_group_id.
//
//   4. Replay safety: re-running the trigger via UPDATE produces no duplicate
//      rows; existing rows are UPSERTed and their raw_label_embedding is
//      reset to NULL so canonical-rollup re-processes on the next sweep.
//
// To run (against a dev/staging Supabase):
//
//     SUPABASE_URL=https://<project>.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=<service_role_jwt> \
//     W11_5_TEST_ROUND_ID=<existing round> \
//     W11_5_TEST_GROUP_ID_A=<group in that round> \
//     W11_5_TEST_GROUP_ID_B=<another group> \
//     W11_5_TEST_USER_ID=<auth.users.id of any test user> \
//     W11_5_TEST_PROJECT_ID=<project that owns the round> \
//       deno test --allow-net --allow-env supabase/tests/wave11_5_human_override_capture.test.ts
//
// If the env vars are missing, tests SKIP rather than fail (so CI without
// secret access stays green).
// ─────────────────────────────────────────────────────────────────────────────

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ROUND_ID = Deno.env.get('W11_5_TEST_ROUND_ID') ?? '';
const GROUP_ID_A = Deno.env.get('W11_5_TEST_GROUP_ID_A') ?? '';
const GROUP_ID_B = Deno.env.get('W11_5_TEST_GROUP_ID_B') ?? '';
const USER_ID = Deno.env.get('W11_5_TEST_USER_ID') ?? '';
const PROJECT_ID = Deno.env.get('W11_5_TEST_PROJECT_ID') ?? '';

const HAS_FIXTURE = SUPABASE_URL && SERVICE_KEY
  && ROUND_ID && GROUP_ID_A && GROUP_ID_B && USER_ID && PROJECT_ID;

async function pgRest(path: string, init?: RequestInit): Promise<Response> {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = new Headers(init?.headers);
  headers.set('apikey', SERVICE_KEY);
  headers.set('authorization', `Bearer ${SERVICE_KEY}`);
  headers.set('content-type', 'application/json');
  if (!headers.has('prefer')) headers.set('prefer', 'return=representation');
  return await fetch(url, { ...init, headers });
}

async function insertOverride(payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await pgRest('/composition_classification_overrides', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`insert override failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

async function selectObs(filter: string): Promise<Array<Record<string, unknown>>> {
  const res = await pgRest(`/raw_attribute_observations?${filter}`);
  if (!res.ok) throw new Error(`select obs failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function deleteObs(filter: string): Promise<void> {
  await pgRest(`/raw_attribute_observations?${filter}`, { method: 'DELETE' });
}

async function deleteOverride(id: string): Promise<void> {
  await pgRest(`/composition_classification_overrides?id=eq.${id}`, { method: 'DELETE' });
}

async function deleteOverrideBy(round: string, group: string, source: string): Promise<void> {
  await pgRest(
    `/composition_classification_overrides?round_id=eq.${round}&group_id=eq.${group}&override_source=eq.${source}`,
    { method: 'DELETE' },
  );
}

// ─── Test 1: INSERT → 3 obs rows with correct shape ──────────────────────────

Deno.test({
  name: 'composition_override INSERT emits 3 raw_attribute_observations',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    // Cleanup any leftover state from prior test runs.
    await deleteOverrideBy(ROUND_ID, GROUP_ID_A, 'stage1_correction');
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}`);

    const inserted = await insertOverride({
      round_id: ROUND_ID,
      group_id: GROUP_ID_A,
      override_source: 'stage1_correction',
      ai_room_type: 'exterior_front',
      human_room_type: 'exterior_rear',
      ai_composition_type: 'hero_tight',
      human_composition_type: 'hero_wide',
      ai_vantage_point: 'neutral',
      human_vantage_point: 'exterior_looking_in',
      override_reason: 'Hills Hoist visible — back yard',
      actor_user_id: USER_ID,
    });

    const obs = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`,
    );
    assertEquals(obs.length, 3, 'expected 3 observations from 3-field override');

    const labels = obs.map((o) => o.raw_label).sort();
    assertEquals(labels, [
      'composition_type:hero_wide',
      'room_type:exterior_rear',
      'vantage_point:exterior_looking_in',
    ]);

    const roomObs = obs.find((o) => o.raw_label === 'room_type:exterior_rear')!;
    assertEquals(roomObs.source_type, 'human_override');
    assertEquals(Number(roomObs.confidence), 1);
    const attrs = roomObs.attributes as Record<string, unknown>;
    assertEquals(attrs.override_id, inserted.id);
    assertEquals(attrs.field, 'room_type');
    assertEquals(attrs.ai_value, 'exterior_front');
    assertEquals(attrs.human_value, 'exterior_rear');
    assertEquals(attrs.override_source, 'stage1_correction');

    // Cleanup.
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`);
    await deleteOverride(inserted.id);
  },
});

// ─── Test 2: combined_score is intentionally NOT emitted ─────────────────────

Deno.test({
  name: 'composition_override combined_score does not emit observation',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    await deleteOverrideBy(ROUND_ID, GROUP_ID_A, 'stage1_correction');
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`);

    const inserted = await insertOverride({
      round_id: ROUND_ID,
      group_id: GROUP_ID_A,
      override_source: 'stage1_correction',
      ai_combined_score: 6.0,
      human_combined_score: 8.5,
      override_reason: 'manager hand-grade — premium-quality lighting',
      actor_user_id: USER_ID,
    });

    const obs = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`,
    );
    assertEquals(obs.length, 0, 'combined_score should not emit observation');

    await deleteOverride(inserted.id);
  },
});

// ─── Test 3: stage4_visual_override is SKIPPED ───────────────────────────────

Deno.test({
  name: 'override_source=stage4_visual_override does not emit observations',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    await deleteOverrideBy(ROUND_ID, GROUP_ID_B, 'stage4_visual_override');
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`);

    const inserted = await insertOverride({
      round_id: ROUND_ID,
      group_id: GROUP_ID_B,
      override_source: 'stage4_visual_override',
      ai_room_type: 'exterior_front',
      human_room_type: 'exterior_rear',
      override_reason: 'Stage 4 cross-image visual cross-reference',
      // actor_user_id intentionally omitted (mig 379a permits NULL for stage4)
    });

    const obs = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`,
    );
    assertEquals(obs.length, 0, 'stage4_visual_override should not emit obs');

    await deleteOverride(inserted.id);
  },
});

// ─── Test 4: Replay safety on UPDATE ────────────────────────────────────────

Deno.test({
  name: 'composition_override UPDATE is replay-safe (no duplicates)',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    await deleteOverrideBy(ROUND_ID, GROUP_ID_A, 'stage1_correction');
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`);

    const inserted = await insertOverride({
      round_id: ROUND_ID,
      group_id: GROUP_ID_A,
      override_source: 'stage1_correction',
      ai_room_type: 'exterior_front',
      human_room_type: 'exterior_rear',
      override_reason: 'first',
      actor_user_id: USER_ID,
    });

    const obsBefore = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&raw_label=eq.room_type:exterior_rear`,
    );
    assertEquals(obsBefore.length, 1);
    const originalObsId = obsBefore[0].id as string;

    // Same-value UPDATE → no new obs row.
    await pgRest(
      `/composition_classification_overrides?id=eq.${inserted.id}`,
      { method: 'PATCH', body: JSON.stringify({ override_reason: 'updated reason' }) },
    );
    const obsAfterSameUpdate = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`,
    );
    assertEquals(obsAfterSameUpdate.length, 1, 'same-value UPDATE created duplicate');

    // Value-change UPDATE (laundry) → new obs row, original still present.
    await pgRest(
      `/composition_classification_overrides?id=eq.${inserted.id}`,
      { method: 'PATCH', body: JSON.stringify({ human_room_type: 'laundry' }) },
    );
    const obsAfterChange = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`,
    );
    assertEquals(obsAfterChange.length, 2, 'value-change UPDATE wrong count');

    // Revert UPDATE → upserts existing row, NO duplicate.
    await pgRest(
      `/composition_classification_overrides?id=eq.${inserted.id}`,
      { method: 'PATCH', body: JSON.stringify({ human_room_type: 'exterior_rear' }) },
    );
    const obsAfterRevert = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&raw_label=eq.room_type:exterior_rear`,
    );
    assertEquals(obsAfterRevert.length, 1, 'revert UPDATE created duplicate');
    assert(
      obsAfterRevert[0].id === originalObsId,
      'revert created new row instead of UPSERTing existing',
    );

    // The upsert should reset raw_label_embedding to null so canonical-rollup
    // re-processes on the next sweep.
    assertEquals(
      obsAfterRevert[0].raw_label_embedding,
      null,
      'upsert should null raw_label_embedding for re-processing',
    );

    // Cleanup.
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_A}&source_type=eq.human_override`);
    await deleteOverride(inserted.id);
  },
});

// ─── Test 5: shortlisting_overrides emits one obs row ────────────────────────

Deno.test({
  name: 'shortlisting_override with primary_signal_overridden emits obs',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`);

    const res = await pgRest('/shortlisting_overrides', {
      method: 'POST',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID_B,
        ai_proposed_slot_id: 'living_hero',
        ai_proposed_score: 7.5,
        human_action: 'swapped',
        human_selected_group_id: GROUP_ID_B,
        override_reason: 'quality_preference',
        override_note: 'Composition was the real issue',
        primary_signal_overridden: 'composition_strength',
        project_tier: 'standard',
      }),
    });
    if (!res.ok) throw new Error(`insert shortlisting_override failed: ${res.status} ${await res.text()}`);
    const inserted = (await res.json())[0];

    const obs = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&raw_label=eq.shortlist_action:swapped:composition_strength`,
    );
    assertEquals(obs.length, 1, 'shortlisting swap should emit one obs');
    assertEquals(obs[0].source_type, 'human_override');
    const attrs = obs[0].attributes as Record<string, unknown>;
    assertEquals(attrs.shortlisting_override_id, inserted.id);
    assertEquals(attrs.human_action, 'swapped');
    assertEquals(attrs.primary_signal_overridden, 'composition_strength');

    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`);
    await pgRest(`/shortlisting_overrides?id=eq.${inserted.id}`, { method: 'DELETE' });
  },
});

// ─── Test 6: shortlisting approved_as_proposed is SKIPPED ────────────────────

Deno.test({
  name: 'shortlisting_override approved_as_proposed does not emit',
  ignore: !HAS_FIXTURE,
  fn: async () => {
    await deleteObs(`round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`);

    const res = await pgRest('/shortlisting_overrides', {
      method: 'POST',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        round_id: ROUND_ID,
        ai_proposed_group_id: GROUP_ID_B,
        ai_proposed_slot_id: 'living_hero',
        ai_proposed_score: 7.5,
        human_action: 'approved_as_proposed',
        human_selected_group_id: GROUP_ID_B,
        primary_signal_overridden: 'composition_strength',
      }),
    });
    if (!res.ok) throw new Error(`insert shortlisting_override failed: ${res.status} ${await res.text()}`);
    const inserted = (await res.json())[0];

    const obs = await selectObs(
      `round_id=eq.${ROUND_ID}&group_id=eq.${GROUP_ID_B}&source_type=eq.human_override`,
    );
    assertEquals(obs.length, 0);

    await pgRest(`/shortlisting_overrides?id=eq.${inserted.id}`, { method: 'DELETE' });
  },
});

if (!HAS_FIXTURE) {
  console.log('[wave11_5_human_override_capture] tests SKIPPED — set fixture env vars to run');
}
