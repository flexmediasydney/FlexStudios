/**
 * Unit tests for the dispatcher JWT structural validator.
 *
 * The validator (`validateDispatcherJwt`) lives in
 * `_shared/dispatcherJwtValidator.ts` and is consumed by
 * `shortlisting-job-dispatcher/index.ts`. Wave 7 P0-2 added it so the
 * function's `_health_check` endpoint can fail-loud with HTTP 503 when
 * the `SHORTLISTING_DISPATCHER_JWT` secret is missing or wrong-shaped.
 *
 * We test the function in isolation here so the safer-than-unsetting-prod
 * path is covered. Run: deno test supabase/functions/_shared/dispatcherJwtValidator.test.ts
 *
 * The CI gate runs `_shared/*.test.ts`, so this is auto-included.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateDispatcherJwt } from './dispatcherJwtValidator.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function base64url(s: string): string {
  // btoa works on binary strings; encode then strip padding and URL-safe-ify.
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(header: object, payload: object, signature = 'sig'): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.${signature}`;
}

// ─── empty / wrong type ──────────────────────────────────────────────────────

Deno.test('validateDispatcherJwt: empty string → not ok', () => {
  const r = validateDispatcherJwt('');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('empty'), true);
});

Deno.test('validateDispatcherJwt: whitespace string → fails part-count', () => {
  // A bare-whitespace string still has length>0 so the empty branch doesn't
  // match — it falls through to the part-count check. Either way it's ok=false,
  // which is the contract the health-check relies on.
  const r = validateDispatcherJwt('   ');
  assertEquals(r.ok, false);
});

// ─── wrong shape ─────────────────────────────────────────────────────────────

Deno.test('validateDispatcherJwt: zero dots → not ok', () => {
  const r = validateDispatcherJwt('not-a-jwt');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('3 dot-separated parts'), true);
});

Deno.test('validateDispatcherJwt: one dot → not ok', () => {
  const r = validateDispatcherJwt('header.payload');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('3 dot-separated parts'), true);
});

Deno.test('validateDispatcherJwt: four dots → not ok', () => {
  const r = validateDispatcherJwt('a.b.c.d');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('3 dot-separated parts'), true);
});

// ─── sb_secret_* style env values are NOT JWTs (the original Round 2 bug) ────

Deno.test('validateDispatcherJwt: sb_secret_* env value is not a JWT', () => {
  // This is the exact failure mode of the dispatcher in production: someone
  // set the secret to the `sb_secret_xxx` env value instead of the
  // service-role JWT. The validator must reject it.
  const r = validateDispatcherJwt(
    'sb_secret_abc123_some_random_garbage_with_underscores',
  );
  assertEquals(r.ok, false);
});

// ─── malformed payload ───────────────────────────────────────────────────────

Deno.test('validateDispatcherJwt: payload not base64 → not ok', () => {
  // Header + signature look fine but middle segment isn't valid base64.
  const r = validateDispatcherJwt('aaa.@@@!!!.sig');
  assertEquals(r.ok, false);
});

Deno.test('validateDispatcherJwt: payload base64 but not JSON → not ok', () => {
  const notJson = base64url('this is not json');
  const r = validateDispatcherJwt(`aaa.${notJson}.sig`);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('payload is not JSON'), true);
});

Deno.test('validateDispatcherJwt: payload JSON but not an object → not ok', () => {
  // Encodes the JSON literal `null`. parts.length is fine, JSON.parse
  // succeeds, but the payload-is-object guard rejects.
  const nullJson = base64url('null');
  const r = validateDispatcherJwt(`aaa.${nullJson}.sig`);
  assertEquals(r.ok, false);
});

// ─── role checks ─────────────────────────────────────────────────────────────

Deno.test('validateDispatcherJwt: role=anon → rejected', () => {
  const tok = makeJwt({ alg: 'HS256', typ: 'JWT' }, { role: 'anon', iss: 'supabase' });
  const r = validateDispatcherJwt(tok);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('anon'), true);
});

Deno.test('validateDispatcherJwt: role=authenticated → rejected', () => {
  const tok = makeJwt(
    { alg: 'HS256', typ: 'JWT' },
    { role: 'authenticated', sub: 'abc' },
  );
  const r = validateDispatcherJwt(tok);
  assertEquals(r.ok, false);
});

Deno.test('validateDispatcherJwt: role missing → rejected', () => {
  const tok = makeJwt({ alg: 'HS256', typ: 'JWT' }, { iss: 'supabase' });
  const r = validateDispatcherJwt(tok);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes('<missing>'), true);
});

// ─── happy path ──────────────────────────────────────────────────────────────

Deno.test('validateDispatcherJwt: real-shape service_role JWT → ok', () => {
  const tok = makeJwt(
    { alg: 'HS256', typ: 'JWT' },
    {
      iss: 'supabase',
      ref: 'rjzdznwkxnzfekgcdkei',
      role: 'service_role',
      iat: 1700000000,
      exp: 1900000000,
    },
  );
  const r = validateDispatcherJwt(tok);
  assertEquals(r.ok, true);
});

Deno.test('validateDispatcherJwt: padded base64 (length not multiple of 4) → ok', () => {
  // Some encoders strip = padding from the URL-safe form. The validator must
  // re-pad before atob() or the decode fails. Construct a payload whose
  // base64 representation is not a multiple of 4 in length BEFORE padding.
  const payload = JSON.stringify({ role: 'service_role', x: 'a' });
  const b64 = base64url(payload); // padding stripped
  // Sanity: this string should not end with `=`.
  assertEquals(b64.endsWith('='), false);
  const tok = `aaa.${b64}.sig`;
  const r = validateDispatcherJwt(tok);
  assertEquals(r.ok, true);
});
