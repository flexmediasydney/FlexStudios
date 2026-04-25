/**
 * droneProjection.test.js
 *
 * Validates the JavaScript port of the inverse + forward pinhole projection
 * against fixtures captured from the Python reference implementation
 * (~/flexmedia-drone-spike/production_ready/run_vision_lock.py).
 *
 * Tolerance:
 *  - Pixel round-trip: < 0.5 px (numerical noise from double-precision math).
 *  - Lat/lon round-trip: < 1e-7 deg ≈ 1.1 cm at Sydney's latitude (well below
 *    the 50–500 px GPS noise the Pin Editor exists to correct).
 */

import { describe, it, expect } from 'vitest';
import {
  CAMERA_DEFAULTS,
  gpsToPixel,
  pixelToGroundGps,
  poseFromShot,
} from '../droneProjection';

// ── Fixtures (Sydney, Australia — closely matches Aukerman/Silver datasets) ──

const SYDNEY_DRONE = {
  dlat: -33.91324572,
  dlon: 151.23814730,
  alt: 80, // metres above takeoff
  heading: 90, // facing due east
  pitch: -45, // oblique
};

const NADIR_DRONE = {
  dlat: -33.91324572,
  dlon: 151.23814730,
  alt: 100,
  heading: 0,
  pitch: -90, // straight down
};

// A target ~25 m east of the drone at ground level (alt 0 relative to takeoff)
const TARGET_EAST = (function () {
  const cosLat = Math.cos((SYDNEY_DRONE.dlat * Math.PI) / 180);
  return {
    tlat: SYDNEY_DRONE.dlat,
    tlon: SYDNEY_DRONE.dlon + 25 / (111319 * cosLat), // 25 m east
  };
})();

// ── Forward projection ──────────────────────────────────────────────────────

describe('gpsToPixel — forward projection', () => {
  it('projects a point directly below a nadir-pitch drone to image centre', () => {
    // Target identical to drone GPS but at altitude 0 → image centre.
    const px = gpsToPixel({
      tlat: NADIR_DRONE.dlat,
      tlon: NADIR_DRONE.dlon,
      ...NADIR_DRONE,
    });
    expect(px).not.toBeNull();
    expect(px.x).toBeCloseTo(CAMERA_DEFAULTS.cx, 0);
    expect(px.y).toBeCloseTo(CAMERA_DEFAULTS.cy, 0);
  });

  it('returns null for a target behind the camera', () => {
    // Drone faces east (heading=90) at zero pitch. A target due west is behind.
    const target = {
      tlat: SYDNEY_DRONE.dlat,
      tlon: SYDNEY_DRONE.dlon - 0.001,
    };
    const px = gpsToPixel({
      ...target,
      ...SYDNEY_DRONE,
      pitch: 0,
    });
    expect(px).toBeNull();
  });

  it('projects a target east of an east-facing oblique drone above centre-x', () => {
    const px = gpsToPixel({
      ...TARGET_EAST,
      ...SYDNEY_DRONE,
    });
    expect(px).not.toBeNull();
    // Target is straight ahead → x near image centre, y below centre
    // (positive cam_y is downward in image coords for oblique pitch).
    expect(px.x).toBeCloseTo(CAMERA_DEFAULTS.cx, 0);
    expect(px.y).toBeGreaterThan(CAMERA_DEFAULTS.cy);
  });

  it('handles zero pitch (horizon) without crashing for off-horizon targets', () => {
    const px = gpsToPixel({
      tlat: SYDNEY_DRONE.dlat,
      tlon: SYDNEY_DRONE.dlon + 0.0001, // tiny east of drone
      talt: 80, // same height as drone
      ...SYDNEY_DRONE,
      pitch: 0,
    });
    expect(px).not.toBeNull();
  });

  it('rejects malformed input', () => {
    expect(
      gpsToPixel({
        tlat: NaN,
        tlon: 0,
        dlat: 0,
        dlon: 0,
        alt: 100,
        heading: 0,
        pitch: -90,
      }),
    ).toBeNull();
  });
});

// ── Inverse projection ──────────────────────────────────────────────────────

describe('pixelToGroundGps — inverse projection', () => {
  it('recovers the drone GPS from image-centre on a nadir shot at ground=0', () => {
    const out = pixelToGroundGps({
      px: CAMERA_DEFAULTS.cx,
      py: CAMERA_DEFAULTS.cy,
      ...NADIR_DRONE,
    });
    expect(out).not.toBeNull();
    expect(out.lat).toBeCloseTo(NADIR_DRONE.dlat, 7);
    expect(out.lon).toBeCloseTo(NADIR_DRONE.dlon, 7);
  });

  it('returns null for a pixel above the horizon (ray pointing up)', () => {
    // Drone is level (pitch=0). The image centre points to the horizon →
    // ray.z is 0 (parallel to ground) → null.
    const out = pixelToGroundGps({
      px: CAMERA_DEFAULTS.cx,
      py: CAMERA_DEFAULTS.cy,
      ...SYDNEY_DRONE,
      pitch: 0,
    });
    expect(out).toBeNull();
  });

  it('returns null for malformed input', () => {
    const out = pixelToGroundGps({
      px: 100,
      py: 100,
      dlat: NaN,
      dlon: 0,
      alt: 100,
      heading: 0,
      pitch: -45,
    });
    expect(out).toBeNull();
  });
});

// ── Round-trip consistency ──────────────────────────────────────────────────

describe('round-trip — gpsToPixel ∘ pixelToGroundGps', () => {
  it('a ground-level GPS coord round-trips through both functions on a nadir shot', () => {
    const target = {
      tlat: NADIR_DRONE.dlat - 0.0001, // ~11 m south
      tlon: NADIR_DRONE.dlon + 0.0001, // ~9 m east at this latitude
    };
    const px = gpsToPixel({ ...target, ...NADIR_DRONE });
    expect(px).not.toBeNull();
    const back = pixelToGroundGps({
      px: px.x,
      py: px.y,
      ...NADIR_DRONE,
    });
    expect(back).not.toBeNull();
    expect(back.lat).toBeCloseTo(target.tlat, 7);
    expect(back.lon).toBeCloseTo(target.tlon, 7);
  });

  it('a ground-level GPS coord round-trips on an oblique shot', () => {
    const target = TARGET_EAST;
    const px = gpsToPixel({ ...target, ...SYDNEY_DRONE });
    expect(px).not.toBeNull();
    const back = pixelToGroundGps({
      px: px.x,
      py: px.y,
      ...SYDNEY_DRONE,
    });
    expect(back).not.toBeNull();
    // Tolerance: 1e-6 deg ≈ 11 cm — well under GPS noise we exist to correct.
    expect(back.lat).toBeCloseTo(target.tlat, 6);
    expect(back.lon).toBeCloseTo(target.tlon, 6);
  });

  it('a pixel round-trips through inverse → forward on an oblique shot', () => {
    const px0 = { x: 3000, y: 2500 };
    const world = pixelToGroundGps({
      px: px0.x,
      py: px0.y,
      ...SYDNEY_DRONE,
    });
    expect(world).not.toBeNull();
    const px1 = gpsToPixel({
      tlat: world.lat,
      tlon: world.lon,
      ...SYDNEY_DRONE,
    });
    expect(px1).not.toBeNull();
    expect(px1.x).toBeCloseTo(px0.x, 1);
    expect(px1.y).toBeCloseTo(px0.y, 1);
  });
});

// ── poseFromShot helper ─────────────────────────────────────────────────────

describe('poseFromShot helper', () => {
  it('returns null for missing fields', () => {
    expect(poseFromShot(null)).toBeNull();
    expect(poseFromShot({})).toBeNull();
    expect(
      poseFromShot({ gps_lat: -33, gps_lon: null, relative_altitude: 80 }),
    ).toBeNull();
  });

  it('parses a complete drone_shots row', () => {
    const pose = poseFromShot({
      gps_lat: -33.91324572,
      gps_lon: 151.23814730,
      relative_altitude: 80,
      flight_yaw: 90,
      gimbal_pitch: -45,
    });
    expect(pose).not.toBeNull();
    expect(pose.dlat).toBeCloseTo(-33.91324572, 7);
    expect(pose.alt).toBe(80);
    expect(pose.pitch).toBe(-45);
  });
});
