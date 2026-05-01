/**
 * exifContextBlock.ts — W11.6.14 (W7.6 block) per-image EXIF metadata
 * preamble for vision prompts.
 *
 * Pass 0 already extracts complete EXIF metadata (camera model, focal length,
 * aperture, shutter, ISO, AEB bracket value, motion-blur risk, high-ISO risk)
 * and persists it to `composition_groups.exif_metadata` JSONB keyed by stem.
 * Until W11.6.14 the Stage 1 + Stage 4 vision prompts NEVER surfaced this
 * metadata to Gemini — a missed leverage point.
 *
 * Joseph (CEO, master photographer, 2026-05-01):
 *   "a 14mm ultra-wide on a full-frame R6m2 is a different photograph from
 *    a 70mm telephoto detail shot — Gemini should know which it's looking
 *    at to reason correctly about composition, perspective distortion,
 *    foreground emphasis, depth of field, etc."
 *
 * The block renders ONE per-image text block of metadata + an "Implications"
 * line that derives semantic meaning from the raw numbers (so Gemini doesn't
 * have to redo the photographic reasoning every call). Inject at the BOTTOM
 * of the user_text on Stage 1 (after sourceContextBlock + photographer
 * techniques + the existing pass1 user blocks but before SELF_CRITIQUE).
 *
 * On Stage 4 we render a compact PER-IMAGE METADATA TABLE (one row per image)
 * to keep the prompt under budget — see exifContextTable below.
 *
 * Versioned via EXIF_CONTEXT_BLOCK_VERSION so prompt-cache invalidation
 * tracks block changes (persisted in composition_classifications.
 * prompt_block_versions and engine_run_audit.prompt_block_versions).
 */

export const EXIF_CONTEXT_BLOCK_VERSION = 'v1.0';

export interface ExifContextOpts {
  cameraModel?: string | null;
  focalLengthMm?: number | null;
  aperture?: number | null;
  shutterSpeed?: string | null;
  iso?: number | null;
  aebBracketValue?: number | null;
  motionBlurRisk?: boolean;
  highIsoRisk?: boolean;
}

// ─── Sensor format detection (camera model → sensor format hint) ─────────────

function sensorFormat(cameraModel: string | null | undefined): string {
  if (!cameraModel) return 'unknown sensor';
  const m = cameraModel.toUpperCase();
  // Canon full-frame mirrorless (R-series flagships, including model
  // suffixes like R6M2 / R5C). Word-boundary on the LEFT only — Canon's
  // EOS firmware reports the model body and we accept any suffix.
  if (/\bR5C?\b|\bR5M?\d?\b|\bR6M?\d?\b|\bR3\b|\bR1\b|\bRP\b|\bR8\b/.test(m)) return 'full-frame';
  // Canon APS-C mirrorless
  if (/\bR7\b|\bR10\b|\bR50\b|\bR100\b/.test(m)) return 'APS-C';
  // Sony full-frame
  if (/\bA7\b|\bA9\b|\bA1\b|\bILCE-7\b|\bILCE-9\b|\bILCE-1\b/.test(m)) return 'full-frame';
  // Nikon full-frame
  if (/\bZ7\b|\bZ8\b|\bZ9\b|\bZ6\b|\bZ5\b|\bD850\b|\bD780\b|\bD750\b|\bD800\b/.test(m)) return 'full-frame';
  // Fujifilm medium format
  if (/\bGFX\b/.test(m)) return 'medium-format';
  // Phantom/iPhone/Android — small sensor
  if (/IPHONE|PIXEL|GALAXY|SAMSUNG|MAVIC|PHANTOM/.test(m)) return 'small sensor';
  // Default fallback for unknown DSLR/mirrorless
  if (/CANON|NIKON|SONY|FUJI|PANASONIC|OLYMPUS/.test(m)) return 'unknown sensor';
  return 'unknown sensor';
}

function megapixelHint(cameraModel: string | null | undefined): string {
  if (!cameraModel) return '';
  const m = cameraModel.toUpperCase();
  if (/\bR5\b/.test(m)) return ', 45MP';
  if (/\bR5C\b/.test(m)) return ', 45MP';
  if (/\bR6M2\b|\bR6 MARK II\b/.test(m)) return ', 24MP';
  if (/\bR6\b/.test(m)) return ', 20MP';
  if (/\bR3\b/.test(m)) return ', 24MP';
  if (/\bR1\b/.test(m)) return ', 24MP';
  if (/\bR7\b/.test(m)) return ', 33MP';
  if (/\bR10\b/.test(m)) return ', 24MP';
  if (/\bA7R\b|\bA7RV\b|\bA7R IV\b/.test(m)) return ', 61MP';
  if (/\bZ8\b|\bZ9\b/.test(m)) return ', 45MP';
  return '';
}

function focalLengthBucket(mm: number | null | undefined): string {
  if (typeof mm !== 'number' || !Number.isFinite(mm) || mm <= 0) return 'unknown';
  if (mm <= 16) return 'ultra-wide architectural';
  if (mm <= 28) return 'wide-angle';
  if (mm <= 50) return 'standard';
  if (mm <= 85) return 'short telephoto / portrait';
  return 'telephoto detail';
}

function apertureBucket(aperture: number | null | undefined): string {
  if (typeof aperture !== 'number' || !Number.isFinite(aperture) || aperture <= 0) {
    return 'unknown DOF';
  }
  if (aperture <= 4) return 'shallow DOF — selective focus';
  if (aperture <= 11) return 'deep DOF';
  return 'deep DOF + diffraction risk';
}

function isoBucket(iso: number | null | undefined): string {
  if (typeof iso !== 'number' || !Number.isFinite(iso) || iso <= 0) return 'unknown noise';
  if (iso <= 400) return 'clean';
  if (iso <= 1600) return 'moderate noise';
  return 'heavy noise risk';
}

function bracketBucket(aeb: number | null | undefined): string {
  if (typeof aeb !== 'number' || !Number.isFinite(aeb)) return 'unknown bracket';
  if (aeb === 0) return 'neutral exposure';
  if (aeb <= -1) return 'underexposed bracket (highlight protection)';
  if (aeb >= 1) return 'overexposed bracket (shadow recovery)';
  if (aeb < 0) return 'slightly underexposed bracket (highlight protection)';
  return 'slightly overexposed bracket (shadow recovery)';
}

function focalImplication(mm: number | null | undefined): string {
  const bucket = focalLengthBucket(mm);
  if (bucket === 'unknown') return '';
  if (bucket === 'ultra-wide architectural') {
    return 'ultra-wide perspective with mild barrel distortion at edges';
  }
  if (bucket === 'wide-angle') {
    return 'wide field of view; minor edge distortion possible';
  }
  if (bucket === 'standard') {
    return 'natural perspective close to human eye';
  }
  if (bucket === 'short telephoto / portrait') {
    return 'compressed perspective, flattering to subjects, mild background blur';
  }
  return 'strong perspective compression and isolation of distant detail';
}

function dofImplication(aperture: number | null | undefined): string {
  if (typeof aperture !== 'number' || !Number.isFinite(aperture) || aperture <= 0) return '';
  if (aperture <= 4) return 'shallow DOF means foreground subject is sharp while background falls off';
  if (aperture <= 11) return 'deep DOF means foreground and background equally sharp';
  return 'deep DOF but f/16+ introduces diffraction softness';
}

function bracketImplication(aeb: number | null | undefined): string {
  if (typeof aeb !== 'number' || !Number.isFinite(aeb)) return '';
  if (aeb === 0) {
    return 'bracket=0 means this is the neutral frame of an HDR sequence (final image will be merged from multiple brackets)';
  }
  if (aeb <= -1) {
    return `bracket=${aeb} is the underexposed frame — protects highlights for the merged HDR (final image will be the merged result)`;
  }
  if (aeb >= 1) {
    return `bracket=+${aeb} is the overexposed frame — recovers shadows for the merged HDR (final image will be the merged result)`;
  }
  return `bracket=${aeb} is a near-neutral frame of an HDR sequence`;
}

/**
 * Build the per-image EXIF context block for Stage 1.
 *
 * Inject at the BOTTOM of user_text (after sourceContextBlock +
 * photographerTechniquesBlock + the existing pass1 user blocks but BEFORE
 * the SELF_CRITIQUE block) so the model reads it as fresh context just
 * before scoring.
 *
 * Returns a string. When ALL fields are missing, renders a graceful
 * "no metadata available" stub rather than throwing.
 */
export function exifContextBlock(opts: ExifContextOpts): string {
  const cam = opts.cameraModel ?? null;
  const fl = typeof opts.focalLengthMm === 'number' ? opts.focalLengthMm : null;
  const ap = typeof opts.aperture === 'number' ? opts.aperture : null;
  const sh = opts.shutterSpeed ?? null;
  const iso = typeof opts.iso === 'number' ? opts.iso : null;
  const aeb = typeof opts.aebBracketValue === 'number' ? opts.aebBracketValue : null;
  const motion = opts.motionBlurRisk === true;
  const highIso = opts.highIsoRisk === true;

  const sensor = sensorFormat(cam);
  const mp = megapixelHint(cam);
  const cameraLine = cam ? `Camera: ${cam} (${sensor}${mp})` : `Camera: unknown`;

  const focalLine = fl != null
    ? `Focal length: ${fl}mm (${focalLengthBucket(fl)})`
    : `Focal length: unknown`;

  const apertureLine = ap != null
    ? `Aperture: f/${ap} (${apertureBucket(ap)})`
    : `Aperture: unknown`;

  const shStr = sh && sh.length > 0 ? sh : 'unknown';
  const isoStr = iso != null ? `${iso}` : 'unknown';
  const aebStr = aeb != null ? `${aeb} (${bracketBucket(aeb)})` : `unknown`;
  const triLine = `Shutter: ${shStr} · ISO ${isoStr} · Bracket: ${aebStr}`;

  const risks: string[] = [];
  if (motion) risks.push('motion_blur=true (handheld shutter slower than 1/focal — expect minor motion)');
  if (highIso) risks.push('high_iso=true (ISO above 3200 — expect noise + reduced micro-contrast)');
  const riskLine = risks.length > 0 ? `Risks: ${risks.join('; ')}` : `Risks: none`;

  const impls: string[] = [];
  const fi = focalImplication(fl);
  if (fi) impls.push(fi);
  const di = dofImplication(ap);
  if (di) impls.push(di);
  const bi = bracketImplication(aeb);
  if (bi) impls.push(bi);
  if (highIso) impls.push('expect ISO noise + reduced micro-contrast — score lighting/aesthetic accordingly');
  const implLine = impls.length > 0
    ? `Implications: ${impls.join('; ')}.`
    : `Implications: insufficient metadata to derive semantic implications.`;

  return [
    '── IMAGE METADATA ──',
    cameraLine,
    focalLine,
    apertureLine,
    triLine,
    riskLine,
    implLine,
  ].join('\n');
}

export interface ExifTableRow extends ExifContextOpts {
  stem: string;
}

/**
 * Build the COMPACT per-image EXIF table for Stage 4.
 *
 * Stage 4 sees ALL images at once — rendering the full per-image block (7
 * lines × N images) would blow the prompt budget. Instead we render a
 * compact pipe-separated table (one row per image) that still gives Gemini
 * the focal/aperture/shutter/iso/bracket/risks signals it needs to reason
 * about the image set.
 *
 * Inject BEFORE the Stage 1 enrichment JSON in buildStage4UserPrompt.
 */
export function exifContextTable(rows: ExifTableRow[]): string {
  if (rows.length === 0) {
    return [
      '── PER-IMAGE METADATA ──',
      '(no per-image EXIF metadata available)',
    ].join('\n');
  }

  const header = 'stem | focal | aperture | shutter | iso | bracket | risks';
  const dataRows = rows.map((r) => {
    const stem = r.stem;
    const fl = typeof r.focalLengthMm === 'number'
      ? `${r.focalLengthMm}mm ${focalLengthBucket(r.focalLengthMm).split(' ')[0]}`
      : '?';
    const ap = typeof r.aperture === 'number' ? `f/${r.aperture}` : '?';
    const sh = r.shutterSpeed && r.shutterSpeed.length > 0 ? r.shutterSpeed : '?';
    const iso = typeof r.iso === 'number' ? `${r.iso}` : '?';
    const aeb = typeof r.aebBracketValue === 'number' ? `${r.aebBracketValue}` : '?';
    const risks: string[] = [];
    if (r.motionBlurRisk === true) risks.push('motion_blur');
    if (r.highIsoRisk === true) risks.push('high_iso');
    const riskStr = risks.length > 0 ? risks.join(',') : '-';
    return `${stem} | ${fl} | ${ap} | ${sh} | ${iso} | ${aeb} | ${riskStr}`;
  });

  return [
    '── PER-IMAGE METADATA ──',
    header,
    ...dataRows,
  ].join('\n');
}
