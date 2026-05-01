/**
 * canonicalRegistryBlock.test.ts — Wave 12.A unit tests for the pure
 * renderer split out from the composed `canonicalRegistryBlock` helper.
 *
 * The DB loader (`loadTopCanonicals`) requires a SupabaseClient and is
 * exercised via integration coverage. The pure renderer
 * (`renderCanonicalRegistryBlock`) is what we assert here — given a fixture
 * of mock canonical rows, it must produce a stable, Gemini-friendly text
 * block.
 *
 * Run: deno test supabase/functions/_shared/visionPrompts/blocks/canonicalRegistryBlock.test.ts --no-check --allow-all
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  CANONICAL_REGISTRY_BLOCK_VERSION,
  renderCanonicalRegistryBlock,
  type CanonicalRow,
} from './canonicalRegistryBlock.ts';

// ─── Version stamp guard ────────────────────────────────────────────────────

Deno.test('CANONICAL_REGISTRY_BLOCK_VERSION is v1.1 (W12.A refactor rev)', () => {
  // The version stamp's NAME must remain stable across waves so the
  // shortlisting-shape-d prompt assembly compiles. The VALUE bumped from
  // v1.0 → v1.1 when W12.A split the loader from the renderer (no semantic
  // output change but the API surface changed; bumping invalidates the
  // prompt cache entry just to be safe).
  assertEquals(CANONICAL_REGISTRY_BLOCK_VERSION, 'v1.1');
});

// ─── Fixture ────────────────────────────────────────────────────────────────

const FIXTURE_ROWS: CanonicalRow[] = [
  {
    canonical_id: 'hills_hoist',
    display_name: 'Hills Hoist',
    description: 'rotary clothesline',
    market_frequency: 47,
    signal_room_type: 'exterior_rear',
    signal_confidence: 0.92,
  },
  {
    canonical_id: 'caesarstone',
    display_name: 'Caesarstone',
    description: 'engineered stone benchtop',
    market_frequency: 80,
    signal_room_type: 'kitchen_main',
    signal_confidence: 0.96,
  },
  {
    canonical_id: 'subway_tile_splashback',
    display_name: 'Subway tile splashback',
    description: null,
    market_frequency: 42,
    signal_room_type: 'kitchen_main',
    signal_confidence: 0.87,
  },
  {
    canonical_id: 'terracotta_tile_roof',
    display_name: 'Terracotta tile roof',
    description: null,
    market_frequency: 211,
    signal_room_type: 'exterior',
    signal_confidence: 0.99,
  },
  {
    canonical_id: 'plantation_shutter',
    display_name: 'Plantation shutter',
    description: 'painted timber louvre window cover',
    market_frequency: 33,
    signal_room_type: null,
    signal_confidence: null,
  },
];

// ─── Empty-input guard ──────────────────────────────────────────────────────

Deno.test('empty input renders empty string (registry not yet populated)', () => {
  assertEquals(renderCanonicalRegistryBlock([]), '');
});

// ─── Header shape ───────────────────────────────────────────────────────────

Deno.test('header counts the actual rows passed in', () => {
  const out = renderCanonicalRegistryBlock(FIXTURE_ROWS);
  assertStringIncludes(
    out,
    `CANONICAL FEATURE REGISTRY (top ${FIXTURE_ROWS.length} by frequency, for cross-project consistency):`,
  );
});

// ─── Per-row formatting ─────────────────────────────────────────────────────

Deno.test('row with description + signal renders the (desc): signal, conf, obs shape', () => {
  const out = renderCanonicalRegistryBlock([FIXTURE_ROWS[0]]); // hills_hoist
  assertStringIncludes(
    out,
    '- hills_hoist (rotary clothesline): exterior_rear signal, 92%, 47 obs',
  );
});

Deno.test('row without description still renders signal + obs', () => {
  const out = renderCanonicalRegistryBlock([FIXTURE_ROWS[2]]); // subway_tile_splashback
  assertStringIncludes(
    out,
    '- subway_tile_splashback: kitchen_main signal, 87%, 42 obs',
  );
});

Deno.test('row without signal_room_type renders just canonical + obs', () => {
  const out = renderCanonicalRegistryBlock([FIXTURE_ROWS[4]]); // plantation_shutter
  assertStringIncludes(
    out,
    '- plantation_shutter (painted timber louvre window cover): 33 obs',
  );
});

Deno.test('row with null signal_confidence drops the confidence segment', () => {
  const partial: CanonicalRow = {
    canonical_id: 'mock_object',
    display_name: 'Mock Object',
    description: null,
    market_frequency: 5,
    signal_room_type: 'living',
    signal_confidence: null,
  };
  const out = renderCanonicalRegistryBlock([partial]);
  assertStringIncludes(out, '- mock_object: living signal, 5 obs');
  // No "%" character should appear when confidence is null.
  assert(!out.includes('%'), 'confidence percent must not render when null');
});

// ─── Trailing instruction sentence (canonical_id preference cue) ───────────

Deno.test('renders the trailing canonical_id preference instruction', () => {
  const out = renderCanonicalRegistryBlock(FIXTURE_ROWS);
  assertStringIncludes(out, 'prefer the canonical_id');
  assertStringIncludes(out, 'raw_label is still encouraged');
  assertStringIncludes(out, 'canonical-rollup pass');
});

// ─── Stable structure across calls (deterministic) ────────────────────────

Deno.test('output is deterministic for a fixed input array', () => {
  const a = renderCanonicalRegistryBlock(FIXTURE_ROWS);
  const b = renderCanonicalRegistryBlock(FIXTURE_ROWS);
  assertEquals(a, b);
});

// ─── Ordering preserved from input ────────────────────────────────────────

Deno.test('ordering follows the input array (caller pre-sorts by frequency)', () => {
  const out = renderCanonicalRegistryBlock(FIXTURE_ROWS);
  const idxHills = out.indexOf('hills_hoist');
  const idxCaesar = out.indexOf('caesarstone');
  const idxSubway = out.indexOf('subway_tile_splashback');
  assert(idxHills > 0 && idxCaesar > 0 && idxSubway > 0, 'all canonicals must render');
  assert(idxHills < idxCaesar, 'hills_hoist should appear before caesarstone (input order)');
  assert(idxCaesar < idxSubway, 'caesarstone should appear before subway (input order)');
});
