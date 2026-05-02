/**
 * Unit tests for shortlisting-extract pure helpers.
 * Run: deno test --no-check --allow-all supabase/functions/shortlisting-extract/index.test.ts
 *
 * F-B-007 (W11.QC-iter2-W4 P1): pin the role-gate contract.
 *
 *   - Before this wave, only master_admin/admin were permitted, despite
 *     pass0/pass3/shape-d/shape-d-stage4 all permitting manager. The fn-level
 *     comment ("manual rerun via UI / curl") implied manager was intended.
 *   - After this wave, manager is permitted alongside master_admin/admin.
 *   - service_role bypasses the gate entirely; no user → 401.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { evaluateExtractRoleGate } from './index.ts';

Deno.test('evaluateExtractRoleGate: service_role bypass', () => {
  const r = evaluateExtractRoleGate(true, null);
  assertEquals(r.allow, true);
});

Deno.test('evaluateExtractRoleGate: no user → 401', () => {
  const r = evaluateExtractRoleGate(false, null);
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 401);
});

Deno.test('evaluateExtractRoleGate: master_admin → allow', () => {
  const r = evaluateExtractRoleGate(false, { role: 'master_admin' });
  assertEquals(r.allow, true);
});

Deno.test('evaluateExtractRoleGate: admin → allow', () => {
  const r = evaluateExtractRoleGate(false, { role: 'admin' });
  assertEquals(r.allow, true);
});

// F-B-007: this is the regression-pin — manager MUST be allowed.
Deno.test('evaluateExtractRoleGate: manager → allow (F-B-007)', () => {
  const r = evaluateExtractRoleGate(false, { role: 'manager' });
  assertEquals(r.allow, true);
});

Deno.test('evaluateExtractRoleGate: employee role → 403', () => {
  const r = evaluateExtractRoleGate(false, { role: 'employee' });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});

Deno.test('evaluateExtractRoleGate: contractor role → 403', () => {
  const r = evaluateExtractRoleGate(false, { role: 'contractor' });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});

Deno.test('evaluateExtractRoleGate: null role → 403', () => {
  const r = evaluateExtractRoleGate(false, { role: null });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});
