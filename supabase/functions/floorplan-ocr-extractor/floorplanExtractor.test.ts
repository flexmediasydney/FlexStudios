/**
 * floorplanExtractor.test.ts — unit tests for the W13c floorplan extractor
 * pure helpers.
 *
 * Run: deno test --no-check --allow-all supabase/functions/floorplan-ocr-extractor/floorplanExtractor.test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildFloorplanRequest,
  computeCrossCheckFlags,
  computeUrlHash,
  FLOORPLAN_EXTRACTOR_BLOCK_VERSION,
  parseFloorplanOutput,
} from './floorplanExtractor.ts';

// ─── parseFloorplanOutput: happy path ──────────────────────────────────────

Deno.test('parseFloorplanOutput: rich valid response normalises cleanly', () => {
  const raw = {
    total_internal_sqm: 187.5,
    total_land_sqm: 612,
    rooms_detected: [
      { room_label: 'master', count: 1, dimensions_sqm: 18.4 },
      { room_label: 'BEDROOM', count: 2, dimensions_sqm: 12.0 },
      { room_label: 'kitchen', count: 1 },
      { room_label: 'study', count: 1, dimensions_sqm: 8.5 },
    ],
    bedrooms_count: 3,
    bathrooms_count: 2,
    home_archetype: 'open_plan',
    north_arrow_orientation: 270.5,
    garage_type: 'double',
    flow_paths: [
      { from: 'KITCHEN', to: 'Dining' },
      { from: 'living', to: 'alfresco' },
    ],
    legibility_score: 8.5,
    extraction_confidence: 0.91,
  };
  const out = parseFloorplanOutput(raw);
  assertEquals(out.total_internal_sqm, 187.5);
  assertEquals(out.total_land_sqm, 612);
  assertEquals(out.bedrooms_count, 3);
  assertEquals(out.bathrooms_count, 2);
  assertEquals(out.home_archetype, 'open_plan');
  assertEquals(out.north_arrow_orientation, 270.5);
  assertEquals(out.garage_type, 'double');
  assertEquals(out.legibility_score, 8.5);
  assertEquals(out.extraction_confidence, 0.91);
  // room labels normalised lowercase
  assertEquals(out.rooms_detected[0].room_label, 'master');
  assertEquals(out.rooms_detected[1].room_label, 'bedroom');
  assertEquals(out.rooms_detected[1].count, 2);
  assertEquals(out.rooms_detected[2].dimensions_sqm, undefined);
  // flow paths normalised lowercase
  assertEquals(out.flow_paths[0], { from: 'kitchen', to: 'dining' });
  assertEquals(out.flow_paths[1], { from: 'living', to: 'alfresco' });
});

Deno.test('parseFloorplanOutput: defensive defaults on garbage input', () => {
  const raw = {
    rooms_detected: 'not-an-array',
    home_archetype: 'invalid_archetype',
    garage_type: 'monster_truck_garage',
    flow_paths: null,
    legibility_score: 99,           // out of range, should clamp to 10
    extraction_confidence: -3,      // out of range, should clamp to 0
  };
  const out = parseFloorplanOutput(raw);
  assertEquals(out.total_internal_sqm, null);
  assertEquals(out.total_land_sqm, null);
  assertEquals(out.rooms_detected, []);
  assertEquals(out.home_archetype, 'unknown');
  assertEquals(out.garage_type, 'unknown');
  assertEquals(out.flow_paths, []);
  assertEquals(out.legibility_score, 10);
  assertEquals(out.extraction_confidence, 0);
});

Deno.test('parseFloorplanOutput: north arrow normalised to [0,360)', () => {
  // negative degrees → wrap into 0-360
  const a = parseFloorplanOutput({ rooms_detected: [], home_archetype: 'open_plan', garage_type: 'none', flow_paths: [], legibility_score: 5, extraction_confidence: 0.5, north_arrow_orientation: -90 });
  assertEquals(a.north_arrow_orientation, 270);
  // > 360 wraps too
  const b = parseFloorplanOutput({ rooms_detected: [], home_archetype: 'open_plan', garage_type: 'none', flow_paths: [], legibility_score: 5, extraction_confidence: 0.5, north_arrow_orientation: 720 });
  assertEquals(b.north_arrow_orientation, 0);
  // Decimal preserved
  const c = parseFloorplanOutput({ rooms_detected: [], home_archetype: 'open_plan', garage_type: 'none', flow_paths: [], legibility_score: 5, extraction_confidence: 0.5, north_arrow_orientation: 45.789 });
  assertEquals(c.north_arrow_orientation, 45.79);
});

Deno.test('parseFloorplanOutput: rooms with invalid count or empty label dropped', () => {
  const raw = {
    rooms_detected: [
      { room_label: 'kitchen', count: 1 },          // ✓ kept
      { room_label: '', count: 5 },                 // ✗ empty label
      { room_label: 'lounge', count: 0 },           // ✗ zero count
      { room_label: 'bath', count: -1 },            // ✗ negative count
      { room_label: 'bath', count: 'abc' },         // ✗ non-numeric count
      { count: 2 },                                 // ✗ no label
      'just-a-string',                              // ✗ not an object
    ],
    home_archetype: 'traditional',
    garage_type: 'single',
    flow_paths: [],
    legibility_score: 7,
    extraction_confidence: 0.8,
  };
  const out = parseFloorplanOutput(raw);
  assertEquals(out.rooms_detected.length, 1);
  assertEquals(out.rooms_detected[0].room_label, 'kitchen');
});

// ─── computeCrossCheckFlags ────────────────────────────────────────────────

Deno.test('computeCrossCheckFlags: extracted matches CRM → no flags', () => {
  const flags = computeCrossCheckFlags({
    extractedBedrooms: 3,
    extractedBathrooms: 2,
    crmBedrooms: 3,
    crmBathrooms: 2,
  });
  assertEquals(flags, []);
});

Deno.test('computeCrossCheckFlags: bedrooms mismatch token shape is `<extracted>_vs_<crm>`', () => {
  const flags = computeCrossCheckFlags({
    extractedBedrooms: 4,
    extractedBathrooms: 2,
    crmBedrooms: 3,
    crmBathrooms: 2,
  });
  // Spec wording in the prompt: bedrooms_mismatch_2_vs_3 means extracted_2 vs crm_3
  assert(flags.includes('bedrooms_mismatch_4_vs_3'), `expected bedrooms_mismatch_4_vs_3 in ${JSON.stringify(flags)}`);
  assertEquals(flags.length, 1);
});

Deno.test('computeCrossCheckFlags: both diverge → both flags emit', () => {
  const flags = computeCrossCheckFlags({
    extractedBedrooms: 5,
    extractedBathrooms: 3,
    crmBedrooms: 4,
    crmBathrooms: 2,
  });
  assert(flags.includes('bedrooms_mismatch_5_vs_4'));
  assert(flags.includes('bathrooms_mismatch_3_vs_2'));
  assertEquals(flags.length, 2);
});

Deno.test('computeCrossCheckFlags: CRM null → no_crm_*_to_check flags', () => {
  const flags = computeCrossCheckFlags({
    extractedBedrooms: 3,
    extractedBathrooms: 2,
    crmBedrooms: null,
    crmBathrooms: null,
  });
  assert(flags.includes('no_crm_bedrooms_to_check'));
  assert(flags.includes('no_crm_bathrooms_to_check'));
});

Deno.test('computeCrossCheckFlags: extracted null is silent (no flag, no false positive)', () => {
  // The model failed to read the count — we don't penalise; the row's
  // legibility_score / extraction_confidence flag the extract quality.
  const flags = computeCrossCheckFlags({
    extractedBedrooms: null,
    extractedBathrooms: null,
    crmBedrooms: 3,
    crmBathrooms: 2,
  });
  assertEquals(flags, []);
});

// ─── buildFloorplanRequest ─────────────────────────────────────────────────

Deno.test('buildFloorplanRequest: includes source-context floorplan block in user_text', () => {
  const req = buildFloorplanRequest({
    base64: 'aGVsbG8=',  // "hello"
    mediaType: 'image/jpeg',
    crm_bedrooms: 3,
    crm_bathrooms: 2,
    model: 'gemini-2.5-pro',
    vendor: 'google',
    thinking_budget: 2048,
    max_output_tokens: 1500,
  });
  assertEquals(req.vendor, 'google');
  assertEquals(req.model, 'gemini-2.5-pro');
  assertEquals(req.thinking_budget, 2048);
  assertEquals(req.max_output_tokens, 1500);
  assertEquals(req.images.length, 1);
  assertEquals(req.images[0].source_type, 'base64');
  assertEquals(req.images[0].media_type, 'image/jpeg');
  assertEquals(req.images[0].data, 'aGVsbG8=');
  // Source-context block (W7.6) MUST be in the user prompt — that's the whole
  // point of source_type='floorplan_image'.
  assertStringIncludes(req.user_text, 'SOURCE CONTEXT — FLOORPLAN IMAGE');
  assertStringIncludes(req.user_text, 'architectural floorplan drawing');
  // CRM hint is informational
  assertStringIncludes(req.user_text, 'CRM lists this property with 3 bedroom');
  assertStringIncludes(req.user_text, 'CRM lists this property with 2 bathroom');
  // Schema is provided for strict-JSON output
  assertEquals(typeof req.tool_input_schema, 'object');
  assert((req.tool_input_schema as Record<string, unknown>).type === 'object');
});

Deno.test('buildFloorplanRequest: omits CRM hint when both null', () => {
  const req = buildFloorplanRequest({
    base64: 'aGVsbG8=',
    mediaType: 'image/jpeg',
    crm_bedrooms: null,
    crm_bathrooms: null,
    model: 'gemini-2.5-pro',
    vendor: 'google',
    thinking_budget: 2048,
    max_output_tokens: 1500,
  });
  assert(!req.user_text.includes('CRM lists'), 'should not mention CRM when both null');
  assert(!req.user_text.includes('CRM CONTEXT'), 'should not include CRM hint section');
});

// ─── computeUrlHash ────────────────────────────────────────────────────────

Deno.test('computeUrlHash: deterministic across calls', async () => {
  const url = 'https://i3.au.reastatic.net/example/image.jpg';
  const a = await computeUrlHash(url);
  const b = await computeUrlHash(url);
  assertEquals(a, b);
  assertEquals(a.length, 64); // sha-256 hex
  assert(/^[0-9a-f]+$/.test(a));
});

Deno.test('computeUrlHash: different URLs produce different hashes', async () => {
  const a = await computeUrlHash('https://example.com/a.jpg');
  const b = await computeUrlHash('https://example.com/b.jpg');
  assert(a !== b);
});

// ─── Block version stamp ───────────────────────────────────────────────────

Deno.test('FLOORPLAN_EXTRACTOR_BLOCK_VERSION: stable string for prompt-cache key', () => {
  assertEquals(FLOORPLAN_EXTRACTOR_BLOCK_VERSION, 'v1.0');
});

// ─── Schema: Gemini OpenAPI-3.0 compatibility ──────────────────────────────

Deno.test('buildFloorplanRequest: response schema uses nullable:true (Gemini OpenAPI-3.0), not JSON-Schema type-arrays', () => {
  // Regression guard: Gemini's protobuf-backed responseSchema is OpenAPI-3.0
  // subset and rejects JSON-Schema `type: ["number", "null"]` with HTTP 400
  // ("Proto field is not repeating, cannot start list."). All nullable scalar
  // fields must use `nullable: true` instead.
  const req = buildFloorplanRequest({
    base64: 'aGVsbG8=',
    mediaType: 'image/jpeg',
    crm_bedrooms: null,
    crm_bathrooms: null,
    model: 'gemini-2.5-pro',
    vendor: 'google',
    thinking_budget: 2048,
    max_output_tokens: 1500,
  });
  const schemaJson = JSON.stringify(req.tool_input_schema);
  // No literal `["number", "null"]` or `["integer", "null"]` arrays.
  assert(
    !schemaJson.includes('"type":["number","null"]'),
    `schema must not use JSON-Schema array-typed nullables: ${schemaJson}`,
  );
  assert(
    !schemaJson.includes('"type":["integer","null"]'),
    `schema must not use JSON-Schema array-typed nullables: ${schemaJson}`,
  );
  // Nullable fields use OpenAPI's `nullable: true` flag instead.
  assertStringIncludes(schemaJson, '"nullable":true');
});
