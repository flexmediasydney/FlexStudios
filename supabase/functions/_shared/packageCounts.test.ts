/**
 * Unit tests for packageCounts (Wave 7 P1-6 / W7.7).
 * Run: deno test supabase/functions/_shared/packageCounts.test.ts --no-check --allow-all
 *
 * Covers:
 *   - flattenProjectProducts: bundled / à la carte / mixed shapes; null-safety
 *   - computeExpectedFileCount: empty input, single product, additive sums,
 *     fallback category match, min floors at 0, the spec's worked example
 *     (Day Video Package + 5 extra Sales Images = 25 photos).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  computeExpectedFileCount,
  flattenProjectProducts,
  type FlatProductEntry,
  type ProductCatalogEntry,
  type ProjectForFlatten,
} from './packageCounts.ts';

// ─── Catalog fixtures ────────────────────────────────────────────────────────

const SALES_IMAGE: ProductCatalogEntry = {
  id: 'p-sales',
  category: 'Images',
  engine_role: 'photo_day_shortlist',
};
const DUSK_IMAGE: ProductCatalogEntry = {
  id: 'p-dusk',
  category: 'Images',
  engine_role: 'photo_dusk_shortlist',
};
const VIDEO: ProductCatalogEntry = {
  id: 'p-video',
  category: 'Video',
  engine_role: 'video_day_shortlist',
};
const FLOORPLAN: ProductCatalogEntry = {
  id: 'p-floorplan',
  category: 'Floorplan',
  engine_role: 'floorplan_qa',
};
const LEGACY_IMAGE_NO_ROLE: ProductCatalogEntry = {
  id: 'p-legacy-img',
  category: 'Images', // category fallback path
  engine_role: null,
};

const CATALOG: ProductCatalogEntry[] = [
  SALES_IMAGE,
  DUSK_IMAGE,
  VIDEO,
  FLOORPLAN,
  LEGACY_IMAGE_NO_ROLE,
];

const PHOTO_ROLES = ['photo_day_shortlist', 'photo_dusk_shortlist'];
const PHOTO_FALLBACK_CATS = ['Images', 'images'];

// ─── flattenProjectProducts ──────────────────────────────────────────────────

Deno.test('flattenProjectProducts: null/undefined project → empty', () => {
  assertEquals(flattenProjectProducts(null), []);
  assertEquals(flattenProjectProducts(undefined), []);
  assertEquals(flattenProjectProducts({} as ProjectForFlatten), []);
});

Deno.test('flattenProjectProducts: bundled-only project flattens packages[].products[]', () => {
  const project: ProjectForFlatten = {
    packages: [
      {
        package_id: 'pkg-gold',
        tier_choice: 'standard',
        products: [
          { product_id: 'p-sales', quantity: 20 },
          { product_id: 'p-floorplan', quantity: 1 },
        ],
      },
    ],
    products: [],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat.length, 2);
  assertEquals(flat[0], { product_id: 'p-sales', quantity: 20, tier_hint: 'standard' });
  assertEquals(flat[1], { product_id: 'p-floorplan', quantity: 1, tier_hint: 'standard' });
});

Deno.test('flattenProjectProducts: à la carte project flattens projects.products[]', () => {
  const project: ProjectForFlatten = {
    packages: [],
    products: [
      { product_id: 'p-sales', quantity: 12, tier_hint: 'standard' },
      { product_id: 'p-dusk', quantity: 3, tier_hint: 'premium' },
    ],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat.length, 2);
  assertEquals(flat[0], { product_id: 'p-sales', quantity: 12, tier_hint: 'standard' });
  assertEquals(flat[1], { product_id: 'p-dusk', quantity: 3, tier_hint: 'premium' });
});

Deno.test('flattenProjectProducts: mixed project unions both arrays (additive per Joseph 2026-04-27)', () => {
  // Spec example: Day Video Package (20 Sales Images bundled) + 5 à la carte
  // Sales Images = 25 photos total. Both arrays unioned, NOT replaced.
  const project: ProjectForFlatten = {
    packages: [
      {
        package_id: 'pkg-day-video',
        tier_choice: 'standard',
        products: [
          { product_id: 'p-sales', quantity: 20 },
          { product_id: 'p-video', quantity: 1 },
        ],
      },
    ],
    products: [
      { product_id: 'p-sales', quantity: 5, tier_hint: 'standard' },
    ],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat.length, 3);
  // Total Sales Images sum: 20 (bundled) + 5 (à la carte) = 25.
  const totalSales = flat
    .filter((e) => e.product_id === 'p-sales')
    .reduce((s, e) => s + e.quantity, 0);
  assertEquals(totalSales, 25);
});

Deno.test('flattenProjectProducts: bundled tier_choice propagated as tier_hint to nested products', () => {
  const project: ProjectForFlatten = {
    packages: [
      {
        package_id: 'pkg-flex',
        tier_choice: 'premium',
        products: [
          { product_id: 'p-sales', quantity: 30 },
        ],
      },
    ],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat[0].tier_hint, 'premium');
});

Deno.test('flattenProjectProducts: drops malformed entries (no product_id, null packages, etc.)', () => {
  const project: ProjectForFlatten = {
    packages: [
      null as unknown as { products: never[] },
      {
        package_id: 'pkg-1',
        tier_choice: null,
        products: [
          { product_id: '', quantity: 5 }, // empty id — drop
          { quantity: 5 } as { product_id: string; quantity: number }, // missing id — drop
          { product_id: 'p-sales', quantity: 10 },
        ],
      },
    ],
    products: [
      { product_id: 'p-dusk', quantity: 2 },
      null as unknown as { product_id: string; quantity: number }, // null entry — drop
    ],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat.length, 2);
  assertEquals(flat[0].product_id, 'p-sales');
  assertEquals(flat[1].product_id, 'p-dusk');
});

Deno.test('flattenProjectProducts: coerces non-numeric quantities to 0', () => {
  const project: ProjectForFlatten = {
    packages: [
      {
        package_id: 'pkg-1',
        tier_choice: 'standard',
        products: [
          { product_id: 'p-sales', quantity: null as unknown as number },
          { product_id: 'p-dusk', quantity: undefined as unknown as number },
          { product_id: 'p-video', quantity: 'not a number' as unknown as number },
          { product_id: 'p-floorplan', quantity: -5 }, // negative coerced to 0
        ],
      },
    ],
  };
  const flat = flattenProjectProducts(project);
  assertEquals(flat.map((e) => e.quantity), [0, 0, 0, 0]);
});

// ─── computeExpectedFileCount ────────────────────────────────────────────────

Deno.test('computeExpectedFileCount: empty product array → target=0, min=0, max=3', () => {
  const result = computeExpectedFileCount([], CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 0);
  assertEquals(result.min, 0);
  assertEquals(result.max, 3);
});

Deno.test('computeExpectedFileCount: single bundled product → exact sum + tolerance', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-sales', quantity: 20, tier_hint: 'standard' },
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 20);
  assertEquals(result.min, 17);
  assertEquals(result.max, 23);
});

Deno.test('computeExpectedFileCount: single à la carte product (no package) → exact sum', () => {
  // À la carte project: only top-level products, packages array empty/absent.
  const project: ProjectForFlatten = {
    packages: [],
    products: [{ product_id: 'p-sales', quantity: 8 }],
  };
  const flat = flattenProjectProducts(project);
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 8);
  assertEquals(result.min, 5);
  assertEquals(result.max, 11);
});

Deno.test('computeExpectedFileCount: mixed project additive (Day Video Package + 5 extra Sales Images = 25) — spec example', () => {
  // Joseph confirmed 2026-04-27: bundled + à la carte products SUMMED, not
  // replaced.
  const project: ProjectForFlatten = {
    packages: [
      {
        package_id: 'pkg-day-video',
        tier_choice: 'standard',
        products: [
          { product_id: 'p-sales', quantity: 20 },   // bundled photos
          { product_id: 'p-video', quantity: 1 },    // bundled video — different role
        ],
      },
    ],
    products: [
      { product_id: 'p-sales', quantity: 5 },        // à la carte addon
    ],
  };
  const flat = flattenProjectProducts(project);
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 25);
  assertEquals(result.min, 22);
  assertEquals(result.max, 28);
});

Deno.test('computeExpectedFileCount: only matching engine roles count (video bundled but not photo)', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-video', quantity: 5, tier_hint: 'standard' },     // video role — skip
    { product_id: 'p-floorplan', quantity: 2, tier_hint: 'standard' }, // floorplan role — skip
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 0);
});

Deno.test('computeExpectedFileCount: legacy product without engine_role uses category fallback', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-legacy-img', quantity: 12, tier_hint: 'standard' },
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  // Legacy product has no engine_role but its category 'Images' is in the
  // fallback list — gets summed.
  assertEquals(result.target, 12);
});

Deno.test('computeExpectedFileCount: legacy fallback only triggers when engine_role is null', () => {
  // If a product HAS engine_role but it's not in forEngineRoles, it should
  // NOT be saved by the category fallback (otherwise we'd double-count
  // floorplans whose role is floorplan_qa but whose category is also in a
  // permissive fallback list).
  const flat: FlatProductEntry[] = [
    { product_id: 'p-floorplan', quantity: 3, tier_hint: 'standard' },
  ];
  const catalog: ProductCatalogEntry[] = [
    { id: 'p-floorplan', category: 'Images', engine_role: 'floorplan_qa' },
  ];
  const result = computeExpectedFileCount(flat, catalog, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  // engine_role exists but doesn't match — skip; fallback only fires when
  // engine_role is null.
  assertEquals(result.target, 0);
});

Deno.test('computeExpectedFileCount: missing product (catalog miss) is silently skipped', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-orphan', quantity: 100, tier_hint: 'standard' },
    { product_id: 'p-sales', quantity: 4, tier_hint: 'standard' },
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 4);
});

Deno.test('computeExpectedFileCount: min floors at 0 (target=1 → min=0)', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-sales', quantity: 1, tier_hint: 'standard' },
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 1);
  assertEquals(result.min, 0); // not -2
  assertEquals(result.max, 4);
});

Deno.test('computeExpectedFileCount: target=0 → min=0, max=3 (graceful manual-mode trigger)', () => {
  const result = computeExpectedFileCount([], CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result, { target: 0, min: 0, max: 3 });
});

Deno.test('computeExpectedFileCount: photo_day + photo_dusk both summed (multi-role engine)', () => {
  const flat: FlatProductEntry[] = [
    { product_id: 'p-sales', quantity: 20, tier_hint: 'standard' }, // photo_day
    { product_id: 'p-dusk', quantity: 8, tier_hint: 'standard' },   // photo_dusk
  ];
  const result = computeExpectedFileCount(flat, CATALOG, PHOTO_ROLES, PHOTO_FALLBACK_CATS);
  assertEquals(result.target, 28);
});
