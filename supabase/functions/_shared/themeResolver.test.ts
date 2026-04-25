/**
 * Unit tests for themeResolver.
 * Run: deno test supabase/functions/_shared/themeResolver.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  deepMerge,
  mergeConfigChain,
  buildInheritanceDiff,
  computeConfigDiff,
  resolveFromChain,
  type ThemeRow,
} from './themeResolver.ts';

// ── deepMerge ────────────────────────────────────────────────────────────────

Deno.test('deepMerge: higher overrides lower at top level', () => {
  const out = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
  assertEquals(out, { a: 1, b: 3, c: 4 });
});

Deno.test('deepMerge: nested objects recurse — sibling keys preserved', () => {
  const lower = { poi_label: { fill: '#000', text_color: '#fff', font_size_px: 30 } };
  const higher = { poi_label: { fill: '#FFF' } };
  const out = deepMerge(lower, higher);
  assertEquals(out, {
    poi_label: { fill: '#FFF', text_color: '#fff', font_size_px: 30 },
  });
});

Deno.test('deepMerge: arrays replaced wholesale (not concatenated)', () => {
  const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
  assertEquals(out, { list: [9] });
});

Deno.test('deepMerge: undefined value does NOT override', () => {
  const out = deepMerge({ a: 1 }, { a: undefined as unknown as number });
  assertEquals(out, { a: 1 });
});

Deno.test('deepMerge: explicit null DOES override', () => {
  const out = deepMerge({ a: 1 }, { a: null });
  assertEquals(out, { a: null });
});

Deno.test('deepMerge: does not mutate inputs', () => {
  const lower = { a: { b: 1 } };
  const higher = { a: { c: 2 } };
  deepMerge(lower, higher);
  assertEquals(lower, { a: { b: 1 } });
  assertEquals(higher, { a: { c: 2 } });
});

// ── mergeConfigChain ─────────────────────────────────────────────────────────

Deno.test('mergeConfigChain: 3-level merge — person > org > system', () => {
  const system = { theme_name: 'sys', anchor_line: { color: '#000', width_px: 3 } };
  const org = { anchor_line: { color: '#F00' } }; // override colour only
  const person = { anchor_line: { width_px: 5 } }; // override width only
  // Order: lowest first (system), highest last (person).
  const out = mergeConfigChain([system, org, person]);
  assertEquals(out, {
    theme_name: 'sys',
    anchor_line: { color: '#F00', width_px: 5 },
  });
});

Deno.test('mergeConfigChain: empty chain returns {}', () => {
  assertEquals(mergeConfigChain([]), {});
});

Deno.test('mergeConfigChain: single config returned as-is', () => {
  assertEquals(mergeConfigChain([{ a: 1 }]), { a: 1 });
});

// ── resolveFromChain ─────────────────────────────────────────────────────────

const sysTheme: ThemeRow = {
  id: 'sys-id',
  name: 'FlexMedia Default',
  owner_kind: 'system',
  owner_id: null,
  config: {
    theme_name: 'FlexMedia Default',
    anchor_line: { shape: 'thin', width_px: 3, color: '#FFFFFF' },
    poi_label: { fill: '#FFFFFF', text_color: '#000000', font_size_px: 36 },
    property_pin: { mode: 'line_up_with_house_icon' },
  },
  version: 1,
  version_int: 1,
  is_default: true,
  status: 'active',
};
const orgTheme: ThemeRow = {
  id: 'org-id',
  name: 'Belle Property',
  owner_kind: 'organisation',
  owner_id: 'agency-uuid',
  config: {
    poi_label: { fill: '#0A0A0A', text_color: '#FFFFFF' },
    property_pin: { mode: 'teardrop_with_logo' },
  },
  version: 1,
  version_int: 1,
  is_default: true,
  status: 'active',
};
const personTheme: ThemeRow = {
  id: 'person-id',
  name: 'Joseph Override',
  owner_kind: 'person',
  owner_id: 'person-uuid',
  config: {
    poi_label: { fill: '#FF0000' }, // override only fill
  },
  version: 1,
  version_int: 1,
  is_default: true,
  status: 'active',
};

Deno.test('resolveFromChain: 3-level merge — field precedence verified', () => {
  // Highest priority first — that's the convention this fn expects.
  const result = resolveFromChain([personTheme, orgTheme, sysTheme]);

  // poi_label.fill should come from person (#FF0000)
  // poi_label.text_color should come from org (#FFFFFF)
  // poi_label.font_size_px should come from system (36)
  const label = result.resolved_config.poi_label as Record<string, unknown>;
  assertEquals(label.fill, '#FF0000');
  assertEquals(label.text_color, '#FFFFFF');
  assertEquals(label.font_size_px, 36);

  // property_pin.mode should come from org (person didn't touch it)
  const pin = result.resolved_config.property_pin as Record<string, unknown>;
  assertEquals(pin.mode, 'teardrop_with_logo');

  // anchor_line entirely from system (person/org didn't touch it)
  assertEquals(result.resolved_config.anchor_line, {
    shape: 'thin', width_px: 3, color: '#FFFFFF',
  });

  // theme_name from system
  assertEquals(result.resolved_config.theme_name, 'FlexMedia Default');

  // source_chain reports all three, in priority order (highest first)
  assertEquals(result.source_chain, [
    { owner_kind: 'person', theme_id: 'person-id', theme_name: 'Joseph Override' },
    { owner_kind: 'organisation', theme_id: 'org-id', theme_name: 'Belle Property' },
    { owner_kind: 'system', theme_id: 'sys-id', theme_name: 'FlexMedia Default' },
  ]);
});

Deno.test('resolveFromChain: 3-level inheritance_diff — top-key attribution', () => {
  const result = resolveFromChain([personTheme, orgTheme, sysTheme]);
  // poi_label was last touched by person → person owns the diff entry
  assertEquals(result.inheritance_diff.poi_label, 'person');
  // property_pin was last touched by org
  assertEquals(result.inheritance_diff.property_pin, 'organisation');
  // anchor_line + theme_name only system contributed
  assertEquals(result.inheritance_diff.anchor_line, 'system');
  assertEquals(result.inheritance_diff.theme_name, 'system');
});

Deno.test('resolveFromChain: 2-level merge — person missing, org + system', () => {
  const result = resolveFromChain([orgTheme, sysTheme]);
  const label = result.resolved_config.poi_label as Record<string, unknown>;
  // org overrides fill + text_color, font_size from system
  assertEquals(label.fill, '#0A0A0A');
  assertEquals(label.text_color, '#FFFFFF');
  assertEquals(label.font_size_px, 36);
  assertEquals(result.source_chain.length, 2);
  assertEquals(result.source_chain[0].owner_kind, 'organisation');
  assertEquals(result.source_chain[1].owner_kind, 'system');
});

Deno.test('resolveFromChain: 1-level merge — system only', () => {
  const result = resolveFromChain([sysTheme]);
  assertEquals(result.resolved_config, sysTheme.config);
  assertEquals(result.source_chain.length, 1);
  assertEquals(result.source_chain[0].owner_kind, 'system');
  // every key attributes to system
  for (const key of Object.keys(result.resolved_config)) {
    assertEquals(result.inheritance_diff[key], 'system');
  }
});

Deno.test('resolveFromChain: nested-object override does not wipe sibling fields', () => {
  // The exact bug the prompt called out: setting poi_label.fill at person level
  // must NOT erase poi_label.text_color from the org level.
  const sys: ThemeRow = {
    ...sysTheme,
    config: { poi_label: { fill: '#FFF', text_color: '#000', font_size_px: 30 } },
  };
  const org: ThemeRow = {
    ...orgTheme,
    config: { poi_label: { text_color: '#AAA' } },
  };
  const person: ThemeRow = {
    ...personTheme,
    config: { poi_label: { fill: '#F00' } },
  };
  const result = resolveFromChain([person, org, sys]);
  const label = result.resolved_config.poi_label as Record<string, unknown>;
  assertEquals(label.fill, '#F00');         // from person
  assertEquals(label.text_color, '#AAA');    // from org — NOT wiped by person's fill change
  assertEquals(label.font_size_px, 30);      // from system — NOT wiped
});

// ── buildInheritanceDiff ─────────────────────────────────────────────────────

Deno.test('buildInheritanceDiff: only system contributes when others empty', () => {
  const resolved = { a: 1, b: 2 };
  const diff = buildInheritanceDiff(resolved, [
    { owner_kind: 'system', config: { a: 1, b: 2 } },
  ]);
  assertEquals(diff, { a: 'system', b: 'system' });
});

Deno.test('buildInheritanceDiff: highest-priority wins per key', () => {
  const resolved = { a: 1, b: 2, c: 3 };
  const diff = buildInheritanceDiff(resolved, [
    { owner_kind: 'system', config: { a: 0, b: 0, c: 3 } }, // contributes c
    { owner_kind: 'organisation', config: { a: 0, b: 2 } },  // contributes b (overrides system)
    { owner_kind: 'person', config: { a: 1 } },              // contributes a (highest)
  ]);
  assertEquals(diff, { a: 'person', b: 'organisation', c: 'system' });
});

// ── computeConfigDiff ────────────────────────────────────────────────────────

Deno.test('computeConfigDiff: scalar change reports from/to', () => {
  const diff = computeConfigDiff({ a: 1 }, { a: 2 });
  assertEquals(diff, { a: { from: 1, to: 2 } });
});

Deno.test('computeConfigDiff: nested change recurses', () => {
  const diff = computeConfigDiff(
    { obj: { a: 1, b: 2 } },
    { obj: { a: 1, b: 3 } },
  );
  assertEquals(diff, { obj: { b: { from: 2, to: 3 } } });
});

Deno.test('computeConfigDiff: identical configs → empty', () => {
  const diff = computeConfigDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } });
  assertEquals(diff, {});
});

Deno.test('computeConfigDiff: added key recorded', () => {
  const diff = computeConfigDiff({ a: 1 }, { a: 1, b: 2 });
  assertEquals(diff, { b: { from: null, to: 2 } });
});

Deno.test('computeConfigDiff: removed key recorded', () => {
  const diff = computeConfigDiff({ a: 1, b: 2 }, { a: 1 });
  assertEquals(diff, { b: { from: 2, to: null } });
});
