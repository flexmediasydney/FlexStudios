/**
 * Unit tests for auditJsonBuilder pure helpers.
 * Run: deno test --no-check --allow-all supabase/functions/_shared/auditJsonBuilder.test.ts
 *
 * Wave 7 P1-12 (W7.4): the audit JSON is the canonical "what did this round
 * become" record per the spec resolutions. These tests pin the contract:
 *   - schema_version '1.1' as of Wave 8 (was '1.0' pre-W8)
 *   - approved + rejected are mutually exclusive on group_id (approval wins)
 *   - overrides preserved verbatim (we don't filter or reorder)
 *   - ISO 8601 timestamps round-trip and the Dropbox path-safe stamp is
 *     correct (no colons or periods in filenames)
 *
 * Wave 8 (W8.4): added tier_config block tests at the end of this file.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildAuditJson,
  buildAuditJsonPath,
  serializeAuditJson,
  type AuditApprovedInput,
  type AuditJsonInput,
  type AuditOverrideRow,
  type AuditRejectedInput,
  type AuditRoundInfo,
} from './auditJsonBuilder.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXED_ISO = '2026-04-27T03:12:08.441Z';

function makeRound(overrides: Partial<AuditRoundInfo> = {}): AuditRoundInfo {
  return {
    round_id: 'round-uuid-001',
    round_number: 2,
    project_id: 'project-uuid-001',
    package_type: 'TestPkg',
    locked_at: FIXED_ISO,
    locked_by_user_id: 'user-uuid-001',
    engine_version: null,
    tier_used: null,
    ...overrides,
  };
}

function makeApproved(
  group_id: string,
  partial: Partial<AuditApprovedInput> = {},
): AuditApprovedInput {
  return {
    group_id,
    slot_id: 'slot-living-1',
    score: 8.5,
    ai_proposed_score: 8.5,
    file_stems: [`${group_id}_a`, `${group_id}_b`],
    ...partial,
  };
}

function makeRejected(
  group_id: string,
  partial: Partial<AuditRejectedInput> = {},
): AuditRejectedInput {
  return {
    group_id,
    file_stems: [`${group_id}_a`],
    reason: 'human_action=removed',
    ...partial,
  };
}

function makeOverride(partial: Partial<AuditOverrideRow> = {}): AuditOverrideRow {
  return {
    human_action: 'approved_as_proposed',
    ai_proposed_group_id: 'approved-1',
    ai_proposed_slot_id: 'slot-living-1',
    human_selected_group_id: null,
    human_selected_slot_id: null,
    client_sequence: 1,
    actor_user_id: 'user-uuid-001',
    created_at: FIXED_ISO,
    ...partial,
  };
}

// ─── schema_version ──────────────────────────────────────────────────────────

Deno.test('buildAuditJson: schema_version is 1.1 (Wave 8 bump for tier_config block)', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.schema_version, '1.1');
});

Deno.test('buildAuditJson: empty input produces a valid envelope', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.round_id, 'round-uuid-001');
  assertEquals(out.round_number, 2);
  assertEquals(out.project_id, 'project-uuid-001');
  assertEquals(out.package_type, 'TestPkg');
  assertEquals(out.locked_at, FIXED_ISO);
  assertEquals(out.locked_by_user_id, 'user-uuid-001');
  assertEquals(out.engine_version, null);
  assertEquals(out.tier_used, null);
  assertEquals(out.approved, []);
  assertEquals(out.rejected, []);
  assertEquals(out.overrides, []);
});

// ─── Mutual exclusivity (approved wins over rejected) ────────────────────────

Deno.test('buildAuditJson: approved + rejected are mutually exclusive on group_id', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [makeApproved('shared-1'), makeApproved('a-only')],
    // 'shared-1' appears in both — approved should win.
    rejected: [makeRejected('shared-1'), makeRejected('r-only')],
    overrides: [],
  });

  // Approved set is unchanged.
  const approvedIds = out.approved.map((a) => a.group_id).sort();
  assertEquals(approvedIds, ['a-only', 'shared-1']);

  // Rejected has only the unique entries.
  const rejectedIds = out.rejected.map((r) => r.group_id);
  assertEquals(rejectedIds, ['r-only']);
});

Deno.test('buildAuditJson: rejected with no overlap is preserved verbatim', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [makeApproved('a-1')],
    rejected: [
      makeRejected('r-1', { reason: 'near_duplicate' }),
      makeRejected('r-2', { reason: 'human_action=removed' }),
    ],
    overrides: [],
  });
  assertEquals(out.rejected.length, 2);
  assertEquals(out.rejected[0].reason, 'near_duplicate');
  assertEquals(out.rejected[1].reason, 'human_action=removed');
});

// ─── Deterministic ordering ──────────────────────────────────────────────────

Deno.test('buildAuditJson: approved + rejected sorted by group_id deterministically', () => {
  const out = buildAuditJson({
    round: makeRound(),
    // Insert in non-sorted order; expect lexicographic output.
    approved: [makeApproved('zzz'), makeApproved('aaa'), makeApproved('mmm')],
    rejected: [makeRejected('yyy'), makeRejected('bbb')],
    overrides: [],
  });
  assertEquals(out.approved.map((a) => a.group_id), ['aaa', 'mmm', 'zzz']);
  assertEquals(out.rejected.map((r) => r.group_id), ['bbb', 'yyy']);
});

// ─── Overrides verbatim ──────────────────────────────────────────────────────

Deno.test('buildAuditJson: overrides preserved verbatim (no filtering, no reordering)', () => {
  const ov1 = makeOverride({ client_sequence: 5, human_action: 'removed' });
  const ov2 = makeOverride({ client_sequence: 1, human_action: 'approved_as_proposed' });
  const ov3 = makeOverride({ client_sequence: 3, human_action: 'swapped' });
  // Caller is expected to have already ordered by client_sequence/created_at;
  // builder honours that order and does NOT re-sort.
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [ov2, ov3, ov1],
  });
  assertEquals(out.overrides.length, 3);
  assertEquals(out.overrides[0].client_sequence, 1);
  assertEquals(out.overrides[1].client_sequence, 3);
  assertEquals(out.overrides[2].client_sequence, 5);
});

Deno.test('buildAuditJson: override required fields all present', () => {
  const ov = makeOverride({
    human_action: 'swapped',
    ai_proposed_group_id: 'g-ai',
    ai_proposed_slot_id: 'slot-a',
    human_selected_group_id: 'g-human',
    human_selected_slot_id: 'slot-a',
    client_sequence: 7,
    actor_user_id: 'user-x',
    created_at: FIXED_ISO,
  });
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [ov],
  });
  const r = out.overrides[0];
  assertEquals(r.human_action, 'swapped');
  assertEquals(r.ai_proposed_group_id, 'g-ai');
  assertEquals(r.ai_proposed_slot_id, 'slot-a');
  assertEquals(r.human_selected_group_id, 'g-human');
  assertEquals(r.human_selected_slot_id, 'slot-a');
  assertEquals(r.client_sequence, 7);
  assertEquals(r.actor_user_id, 'user-x');
  assertEquals(r.created_at, FIXED_ISO);
});

Deno.test('buildAuditJson: override forward-compat fields preserved', () => {
  const ov = makeOverride({ override_reason: 'quality_preference', variant_count: 3 });
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [ov],
  });
  assertEquals(out.overrides[0].override_reason, 'quality_preference');
  assertEquals(out.overrides[0].variant_count, 3);
});

// ─── ISO timestamps + serialisation ──────────────────────────────────────────

Deno.test('buildAuditJson: locked_at preserves ISO 8601 round-trip', () => {
  const out = buildAuditJson({
    round: makeRound({ locked_at: FIXED_ISO }),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.locked_at, FIXED_ISO);
  // ISO round-trip via Date — equal milliseconds.
  const parsed = new Date(out.locked_at);
  assertEquals(parsed.toISOString(), FIXED_ISO);
});

Deno.test('serializeAuditJson: 2-space pretty-printed and round-trips', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [makeApproved('a-1')],
    rejected: [makeRejected('r-1')],
    overrides: [makeOverride()],
  });
  const ser = serializeAuditJson(out);
  // Pretty-print check: should contain a 2-space indent.
  assert(ser.includes('\n  "schema_version": "1.1"'), 'expected 2-space indent in serialised JSON');
  // Round-trip through JSON.parse.
  const parsed = JSON.parse(ser);
  assertEquals(parsed.schema_version, '1.1');
  assertEquals(parsed.approved[0].group_id, 'a-1');
  assertEquals(parsed.rejected[0].group_id, 'r-1');
});

// ─── Path builder ────────────────────────────────────────────────────────────

Deno.test('buildAuditJsonPath: composes Photos/_AUDIT path with sanitised stamp', () => {
  const path = buildAuditJsonPath(
    '/Flex Media Team Folder/Projects/abc_lot-45',
    2,
    FIXED_ISO,
  );
  assertEquals(
    path,
    '/Flex Media Team Folder/Projects/abc_lot-45/Photos/_AUDIT/round_2_locked_2026-04-27T03-12-08-441Z.json',
  );
});

Deno.test('buildAuditJsonPath: strips trailing slash on root', () => {
  const path = buildAuditJsonPath('/Acme/', 1, FIXED_ISO);
  assertEquals(
    path,
    '/Acme/Photos/_AUDIT/round_1_locked_2026-04-27T03-12-08-441Z.json',
  );
});

Deno.test('buildAuditJsonPath: filename has no colons or periods (Dropbox-safe)', () => {
  const path = buildAuditJsonPath('/Acme', 99, FIXED_ISO);
  // The path itself contains a period from the .json extension; check the
  // stamp portion only.
  const stamp = path.split('round_99_locked_')[1].replace(/\.json$/, '');
  assertEquals(stamp.includes(':'), false);
  assertEquals(stamp.includes('.'), false);
});

Deno.test('buildAuditJsonPath: distinct timestamps produce distinct files (re-lock semantics)', () => {
  const t1 = '2026-04-27T03:12:08.441Z';
  const t2 = '2026-04-27T03:12:08.442Z';
  const p1 = buildAuditJsonPath('/Acme', 1, t1);
  const p2 = buildAuditJsonPath('/Acme', 1, t2);
  assertNotEquals(p1, p2);
});

// ─── Engine version + tier used (forward-compat fields) ──────────────────────

Deno.test('buildAuditJson: engine_version + tier_used pass through when set', () => {
  const out = buildAuditJson({
    round: makeRound({ engine_version: 'v2.1.0', tier_used: 'gold' }),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.engine_version, 'v2.1.0');
  assertEquals(out.tier_used, 'gold');
});

Deno.test('buildAuditJson: engine_version + tier_used null when not provided', () => {
  const out = buildAuditJson({
    round: makeRound(), // defaults are null
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.engine_version, null);
  assertEquals(out.tier_used, null);
});

// ─── Approved entry contract ─────────────────────────────────────────────────

Deno.test('buildAuditJson: approved entry contains slot_id, scores, file_stems', () => {
  const a = makeApproved('g-1', {
    slot_id: 'slot-master-1',
    score: 9.2,
    ai_proposed_score: 9.0,
    file_stems: ['IMG_5620', 'IMG_5621'],
  });
  const out = buildAuditJson({
    round: makeRound(),
    approved: [a],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.approved[0].slot_id, 'slot-master-1');
  assertEquals(out.approved[0].score, 9.2);
  assertEquals(out.approved[0].ai_proposed_score, 9.0);
  assertEquals(out.approved[0].file_stems, ['IMG_5620', 'IMG_5621']);
});

Deno.test('buildAuditJson: approved entry tolerates null slot_id (phase-3 recommendations)', () => {
  const a = makeApproved('g-1', { slot_id: null, score: null, ai_proposed_score: null });
  const out = buildAuditJson({
    round: makeRound(),
    approved: [a],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.approved[0].slot_id, null);
  assertEquals(out.approved[0].score, null);
  assertEquals(out.approved[0].ai_proposed_score, null);
});

// ─── Mode field (Wave 7 P1-19 / W7.13) ───────────────────────────────────────

Deno.test('buildAuditJson: mode defaults to "engine" when not provided (back-compat)', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.mode, 'engine');
});

Deno.test('buildAuditJson: mode="engine" passed through explicitly', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    mode: 'engine',
  });
  assertEquals(out.mode, 'engine');
});

Deno.test('buildAuditJson: mode="manual" passed through explicitly', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [makeApproved('m-1', { slot_id: null, score: null, ai_proposed_score: null })],
    rejected: [],
    overrides: [],
    mode: 'manual',
  });
  assertEquals(out.mode, 'manual');
  // Manual-mode shape per W7.13 spec § "audit JSON path already correct":
  // approved entries have null slot_id + score, no rejected entries, no overrides.
  assertEquals(out.approved[0].slot_id, null);
  assertEquals(out.approved[0].score, null);
  assertEquals(out.approved[0].ai_proposed_score, null);
  assertEquals(out.rejected, []);
  assertEquals(out.overrides, []);
});

Deno.test('buildAuditJson: schema_version stays "1.1" regardless of mode (mode is additive)', () => {
  // mode is an additive optional field within schema 1.1; mode does not bump
  // the schema version (only adding new top-level fields like tier_config does).
  const engine = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    mode: 'engine',
  });
  const manual = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    mode: 'manual',
  });
  assertEquals(engine.schema_version, '1.1');
  assertEquals(manual.schema_version, '1.1');
});

Deno.test('serializeAuditJson: mode field round-trips through JSON', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    mode: 'manual',
  });
  const parsed = JSON.parse(serializeAuditJson(out));
  assertEquals(parsed.mode, 'manual');
});

// ─── Rejected entry contract ─────────────────────────────────────────────────

Deno.test('buildAuditJson: rejected entry preserves reason verbatim', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [
      makeRejected('r-1', { reason: 'near_duplicate' }),
      makeRejected('r-2', { reason: 'human_action=removed' }),
    ],
    overrides: [],
  });
  // Sorted by group_id, so r-1 then r-2.
  assertEquals(out.rejected[0].group_id, 'r-1');
  assertEquals(out.rejected[0].reason, 'near_duplicate');
  assertEquals(out.rejected[1].group_id, 'r-2');
  assertEquals(out.rejected[1].reason, 'human_action=removed');
});

// ─── tier_config block (Wave 8 / W8.4) ──────────────────────────────────────

Deno.test('buildAuditJson: tier_config block omitted when input.tier_config is undefined (back-compat)', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
  });
  // The field is OPTIONAL — when caller doesn't pass it, the rendered JSON
  // does not include the key at all (vs explicitly null).
  assertEquals('tier_config' in out, false);
});

Deno.test('buildAuditJson: tier_config block included when input.tier_config provided', () => {
  const out = buildAuditJson({
    round: makeRound({ engine_version: 'wave-8-v1', tier_used: 'P' }),
    approved: [],
    rejected: [],
    overrides: [],
    tier_config: {
      tier_code: 'P',
      version: 3,
      dimension_weights: { technical: 0.20, lighting: 0.30, composition: 0.25, aesthetic: 0.25 },
      signal_weights: { signal_a: 1.0, signal_b: 0.8 },
      hard_reject_thresholds: { technical: 4.5, lighting: 4.5 },
    },
  });
  assertEquals(out.engine_version, 'wave-8-v1');
  assertEquals(out.tier_used, 'P');
  assertEquals(out.tier_config?.tier_code, 'P');
  assertEquals(out.tier_config?.version, 3);
  assertEquals(out.tier_config?.dimension_weights?.technical, 0.20);
  assertEquals(out.tier_config?.dimension_weights?.lighting, 0.30);
  assertEquals(out.tier_config?.signal_weights?.signal_a, 1.0);
  assertEquals(out.tier_config?.hard_reject_thresholds?.technical, 4.5);
});

Deno.test('buildAuditJson: tier_config block null when input is null (engine round, no active config)', () => {
  // Caller can explicitly pass null to mark "no active tier_config at lock
  // time" — different from omitting the key (back-compat). Useful for
  // analytics that want to distinguish "audit JSON written under W8 schema
  // but no config was active" from "audit JSON pre-W8".
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    tier_config: null,
  });
  assertEquals('tier_config' in out, true);
  assertEquals(out.tier_config, null);
});

Deno.test('buildAuditJson: tier_config block fields all default to null when partial input', () => {
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
    tier_config: {
      tier_code: 'S',
      version: null,
      dimension_weights: null,
      signal_weights: null,
      hard_reject_thresholds: null,
    },
  });
  assertEquals(out.tier_config?.tier_code, 'S');
  assertEquals(out.tier_config?.version, null);
  assertEquals(out.tier_config?.dimension_weights, null);
});

Deno.test('serializeAuditJson: tier_config block round-trips through JSON when present', () => {
  const out = buildAuditJson({
    round: makeRound({ engine_version: 'wave-8-v1', tier_used: 'P' }),
    approved: [],
    rejected: [],
    overrides: [],
    tier_config: {
      tier_code: 'P',
      version: 1,
      dimension_weights: { technical: 0.25, lighting: 0.30, composition: 0.25, aesthetic: 0.20 },
      signal_weights: { signal_a: 1.0 },
      hard_reject_thresholds: null,
    },
  });
  const ser = serializeAuditJson(out);
  const parsed = JSON.parse(ser);
  assertEquals(parsed.tier_config.tier_code, 'P');
  assertEquals(parsed.tier_config.version, 1);
  assertEquals(parsed.tier_config.dimension_weights.lighting, 0.30);
  assertEquals(parsed.tier_config.hard_reject_thresholds, null);
});

Deno.test('buildAuditJson: schema_version is 1.1 even with tier_config absent (additive field)', () => {
  // tier_config is optional within 1.1; older readers parsing 1.1 should
  // tolerate missing tier_config gracefully.
  const out = buildAuditJson({
    round: makeRound(),
    approved: [],
    rejected: [],
    overrides: [],
  });
  assertEquals(out.schema_version, '1.1');
  assertEquals('tier_config' in out, false);
});
