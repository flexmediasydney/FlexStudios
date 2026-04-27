/**
 * cameraPartitioner.ts — Wave 10.1 P2-6 (W10.1).
 *
 * Pure-function partitioner that buckets a flat list of EXIF-extracted files
 * by canonical `<model>:<serial>` slug, then labels exactly one bucket as
 * the primary camera source for the round.
 *
 * No I/O, no side effects, fully unit-testable. Lives next to bracketDetector
 * so the two helpers can be composed by the Pass 0 caller without crossing
 * folder boundaries.
 *
 * Why this exists
 * ───────────────
 * Today's Pass 0 bracket detector assumes a single camera per shoot. When a
 * round has 2+ cameras (Canon R5 primary + Canon R6 / iPhone secondary), the
 * timestamps interleave through the timeline, settings-continuity breaks
 * mid-bracket, and the detector emits junk groups. The fix is to partition
 * the input upstream by camera source: detect each unique `<model>:<serial>`
 * tuple, run the bracket detector ONLY on the primary partition, and emit
 * secondary-camera files as singletons.
 *
 * The orchestrator's Q1-Q3 resolutions (per the design spec):
 *   Q1 — primary = largest bucket; ties broken by Canon model > non-Canon.
 *   Q2 — binary `is_secondary_camera` for v1; tier system deferred.
 *   Q3 — drift validation deferred to a future wave (TODO below).
 *
 * Edge-case handling
 * ──────────────────
 *   - Missing bodySerial collapses to "<model>:unknown" so every file from
 *     the same model with no readable serial buckets together (the desired
 *     iPhone behaviour: multiple iPhones look like one source, which the
 *     editor treats as a single secondary group).
 *   - Missing cameraModel collapses to "unknown:<serial>" — a defensive
 *     fallback; in practice every file we ingest carries a Model tag.
 *   - iPhone files never beat Canon files for primary, even with higher file
 *     counts. The "primary photographer's main body" intuition trumps a
 *     burst of phone snaps.
 *
 * TODO (W10 follow-up): per Q3, the partitioner does NOT validate inter-
 * camera timing drift (e.g. R5 clock at 12:00:00 vs R6 clock at 11:59:50
 * because the photographers didn't sync). A future wave should add a
 * sanity-check helper that flags suspect partitions when secondary-camera
 * timestamps fall inside primary-camera burst windows by more than the
 * GAP_MS threshold — that's a sign of clock drift, not a real second body.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal projection over the EXIF response that the partitioner needs. The
 * Pass 0 caller can pass a richer object (any shape extending this type works)
 * but the helper only reads these three fields.
 */
export interface ExifMinimal {
  /** File stem without extension, e.g. "IMG_1234". */
  stem: string;
  /** EXIF Model tag value, e.g. "Canon EOS R5" or null when unreadable. */
  cameraModel: string | null;
  /** EXIF body serial (SerialNumber / BodySerialNumber), e.g. "01234567890" or null. */
  bodySerial: string | null;
}

/**
 * One bucket of files bound to a single camera source. The partitioner emits
 * one of these per unique camera_source in the input, exactly one of which
 * has `isPrimary=true`.
 */
export interface CameraPartition<T extends ExifMinimal = ExifMinimal> {
  /** Canonical "<model>:<serial>" slug, e.g. "canon-eos-r5:01234567890". */
  cameraSource: string;
  /** Files belonging to this camera source (input order preserved). */
  files: T[];
  /** Exactly one partition in the result has isPrimary=true. */
  isPrimary: boolean;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Lowercase + slug a single EXIF string component. Non-alphanumerics collapse
 * to '-', leading/trailing '-' stripped. Identical to the engine's other
 * slug-style identifiers (engine_role, tier_code) for visual consistency.
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the canonical "<model>:<serial>" slug. Either or both inputs may be
 * null/empty; missing values become 'unknown' so files with the same model
 * but no readable serial bucket together cleanly.
 */
export function canonicalCameraSource(
  cameraModel: string | null | undefined,
  bodySerial: string | null | undefined,
): string {
  const modelRaw = (cameraModel ?? '').toString().trim();
  const serialRaw = (bodySerial ?? '').toString().trim();
  const modelPart = slug(modelRaw) || 'unknown';
  const serialPart = slug(serialRaw) || 'unknown';
  return `${modelPart}:${serialPart}`;
}

/**
 * Detect Canon model from the source slug. Used by the primary tie-break.
 */
function isCanon(cameraSource: string): boolean {
  return cameraSource.startsWith('canon-');
}

/**
 * Detect iPhone / Apple from the source slug. iPhone files never claim
 * primary even when they outnumber the Canon files — the editor's intuition
 * is "the camera I shot most with on a real body is primary".
 */
function isIPhone(cameraSource: string): boolean {
  // Apple HEIC EXIF Make=Apple, Model="iPhone 14 Pro" → slug
  // "apple-iphone-14-pro" or sometimes just "iphone-14-pro" depending on
  // whether the Modal worker concatenates Make+Model. Match either prefix.
  return (
    cameraSource.startsWith('iphone-') ||
    cameraSource.startsWith('apple-') ||
    cameraSource.startsWith('apple:') ||
    cameraSource.includes(':iphone')
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Bucket files by canonical camera_source slug; designate exactly one bucket
 * as primary per the orchestrator's tie-break rules.
 *
 * Primary selection (in order):
 *   1. Largest file count wins.
 *   2. iPhone files NEVER beat Canon files, regardless of count. If the
 *      largest bucket is iPhone but a Canon bucket exists, Canon wins.
 *   3. Tie at file count: Canon model wins over non-Canon non-iPhone (Sony,
 *      etc.).
 *   4. If both buckets are Canon and tied: lexically smaller cameraSource
 *      wins (deterministic — same input always picks the same primary).
 *
 * Empty input returns []. Single source returns one partition with
 * isPrimary=true.
 */
export function partitionByCamera<T extends ExifMinimal = ExifMinimal>(
  files: T[],
): CameraPartition<T>[] {
  if (files.length === 0) return [];

  // Bucket by canonical source. Map preserves first-seen-key insertion order
  // which we use as a stable secondary tie-break for matching iPhone vs
  // iPhone (or any tied non-Canon vs non-Canon).
  const byCamera = new Map<string, T[]>();
  for (const f of files) {
    const key = canonicalCameraSource(f.cameraModel, f.bodySerial);
    if (!byCamera.has(key)) byCamera.set(key, []);
    byCamera.get(key)!.push(f);
  }

  const entries = [...byCamera.entries()];

  // Primary selection: rank candidates and take the top.
  // Ranking lower number = better candidate.
  type Ranked = {
    key: string;
    files: T[];
    isCanon: boolean;
    isIPhone: boolean;
    count: number;
  };
  const ranked: Ranked[] = entries.map(([key, fs]) => ({
    key,
    files: fs,
    isCanon: isCanon(key),
    isIPhone: isIPhone(key),
    count: fs.length,
  }));

  ranked.sort((a, b) => {
    // 1. iPhone always loses to non-iPhone. Two iPhones tie below.
    if (a.isIPhone !== b.isIPhone) {
      return a.isIPhone ? 1 : -1;
    }
    // 2. Canon always beats non-Canon (after iPhone has been demoted).
    if (a.isCanon !== b.isCanon) {
      return a.isCanon ? -1 : 1;
    }
    // 3. Larger count wins.
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    // 4. Deterministic tie-break: lexically smaller key wins. For two Canon
    //    R5 bodies tied at the same count this picks the smaller serial,
    //    matching the spec's "deterministic" requirement.
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const primaryKey = ranked[0]?.key ?? null;

  // Emit partitions in the original Map insertion order so callers can rely
  // on a stable shape (the test suite asserts on it).
  return entries.map(([cameraSource, partitionFiles]) => ({
    cameraSource,
    files: partitionFiles,
    isPrimary: cameraSource === primaryKey,
  }));
}
