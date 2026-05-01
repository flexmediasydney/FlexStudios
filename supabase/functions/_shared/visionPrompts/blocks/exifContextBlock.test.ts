import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  EXIF_CONTEXT_BLOCK_VERSION,
  exifContextBlock,
  exifContextTable,
} from './exifContextBlock.ts';

Deno.test('exifContextBlock: 14mm focal renders "ultra-wide architectural" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R6m2',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/16',
    iso: 640,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, '14mm');
  assertStringIncludes(txt, 'ultra-wide architectural');
});

Deno.test('exifContextBlock: 70mm focal renders "short telephoto / portrait" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 70,
    aperture: 4,
    shutterSpeed: '1/200',
    iso: 400,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, '70mm');
  assertStringIncludes(txt, 'short telephoto / portrait');
});

Deno.test('exifContextBlock: 24mm focal renders "wide-angle" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 24,
    aperture: 8,
    shutterSpeed: '1/100',
    iso: 200,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, '24mm');
  assertStringIncludes(txt, 'wide-angle');
});

Deno.test('exifContextBlock: 50mm focal renders "standard" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 50,
    aperture: 4,
    shutterSpeed: '1/200',
    iso: 400,
  });
  assertStringIncludes(txt, '50mm');
  assertStringIncludes(txt, 'standard');
});

Deno.test('exifContextBlock: 200mm focal renders "telephoto detail" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 200,
    aperture: 5.6,
    shutterSpeed: '1/500',
    iso: 800,
  });
  assertStringIncludes(txt, '200mm');
  assertStringIncludes(txt, 'telephoto detail');
});

Deno.test('exifContextBlock: f/2.8 aperture renders "shallow DOF — selective focus"', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 50,
    aperture: 2.8,
    shutterSpeed: '1/200',
    iso: 400,
  });
  assertStringIncludes(txt, 'f/2.8');
  assertStringIncludes(txt, 'shallow DOF');
  assertStringIncludes(txt, 'selective focus');
});

Deno.test('exifContextBlock: f/8 aperture renders "deep DOF" bucket', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/16',
    iso: 640,
  });
  assertStringIncludes(txt, 'f/8');
  assertStringIncludes(txt, 'deep DOF');
});

Deno.test('exifContextBlock: f/16 aperture renders "deep DOF + diffraction risk"', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 24,
    aperture: 16,
    shutterSpeed: '1/100',
    iso: 200,
  });
  assertStringIncludes(txt, 'f/16');
  assertStringIncludes(txt, 'diffraction risk');
});

Deno.test('exifContextBlock: bracket=-2 renders "underexposed bracket (highlight protection)"', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/64',
    iso: 640,
    aebBracketValue: -2,
  });
  assertStringIncludes(txt, 'underexposed bracket');
  assertStringIncludes(txt, 'highlight protection');
});

Deno.test('exifContextBlock: bracket=+2 renders "overexposed bracket (shadow recovery)"', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/4',
    iso: 640,
    aebBracketValue: 2,
  });
  assertStringIncludes(txt, 'overexposed bracket');
  assertStringIncludes(txt, 'shadow recovery');
});

Deno.test('exifContextBlock: bracket=0 renders "neutral exposure"', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/16',
    iso: 640,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, 'neutral exposure');
});

Deno.test('exifContextBlock: ISO=200 renders "clean" bucket implicitly via no high_iso risk', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 24,
    aperture: 8,
    shutterSpeed: '1/100',
    iso: 200,
  });
  assertStringIncludes(txt, 'ISO 200');
  assertStringIncludes(txt, 'Risks: none');
});

Deno.test('exifContextBlock: high_iso risk surfaces in Risks line + implications', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 24,
    aperture: 4,
    shutterSpeed: '1/60',
    iso: 6400,
    highIsoRisk: true,
  });
  assertStringIncludes(txt, 'ISO 6400');
  assertStringIncludes(txt, 'high_iso=true');
  assertStringIncludes(txt, 'noise');
});

Deno.test('exifContextBlock: motion_blur risk surfaces in Risks line', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/5',
    iso: 640,
    aebBracketValue: 0,
    motionBlurRisk: true,
  });
  assertStringIncludes(txt, 'motion_blur=true');
});

Deno.test('exifContextBlock: missing fields render graceful "unknown" fallbacks (no error)', () => {
  const txt = exifContextBlock({});
  assertStringIncludes(txt, 'Camera: unknown');
  assertStringIncludes(txt, 'Focal length: unknown');
  assertStringIncludes(txt, 'Aperture: unknown');
  assertStringIncludes(txt, 'Shutter: unknown');
  assertStringIncludes(txt, 'ISO unknown');
  assertStringIncludes(txt, 'Bracket: unknown');
});

Deno.test('exifContextBlock: partial fields render the present ones + unknown for the rest', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R6m2',
    focalLengthMm: 14,
  });
  assertStringIncludes(txt, 'Canon EOS R6m2');
  assertStringIncludes(txt, '14mm');
  assertStringIncludes(txt, 'Aperture: unknown');
  assertStringIncludes(txt, 'Shutter: unknown');
});

Deno.test('exifContextBlock: full-frame R6m2 sensor format is detected', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R6m2',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/16',
    iso: 640,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, 'full-frame');
  assertStringIncludes(txt, '24MP');
});

Deno.test('exifContextBlock: APS-C R7 sensor format is detected', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R7',
    focalLengthMm: 24,
    aperture: 5.6,
    shutterSpeed: '1/200',
    iso: 800,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, 'APS-C');
});

Deno.test('exifContextBlock: header line is present', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R5',
    focalLengthMm: 24,
    aperture: 8,
  });
  assertStringIncludes(txt, '── IMAGE METADATA ──');
});

Deno.test('exifContextBlock: implications line cites the focal-length perspective + DOF', () => {
  const txt = exifContextBlock({
    cameraModel: 'Canon EOS R6m2',
    focalLengthMm: 14,
    aperture: 8,
    shutterSpeed: '1/16',
    iso: 640,
    aebBracketValue: 0,
  });
  assertStringIncludes(txt, 'Implications:');
  assertStringIncludes(txt, 'ultra-wide perspective');
  assertStringIncludes(txt, 'foreground and background equally sharp');
  assertStringIncludes(txt, 'bracket=0');
});

Deno.test('exifContextTable: empty rows renders "no per-image EXIF metadata available"', () => {
  const txt = exifContextTable([]);
  assertStringIncludes(txt, 'no per-image EXIF metadata available');
});

Deno.test('exifContextTable: renders one row per image with focal/aperture/shutter/iso/bracket', () => {
  const txt = exifContextTable([
    {
      stem: '034A7960',
      cameraModel: 'Canon EOS R6m2',
      focalLengthMm: 14,
      aperture: 8,
      shutterSpeed: '1/5',
      iso: 640,
      aebBracketValue: 0,
      motionBlurRisk: true,
    },
    {
      stem: '034A7916',
      cameraModel: 'Canon EOS R6m2',
      focalLengthMm: 14,
      aperture: 8,
      shutterSpeed: '1/40',
      iso: 640,
      aebBracketValue: 0,
    },
  ]);
  assertStringIncludes(txt, '── PER-IMAGE METADATA ──');
  assertStringIncludes(txt, 'stem | focal | aperture | shutter | iso | bracket | risks');
  assertStringIncludes(txt, '034A7960 | 14mm ultra-wide | f/8 | 1/5 | 640 | 0 | motion_blur');
  assertStringIncludes(txt, '034A7916 | 14mm ultra-wide | f/8 | 1/40 | 640 | 0 | -');
});

Deno.test('exifContextTable: missing fields render "?" placeholders', () => {
  const txt = exifContextTable([
    {
      stem: 'IMG_NO_META',
    },
  ]);
  assertStringIncludes(txt, 'IMG_NO_META | ? | ? | ? | ? | ? | -');
});

Deno.test('EXIF_CONTEXT_BLOCK_VERSION: v1.0 baseline', () => {
  assertEquals(EXIF_CONTEXT_BLOCK_VERSION, 'v1.0');
});
