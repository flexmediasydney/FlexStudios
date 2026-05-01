/**
 * lensClass.ts — Wave 11.6.7 P1-4 pure derivation helper.
 *
 * Maps EXIF focal length + camera context to one of:
 *   - 'wide_angle'  (focal_length_mm ≤ 28)
 *   - 'standard'    (28 < focal ≤ 70)
 *   - 'telephoto'   (focal > 70)
 *   - 'tilt_shift'  (camera body indicates a TS lens) — explicit override
 *   - 'drone'       (drone EXIF / drone group) — explicit override
 *
 * The 'any' value (NULL on the column) means "lens class unknown" and is
 * intentionally NOT one of the derived buckets — it indicates EXIF was
 * missing or unparseable. Slots that want to accept anything use NULL on the
 * `lens_class_constraint` column rather than 'any' as a string sentinel.
 *
 * Pure — no DB calls, no env reads. Spec: docs/WAVE_7_BACKLOG.md L206-211.
 */

export const LENS_CLASSES = [
  'wide_angle',
  'standard',
  'telephoto',
  'tilt_shift',
  'drone',
] as const;

export type LensClass = (typeof LENS_CLASSES)[number];

/** Subset of the EXIF metadata payload we need to make a lens_class call. */
export interface LensClassExifInput {
  /** Focal length in millimetres (35mm-equivalent if available, else native). */
  focalLength?: number | null;
  /** Camera body / make / model string — used for tilt_shift detection. */
  cameraModel?: string | null;
  cameraMake?: string | null;
  /** Lens model string when EXIF carries it (Canon, Sony do; some lenses
   *  emit `'TS-E 24mm'` or similar tilt-shift markers). */
  lensModel?: string | null;
}

export interface DeriveLensClassOpts {
  /** Pass 0 / Pass 1 derived `is_drone` flag. When true, lens_class is
   *  forced to 'drone' regardless of focal length (drones report wide focal
   *  numbers natively but the photographic intent is sky/aerial, not the
   *  ground-truth wide_angle bucket). */
  isDrone?: boolean | null;
}

/**
 * Derive lens_class from an EXIF row + drone flag.
 *
 * Returns null when:
 *   - focal length is missing or non-finite
 *   - AND no override hint (drone, tilt_shift) applies
 *
 * Stage 1 persists the result to `composition_classifications.lens_class`.
 */
export function deriveLensClass(
  exif: LensClassExifInput | null | undefined,
  opts: DeriveLensClassOpts = {},
): LensClass | null {
  // 1. Drone override has highest priority — drone EXIF carries focal length
  //    in the wide range, but classifying drone shots as 'wide_angle' would
  //    let any drone shot fill a generic wide-angle interior slot. Drones
  //    are their own bucket.
  if (opts.isDrone === true) return 'drone';

  // 2. Tilt-shift detection from lens/camera model strings. Canon TS-E and
  //    Nikon PC-E lenses are common in real estate workflows. Lens model
  //    string `TS-E`, `PC-E`, `Tilt-Shift` is the marker.
  const lensModel = (exif?.lensModel || '').toLowerCase();
  if (
    lensModel.includes('ts-e') ||
    lensModel.includes('pc-e') ||
    lensModel.includes('tilt-shift') ||
    lensModel.includes('tilt shift')
  ) {
    return 'tilt_shift';
  }

  // 3. Focal-length buckets per spec L206-211.
  const f = exif?.focalLength;
  if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) return null;
  if (f <= 28) return 'wide_angle';
  if (f <= 70) return 'standard';
  return 'telephoto';
}
