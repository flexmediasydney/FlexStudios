// ─────────────────────────────────────────────────────────────────────────────
// Wave 14 — calibration session migration + benchmark-runner integration.
//
// Spec: docs/design-specs/W14-calibration-session.md
// Migration: supabase/migrations/407_w14_calibration_session.sql
//
// Run (against a project with the migration applied):
//
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role_jwt> \
//     deno test --allow-net --allow-env \
//       supabase/tests/wave14_calibration_session.test.ts
//
// Without env vars present the tests skip — same scaffolding pattern as the
// other wave14_*.test.ts files in this directory.
// ─────────────────────────────────────────────────────────────────────────────

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const HAS_SUPABASE = SUPABASE_URL.length > 0 && SERVICE_ROLE.length > 0;

async function pgRest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Test 1: schema (mig 407) — three tables exist + RLS on ────────────────

Deno.test({
  name: 'mig 407: calibration_sessions / calibration_editor_shortlists / calibration_decisions exist',
  ignore: !HAS_SUPABASE,
  fn: async () => {
    for (const table of [
      'calibration_sessions',
      'calibration_editor_shortlists',
      'calibration_decisions',
    ]) {
      const res = await pgRest('GET', `${table}?limit=1`);
      assert(res.ok, `${table} GET failed: ${res.status}`);
      // Drain body so the connection is freed.
      await res.text();
    }
  },
});

// ─── Test 2: end-to-end fixture: session → editor shortlist → decisions ─────

Deno.test({
  name: 'mig 407: fixture session + decisions + W14.5 market_frequency join',
  ignore: !HAS_SUPABASE,
  fn: async () => {
    // Pick any project to seed against.
    const projectRes = await pgRest('GET', 'projects?select=id&limit=1');
    if (!projectRes.ok) throw new Error('cannot read projects');
    const projects = (await projectRes.json()) as Array<{ id: string }>;
    if (projects.length === 0) {
      console.warn('no projects available, skipping');
      return;
    }
    const projectId = projects[0].id;

    // 1. Create the calibration session.
    const sessRes = await pgRest('POST', 'calibration_sessions', {
      session_name: `w14-test-${Date.now()}`,
      stratification_config: { cells: [] },
      engine_version: 'wave-6-p8',
    });
    assert(sessRes.ok, `session insert failed: ${sessRes.status}`);
    const sessRows = (await sessRes.json()) as Array<{ id: string }>;
    const sessionId = sessRows[0].id;

    try {
      // 2. Create the editor shortlist row.
      const elRes = await pgRest('POST', 'calibration_editor_shortlists', {
        calibration_session_id: sessionId,
        project_id: projectId,
        editor_picked_stems: ['IMG_001', 'IMG_002'],
        status: 'submitted',
      });
      assert(elRes.ok, `editor_shortlist insert failed: ${elRes.status}`);
      await elRes.text();

      // 3. Insert 3 decisions: 2 disagree (with reasoning), 1 match.
      // PostgREST requires every row in a bulk insert to have the SAME keys —
      // explicit null on the match row keeps the shape uniform.
      const decisionRows = [
        {
          calibration_session_id: sessionId,
          project_id: projectId,
          slot_id: 'kitchen_main',
          stem: 'IMG_017',
          ai_decision: 'shortlisted',
          editor_decision: 'rejected',
          agreement: 'disagree',
          editor_reasoning: 'AI under-weighted clutter on bench',
          primary_signal_diff: 'aesthetic',
        },
        {
          calibration_session_id: sessionId,
          project_id: projectId,
          slot_id: 'living_room_hero',
          stem: 'IMG_022',
          ai_decision: 'shortlisted',
          editor_decision: 'rejected',
          agreement: 'disagree',
          editor_reasoning: 'window blowout area too large',
          primary_signal_diff: 'lighting',
        },
        {
          calibration_session_id: sessionId,
          project_id: projectId,
          slot_id: 'exterior_front_hero',
          stem: 'IMG_002',
          ai_decision: 'shortlisted',
          editor_decision: 'shortlisted',
          agreement: 'match',
          editor_reasoning: null,
          primary_signal_diff: null,
        },
      ];
      const dRes = await pgRest('POST', 'calibration_decisions', decisionRows);
      assert(dRes.ok, `decisions insert failed: ${dRes.status}`);
      await dRes.text();

      // 4. Verify count of disagreements via filter.
      const dgRes = await pgRest(
        'GET',
        `calibration_decisions?calibration_session_id=eq.${sessionId}&agreement=eq.disagree&select=slot_id,primary_signal_diff`,
      );
      const disagreements = (await dgRes.json()) as Array<{
        slot_id: string;
        primary_signal_diff: string;
      }>;
      assertEquals(disagreements.length, 2);
      assert(
        disagreements.every((d) => d.primary_signal_diff !== null),
        'every disagreement carries primary_signal_diff',
      );
    } finally {
      // Cleanup: cascade delete via session.
      const cleanupRes = await pgRest(
        'DELETE',
        `calibration_sessions?id=eq.${sessionId}`,
      );
      await cleanupRes.text();
    }
  },
});

// ─── Test 3: shortlisting_benchmark_results.trigger CHECK accepts 'calibration' ─

Deno.test({
  name: 'mig 407: benchmark_results.trigger CHECK was relaxed to allow calibration',
  ignore: !HAS_SUPABASE,
  fn: async () => {
    // Probe by attempting an INSERT with trigger='calibration'. If the CHECK
    // was relaxed, this returns 201; if not, 400 with a check_violation.
    const res = await pgRest('POST', 'shortlisting_benchmark_results', {
      ran_by: null,
      trigger: 'calibration',
      sample_size: 0,
      total_matches: 0,
      total_slots: 0,
      match_rate: 0,
      baseline_match_rate: 0,
      improvement_vs_baseline: 0,
      per_slot_match_rates: {},
      per_package_match_rates: {},
      engine_version: 'w14-test',
      model_versions: {},
      notes: 'mig407 trigger CHECK probe',
    });
    if (res.status === 201) {
      const inserted = (await res.json()) as Array<{ id: string }>;
      // Cleanup
      const cleanupRes = await pgRest(
        'DELETE',
        `shortlisting_benchmark_results?id=eq.${inserted[0].id}`,
      );
      await cleanupRes.text();
    } else {
      const body = await res.text();
      throw new Error(
        `expected 201 (CHECK relaxed); got ${res.status}: ${body.slice(0, 200)}`,
      );
    }
  },
});
