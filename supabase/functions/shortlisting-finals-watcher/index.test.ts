/**
 * Unit tests for shortlisting-finals-watcher pure helpers.
 * Run: deno test --no-check --allow-all supabase/functions/shortlisting-finals-watcher/index.test.ts
 *
 * F-B-006 (W11.QC-iter2-W4 P1): pin the role-gate contract.
 *
 *   - service_role: always allowed, no user required
 *   - missing user: 401 Authentication required
 *   - non-admin/non-manager role: 403 Forbidden
 *   - master_admin / admin / manager: allowed
 *
 * The cross-project-access guard (callerHasProjectAccess) is exercised in
 * the shared supabase.ts test suite and pass0 integration tests; here we
 * only pin the role-gate decision since that's what F-B-006 changed in
 * combination with the inline access check.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { evaluateFinalsWatcherRoleGate } from './index.ts';

Deno.test('evaluateFinalsWatcherRoleGate: service_role bypass — no user required', () => {
  const r = evaluateFinalsWatcherRoleGate(true, null);
  assertEquals(r.allow, true);
});

Deno.test('evaluateFinalsWatcherRoleGate: no user → 401', () => {
  const r = evaluateFinalsWatcherRoleGate(false, null);
  assert(r.allow === false);
  if (r.allow === false) {
    assertEquals(r.status, 401);
    assertEquals(r.reason, 'Authentication required');
  }
});

Deno.test('evaluateFinalsWatcherRoleGate: employee role → 403', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: 'employee' });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});

Deno.test('evaluateFinalsWatcherRoleGate: contractor role → 403', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: 'contractor' });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});

Deno.test('evaluateFinalsWatcherRoleGate: undefined role → 403', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: null });
  assert(r.allow === false);
  if (r.allow === false) assertEquals(r.status, 403);
});

Deno.test('evaluateFinalsWatcherRoleGate: master_admin → allow', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: 'master_admin' });
  assertEquals(r.allow, true);
});

Deno.test('evaluateFinalsWatcherRoleGate: admin → allow', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: 'admin' });
  assertEquals(r.allow, true);
});

Deno.test('evaluateFinalsWatcherRoleGate: manager → allow', () => {
  const r = evaluateFinalsWatcherRoleGate(false, { role: 'manager' });
  assertEquals(r.allow, true);
});
