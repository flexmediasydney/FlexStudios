/**
 * Unit tests for projectFolders pure helpers.
 * Run: deno test supabase/functions/_shared/projectFolders.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { slugifyAddress, defaultProjectRootPath } from './projectFolders.ts';

Deno.test('slugifyAddress: spec example with slash', () => {
  assertEquals(slugifyAddress('6/3 Silver St'), '6-3-silver-st');
});

Deno.test('slugifyAddress: lowercases', () => {
  assertEquals(slugifyAddress('UPPER Case Street'), 'upper-case-street');
});

Deno.test('slugifyAddress: strips special chars', () => {
  assertEquals(slugifyAddress('Unit 4, 12 Smith St.'), 'unit-4-12-smith-st');
});

Deno.test('slugifyAddress: collapses whitespace', () => {
  assertEquals(slugifyAddress('123  Main    Road'), '123-main-road');
});

Deno.test('slugifyAddress: trims leading/trailing hyphens', () => {
  assertEquals(slugifyAddress('  Hello World  '), 'hello-world');
  assertEquals(slugifyAddress('--abc--'), 'abc');
});

Deno.test('slugifyAddress: caps at 40 chars', () => {
  const long = 'a'.repeat(60);
  const slug = slugifyAddress(long);
  assertEquals(slug.length, 40);
  assertEquals(slug, 'a'.repeat(40));
});

Deno.test('slugifyAddress: 40-char cap does not leave trailing hyphen', () => {
  // Construct an address such that char 40 is part of a hyphen.
  // "abcdefghij " repeated → "abcdefghij-abcdefghij-abcdefghij-abcdefgh" → no trailing
  // But: "abcdefghij abcdefghij abcdefghij abcdefghij" (ends at exactly 40 with letter)
  // Try: "ab cd ef gh ij kl mn op qr st uv wx yz 12 34"
  //  → "ab-cd-ef-gh-ij-kl-mn-op-qr-st-uv-wx-yz-12-34" (44 chars)
  //  sliced @40 → "ab-cd-ef-gh-ij-kl-mn-op-qr-st-uv-wx-yz-1" (no trailing hyphen)
  const slug = slugifyAddress('ab cd ef gh ij kl mn op qr st uv wx yz 12 34');
  assertEquals(slug.endsWith('-'), false);

  // Force a case where the cut DOES land on a hyphen:
  // 39 letter chars then space → slice@40 gives 39 chars + '-' which gets trimmed.
  const force = 'a'.repeat(39) + ' z';
  const slug2 = slugifyAddress(force);
  assertEquals(slug2.endsWith('-'), false);
});

Deno.test('slugifyAddress: empty/null falls back to "unknown"', () => {
  assertEquals(slugifyAddress(''), 'unknown');
  assertEquals(slugifyAddress(null), 'unknown');
  assertEquals(slugifyAddress(undefined), 'unknown');
  assertEquals(slugifyAddress('!!!'), 'unknown'); // all-special collapses to empty
});

Deno.test('slugifyAddress: preserves digits', () => {
  assertEquals(slugifyAddress('123 Main St'), '123-main-st');
});

Deno.test('slugifyAddress: handles backslash like forward slash', () => {
  assertEquals(slugifyAddress('A\\B C'), 'a-b-c');
});

Deno.test('defaultProjectRootPath: composes id_slug', () => {
  assertEquals(
    defaultProjectRootPath('abc-123', '6/3 Silver St'),
    '/Flex Media Team Folder/Projects/abc-123_6-3-silver-st',
  );
});

Deno.test('defaultProjectRootPath: null address falls back', () => {
  assertEquals(
    defaultProjectRootPath('abc-123', null),
    '/Flex Media Team Folder/Projects/abc-123_unknown',
  );
});
