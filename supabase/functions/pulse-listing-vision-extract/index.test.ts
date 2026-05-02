/**
 * Tests for pulse-listing-vision-extract pure helpers + the response schema.
 *
 * Mirrors the pulse-description-extractor test pattern:
 *   - assertEquals / assertStringIncludes from std/assert
 *   - One Deno.test per assertion cluster
 *   - Pure unit tests over the exported helpers; DB-touching code is exercised
 *     via mocked supabase clients (no real network or DB calls).
 *
 * Coverage targets:
 *   1. Schema validation — required fields + image_type enum
 *   2. Per-image classification mapping (normaliseClassification)
 *   3. extractImageUrls (string[] + object[] tolerant)
 *   4. toVisionResponseV2 augments observed_attributes for branding rollup
 *   5. estimateGemini25FlashCost — Flash pricing inline (not Sonnet fallback)
 *   6. Cost cap enforcement: daily cap exceeded → 429-shape behaviour via
 *      getDailyCapUsd / getDailySpendUsd
 *   7. Idempotency: re-fire on same listing → upsert by createPulseVisionExtract
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';

import {
  pulseExternalListingSchema,
  PULSE_EXTERNAL_LISTING_SCHEMA_VERSION,
} from '../_shared/visionPrompts/blocks/pulseExternalListingSchema.ts';
import {
  estimateGemini25FlashCost,
  extractImageUrls,
  normaliseClassification,
  toVisionResponseV2,
} from './index.ts';
import {
  computePhotoBreakdown,
  computeCompetitorBranding,
} from '../_shared/pulseVisionPersist.ts';

// ─── 1. Schema validation ────────────────────────────────────────────────────

Deno.test('pulseExternalListingSchema: declares all required top-level fields', () => {
  const schema = pulseExternalListingSchema as Record<string, unknown>;
  assertEquals(schema.type, 'object');
  const required = schema.required as string[];
  // The 11 required fields per W15b.1 spec
  for (const field of [
    'image_type',
    'is_dusk',
    'is_drone',
    'is_floorplan',
    'is_video_thumbnail',
    'is_day',
    'watermark_visible',
    'delivery_quality_score',
    'observed_objects',
    'observed_attributes',
    'analysis',
  ]) {
    assertEquals(
      required.includes(field),
      true,
      `required field missing: ${field}`,
    );
  }
});

Deno.test('pulseExternalListingSchema: image_type enum has 8 mutually-exclusive labels', () => {
  const schema = pulseExternalListingSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const it = props.image_type;
  assertEquals(it.type, 'string');
  const enumVals = (it.enum as string[]).sort();
  assertEquals(
    enumVals,
    [
      'is_agent_headshot',
      'is_day',
      'is_detail_shot',
      'is_drone',
      'is_dusk',
      'is_floorplan',
      'is_other',
      'is_video_thumbnail',
    ],
  );
});

Deno.test('PULSE_EXTERNAL_LISTING_SCHEMA_VERSION = v1.0', () => {
  assertEquals(PULSE_EXTERNAL_LISTING_SCHEMA_VERSION, 'v1.0');
});

// ─── 2. normaliseClassification (per-image mapping) ──────────────────────────

Deno.test('normaliseClassification: coerces a well-formed Flash output', () => {
  const raw = {
    image_type: 'is_dusk',
    is_day: false,
    is_dusk: true,
    is_drone: true,
    is_floorplan: false,
    is_video_thumbnail: false,
    watermark_visible: true,
    photographer_credit: 'Studio X',
    agency_logo_text: 'BellePropertyXYZ',
    delivery_quality_score: 8.5,
    observed_objects: [{ raw_label: 'pool', confidence: 0.9 }],
    observed_attributes: [{ raw_label: 'marble splashback', confidence: 0.85 }],
    style_archetype: 'contemporary coastal',
    era_hint: 'contemporary',
    material_palette: ['marble', 'oak floorboards'],
    analysis: 'Dusk drone shot of a contemporary coastal home with marble interiors visible.',
  };
  const out = normaliseClassification(raw);
  assertEquals(out.image_type, 'is_dusk');
  assertEquals(out.is_drone, true);
  assertEquals(out.is_dusk, true);
  assertEquals(out.is_day, false);
  assertEquals(out.watermark_visible, true);
  assertEquals(out.photographer_credit, 'Studio X');
  assertEquals(out.delivery_quality_score, 8.5);
  assertEquals(out.material_palette, ['marble', 'oak floorboards']);
  assertEquals(out.observed_objects.length, 1);
});

Deno.test('normaliseClassification: applies safe defaults for missing fields', () => {
  const out = normaliseClassification({});
  assertEquals(out.image_type, 'is_other');
  assertEquals(out.is_day, false);
  assertEquals(out.is_drone, false);
  assertEquals(out.delivery_quality_score, 0);
  assertEquals(out.watermark_visible, false);
  assertEquals(out.photographer_credit, null);
  assertEquals(out.material_palette, []);
  assertEquals(out.analysis, '');
});

Deno.test('normaliseClassification: clamps delivery_quality_score to 0-10', () => {
  assertEquals(
    normaliseClassification({ delivery_quality_score: 99 }).delivery_quality_score,
    10,
  );
  assertEquals(
    normaliseClassification({ delivery_quality_score: -3 }).delivery_quality_score,
    0,
  );
});

Deno.test('normaliseClassification: caps material_palette at 12 entries', () => {
  const big = Array.from({ length: 30 }, (_, i) => `material_${i}`);
  const out = normaliseClassification({ material_palette: big });
  assertEquals(out.material_palette.length, 12);
});

// ─── 3. extractImageUrls ─────────────────────────────────────────────────────

Deno.test('extractImageUrls: handles string[] images', () => {
  const out = extractImageUrls(
    ['https://rea.cdn/a.jpg', 'https://rea.cdn/b.jpg'],
    null,
  );
  assertEquals(out.length, 2);
  assertEquals(out[0], 'https://rea.cdn/a.jpg');
});

Deno.test('extractImageUrls: handles object[] with .url', () => {
  const out = extractImageUrls(
    [{ url: 'https://rea.cdn/a.jpg' }, { href: 'https://rea.cdn/b.jpg' }],
    null,
  );
  assertEquals(out.length, 2);
});

Deno.test('extractImageUrls: prepends hero_image and de-dupes', () => {
  const out = extractImageUrls(
    ['https://rea.cdn/a.jpg', 'https://rea.cdn/b.jpg'],
    'https://rea.cdn/hero.jpg',
  );
  assertEquals(out.length, 3);
  assertEquals(out[0], 'https://rea.cdn/hero.jpg');
  // De-dup when hero is already in the array
  const dup = extractImageUrls(
    ['https://rea.cdn/a.jpg'],
    'https://rea.cdn/a.jpg',
  );
  assertEquals(dup.length, 1);
});

// ─── 4. toVisionResponseV2 — competitor branding rollup ──────────────────────

Deno.test('toVisionResponseV2: augments observed_attributes with watermark / agency_logo / photographer credit so persist helper aggregates branding correctly', () => {
  const c = {
    image_type: 'is_day',
    is_day: true,
    is_dusk: false,
    is_drone: false,
    is_floorplan: false,
    is_video_thumbnail: false,
    watermark_visible: true,
    photographer_credit: 'Studio X',
    agency_logo_text: 'BellePropertyXYZ',
    delivery_quality_score: 7,
    observed_objects: [],
    observed_attributes: [{ raw_label: 'oak floorboards' }],
    style_archetype: null,
    era_hint: null,
    material_palette: [],
    analysis: '',
  };
  const v2 = toVisionResponseV2(c, 'https://rea.cdn/a.jpg');
  assertEquals(v2.image_type, 'is_day');
  assertEquals(v2.source_image_url, 'https://rea.cdn/a.jpg');
  // Aggregator picks up these by raw_label substring
  const branded = computeCompetitorBranding([v2]);
  assertEquals(branded.watermark_visible, true);
  assertEquals(branded.agency_logo, true);
  assertEquals(branded.photographer_credit, true);
  assertEquals(branded.dominant_brand_inferred, 'BellePropertyXYZ');
});

Deno.test('toVisionResponseV2: when no branding present, observed_attributes are passed through unaugmented and aggregator returns false', () => {
  const c = {
    image_type: 'is_day',
    is_day: true,
    is_dusk: false,
    is_drone: false,
    is_floorplan: false,
    is_video_thumbnail: false,
    watermark_visible: false,
    photographer_credit: null,
    agency_logo_text: null,
    delivery_quality_score: 5,
    observed_objects: [],
    observed_attributes: [{ raw_label: 'oak floorboards' }],
    style_archetype: null,
    era_hint: null,
    material_palette: [],
    analysis: '',
  };
  const v2 = toVisionResponseV2(c, 'https://rea.cdn/a.jpg');
  assertEquals(v2.observed_attributes?.length, 1);
  const branded = computeCompetitorBranding([v2]);
  assertEquals(branded.watermark_visible, false);
  assertEquals(branded.agency_logo, false);
  assertEquals(branded.dominant_brand_inferred, null);
});

// ─── 5. estimateGemini25FlashCost ───────────────────────────────────────────

Deno.test('estimateGemini25FlashCost: input $0.30 + output $2.50 per 1M tokens', () => {
  // 1M input, 1M output → $0.30 + $2.50 = $2.80
  const cost = estimateGemini25FlashCost(1_000_000, 1_000_000);
  assertEquals(cost, 2.8);
});

Deno.test('estimateGemini25FlashCost: zero tokens → 0', () => {
  assertEquals(estimateGemini25FlashCost(0, 0), 0);
});

Deno.test('estimateGemini25FlashCost: spec-aligned per-image cost ~ $0.0015', () => {
  // ~600 input + ~600 output is the typical per-image profile
  const cost = estimateGemini25FlashCost(600, 600);
  // 600 / 1M * $0.30 + 600 / 1M * $2.50 = $0.000180 + $0.001500 = $0.00168
  assert(cost > 0 && cost < 0.0025, `expected ~$0.0015-0.002, got ${cost}`);
});

// QC-iter2 W6b (F-E-002): the inline Flash estimator now thinly wraps
// estimateCost('google', 'gemini-2.5-flash', ...). Pin the wrapper's output to
// the canonical pricing.ts source so a future drift in pricing.ts (e.g. Google
// raising the rate) propagates through this helper unchanged.
import { estimateCost } from '../_shared/visionAdapter/pricing.ts';

Deno.test('F-E-002: estimateGemini25FlashCost matches estimateCost(google, 2.5-flash)', () => {
  for (const [input, output] of [[0, 0], [600, 600], [10000, 5000], [200000, 50000]]) {
    const wrapper = estimateGemini25FlashCost(input, output);
    const canonical = estimateCost('google', 'gemini-2.5-flash', {
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: 0,
    });
    assertEquals(
      wrapper,
      canonical,
      `mismatch at (${input}, ${output}): wrapper=${wrapper} canonical=${canonical}`,
    );
  }
});

// ─── 6. Photo breakdown rollup (smoke check on the aggregator) ───────────────

Deno.test('computePhotoBreakdown: sums day/dusk/drone counts via image_type', () => {
  const rows = [
    { image_type: 'is_day' },
    { image_type: 'is_day' },
    { image_type: 'is_dusk' },
    { image_type: 'is_drone' },
    { image_type: 'is_floorplan' },
    { image_type: 'is_agent_headshot' },
    { image_type: 'is_other' },
  ];
  const breakdown = computePhotoBreakdown(rows);
  assertEquals(breakdown.day_count, 2);
  assertEquals(breakdown.dusk_count, 1);
  assertEquals(breakdown.drone_count, 1);
  assertEquals(breakdown.floorplan_count, 1);
  assertEquals(breakdown.agent_headshot_count, 1);
  assertEquals(breakdown.total_images, 7);
});

// ─── 7. Cost cap enforcement (mock supabase client) ──────────────────────────

interface MockChain {
  selectArgs?: string;
  eqArgs?: [string, unknown];
  from(table: string): MockChain;
  select(args: string): MockChain;
  eq(col: string, val: unknown): MockChain;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  gte(col: string, val: unknown): { data: unknown; error: null };
}

function makeAdminMock(handlers: {
  pulse_vision_setting?: { data: { value: unknown } | null; error: null };
  daily_spend_rows?: Array<{ total_cost_usd: number | string | null }>;
}): unknown {
  return {
    from(table: string) {
      if (table === 'engine_settings') {
        return {
          select(_args: string) {
            return {
              eq(_col: string, _val: unknown) {
                return {
                  maybeSingle() {
                    return Promise.resolve(
                      handlers.pulse_vision_setting ?? { data: null, error: null },
                    );
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'pulse_listing_vision_extracts') {
        return {
          select(_args: string) {
            return {
              gte(_col: string, _val: unknown) {
                return Promise.resolve({
                  data: handlers.daily_spend_rows ?? [],
                  error: null,
                });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

Deno.test('getDailyCapUsd: reads engine_settings.pulse_vision.daily_cap_usd', async () => {
  const { getDailyCapUsd } = await import('./index.ts');
  const admin = makeAdminMock({
    pulse_vision_setting: {
      data: { value: { daily_cap_usd: 50 } },
      error: null,
    },
  });
  // deno-lint-ignore no-explicit-any
  const cap = await getDailyCapUsd(admin as any);
  assertEquals(cap, 50);
});

Deno.test('getDailyCapUsd: falls back to default when row missing', async () => {
  const { getDailyCapUsd } = await import('./index.ts');
  const admin = makeAdminMock({});
  // deno-lint-ignore no-explicit-any
  const cap = await getDailyCapUsd(admin as any, 30);
  assertEquals(cap, 30);
});

Deno.test('getDailySpendUsd: sums total_cost_usd across rows', async () => {
  const { getDailySpendUsd } = await import('./index.ts');
  const admin = makeAdminMock({
    daily_spend_rows: [
      { total_cost_usd: 5.5 },
      { total_cost_usd: 10.25 },
      { total_cost_usd: '4.75' },
      { total_cost_usd: null },
    ],
  });
  // deno-lint-ignore no-explicit-any
  const spend = await getDailySpendUsd(admin as any);
  assertEquals(spend, 20.5);
});

Deno.test('cost cap check: dailySpend >= dailyCap means 429 should fire', async () => {
  const { getDailyCapUsd, getDailySpendUsd } = await import('./index.ts');
  const admin = makeAdminMock({
    pulse_vision_setting: { data: { value: { daily_cap_usd: 30 } }, error: null },
    daily_spend_rows: [{ total_cost_usd: 31.0 }],
  });
  // deno-lint-ignore no-explicit-any
  const cap = await getDailyCapUsd(admin as any);
  // deno-lint-ignore no-explicit-any
  const spend = await getDailySpendUsd(admin as any);
  assertEquals(cap, 30);
  assertEquals(spend, 31);
  assert(spend >= cap, 'cost gate would fire when spend exceeds cap');
});

// ─── 8. Idempotency via createPulseVisionExtract ─────────────────────────────

Deno.test('createPulseVisionExtract: returns existing row when (listing, schema_version) already exists (idempotent re-fire)', async () => {
  const { createPulseVisionExtract } = await import('../_shared/pulseVisionPersist.ts');
  const existingId = 'existing-extract-uuid-1234';
  // deno-lint-ignore no-explicit-any
  const admin: any = {
    from(_t: string) {
      return {
        select(_a: string) {
          return {
            eq(_c: string, _v: unknown) {
              return {
                eq(_c2: string, _v2: unknown) {
                  return {
                    maybeSingle() {
                      return Promise.resolve({
                        data: { id: existingId },
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const out = await createPulseVisionExtract(admin, {
    listing_id: 'listing-1',
    triggered_by: 'operator_manual',
    schema_version: 'v1.0',
  });
  assertEquals(out.created, false);
  assertEquals(out.extract_id, existingId);
});

Deno.test('createPulseVisionExtract: inserts new row when no existing match', async () => {
  const { createPulseVisionExtract } = await import('../_shared/pulseVisionPersist.ts');
  let inserted = false;
  // deno-lint-ignore no-explicit-any
  const admin: any = {
    from(_t: string) {
      return {
        select(_a: string) {
          return {
            eq(_c: string, _v: unknown) {
              return {
                eq(_c2: string, _v2: unknown) {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
              };
            },
          };
        },
        insert(_row: unknown) {
          inserted = true;
          return {
            select(_a: string) {
              return {
                single() {
                  return Promise.resolve({
                    data: { id: 'new-extract-uuid' },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };
  const out = await createPulseVisionExtract(admin, {
    listing_id: 'listing-2',
    triggered_by: 'operator_manual',
  });
  assertEquals(out.created, true);
  assertEquals(out.extract_id, 'new-extract-uuid');
  assert(inserted, 'expected admin.from(...).insert(...) to be invoked');
});

// ─── 9. Schema "validation" — ensure required + properties align (sanity) ───

Deno.test('schema: every required key has a corresponding properties entry', () => {
  const schema = pulseExternalListingSchema as Record<string, unknown>;
  const required = schema.required as string[];
  const props = schema.properties as Record<string, unknown>;
  for (const key of required) {
    assert(
      key in props,
      `required field "${key}" missing from properties`,
    );
  }
  // analysis property carries description
  const analysisProp = props.analysis as Record<string, unknown>;
  assertStringIncludes(String(analysisProp.description), 'Brief reasoning');
});
