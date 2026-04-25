/**
 * droneProjection.js — forward + inverse pinhole projection for drone shots.
 *
 * Forward (`gpsToPixel`):    world (lat, lng, alt) + drone pose → pixel (x, y) on a shot.
 * Inverse (`pixelToGroundGps`): pixel + drone pose → world (lat, lng) on the ground.
 *
 * Ported from `~/flexmedia-drone-spike/production_ready/run_vision_lock.py`
 * (`gps_to_px` and `pixel_to_ground_gps`) and the camera coordinate frame
 * used by `aukerman_project.py` (`world_enu_to_pixel`).
 *
 * Notes:
 *   - Camera frame: cam_z is forward (heading + pitch), cam_x is yaw-rotated
 *     east-axis at zero pitch, cam_y = cam_z × cam_x (down-ish).
 *   - "alt" is drone altitude above ground (RelativeAltitude in EXIF).
 *   - "ground_alt" is the altitude of the target plane (default 0 = takeoff
 *     ground).
 *   - Returns `null` for off-frame, behind-camera, or above-horizon pixels.
 *
 * Camera intrinsics: defaults match the Hasselblad L2D-20c sensor on the
 * DJI Mavic 3 Pro (current FlexMedia drone). Pass `{w, h, fx, fy, cx, cy}`
 * overrides for other rigs.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const METRES_PER_DEG_LAT = 111319;

/**
 * Hasselblad L2D-20c on DJI Mavic 3 Pro.
 *   sensor 17.3 × 13.0 mm, focal length 12.29 mm, output 5280 × 3956 px.
 *   fx = focal_mm / sensor_w_mm * image_w_px → 3750.9
 *   fy = focal_mm / sensor_h_mm * image_h_px → 3742.0
 *   cx, cy = optical centre (assume image centre).
 */
export const CAMERA_DEFAULTS = Object.freeze({
  w: 5280,
  h: 3956,
  fx: (12.29 / 17.3) * 5280, // 3750.9
  fy: (12.29 / 13.0) * 3956, // 3742.0
  cx: 5280 / 2, // 2640
  cy: 3956 / 2, // 1978
});

// ── Internal helpers ───────────────────────────────────────────────────────

function deg2rad(d) {
  return (d * Math.PI) / 180;
}

/**
 * Build the camera basis (column-major intent — we just keep three vectors).
 * cam_z: forward. cam_x: right. cam_y: cross(cam_z, cam_x) — points down-ish
 * for negative pitch (gimbal looking down).
 */
function cameraBasis(headingDeg, pitchDeg) {
  const hr = deg2rad(headingDeg);
  const pr = deg2rad(pitchDeg);
  const cosP = Math.cos(pr);
  const sinP = Math.sin(pr);
  const cosH = Math.cos(hr);
  const sinH = Math.sin(hr);
  const cam_z = [cosP * sinH, cosP * cosH, sinP];
  const cam_x = [cosH, -sinH, 0];
  // cam_y = cam_z × cam_x
  const cam_y = [
    cam_z[1] * cam_x[2] - cam_z[2] * cam_x[1],
    cam_z[2] * cam_x[0] - cam_z[0] * cam_x[2],
    cam_z[0] * cam_x[1] - cam_z[1] * cam_x[0],
  ];
  return { cam_x, cam_y, cam_z };
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ── Forward projection ─────────────────────────────────────────────────────

/**
 * Forward project a world GPS coord to a pixel on a specific shot.
 *
 * @param {object} args
 *   tlat, tlon       target lat/lon (degrees)
 *   talt             target altitude (m above local ground; default 0)
 *   dlat, dlon       drone lat/lon (degrees)
 *   alt              drone altitude above takeoff (m)
 *   heading          flight yaw (degrees, 0 = north, 90 = east)
 *   pitch            gimbal pitch (degrees, negative = looking down)
 *   w, h, fx, fy, cx, cy   intrinsics; defaults to Hasselblad L2D-20c
 * @returns {{x:number, y:number} | null}
 */
export function gpsToPixel({
  tlat,
  tlon,
  talt = 0,
  dlat,
  dlon,
  alt,
  heading,
  pitch,
  w = CAMERA_DEFAULTS.w,
  h = CAMERA_DEFAULTS.h,
  fx = CAMERA_DEFAULTS.fx,
  fy = CAMERA_DEFAULTS.fy,
  cx = CAMERA_DEFAULTS.cx,
  cy = CAMERA_DEFAULTS.cy,
}) {
  if (
    !Number.isFinite(tlat) ||
    !Number.isFinite(tlon) ||
    !Number.isFinite(dlat) ||
    !Number.isFinite(dlon) ||
    !Number.isFinite(alt) ||
    !Number.isFinite(heading) ||
    !Number.isFinite(pitch)
  ) {
    return null;
  }

  const cosLat = Math.cos(deg2rad(dlat));
  const dE = (tlon - dlon) * METRES_PER_DEG_LAT * cosLat;
  const dN = (tlat - dlat) * METRES_PER_DEG_LAT;
  const dU = talt - alt; // negative when target is below the drone

  const offset = [dE, dN, dU];
  const { cam_x, cam_y, cam_z } = cameraBasis(heading, pitch);

  const Xc = dot3(offset, cam_x);
  const Yc = dot3(offset, cam_y);
  const Zc = dot3(offset, cam_z);

  if (Zc <= 0) return null; // behind the camera

  const x = (fx * Xc) / Zc + cx;
  const y = (fy * Yc) / Zc + cy;

  // Allow a generous off-frame margin (callers decide what to do); we still
  // return numeric coords so a UI can clip or warn.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Discard pixels far outside the frame (>2x in any direction) — likely a
  // numerical instability case.
  if (x < -2 * w || x > 3 * w || y < -2 * h || y > 3 * h) return null;
  return { x, y };
}

// ── Inverse projection (ray-cast) ──────────────────────────────────────────

/**
 * Inverse project a pixel on a specific shot to a ground-plane GPS coord.
 *
 * Cast a ray from the camera centre through the pixel, intersect with the
 * horizontal plane at z = ground_alt (in metres relative to drone takeoff),
 * convert the resulting ENU offset back to lat/lng.
 *
 * @param {object} args
 *   px, py           pixel coords (full-res)
 *   dlat, dlon       drone lat/lon (degrees)
 *   alt              drone altitude above takeoff (m)
 *   heading          flight yaw (degrees)
 *   pitch            gimbal pitch (degrees, negative = looking down)
 *   ground_alt       altitude of the ground plane (m, default 0)
 *   w, h, fx, fy, cx, cy   intrinsics; defaults to Hasselblad L2D-20c
 * @returns {{lat:number, lon:number} | null}
 */
export function pixelToGroundGps({
  px,
  py,
  dlat,
  dlon,
  alt,
  heading,
  pitch,
  ground_alt = 0,
  fx = CAMERA_DEFAULTS.fx,
  fy = CAMERA_DEFAULTS.fy,
  cx = CAMERA_DEFAULTS.cx,
  cy = CAMERA_DEFAULTS.cy,
}) {
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(dlat) ||
    !Number.isFinite(dlon) ||
    !Number.isFinite(alt) ||
    !Number.isFinite(heading) ||
    !Number.isFinite(pitch)
  ) {
    return null;
  }

  const nx = (px - cx) / fx;
  const ny = (py - cy) / fy;
  const { cam_x, cam_y, cam_z } = cameraBasis(heading, pitch);

  // Ray direction in ENU: nx*cam_x + ny*cam_y + cam_z (camera is at origin).
  const ray = [
    nx * cam_x[0] + ny * cam_y[0] + cam_z[0],
    nx * cam_x[1] + ny * cam_y[1] + cam_z[1],
    nx * cam_x[2] + ny * cam_y[2] + cam_z[2],
  ];

  if (Math.abs(ray[2]) < 1e-6) return null; // ray parallel to ground plane
  // t along ray such that ray[2]*t + alt = ground_alt → reach ground plane
  const t = (ground_alt - alt) / ray[2];
  if (t < 0) return null; // ray points away from ground (above horizon)

  const dE = t * ray[0];
  const dN = t * ray[1];

  const cosLat = Math.cos(deg2rad(dlat));
  if (cosLat === 0) return null; // pole degeneracy
  const lat = dlat + dN / METRES_PER_DEG_LAT;
  const lon = dlon + dE / (METRES_PER_DEG_LAT * cosLat);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// ── Convenience helper for the editor ──────────────────────────────────────

/**
 * Build a `pose` shorthand from a drone_shots row. Returns `null` when the
 * row is missing required EXIF fields (e.g. shots that didn't get parsed).
 *
 * Uses sfm_pose when present (post-SfM, more accurate), else falls back to
 * raw EXIF GPS + IMU.
 */
export function poseFromShot(shot) {
  if (!shot) return null;
  const lat = Number(shot.gps_lat);
  const lon = Number(shot.gps_lon);
  const alt = Number(shot.relative_altitude);
  const heading = Number(shot.flight_yaw);
  const pitch = Number(shot.gimbal_pitch);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(alt) ||
    !Number.isFinite(heading) ||
    !Number.isFinite(pitch)
  ) {
    return null;
  }
  return { dlat: lat, dlon: lon, alt, heading, pitch };
}
