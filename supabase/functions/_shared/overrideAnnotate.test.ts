/**
 * Unit tests for the Wave 10.3 P1-16 annotate-action validation helper.
 * Run: deno test --no-check --allow-all supabase/functions/_shared/overrideAnnotate.test.ts
 *
 * Spec: docs/design-specs/W10-3-override-metadata-columns.md §3.
 * The full E2E (HTTP roundtrip + DB update) is out of scope for this unit
 * suite — the index.ts wires the helper into a SupabaseClient call. These
 * tests cover the input contract: what shapes the helper accepts, what it
 * rejects, and the trim/normalise rules.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { validateAnnotate } from './overrideAnnotate.ts';

Deno.test('validateAnnotate: accepts UUID + signal string', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: 'window_blowout_area',
  });
  assert(result.ok);
  assertEquals(result.override_id, '11111111-2222-3333-4444-555555555555');
  assertEquals(result.primary_signal_overridden, 'window_blowout_area');
});

Deno.test('validateAnnotate: accepts null signal (dismissed modal)', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: null,
  });
  assert(result.ok);
  assertEquals(result.primary_signal_overridden, null);
});

Deno.test('validateAnnotate: missing primary_signal_overridden coerces to null', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
  });
  assert(result.ok);
  assertEquals(result.primary_signal_overridden, null);
});

Deno.test('validateAnnotate: trims whitespace from signal', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: '  composition_type_match  ',
  });
  assert(result.ok);
  assertEquals(result.primary_signal_overridden, 'composition_type_match');
});

Deno.test('validateAnnotate: empty-after-trim signal collapses to null', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: '   ',
  });
  assert(result.ok);
  // Semantically equivalent to "no signal" — saves NULL-vs-"" ambiguity in
  // downstream analytics SQL.
  assertEquals(result.primary_signal_overridden, null);
});

Deno.test('validateAnnotate: free-text "other" is preserved verbatim (post-trim)', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: 'editor preferred kitchen-island angle',
  });
  assert(result.ok);
  assertEquals(
    result.primary_signal_overridden,
    'editor preferred kitchen-island angle',
  );
});

Deno.test('validateAnnotate: rejects non-object body', () => {
  const result = validateAnnotate(null);
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_NOT_OBJECT');
});

Deno.test('validateAnnotate: rejects array body', () => {
  // Arrays are typeof 'object' in JS — guard explicitly is not strictly
  // required for security (the override_id check catches it) but we rely on
  // the override_id guard. Confirm the failure mode is well-defined.
  const result = validateAnnotate([]);
  assert(!result.ok);
  // Arrays don't have an override_id property, so we get the next-best error.
  assertEquals(result.error_code, 'ANNOTATE_OVERRIDE_ID_REQUIRED');
});

Deno.test('validateAnnotate: rejects missing override_id', () => {
  const result = validateAnnotate({
    primary_signal_overridden: 'some_signal',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_OVERRIDE_ID_REQUIRED');
});

Deno.test('validateAnnotate: rejects empty-string override_id', () => {
  const result = validateAnnotate({
    override_id: '',
    primary_signal_overridden: 'some_signal',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_OVERRIDE_ID_REQUIRED');
});

Deno.test('validateAnnotate: rejects non-string override_id', () => {
  const result = validateAnnotate({
    override_id: 12345,
    primary_signal_overridden: 'x',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_OVERRIDE_ID_REQUIRED');
});

Deno.test('validateAnnotate: rejects non-string non-null signal', () => {
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: 42,
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_SIGNAL_TYPE_INVALID');
});

Deno.test('validateAnnotate: rejects signal over 200 chars', () => {
  const longSignal = 'x'.repeat(201);
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: longSignal,
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'ANNOTATE_SIGNAL_TOO_LONG');
});

Deno.test('validateAnnotate: accepts signal at exactly 200 chars', () => {
  const signal = 'x'.repeat(200);
  const result = validateAnnotate({
    override_id: '11111111-2222-3333-4444-555555555555',
    primary_signal_overridden: signal,
  });
  assert(result.ok);
  assertEquals(result.primary_signal_overridden, signal);
});
