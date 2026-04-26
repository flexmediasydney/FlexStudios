/**
 * bracketDetector.ts — pure bracket-grouping logic for Pass 0 of the
 * shortlisting engine. No I/O, no side effects, fully unit-testable.
 *
 * Per spec section 4.3 (5-Shot Maximum Enforcement):
 *
 *   1. Primary grouping: walk files sorted by capture timestamp; start a new
 *      group when the gap between consecutive shots exceeds GAP_MS (4 s),
 *      OR when key camera settings change (camera model / aperture /
 *      focal length / ISO).
 *
 *   2. CRITICAL v2 enforcement: any group containing > 5 files is split into
 *      5-shot chunks at the 5→6 boundary. Chunks 2..N inherit the group
 *      metadata but carry `isMicroAdjustmentSplit: true` — they're the
 *      micro-adjustment re-shoots that v1 missed.
 *
 *   3. Validation: total groups × 5 ≈ totalFiles within ±2 (allowance for
 *      intentional singles or incomplete final brackets).
 *
 * The grouping is deliberately tolerant of AEB tag drift — we DO use the
 * Canon AEBBracketValue when present (a non-null AEB run with the same shutter
 * progression is a strong signal), but we don't require it. EXIF subseconds
 * + shutter+aperture+ISO continuity are the load-bearing signals; AEB-zero
 * resets are a corroborating signal.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExifSignals {
  fileName: string;
  cameraModel: string;
  shutterSpeed: string;
  shutterSpeedValue: number;
  aperture: number;
  iso: number;
  focalLength: number;
  /** Canon AEBBracketValue: typically -2.667, -1.333, 0, +1.333, +2.667 — or null when not bracketed. */
  aebBracketValue: number | null;
  dateTimeOriginal: string;
  subSecTimeOriginal: string;
  /** Combined dateTimeOriginal+subSec → epoch ms, computed by Pass 0 caller. */
  captureTimestampMs: number;
  orientation: string;
  motionBlurRisk: boolean;
  highIsoRisk: boolean;
}

export interface BracketGroup {
  files: ExifSignals[];
  /** Length === 5. */
  isComplete: boolean;
  /** True if this chunk was split out of a > 5 raw group (micro-adjustment re-shoot). */
  isMicroAdjustmentSplit: boolean;
  cameraModel: string;
  /** Earliest captureTimestampMs in the group. */
  primaryTimestampMs: number;
}

export interface ValidationResult {
  ok: boolean;
  expected: number;
  actual: number;
  drift: number;
  warnings: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max gap between two consecutive shots in the same bracket. */
const GAP_MS = 4_000;

/** Aperture / focal length tolerance — small floating-point drift is fine. */
const APERTURE_EPSILON = 0.05;
const FOCAL_LENGTH_EPSILON = 0.5;

/** v2 critical: hard cap on shots per group, regardless of timestamp gap. */
const MAX_FILES_PER_GROUP = 5;

/** Validation drift allowance — see spec §4.3 final paragraph. */
const VALIDATION_DRIFT_TOLERANCE = 2;

// ─── Internal helpers ────────────────────────────────────────────────────────

function settingsContinuous(prev: ExifSignals, curr: ExifSignals): boolean {
  if (prev.cameraModel !== curr.cameraModel) return false;
  if (Math.abs(prev.aperture - curr.aperture) > APERTURE_EPSILON) return false;
  if (Math.abs(prev.focalLength - curr.focalLength) > FOCAL_LENGTH_EPSILON) return false;
  if (prev.iso !== curr.iso) return false;
  // Burst 3 I4: AEB nullability transition is a hard break — a non-bracketed
  // test shot followed immediately by an AEB sequence (or vice versa) must
  // NOT merge into one group even with same camera settings + tight timestamp,
  // otherwise the 5-shot max enforcement produces a heterogeneous group + an
  // orphan. Real-world: photographer fires a manual-exposure test, switches
  // to AEB mode, fires the 5-bracket sequence within 4s.
  if ((prev.aebBracketValue == null) !== (curr.aebBracketValue == null)) return false;
  return true;
}

/**
 * AEB-aware boundary check: if both sides have non-null AEB and the new shot's
 * AEB equals the FIRST AEB of the current group, that's a clean restart of
 * the bracket sequence — start a new group even if the timestamp gap is small.
 *
 * Example Canon AEB sequence repeating: [-2.667, -1.333, 0, +1.333, +2.667,
 * -2.667, -1.333, ...]. Without this, two back-to-back identical bursts
 * fired with no tripod move (same settings) would merge into a 10-shot
 * group.
 */
function aebSequenceRestart(group: ExifSignals[], curr: ExifSignals): boolean {
  if (group.length === 0) return false;
  const first = group[0];
  if (first.aebBracketValue == null || curr.aebBracketValue == null) return false;
  if (group.length < 2) return false;
  // Only call it a restart when the current AEB matches the FIRST one in the
  // group AND the previous shot was non-first AEB (i.e. mid/late in a sweep).
  const prev = group[group.length - 1];
  if (prev.aebBracketValue === first.aebBracketValue) return false;
  return Math.abs(curr.aebBracketValue - first.aebBracketValue) < 0.01;
}

function buildGroup(files: ExifSignals[], isMicroAdjustmentSplit: boolean): BracketGroup {
  const sorted = [...files].sort((a, b) => a.captureTimestampMs - b.captureTimestampMs);
  return {
    files: sorted,
    isComplete: sorted.length === MAX_FILES_PER_GROUP,
    isMicroAdjustmentSplit,
    cameraModel: sorted[0]?.cameraModel || '',
    primaryTimestampMs: sorted[0]?.captureTimestampMs || 0,
  };
}

/**
 * Step 1: primary grouping by AEB tag + timestamp ≤ GAP_MS gap + camera
 * settings continuity. Does NOT enforce the 5-shot maximum yet — that's
 * step 2 (the v2 critical change).
 */
function primaryGrouping(files: ExifSignals[]): ExifSignals[][] {
  if (files.length === 0) return [];

  const sorted = [...files].sort((a, b) => a.captureTimestampMs - b.captureTimestampMs);
  const groups: ExifSignals[][] = [];
  let current: ExifSignals[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.captureTimestampMs - prev.captureTimestampMs;
    const breaksOnGap = gap > GAP_MS;
    const breaksOnSettings = !settingsContinuous(prev, curr);
    const breaksOnAebRestart = aebSequenceRestart(current, curr);

    if (breaksOnGap || breaksOnSettings || breaksOnAebRestart) {
      groups.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Group files into bracket groups and enforce 5-shot maximum.
 *
 * Two-step pipeline (per spec §4.3):
 *   1. Primary grouping by AEB / timestamp / settings.
 *   2. v2 enforcement: split any group of > 5 into 5-chunks; mark chunk 2..N
 *      with isMicroAdjustmentSplit=true.
 *
 * Caller should sort the result by primaryTimestampMs if a deterministic
 * group order is needed (it already is — primary groups are walked in input
 * order which itself is sorted by timestamp).
 */
export function groupIntoBrackets(files: ExifSignals[]): BracketGroup[] {
  const rawGroups = primaryGrouping(files);
  const finalGroups: BracketGroup[] = [];

  for (const rawGroup of rawGroups) {
    if (rawGroup.length <= MAX_FILES_PER_GROUP) {
      finalGroups.push(buildGroup(rawGroup, false));
      continue;
    }
    // Split at every 5-shot boundary. The first chunk is NOT a micro-
    // adjustment split (it's the original bracket); subsequent chunks ARE.
    for (let i = 0; i < rawGroup.length; i += MAX_FILES_PER_GROUP) {
      const chunk = rawGroup.slice(i, i + MAX_FILES_PER_GROUP);
      const isSplit = i > 0;
      finalGroups.push(buildGroup(chunk, isSplit));
    }
  }
  return finalGroups;
}

/**
 * Validate bracket count vs total files. Returns ok=false (with a warning)
 * when drift > ±VALIDATION_DRIFT_TOLERANCE — Pass 0 caller surfaces this in
 * shortlisting_events but still proceeds with the groups it has.
 */
export function validateBracketCounts(
  groups: BracketGroup[],
  totalFiles: number,
): ValidationResult {
  const expected = totalFiles / MAX_FILES_PER_GROUP;
  const actual = groups.length;
  const drift = actual - expected;
  const warnings: string[] = [];

  if (Math.abs(drift) > VALIDATION_DRIFT_TOLERANCE) {
    warnings.push(
      `Bracket count anomaly: expected ~${expected.toFixed(1)} groups for ${totalFiles} files, got ${actual} (drift ${drift > 0 ? '+' : ''}${drift.toFixed(1)})`,
    );
  }

  // Soft-warn on incomplete groups: a group whose length !== 5 is either an
  // incomplete final bracket (operator stopped early) or a singleton (single-
  // shot composition). Both are legal but worth surfacing.
  const incomplete = groups.filter((g) => !g.isComplete).length;
  if (incomplete > 0) {
    warnings.push(`${incomplete} group(s) have file_count !== 5 (incomplete brackets or singletons)`);
  }

  return {
    ok: warnings.length === 0,
    expected,
    actual,
    drift,
    warnings,
  };
}
