/**
 * lensClass.test.ts — Wave 11.6.7 P1-4 unit tests.
 *
 * Run: deno test supabase/functions/_shared/lensClass.test.ts --no-check --allow-all
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveLensClass } from './lensClass.ts';

Deno.test('deriveLensClass: focal ≤ 28 → wide_angle', () => {
  assertEquals(deriveLensClass({ focalLength: 14 }), 'wide_angle');
  assertEquals(deriveLensClass({ focalLength: 24 }), 'wide_angle');
  assertEquals(deriveLensClass({ focalLength: 28 }), 'wide_angle'); // boundary
});

Deno.test('deriveLensClass: 28 < focal ≤ 70 → standard', () => {
  assertEquals(deriveLensClass({ focalLength: 28.1 }), 'standard');
  assertEquals(deriveLensClass({ focalLength: 50 }), 'standard');
  assertEquals(deriveLensClass({ focalLength: 70 }), 'standard'); // boundary
});

Deno.test('deriveLensClass: focal > 70 → telephoto', () => {
  assertEquals(deriveLensClass({ focalLength: 70.1 }), 'telephoto');
  assertEquals(deriveLensClass({ focalLength: 100 }), 'telephoto');
  assertEquals(deriveLensClass({ focalLength: 200 }), 'telephoto');
});

Deno.test('deriveLensClass: drone override beats focal length', () => {
  assertEquals(
    deriveLensClass({ focalLength: 14 }, { isDrone: true }),
    'drone',
    'drone EXIF carries 14mm-ish but classifies as drone',
  );
  assertEquals(
    deriveLensClass({ focalLength: 50 }, { isDrone: true }),
    'drone',
  );
});

Deno.test('deriveLensClass: tilt_shift detected via lensModel TS-E', () => {
  assertEquals(
    deriveLensClass({ focalLength: 24, lensModel: 'Canon TS-E 24mm f/3.5L II' }),
    'tilt_shift',
  );
  assertEquals(
    deriveLensClass({ focalLength: 17, lensModel: 'Canon TS-E 17mm' }),
    'tilt_shift',
  );
});

Deno.test('deriveLensClass: tilt_shift detected via lensModel PC-E (Nikon)', () => {
  assertEquals(
    deriveLensClass({ focalLength: 24, lensModel: 'Nikon PC-E 24mm f/3.5D' }),
    'tilt_shift',
  );
});

Deno.test('deriveLensClass: tilt_shift wins over drone? drone wins (Joseph said so)', () => {
  // Edge case: drone with a TS lens shouldn't realistically happen, but if
  // both signals are present, drone bucket wins so tilt-shift constrained
  // slots don't accidentally accept drone shots.
  assertEquals(
    deriveLensClass(
      { focalLength: 24, lensModel: 'Canon TS-E 24mm' },
      { isDrone: true },
    ),
    'drone',
  );
});

Deno.test('deriveLensClass: missing focalLength returns null', () => {
  assertEquals(deriveLensClass({}), null);
  assertEquals(deriveLensClass(null), null);
  assertEquals(deriveLensClass(undefined), null);
  assertEquals(deriveLensClass({ focalLength: null }), null);
});

Deno.test('deriveLensClass: zero or negative focalLength returns null', () => {
  assertEquals(deriveLensClass({ focalLength: 0 }), null);
  assertEquals(deriveLensClass({ focalLength: -5 }), null);
});

Deno.test('deriveLensClass: NaN / Infinity returns null', () => {
  assertEquals(deriveLensClass({ focalLength: NaN }), null);
  assertEquals(deriveLensClass({ focalLength: Infinity }), null);
});

Deno.test('deriveLensClass: tilt_shift overrides focal-length when no drone', () => {
  // 14mm + TS-E lens → tilt_shift, not wide_angle (TS lenses are typically wide
  // but the photographic intent is the perspective correction, not the FOV).
  assertEquals(
    deriveLensClass({ focalLength: 14, lensModel: 'Canon TS-E 17mm f/4L' }),
    'tilt_shift',
  );
});

Deno.test('deriveLensClass: lensModel is case-insensitive', () => {
  assertEquals(
    deriveLensClass({ focalLength: 24, lensModel: 'CANON TS-E 24mm' }),
    'tilt_shift',
  );
  assertEquals(
    deriveLensClass({ focalLength: 24, lensModel: 'canon ts-e 24mm' }),
    'tilt_shift',
  );
});
