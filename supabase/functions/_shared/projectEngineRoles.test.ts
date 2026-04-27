/**
 * Unit tests for projectEngineRoles (Wave 7 P1-6 / W7.7 follow-up).
 * Run: deno test supabase/functions/_shared/projectEngineRoles.test.ts --no-check --allow-all
 *
 * Covers:
 *   - null/empty project → []
 *   - bundled-only path → engine_role union from packages[].products[]
 *   - à la carte-only path → engine_role union from projects.products[]
 *   - mixed path is additive (NOT mutually exclusive)
 *   - inactive products are skipped
 *   - products with null engine_role are skipped (add-ons / fees)
 *   - duplicate engine_roles across paths are deduped
 *   - unknown role strings are dropped (forward-compat — same policy as
 *     slotEligibility.resolvePackageEngineRoles)
 *
 * The shared helper replaces three inline copies that previously lived in
 * shortlisting-pass2, shortlisting-pass3, and shortlisting-benchmark-runner.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveProjectEngineRoles,
  type ProjectForEngineRoles,
} from './projectEngineRoles.ts';
import type { ProductRow } from './slotEligibility.ts';

// ─── Catalog fixtures ────────────────────────────────────────────────────────

const DAY: ProductRow = {
  id: 'p-day',
  engine_role: 'photo_day_shortlist',
  is_active: true,
};
const DUSK: ProductRow = {
  id: 'p-dusk',
  engine_role: 'photo_dusk_shortlist',
  is_active: true,
};
const DRONE: ProductRow = {
  id: 'p-drone',
  engine_role: 'drone_shortlist',
  is_active: true,
};
const FEE_NO_ROLE: ProductRow = {
  id: 'p-fee',
  engine_role: null,
  is_active: true,
};
const INACTIVE_DAY: ProductRow = {
  id: 'p-old-day',
  engine_role: 'photo_day_shortlist',
  is_active: false,
};
const FUTURE_UNKNOWN: ProductRow = {
  id: 'p-future',
  // forward-compat — a role someone added before the enum got updated
  engine_role: 'thermal_imaging_shortlist',
  is_active: true,
};

const CATALOG: ProductRow[] = [DAY, DUSK, DRONE, FEE_NO_ROLE, INACTIVE_DAY, FUTURE_UNKNOWN];

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test('resolveProjectEngineRoles: null/undefined/empty project → []', () => {
  assertEquals(resolveProjectEngineRoles(null, CATALOG), []);
  assertEquals(resolveProjectEngineRoles(undefined, CATALOG), []);
  assertEquals(resolveProjectEngineRoles({} as ProjectForEngineRoles, CATALOG), []);
  assertEquals(
    resolveProjectEngineRoles({ packages: [], products: [] }, CATALOG),
    [],
  );
});

Deno.test('resolveProjectEngineRoles: bundled-only path → role union', () => {
  const project: ProjectForEngineRoles = {
    packages: [
      {
        products: [
          { product_id: 'p-day' },
          { product_id: 'p-dusk' },
        ],
      },
    ],
    products: [],
  };
  const roles = resolveProjectEngineRoles(project, CATALOG).sort();
  assertEquals(roles, ['photo_day_shortlist', 'photo_dusk_shortlist']);
});

Deno.test('resolveProjectEngineRoles: à la carte-only path → role union', () => {
  const project: ProjectForEngineRoles = {
    packages: [],
    products: [
      { product_id: 'p-drone' },
      { product_id: 'p-day' },
    ],
  };
  const roles = resolveProjectEngineRoles(project, CATALOG).sort();
  assertEquals(roles, ['drone_shortlist', 'photo_day_shortlist']);
});

Deno.test('resolveProjectEngineRoles: bundled + à la carte are additive (NOT mutually exclusive)', () => {
  // Joseph 2026-04-27: a project with bundled day photos AND an à la carte
  // drone add-on should resolve to BOTH engine roles, not just one.
  const project: ProjectForEngineRoles = {
    packages: [
      {
        products: [{ product_id: 'p-day' }],
      },
    ],
    products: [
      { product_id: 'p-drone' },
    ],
  };
  const roles = resolveProjectEngineRoles(project, CATALOG).sort();
  assertEquals(roles, ['drone_shortlist', 'photo_day_shortlist']);
});

Deno.test('resolveProjectEngineRoles: dedupes when same role appears in bundled + à la carte', () => {
  // bundled day photos + à la carte day photos (extra hero shots) → still
  // just one entry for photo_day_shortlist.
  const project: ProjectForEngineRoles = {
    packages: [
      { products: [{ product_id: 'p-day' }] },
    ],
    products: [
      { product_id: 'p-day' },
    ],
  };
  assertEquals(
    resolveProjectEngineRoles(project, CATALOG),
    ['photo_day_shortlist'],
  );
});

Deno.test('resolveProjectEngineRoles: skips inactive products', () => {
  // p-old-day is inactive; should be ignored even though referenced.
  const project: ProjectForEngineRoles = {
    packages: [
      {
        products: [
          { product_id: 'p-day' },
          { product_id: 'p-old-day' },
        ],
      },
    ],
    products: [],
  };
  assertEquals(
    resolveProjectEngineRoles(project, CATALOG),
    ['photo_day_shortlist'],
  );
});

Deno.test('resolveProjectEngineRoles: skips products with null engine_role (fees / add-ons)', () => {
  // A "rush fee" or "extra edit" product has no engine_role and shouldn't
  // contribute to the role set.
  const project: ProjectForEngineRoles = {
    packages: [
      {
        products: [
          { product_id: 'p-day' },
          { product_id: 'p-fee' },
        ],
      },
    ],
    products: [
      { product_id: 'p-fee' },
    ],
  };
  assertEquals(
    resolveProjectEngineRoles(project, CATALOG),
    ['photo_day_shortlist'],
  );
});

Deno.test('resolveProjectEngineRoles: drops unknown role strings (forward-compat)', () => {
  // p-future has engine_role='thermal_imaging_shortlist' which isn't in
  // the ENGINE_ROLES enum yet. Same forward-compat policy as Pass 2's
  // canonical helper — drop quietly rather than crash.
  const project: ProjectForEngineRoles = {
    packages: [],
    products: [
      { product_id: 'p-day' },
      { product_id: 'p-future' },
    ],
  };
  assertEquals(
    resolveProjectEngineRoles(project, CATALOG),
    ['photo_day_shortlist'],
  );
});

Deno.test('resolveProjectEngineRoles: malformed entries (missing product_id) are tolerated', () => {
  const project: ProjectForEngineRoles = {
    packages: [
      {
        products: [
          { product_id: 'p-day' },
          // deno-lint-ignore no-explicit-any
          ({} as any),
          // deno-lint-ignore no-explicit-any
          ({ product_id: null } as any),
        ],
      },
    ],
    products: [
      // deno-lint-ignore no-explicit-any
      (null as any),
      { product_id: 'p-dusk' },
    ],
  };
  assertEquals(
    resolveProjectEngineRoles(project, CATALOG).sort(),
    ['photo_day_shortlist', 'photo_dusk_shortlist'],
  );
});
