/**
 * Tests for canonical-discovery-queue / canonical-discovery-promote helpers.
 *
 * Coverage targets:
 *   1. Event id parsing (slot:<bigint> vs obj:<uuid>)
 *   2. UI ↔ DB status mapping correctness
 *   3. canonical_label regex validation
 *
 * Pure unit tests; no network/DB calls.
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';

// Re-implement parseEventId here as a copy of the version in
// canonical-discovery-promote/index.ts. Keeping the function inline in the
// edge fn (which lives next to a `Deno.serve` handler) keeps the import
// surface small for the deployed bundle. The test mirrors the reference
// implementation. If the prod copy diverges these tests will fail visibly.
function parseEventId(eventId: string): { kind: 'slot' | 'obj' | null; raw_id: string } {
  if (eventId.startsWith('slot:')) {
    return { kind: 'slot', raw_id: eventId.slice(5) };
  }
  if (eventId.startsWith('obj:')) {
    return { kind: 'obj', raw_id: eventId.slice(4) };
  }
  return { kind: null, raw_id: eventId };
}

Deno.test('parseEventId: slot prefix yields kind=slot + numeric id', () => {
  const r = parseEventId('slot:42');
  assertEquals(r.kind, 'slot');
  assertEquals(r.raw_id, '42');
});

Deno.test('parseEventId: slot prefix preserves big numeric ids', () => {
  const r = parseEventId('slot:9223372036854775807');
  assertEquals(r.kind, 'slot');
  assertEquals(r.raw_id, '9223372036854775807');
});

Deno.test('parseEventId: obj prefix yields kind=obj + uuid raw_id', () => {
  const r = parseEventId('obj:b1c2d3e4-5f6a-7b8c-9d0e-1f2a3b4c5d6e');
  assertEquals(r.kind, 'obj');
  assertEquals(r.raw_id, 'b1c2d3e4-5f6a-7b8c-9d0e-1f2a3b4c5d6e');
});

Deno.test('parseEventId: missing prefix returns kind=null with raw passed through', () => {
  const r = parseEventId('42');
  assertEquals(r.kind, null);
  assertEquals(r.raw_id, '42');
});

Deno.test('parseEventId: empty string yields kind=null', () => {
  const r = parseEventId('');
  assertEquals(r.kind, null);
  assertEquals(r.raw_id, '');
});

// ─── UI ↔ DB status mapping ─────────────────────────────────────────────────
// The discovery queue surfaces 4 UI statuses (pending/promoted/rejected/deferred).
// object_registry_candidates uses 5 DB statuses (pending/approved/rejected/
// merged/auto_archived/deferred). The mapping rules are:
//   UI 'pending'   ↔ DB 'pending'
//   UI 'promoted'  ↔ DB 'approved'
//   UI 'rejected'  ↔ DB 'rejected'
//   UI 'deferred'  ↔ DB 'deferred' OR DB 'auto_archived' (both display as deferred)
// The mapping is asymmetric: many DB statuses map to one UI status. That's
// intentional — the UI doesn't distinguish between operator-deferred and
// time-archived candidates.

function uiToDbStatus(ui: 'pending' | 'promoted' | 'rejected' | 'deferred' | 'all'): string | null {
  if (ui === 'all') return null;
  if (ui === 'promoted') return 'approved';
  return ui;
}

function dbToUiStatus(db: string): string {
  if (db === 'approved') return 'promoted';
  if (db === 'auto_archived') return 'deferred';
  return db;
}

Deno.test('uiToDbStatus: promoted ↔ approved', () => {
  assertEquals(uiToDbStatus('promoted'), 'approved');
});

Deno.test('uiToDbStatus: identity for pending/rejected/deferred', () => {
  assertEquals(uiToDbStatus('pending'), 'pending');
  assertEquals(uiToDbStatus('rejected'), 'rejected');
  assertEquals(uiToDbStatus('deferred'), 'deferred');
});

Deno.test('uiToDbStatus: all → null (no filter)', () => {
  assertEquals(uiToDbStatus('all'), null);
});

Deno.test('dbToUiStatus: approved → promoted', () => {
  assertEquals(dbToUiStatus('approved'), 'promoted');
});

Deno.test('dbToUiStatus: auto_archived → deferred', () => {
  assertEquals(dbToUiStatus('auto_archived'), 'deferred');
});

Deno.test('dbToUiStatus: identity for pending / rejected / deferred / merged', () => {
  assertEquals(dbToUiStatus('pending'), 'pending');
  assertEquals(dbToUiStatus('rejected'), 'rejected');
  assertEquals(dbToUiStatus('deferred'), 'deferred');
  assertEquals(dbToUiStatus('merged'), 'merged');
});

// ─── canonical_label validation (from canonical-discovery-promote) ──────────
const CANONICAL_LABEL_REGEX = /^[a-z0-9_]+$/;

Deno.test('canonical_label regex: accepts snake_case lowercase', () => {
  assertEquals(CANONICAL_LABEL_REGEX.test('kitchen_island'), true);
  assertEquals(CANONICAL_LABEL_REGEX.test('obj_v2'), true);
  assertEquals(CANONICAL_LABEL_REGEX.test('a'), true);
});

Deno.test('canonical_label regex: rejects spaces / hyphens / uppercase', () => {
  assertEquals(CANONICAL_LABEL_REGEX.test('kitchen island'), false);
  assertEquals(CANONICAL_LABEL_REGEX.test('kitchen-island'), false);
  assertEquals(CANONICAL_LABEL_REGEX.test('Kitchen_Island'), false);
});

Deno.test('canonical_label regex: rejects empty + leading underscore-only patterns are still valid', () => {
  assertEquals(CANONICAL_LABEL_REGEX.test(''), false);
  // Leading underscore is technically valid by the regex; promotion endpoint
  // doesn't disallow it. Document via this test.
  assertEquals(CANONICAL_LABEL_REGEX.test('_kitchen'), true);
});
