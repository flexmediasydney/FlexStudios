/**
 * droneShortlist
 * ──────────────
 * Smart-shortlist recommendation for the drone curation flow.
 *
 * Given a list of drone_shots eligible for delivery (i.e.
 * `lifecycle_state='raw_proposed' AND shot_role !== 'nadir_grid'`), pick the
 * top N to flag as `is_ai_recommended=true`. The operator still has the final
 * call — this just pre-fills the curated set.
 *
 * Algorithm
 *   1. Reject shots with |flight_roll| > FLIGHT_ROLL_REJECT_DEG (motion-blur
 *      proxy — drone tilted hard at moment of capture).
 *   2. Group near-duplicates: shots within DEDUP_TIME_WINDOW_SEC AND within
 *      DEDUP_LATLNG_DEG (~10m at Sydney) AND yaw delta ≤ DEDUP_YAW_DELTA_DEG.
 *      Within each group, keep the lowest-|flight_roll| shot (tiebreak: earliest
 *      captured_at, then lexicographically smallest id for stability).
 *   3. Cap result at `cap` (default DEFAULT_SHORTLIST_CAP). Order chronologically
 *      by captured_at ASC.
 *
 * Returns the array of `drone_shots.id` values to flag.
 *
 * Design notes
 *   - Pure function — no DB access, no I/O, fully unit-testable.
 *   - Inputs that are missing GPS or timestamps are treated as "ungroupable"
 *     and flow through the dedupe step as standalone (they can still be
 *     selected if their roll passes). This keeps the function defensive when
 *     fed from real ingest data.
 *   - Yaw wrap-around (e.g. 350° vs 5°) is handled via the smaller arc.
 */

export interface ShortlistableShot {
  id: string;
  captured_at: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  flight_yaw: number | null;
  flight_roll: number | null;
  shot_role: string;
}

export const DEFAULT_SHORTLIST_CAP = 12;
export const FLIGHT_ROLL_REJECT_DEG = 10;
export const DEDUP_TIME_WINDOW_SEC = 5;
export const DEDUP_LATLNG_DEG = 0.0001; // ~10m at Sydney latitude
export const DEDUP_YAW_DELTA_DEG = 15;

/**
 * Smallest absolute angular difference between two yaws, in degrees, on the
 * 0–360 wrap. Returns a value in [0, 180].
 */
function yawDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Magnitude of roll, normalised to a positive degree value. Treats NaN/null as
 * Infinity so they fail the roll gate.
 */
function rollMag(roll: number | null): number {
  if (roll === null || !Number.isFinite(roll)) return Number.POSITIVE_INFINITY;
  return Math.abs(roll);
}

/**
 * Two shots are duplicates iff:
 *   - both have parseable captured_at AND |Δt| ≤ DEDUP_TIME_WINDOW_SEC
 *   - both have parseable gps AND |Δlat| ≤ DEDUP_LATLNG_DEG AND |Δlon| ≤ DEDUP_LATLNG_DEG
 *   - both have parseable yaw AND yawDelta ≤ DEDUP_YAW_DELTA_DEG
 * If any of those signals are missing on either side, the shots are NOT
 * considered duplicates (defensive: don't accidentally collapse different
 * shots when EXIF was incomplete).
 */
function areDuplicates(a: ShortlistableShot, b: ShortlistableShot): boolean {
  const ta = a.captured_at ? Date.parse(a.captured_at) : NaN;
  const tb = b.captured_at ? Date.parse(b.captured_at) : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  if (Math.abs(ta - tb) > DEDUP_TIME_WINDOW_SEC * 1000) return false;

  if (
    a.gps_lat === null || a.gps_lon === null ||
    b.gps_lat === null || b.gps_lon === null ||
    !Number.isFinite(a.gps_lat) || !Number.isFinite(a.gps_lon) ||
    !Number.isFinite(b.gps_lat) || !Number.isFinite(b.gps_lon)
  ) return false;
  if (Math.abs(a.gps_lat - b.gps_lat) > DEDUP_LATLNG_DEG) return false;
  if (Math.abs(a.gps_lon - b.gps_lon) > DEDUP_LATLNG_DEG) return false;

  if (
    a.flight_yaw === null || b.flight_yaw === null ||
    !Number.isFinite(a.flight_yaw) || !Number.isFinite(b.flight_yaw)
  ) return false;
  if (yawDelta(a.flight_yaw, b.flight_yaw) > DEDUP_YAW_DELTA_DEG) return false;

  return true;
}

/**
 * Pick AI-recommended shortlist ids. See module docstring for the algorithm.
 */
export function pickAiShortlist(
  shots: ShortlistableShot[],
  cap = DEFAULT_SHORTLIST_CAP,
): string[] {
  if (!Array.isArray(shots) || shots.length === 0) return [];
  if (cap <= 0) return [];

  // ── 1. Roll filter ────────────────────────────────────────────────
  const rollOk = shots.filter((s) => rollMag(s.flight_roll) <= FLIGHT_ROLL_REJECT_DEG);
  if (rollOk.length === 0) return [];

  // ── 2. Group near-duplicates (single-pass union-find on a sorted list) ──
  // Sort by captured_at ASC so the time-window check only needs to look back
  // a small constant window (we still do an O(n²) pairwise sweep, but bail
  // out of the inner loop as soon as Δt exceeds the window). This keeps the
  // algorithm correct even when GPS/yaw differ wildly between captures.
  const sorted = [...rollOk].sort((a, b) => {
    const ta = a.captured_at ? Date.parse(a.captured_at) : Number.POSITIVE_INFINITY;
    const tb = b.captured_at ? Date.parse(b.captured_at) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  // parent[i] = index of group representative
  const parent: number[] = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression halving
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // Early exit when the time gap definitely exceeds the window. Both
      // sides may lack a parseable timestamp; in that case areDuplicates
      // already returns false and we just keep scanning.
      const ti = sorted[i].captured_at ? Date.parse(sorted[i].captured_at!) : NaN;
      const tj = sorted[j].captured_at ? Date.parse(sorted[j].captured_at!) : NaN;
      if (Number.isFinite(ti) && Number.isFinite(tj)) {
        if (tj - ti > DEDUP_TIME_WINDOW_SEC * 1000) break;
      }
      if (areDuplicates(sorted[i], sorted[j])) union(i, j);
    }
  }

  // Bucket by group rep, pick best per group.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }

  const winners: ShortlistableShot[] = [];
  for (const idxs of groups.values()) {
    let bestIdx = idxs[0];
    for (let k = 1; k < idxs.length; k++) {
      const cand = sorted[idxs[k]];
      const best = sorted[bestIdx];
      const candRoll = rollMag(cand.flight_roll);
      const bestRoll = rollMag(best.flight_roll);
      if (candRoll < bestRoll) {
        bestIdx = idxs[k];
        continue;
      }
      if (candRoll === bestRoll) {
        // Tiebreak: earliest captured_at, then lex-smallest id.
        const ct = cand.captured_at ? Date.parse(cand.captured_at) : Number.POSITIVE_INFINITY;
        const bt = best.captured_at ? Date.parse(best.captured_at) : Number.POSITIVE_INFINITY;
        if (ct < bt || (ct === bt && cand.id < best.id)) {
          bestIdx = idxs[k];
        }
      }
    }
    winners.push(sorted[bestIdx]);
  }

  // ── 3. Order chronologically ASC, cap to N ───────────────────────
  winners.sort((a, b) => {
    const ta = a.captured_at ? Date.parse(a.captured_at) : Number.POSITIVE_INFINITY;
    const tb = b.captured_at ? Date.parse(b.captured_at) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  return winners.slice(0, cap).map((s) => s.id);
}
