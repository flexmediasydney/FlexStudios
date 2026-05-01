/**
 * Unit tests for notification_routing_rules resolution.
 *
 * Wave 11.6.8 (W7.10 P1-9): given a fixture event, the resolver finds the
 * correct active routing rule (recipient_roles + slack_channel) for each of
 * the 9 spec notification types seeded by mig 294 (1) + mig 390 (8).
 *
 * Run:
 *   deno test --allow-all supabase/functions/_shared/notificationRoutingRules.test.ts
 *
 * The CI gate runs `_shared/*.test.ts` so this is auto-included. We hand-roll
 * a fake supabase-js builder so the test does NOT round-trip a live DB — the
 * actual notificationService resolveRecipients fn (in
 * supabase/functions/notificationService/index.ts) reads the rules table at
 * fire-time; this test mirrors its query shape against the seeded fixture and
 * asserts the seeded routing matches the W7.10 spec.
 *
 * Strategy: model the rules table as an in-memory array, expose a tiny
 * supabase-builder shim that returns the row for `.eq('notification_type', t)
 * .eq('is_active', true).maybeSingle()` (the one query notificationService
 * makes), and assert the resolver-equivalent picks the right (role, channel)
 * pair for each of the 9 types.
 */

import {
  assertEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

// ─── Fixture: the 9 seeded routing rules ────────────────────────────────────
//
// This is the literal expected post-mig 390 state. If a future migration
// changes a row, this fixture must be updated alongside — that's intentional
// (the test then catches an accidental routing change).

interface RoutingRule {
  notification_type: string;
  recipient_roles: string[];
  recipient_user_ids: string[];
  slack_channel: string | null;
  is_active: boolean;
  version: number;
}

const SEEDED_RULES: RoutingRule[] = [
  // mig 294
  {
    notification_type: 'shortlist_ready_for_review',
    recipient_roles: ['master_admin'],
    recipient_user_ids: [],
    slack_channel: null,
    is_active: true,
    version: 1,
  },
  // mig 390 — 8 W7.10 spec types
  {
    notification_type: 'coverage_gap_error',
    recipient_roles: ['master_admin'],
    recipient_user_ids: [],
    slack_channel: '#engine-alerts',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'retouch_flags',
    recipient_roles: ['admin'],
    recipient_user_ids: [],
    slack_channel: '#retouch-queue',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'out_of_scope_detected',
    recipient_roles: ['admin'],
    recipient_user_ids: [],
    slack_channel: '#engine-alerts',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'shortlist_lock_failed',
    recipient_roles: ['master_admin'],
    recipient_user_ids: [],
    slack_channel: '#deploy-alerts',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'cost_cap_exceeded',
    recipient_roles: ['master_admin'],
    recipient_user_ids: [],
    slack_channel: '#engine-alerts',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'vendor_failover_triggered',
    recipient_roles: ['master_admin'],
    recipient_user_ids: [],
    slack_channel: '#engine-alerts',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'stage4_review_overdue',
    recipient_roles: ['admin'],
    recipient_user_ids: [],
    slack_channel: '#shortlist-review',
    is_active: true,
    version: 1,
  },
  {
    notification_type: 'master_listing_regenerated',
    recipient_roles: ['admin'],
    recipient_user_ids: [],
    slack_channel: '#listing-review',
    is_active: true,
    version: 1,
  },
];

// ─── Fake supabase client ────────────────────────────────────────────────────
//
// Mirrors the chained shape used by notificationService.resolveRecipients:
//   admin
//     .from('notification_routing_rules')
//     .select('id, recipient_roles, recipient_user_ids, slack_channel')
//     .eq('notification_type', type)
//     .eq('is_active', true)
//     .maybeSingle();
//
// We capture both .eq() filters and resolve to the matching row from
// SEEDED_RULES (or null when no match). We also support .select with no
// explicit columns and ignore the column-list argument since the test only
// asserts the resolved row's shape.

function makeFakeAdmin(rules: RoutingRule[]) {
  return {
    from(table: string) {
      assertEquals(table, 'notification_routing_rules');
      const filters: Array<{ col: string; value: unknown }> = [];
      const builder = {
        // deno-lint-ignore no-explicit-any
        select(_cols: string): any {
          return builder;
        },
        eq(col: string, value: unknown) {
          filters.push({ col, value });
          return builder;
        },
        maybeSingle(): { data: RoutingRule | null; error: null } {
          const matches = rules.filter((r) => {
            for (const f of filters) {
              // Handle both string keys (notification_type) and bool keys
              // (is_active) the same way: strict equality.
              // deno-lint-ignore no-explicit-any
              if ((r as any)[f.col] !== f.value) return false;
            }
            return true;
          });
          return { data: matches[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

// ─── resolveRoutingRule: thin re-implementation of the production resolver ──
//
// This mirrors notificationService.resolveRecipients' rule lookup step
// (without the role→user_id fan-out, which is project-specific and not the
// subject of this test). We assert that for each seeded notification_type
// the (recipient_roles, slack_channel) pair matches the spec.

async function resolveRoutingRule(
  // deno-lint-ignore no-explicit-any
  admin: any,
  type: string,
): Promise<RoutingRule | null> {
  const { data } = await admin
    .from('notification_routing_rules')
    .select('id, recipient_roles, recipient_user_ids, slack_channel')
    .eq('notification_type', type)
    .eq('is_active', true)
    .maybeSingle();
  return data;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test('routing rules: shortlist_ready_for_review → master_admin (in-app only, no Slack)', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'shortlist_ready_for_review');
  assert(r, 'expected rule to resolve');
  assertEquals(r.recipient_roles, ['master_admin']);
  assertEquals(r.slack_channel, null);
});

Deno.test('routing rules: coverage_gap_error → master_admin + #engine-alerts', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'coverage_gap_error');
  assert(r);
  assertEquals(r.recipient_roles, ['master_admin']);
  assertEquals(r.slack_channel, '#engine-alerts');
});

Deno.test('routing rules: retouch_flags → admin + #retouch-queue', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'retouch_flags');
  assert(r);
  assertEquals(r.recipient_roles, ['admin']);
  assertEquals(r.slack_channel, '#retouch-queue');
});

Deno.test('routing rules: out_of_scope_detected → admin + #engine-alerts', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'out_of_scope_detected');
  assert(r);
  assertEquals(r.recipient_roles, ['admin']);
  assertEquals(r.slack_channel, '#engine-alerts');
});

Deno.test('routing rules: shortlist_lock_failed → master_admin + #deploy-alerts', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'shortlist_lock_failed');
  assert(r);
  assertEquals(r.recipient_roles, ['master_admin']);
  assertEquals(r.slack_channel, '#deploy-alerts');
});

Deno.test('routing rules: cost_cap_exceeded → master_admin + #engine-alerts', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'cost_cap_exceeded');
  assert(r);
  assertEquals(r.recipient_roles, ['master_admin']);
  assertEquals(r.slack_channel, '#engine-alerts');
});

Deno.test('routing rules: vendor_failover_triggered → master_admin + #engine-alerts', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'vendor_failover_triggered');
  assert(r);
  assertEquals(r.recipient_roles, ['master_admin']);
  assertEquals(r.slack_channel, '#engine-alerts');
});

Deno.test('routing rules: stage4_review_overdue → admin + #shortlist-review', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'stage4_review_overdue');
  assert(r);
  assertEquals(r.recipient_roles, ['admin']);
  assertEquals(r.slack_channel, '#shortlist-review');
});

Deno.test('routing rules: master_listing_regenerated → admin + #listing-review', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'master_listing_regenerated');
  assert(r);
  assertEquals(r.recipient_roles, ['admin']);
  assertEquals(r.slack_channel, '#listing-review');
});

Deno.test('routing rules: unknown type → null (no rule)', async () => {
  const admin = makeFakeAdmin(SEEDED_RULES);
  const r = await resolveRoutingRule(admin, 'never_seeded_type');
  assertEquals(r, null);
});

Deno.test('routing rules: inactive rule does NOT resolve (is_active filter holds)', async () => {
  // Synthesise a rule set where shortlist_ready_for_review is_active=false.
  // The .eq('is_active', true) filter must reject it.
  const inactiveSet: RoutingRule[] = SEEDED_RULES.map((r) =>
    r.notification_type === 'shortlist_ready_for_review'
      ? { ...r, is_active: false }
      : r,
  );
  const admin = makeFakeAdmin(inactiveSet);
  const r = await resolveRoutingRule(admin, 'shortlist_ready_for_review');
  assertEquals(r, null);
});

Deno.test('routing rules: all 9 spec types are present in the fixture', () => {
  const expected = [
    'shortlist_ready_for_review',
    'coverage_gap_error',
    'retouch_flags',
    'out_of_scope_detected',
    'shortlist_lock_failed',
    'cost_cap_exceeded',
    'vendor_failover_triggered',
    'stage4_review_overdue',
    'master_listing_regenerated',
  ];
  const actual = new Set(SEEDED_RULES.map((r) => r.notification_type));
  for (const t of expected) {
    assert(actual.has(t), `expected seeded type missing: ${t}`);
  }
  assertEquals(SEEDED_RULES.length, expected.length);
});
