/**
 * Tests for shortlisting-extract redactSecrets() — the secret-scrubber
 * introduced by QC-iter2 W8 F-B-016.
 *
 * Background:
 *   shortlisting-extract POSTs to Modal photos-extract with
 *     - dropbox_access_token (4-hour Dropbox bearer, minted from refresh token)
 *     - _token (Supabase service-role JWT)
 *   The Modal response sometimes echoes our request envelope back, and the
 *   per-file `signed_url` field in the response is itself a Dropbox temp URL.
 *
 *   Without redaction those values land verbatim in shortlisting_jobs.result
 *   (a JSONB column readable by manager+). A single role compromise then
 *   exposes credentials. Defence in depth: don't persist them at all.
 *
 *   redactSecrets() walks the object tree, replacing values at known-secret
 *   keys with the literal string "[REDACTED]". Pass 0 only reads
 *   modal_response.files[*].{ok,exif,...} — none of which are secret-keyed —
 *   so the redaction is transparent for downstream consumers.
 *
 * Run:
 *   deno test --no-check --allow-all supabase/functions/shortlisting-extract/redactSecrets.test.ts
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { redactSecrets } from './index.ts';

Deno.test('redactSecrets: dropbox_access_token at top level is masked', () => {
  const input = { project_id: 'p1', dropbox_access_token: 'sl.xxxxxxxxxx' };
  const out = redactSecrets(input);
  assertEquals(out.project_id, 'p1');
  assertEquals(out.dropbox_access_token, '[REDACTED]');
});

Deno.test('redactSecrets: _token is masked (Supabase service-role JWT)', () => {
  const input = { _token: 'eyJhbGciOiJIUzI1NiI...' };
  const out = redactSecrets(input);
  assertEquals(out._token, '[REDACTED]');
});

Deno.test('redactSecrets: signed_url anywhere in the tree is masked', () => {
  const input = {
    files: {
      'photo1.jpg': {
        ok: true,
        signed_url: 'https://dl.dropboxusercontent.com/abc?token=xyz',
        width: 4032,
      },
      'photo2.jpg': {
        ok: false,
        error: 'not found',
      },
    },
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.files['photo1.jpg'].signed_url, '[REDACTED]');
  assertEquals(out.files['photo1.jpg'].width, 4032);  // benign field preserved
  assertEquals(out.files['photo1.jpg'].ok, true);
  assertEquals(out.files['photo2.jpg'].error, 'not found');
});

Deno.test('redactSecrets: Authorization header at any depth is masked', () => {
  const input = {
    request: {
      headers: {
        Authorization: 'Bearer eyJabc...',
        'Content-Type': 'application/json',
      },
    },
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.request.headers.Authorization, '[REDACTED]');
  assertEquals(out.request.headers['Content-Type'], 'application/json');
});

Deno.test('redactSecrets: api_key, refresh_token, service_role_key all masked', () => {
  const input = {
    api_key: 'sk_live_xxx',
    refresh_token: 'rt_xxx',
    service_role_key: 'srk_xxx',
    bearer: 'tok',
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.api_key, '[REDACTED]');
  assertEquals(out.refresh_token, '[REDACTED]');
  assertEquals(out.service_role_key, '[REDACTED]');
  assertEquals(out.bearer, '[REDACTED]');
});

Deno.test('redactSecrets: case-insensitive key match (DROPBOX_ACCESS_TOKEN, SignedUrl)', () => {
  const input = {
    DROPBOX_ACCESS_TOKEN: 'leaked',
    SignedUrl: 'https://dl.dropboxusercontent.com/...',
    AUTHORIZATION: 'Bearer xxx',
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.DROPBOX_ACCESS_TOKEN, '[REDACTED]');
  assertEquals(out.SignedUrl, '[REDACTED]');
  assertEquals(out.AUTHORIZATION, '[REDACTED]');
});

Deno.test('redactSecrets: arrays are walked', () => {
  const input = {
    requests: [
      { id: 1, dropbox_access_token: 't1' },
      { id: 2, dropbox_access_token: 't2' },
    ],
  };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.requests[0].id, 1);
  assertEquals(out.requests[0].dropbox_access_token, '[REDACTED]');
  assertEquals(out.requests[1].id, 2);
  assertEquals(out.requests[1].dropbox_access_token, '[REDACTED]');
});

Deno.test('redactSecrets: full Modal response shape — secrets stripped, file metadata preserved', () => {
  // Realistic shape of what Modal photos-extract returns.
  const modalResponse = {
    ok: true,
    files: {
      'IMG_0001.jpg': {
        ok: true,
        width: 4032,
        height: 3024,
        signed_url: 'https://dl.dropboxusercontent.com/scl/fi/abc/IMG_0001.jpg?token=secrettoken',
        exif: { iso: 100, fnumber: 2.8, focal_length: 50 },
      },
    },
    request_metadata: {
      _token: 'eyJabc',
      dropbox_access_token: 'sl.xyz',
      project_id: 'proj-123',
    },
  };
  const out = redactSecrets(modalResponse);
  // Secrets gone:
  assertEquals(out.files['IMG_0001.jpg'].signed_url, '[REDACTED]');
  assertEquals(out.request_metadata._token, '[REDACTED]');
  assertEquals(out.request_metadata.dropbox_access_token, '[REDACTED]');
  // Benign fields preserved:
  assertEquals(out.ok, true);
  assertEquals(out.files['IMG_0001.jpg'].ok, true);
  assertEquals(out.files['IMG_0001.jpg'].width, 4032);
  assertEquals(out.files['IMG_0001.jpg'].exif.iso, 100);
  assertEquals(out.request_metadata.project_id, 'proj-123');
});

Deno.test('redactSecrets: null/undefined/primitive inputs pass through', () => {
  assertEquals(redactSecrets(null), null);
  assertEquals(redactSecrets(undefined), undefined);
  assertEquals(redactSecrets(42), 42);
  assertEquals(redactSecrets('hello'), 'hello');
  assertEquals(redactSecrets(true), true);
});

Deno.test('redactSecrets: non-secret keys with secret-looking values are NOT masked (key-based, not value-based)', () => {
  // We don't try to detect "looks like a JWT" heuristics — too many false
  // positives, and a misnamed secret slips through. Key-based redaction is
  // deterministic and easy to extend.
  const input = { property_address: '1 Test St, Sydney NSW' };
  const out = redactSecrets(input) as typeof input;
  assertEquals(out.property_address, '1 Test St, Sydney NSW');
});

Deno.test('redactSecrets: input is not mutated', () => {
  const input = { dropbox_access_token: 'sl.xxx' };
  const out = redactSecrets(input);
  // Original still has the secret (we returned a clone).
  assertEquals(input.dropbox_access_token, 'sl.xxx');
  // Output is masked.
  assertNotEquals(out.dropbox_access_token, input.dropbox_access_token);
  assertEquals(out.dropbox_access_token, '[REDACTED]');
  // Different reference.
  assert(out !== input);
});
