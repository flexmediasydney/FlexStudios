/**
 * Drone ingestion pure helpers.
 *
 * Pulled out of `drone-ingest/index.ts` so they can be unit-tested in isolation
 * (no Dropbox / Supabase clients required). The Edge Function composes these
 * functions with the network IO.
 *
 * Three pure responsibilities:
 *   - extractExifFromBytes(): runs ExifReader against JPG bytes and returns the
 *     fields we care about (GPS, gimbal, flight yaw, altitude, capture time,
 *     drone model). DJI puts the interesting metadata in XMP, not standard
 *     EXIF, so we use ExifReader's expanded=true mode.
 *   - parseDjiFilename(): extracts the (timestamp, index) tuple from
 *     `DJI_<ts>_<index>_<suffix>.JPG` filenames. Returns null when the filename
 *     does not match the DJI pattern.
 *   - classifyShotRole(): pure rule-based classifier. Per
 *     IMPLEMENTATION_PLAN_V2 §2.3 ingestion rules:
 *       gimbal_pitch ≤ -85°                              → nadir_grid
 *       relative_altitude > 40m AND -30° ≤ pitch ≤ -5°   → orbital
 *       relative_altitude > 25m AND pitch < -30°         → oblique_hero
 *       relative_altitude < 10m                          → ground_level
 *       otherwise                                        → unclassified
 *   - groupShotsIntoShoots(): clusters shots by their captured_at timestamp.
 *     A gap > 30 minutes between consecutive shots starts a new shoot.
 *
 * Imports ExifReader via `npm:` specifier — Supabase Edge Runtime supports
 * npm specifiers natively (Deno 1.40+). We pin a major version (^4) so minor
 * upgrades land on a function redeploy without manual bumps.
 */

// deno-lint-ignore-file no-explicit-any
import ExifReader from 'npm:exifreader@4';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractedExif {
  /** ISO-8601 timestamp; null when DateTimeOriginal absent. */
  captured_at: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  /** AGL altitude in metres (DJI XMP RelativeAltitude); null when absent. */
  relative_altitude: number | null;
  /** GPS-derived altitude (EXIF GPSAltitude); kept for fallback. */
  gps_altitude: number | null;
  flight_yaw: number | null;
  gimbal_pitch: number | null;
  gimbal_roll: number | null;
  flight_roll: number | null;
  gps_status: string | null;
  drone_model: string | null;
  /** Full raw EXIF blob (for audit and debugging). */
  raw: Record<string, unknown>;
}

export interface DjiFilenameInfo {
  /** YYYYMMDDHHmmss-style timestamp string from filename (informational only — captured_at is the source of truth). */
  timestamp_str: string;
  /** Numeric DJI sequence number (e.g. 0773). */
  dji_index: number;
  /** Trailing variant tag (D = standard, S = subject, T = thermal, etc.). */
  suffix: string;
}

export type ShotRole =
  | 'nadir_grid'
  | 'orbital'
  | 'oblique_hero'
  | 'ground_level'
  | 'unclassified';

export interface ClassifiableShot {
  gimbal_pitch: number | null;
  relative_altitude: number | null;
}

export interface GroupableShot {
  /** ISO-8601 timestamp. Shots with null captured_at fall into the last cluster (or a new one if first). */
  captured_at: string | null;
}

// ─── DJI filename parsing ────────────────────────────────────────────────────

// Case-insensitive on the prefix so Dropbox-style lowercased filenames
// (e.g. `dji_20260420094122_0773_d.jpg`) still parse and get assigned a
// dji_index. The trailing role suffix is also normalised to upper-case for
// consistent indexing downstream. (#17 audit fix)
const DJI_FILENAME_RE = /^dji_(\d{8,14})_(\d{4})_([a-z]+)\.(?:jpe?g|dng)$/i;

export function parseDjiFilename(filename: string): DjiFilenameInfo | null {
  const m = filename.match(DJI_FILENAME_RE);
  if (!m) return null;
  return {
    timestamp_str: m[1],
    dji_index: parseInt(m[2], 10),
    suffix: m[3].toUpperCase(),
  };
}

// ─── EXIF extraction ─────────────────────────────────────────────────────────

/**
 * Convert ExifReader's GPS coordinate format to a signed decimal.
 *
 * ExifReader (with expanded=true) returns GPSLatitude.description as a decimal
 * string already, but in legacy mode it returns the {degrees, minutes, seconds}
 * tuple. Reference code is the .description string when present; tuple
 * fallback otherwise.
 */
function readGpsCoordinate(tag: any, ref: any): number | null {
  if (!tag) return null;
  const refValue: string =
    (typeof ref === 'object' && ref?.value) ||
    (typeof ref === 'object' && ref?.description) ||
    (typeof ref === 'string' ? ref : '') ||
    '';
  let dec: number | null = null;

  if (typeof tag.description === 'string' && tag.description.length > 0) {
    const parsed = parseFloat(tag.description);
    if (!Number.isNaN(parsed)) dec = parsed;
  }

  if (dec === null && Array.isArray(tag.value) && tag.value.length === 3) {
    // Each entry is either a [num, den] pair or already a number.
    const toNum = (v: any) =>
      Array.isArray(v) && v.length === 2 ? v[0] / v[1] : Number(v);
    const [d, m, s] = tag.value.map(toNum);
    dec = d + m / 60 + s / 3600;
  }

  if (dec === null) return null;

  // Ref letter S/W → negative.
  const negRef = /[SW]/i.test(refValue);
  return negRef ? -Math.abs(dec) : Math.abs(dec);
}

function readNumericTag(tag: any): number | null {
  if (!tag) return null;
  if (typeof tag.value === 'number') return tag.value;
  if (Array.isArray(tag.value) && tag.value.length === 2) {
    // rational [num, den]
    const num = Number(tag.value[0]);
    const den = Number(tag.value[1]);
    if (!Number.isNaN(num) && !Number.isNaN(den) && den !== 0) return num / den;
  }
  if (typeof tag.description === 'string') {
    const parsed = parseFloat(tag.description);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof tag.value === 'string') {
    const parsed = parseFloat(tag.value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function readStringTag(tag: any): string | null {
  if (!tag) return null;
  if (typeof tag.description === 'string' && tag.description.length > 0) return tag.description;
  if (typeof tag.value === 'string') return tag.value;
  if (Array.isArray(tag.value)) return tag.value.join('').trim() || null;
  return null;
}

/**
 * Convert EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") to ISO-8601.
 * Treats the string as UTC if no offset present (DJI does not record offset).
 * The drone clock is set in the field, so this UTC interpretation is a
 * known-and-accepted approximation; downstream filters should not assume the
 * timestamp is true UTC, only that it monotonically increases within a flight.
 */
export function djiDateTimeToIso(s: string | null): string | null {
  if (!s) return null;
  // DJI: "2026:04:20 09:41:22"
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    // Try Date.parse fallback for already-ISO inputs (e.g. XMP CreateDate).
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const [, y, mo, d, h, mi, se] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Run ExifReader over a JPG buffer and project the fields we persist.
 * Throws on completely-unreadable input (truncated header). Missing optional
 * fields are returned as null without throwing.
 */
export function extractExifFromBytes(bytes: Uint8Array | ArrayBuffer): ExtractedExif {
  // ExifReader.load accepts ArrayBuffer / Buffer. expanded=true exposes XMP at
  // tags.xmp.<key>; without it XMP fields land in a flat namespace and clash
  // with EXIF same-named keys. includeUnknown=false keeps the audit blob lean.
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const tags = (ExifReader as any).load(buf, { expanded: true, includeUnknown: false });

  const exif = tags.exif || {};
  const xmp = tags.xmp || {};
  const gps = tags.gps || {};
  const file = tags.file || {};

  // Capture time: prefer XMP CreateDate (DJI writes both — same value), fall
  // back to EXIF DateTimeOriginal.
  const dtRaw =
    readStringTag(xmp.CreateDate) ||
    readStringTag(exif.DateTimeOriginal) ||
    readStringTag(exif.DateTime) ||
    null;
  const captured_at = djiDateTimeToIso(dtRaw);

  // Drone model: "DJI Mavic 3" etc.
  const drone_model =
    readStringTag(exif.Model) ||
    readStringTag(file.Model) ||
    readStringTag(xmp.Model) ||
    null;

  // GPS — use ExifReader's normalised gps namespace when available; fall back
  // to raw EXIF tags otherwise.
  let gps_lat: number | null = null;
  let gps_lon: number | null = null;
  if (typeof gps.Latitude === 'number') gps_lat = gps.Latitude;
  if (typeof gps.Longitude === 'number') gps_lon = gps.Longitude;
  if (gps_lat === null) gps_lat = readGpsCoordinate(exif.GPSLatitude, exif.GPSLatitudeRef);
  if (gps_lon === null) gps_lon = readGpsCoordinate(exif.GPSLongitude, exif.GPSLongitudeRef);

  // GPS altitude (EXIF) — fallback when XMP RelativeAltitude is missing.
  let gps_altitude: number | null = null;
  if (typeof gps.Altitude === 'number') gps_altitude = gps.Altitude;
  if (gps_altitude === null) gps_altitude = readNumericTag(exif.GPSAltitude);

  // DJI XMP fields — these are the load-bearing values for shot classification
  // and SfM bootstrapping.
  const relative_altitude = readNumericTag(xmp.RelativeAltitude);
  const flight_yaw = readNumericTag(xmp.FlightYawDegree);
  const gimbal_pitch = readNumericTag(xmp.GimbalPitchDegree);
  const gimbal_roll = readNumericTag(xmp.GimbalRollDegree);
  const flight_roll = readNumericTag(xmp.FlightRollDegree);
  // GPSStatus lives in the EXIF GPS IFD, not XMP. ExifReader exposes it as
  // exif.GPSStatus with value=['A'|'V'] and a human-readable description.
  // (DJI XMP does NOT carry a GpsStatus tag; the spec's name is misleading.)
  const gps_status =
    readStringTag(exif.GPSStatus) ||
    readStringTag((xmp as any).GpsStatus) ||
    null;

  return {
    captured_at,
    gps_lat,
    gps_lon,
    relative_altitude,
    gps_altitude,
    flight_yaw,
    gimbal_pitch,
    gimbal_roll,
    flight_roll,
    gps_status,
    drone_model,
    raw: tags as Record<string, unknown>,
  };
}

// ─── Shot classification ─────────────────────────────────────────────────────

/**
 * Classify a shot by gimbal pitch + altitude. See module docstring for rules.
 *
 * Notes on the boundary conditions (intentional, not lazy):
 *   - The ≤ -85° nadir threshold accommodates DJI grid missions which are
 *     spec'd at -90° but typically read -85.x° to -89.x° at rest.
 *   - The orbital pitch band is -30° to -5° (inclusive). Pitches between 0°
 *     and -5° are typically static / hover (camera level) — we mark those
 *     unclassified rather than orbital.
 *   - We rely on relative_altitude (XMP RelativeAltitude). When that field is
 *     missing (older firmware, GPS lock failure), the classifier returns
 *     'unclassified' rather than guessing.
 */
export function classifyShotRole(shot: ClassifiableShot): ShotRole {
  const pitch = shot.gimbal_pitch;
  const alt = shot.relative_altitude;

  if (pitch !== null && pitch <= -85) return 'nadir_grid';
  if (alt !== null && alt < 10) return 'ground_level';
  if (pitch !== null && alt !== null) {
    if (alt > 40 && pitch >= -30 && pitch <= -5) return 'orbital';
    if (alt > 25 && pitch < -30) return 'oblique_hero';
  }
  return 'unclassified';
}

// ─── Shoot grouping ──────────────────────────────────────────────────────────

const SHOOT_GAP_MS = 30 * 60 * 1000; // 30 minutes

export interface ShootGroup<T extends GroupableShot> {
  /** ISO-8601 of the first shot in this group. */
  flight_started_at: string;
  /** ISO-8601 of the last shot in this group. */
  flight_ended_at: string;
  shots: T[];
}

/**
 * Split a list of shots into shoot groups by clustering on captured_at.
 *
 * Algorithm:
 *   1. Filter out shots without captured_at (cannot be clustered → returned
 *      as a separate "uncategorised" group at the end if any exist).
 *   2. Sort the remaining shots ascending by captured_at.
 *   3. Walk sorted: when the gap from the previous shot exceeds SHOOT_GAP_MS,
 *      start a new group.
 *
 * Stable: the order of shots within each group matches captured_at ascending.
 * A "shoot" with no captured_at-bearing shots is omitted (caller should
 * separately handle the no-timestamp bucket if it cares).
 */
export function groupShotsIntoShoots<T extends GroupableShot>(shots: T[]): ShootGroup<T>[] {
  const dated = shots
    .filter((s) => s.captured_at && !Number.isNaN(Date.parse(s.captured_at)))
    .map((s) => ({ shot: s, t: Date.parse(s.captured_at!) }))
    .sort((a, b) => a.t - b.t);

  if (dated.length === 0) return [];

  const groups: ShootGroup<T>[] = [];
  let current: { items: T[]; first: number; last: number } | null = null;

  for (const { shot, t } of dated) {
    if (!current) {
      current = { items: [shot], first: t, last: t };
      continue;
    }
    if (t - current.last > SHOOT_GAP_MS) {
      groups.push({
        flight_started_at: new Date(current.first).toISOString(),
        flight_ended_at: new Date(current.last).toISOString(),
        shots: current.items,
      });
      current = { items: [shot], first: t, last: t };
    } else {
      current.items.push(shot);
      current.last = t;
    }
  }

  if (current) {
    groups.push({
      flight_started_at: new Date(current.first).toISOString(),
      flight_ended_at: new Date(current.last).toISOString(),
      shots: current.items,
    });
  }

  return groups;
}

/**
 * Threshold (count) of nadir_grid shots required to flag a shoot as having a
 * usable nadir grid. SfM benefits significantly from ≥10 nadir frames
 * (Aukerman test: 39/39 registration at ~14 nadir + ~25 orbital).
 */
export const NADIR_GRID_MIN_SHOTS = 10;
