/**
 * Tests for calibration-run-ai-batch — Wave 14 (W14).
 *
 * Coverage targets the pure helpers (DB-touching path is exercised by the
 * frontend integration tests in SettingsCalibrationSessions.test.jsx + the
 * benchmark-runner's own integration suite). Pure tests here:
 *
 *   1. validateSessionRounds: all projects locked + confirmed → ok + round_ids
 *   2. validateSessionRounds: project missing locked round → missing_lock
 *   3. validateSessionRounds: round lacks confirmed_shortlist_group_ids →
 *      missing_confirmed
 *   4. validateSessionRounds: most-recent locked round picked per project
 *   5. formatMissingLockError: helpful message for editor / admin
 *   6. formatMissingConfirmedError: helpful message references round id
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';

import {
  formatMissingConfirmedError,
  formatMissingLockError,
  validateSessionRounds,
  type RoundRow,
} from './index.ts';

// ─── 1. ok path ──────────────────────────────────────────────────────────────

Deno.test('validateSessionRounds: all locked + confirmed → ok with round_ids', () => {
  const rounds: RoundRow[] = [
    {
      id: 'r1',
      project_id: 'p1',
      status: 'locked',
      confirmed_shortlist_group_ids: ['g1', 'g2'],
      locked_at: '2026-04-29T10:00:00Z',
    },
    {
      id: 'r2',
      project_id: 'p2',
      status: 'locked',
      confirmed_shortlist_group_ids: ['g3'],
      locked_at: '2026-04-30T10:00:00Z',
    },
  ];
  const result = validateSessionRounds(['p1', 'p2'], rounds);
  assertEquals(result.kind, 'ok');
  assert(result.kind === 'ok');
  assertEquals(result.round_ids.sort(), ['r1', 'r2']);
});

// ─── 2. missing lock ─────────────────────────────────────────────────────────

Deno.test('validateSessionRounds: missing locked round → missing_lock', () => {
  const rounds: RoundRow[] = [
    {
      id: 'r1',
      project_id: 'p1',
      status: 'locked',
      confirmed_shortlist_group_ids: ['g1'],
      locked_at: '2026-04-29T10:00:00Z',
    },
    // p2 has no locked round.
  ];
  const result = validateSessionRounds(['p1', 'p2', 'p3'], rounds);
  assertEquals(result.kind, 'missing_lock');
  assert(result.kind === 'missing_lock');
  assertEquals(result.project_ids.sort(), ['p2', 'p3']);
});

// ─── 3. missing confirmed_shortlist_group_ids ────────────────────────────────

Deno.test('validateSessionRounds: round lacks confirmed → missing_confirmed', () => {
  const rounds: RoundRow[] = [
    {
      id: 'r1',
      project_id: 'p1',
      status: 'locked',
      confirmed_shortlist_group_ids: ['g1'],
      locked_at: '2026-04-29T10:00:00Z',
    },
    {
      id: 'r2',
      project_id: 'p2',
      status: 'locked',
      confirmed_shortlist_group_ids: [],
      locked_at: '2026-04-30T10:00:00Z',
    },
    {
      id: 'r3',
      project_id: 'p3',
      status: 'locked',
      confirmed_shortlist_group_ids: null,
      locked_at: '2026-04-30T10:00:00Z',
    },
  ];
  const result = validateSessionRounds(['p1', 'p2', 'p3'], rounds);
  assertEquals(result.kind, 'missing_confirmed');
  assert(result.kind === 'missing_confirmed');
  assertEquals(result.round_ids.sort(), ['r2', 'r3']);
});

// ─── 4. most-recent locked round picked per project ─────────────────────────

Deno.test('validateSessionRounds: most-recent locked round wins per project', () => {
  // Caller pre-sorts rounds DESC by locked_at; helper picks the first one
  // it sees per project_id.
  const rounds: RoundRow[] = [
    {
      id: 'r2_new',
      project_id: 'p1',
      status: 'locked',
      confirmed_shortlist_group_ids: ['gA'],
      locked_at: '2026-04-30T10:00:00Z',
    },
    {
      id: 'r2_old',
      project_id: 'p1',
      status: 'locked',
      confirmed_shortlist_group_ids: ['gB'],
      locked_at: '2026-04-29T10:00:00Z',
    },
  ];
  const result = validateSessionRounds(['p1'], rounds);
  assertEquals(result.kind, 'ok');
  assert(result.kind === 'ok');
  assertEquals(result.round_ids, ['r2_new']);
});

// ─── 5 + 6. formatters ───────────────────────────────────────────────────────

Deno.test('formatMissingLockError: includes lock-manually-then-retry hint', () => {
  const msg = formatMissingLockError(['p1', 'p2']);
  assertStringIncludes(msg, 'lock manually then retry');
  assertStringIncludes(msg, 'p1');
  assertStringIncludes(msg, 'p2');
});

Deno.test('formatMissingLockError: truncates after 5 ids', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const msg = formatMissingLockError(ids);
  assertStringIncludes(msg, '+2 more');
  assert(!msg.includes('p7'));
});

Deno.test('formatMissingConfirmedError: references round id, not project', () => {
  const msg = formatMissingConfirmedError(['r9']);
  assertStringIncludes(msg, 'r9');
  assertStringIncludes(msg, 'lock manually then retry');
});
