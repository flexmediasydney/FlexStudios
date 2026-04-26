"""Projection + GPS-alignment helpers for the SfM worker.

Ports `aukerman_project.py` from the spike:
  - ENU local frame builder (lat/lon/alt -> metres East/North/Up)
  - Umeyama similarity transform (3D point sets, scale + rotation + translation)
  - SfM-camera-centre extraction
  - World point projection through a registered camera

Runs equally well on the worker (inside the Modal container) and locally.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np


# ── ENU local frame ────────────────────────────────────────────────
# Equirectangular approximation; ~1m accuracy over the few-hundred-metre
# range a single drone flight covers, which is well below GPS error.
EARTH_M_PER_DEG = 111_319.0


@dataclass(frozen=True)
class EnuRef:
    lat: float
    lon: float
    alt: float

    def __post_init__(self):
        # QC2-2 #13: defend against caller-supplied garbage (e.g. swapped
        # lat/lon, accidentally degrees vs radians). EnuRef is the alignment
        # anchor — corruption here silently wrecks every projection.
        if not (-90.0 <= self.lat <= 90.0):
            raise ValueError(
                f"EnuRef.lat must be in [-90, 90], got {self.lat}"
            )
        if not (-180.0 <= self.lon <= 180.0):
            raise ValueError(
                f"EnuRef.lon must be in [-180, 180], got {self.lon}"
            )

    def to_enu(self, lat: float, lon: float, alt: float) -> np.ndarray:
        # Antimeridian-safe longitude difference. Without normalisation a
        # ref.lon=179.9 vs lon=-179.9 reads as ~-360° instead of ~+0.2°,
        # mis-projecting points by ~40 000 km (QC2 finding #1).
        dlon = ((lon - self.lon + 540.0) % 360.0) - 180.0
        ref_lat_clamped = max(-89.9, min(89.9, self.lat))  # avoid pole singularity
        dE = dlon * EARTH_M_PER_DEG * math.cos(math.radians(ref_lat_clamped))
        dN = (lat - self.lat) * EARTH_M_PER_DEG
        dU = alt - self.alt
        return np.array([dE, dN, dU], dtype=float)

    def from_enu(self, enu: np.ndarray) -> Tuple[float, float, float]:
        dE, dN, dU = float(enu[0]), float(enu[1]), float(enu[2])
        ref_lat_clamped = max(-89.9, min(89.9, self.lat))
        lon = self.lon + dE / (EARTH_M_PER_DEG * math.cos(math.radians(ref_lat_clamped)))
        # Wrap longitude back into (-180, 180]
        lon = ((lon + 540.0) % 360.0) - 180.0
        lat = self.lat + dN / EARTH_M_PER_DEG
        # QC2-2 #4: clamp lat after the rebase. A long ENU dN can push the
        # arithmetic out of [-90, 90], producing nonsense WGS84 that confuses
        # every downstream consumer (Mapbox markers jump to the antipode).
        lat = max(-90.0, min(90.0, lat))
        alt = self.alt + dU
        return (lat, lon, alt)


def lonlat_mean_via_unit_vectors(
    lats: List[float], lngs: List[float]
) -> Tuple[float, float]:
    """Spherical mean of lat/lng via unit-vector sum + renormalise.

    Naive arithmetic mean of longitudes wraps incorrectly anywhere near the
    antimeridian (e.g. +179.9° and -179.9° average to 0°, when the real
    midpoint is ±180°). Convert each (lat, lng) to a unit vector on the unit
    sphere, sum + renormalise, convert back. Correct anywhere on the globe;
    cost is ~10 µs per point. (QC2 #9 + QC2-2 #3.)

    Returns (mean_lat, mean_lng) in degrees.

    Raises ValueError on empty / mismatched-length input.
    """
    if not lats or not lngs or len(lats) != len(lngs):
        raise ValueError("lats and lngs must be same non-empty length")
    sx = sy = sz = 0.0
    for lat, lng in zip(lats, lngs):
        lat_r = math.radians(lat)
        lng_r = math.radians(lng)
        cos_lat = math.cos(lat_r)
        sx += cos_lat * math.cos(lng_r)
        sy += cos_lat * math.sin(lng_r)
        sz += math.sin(lat_r)
    n = float(len(lats))
    mx, my, mz = sx / n, sy / n, sz / n
    norm = math.sqrt(mx * mx + my * my + mz * mz)
    if norm < 1e-12:
        # Antipodal cancellation — fall back to arithmetic mean. Realistic
        # nadir grids span <100 m so this branch is unreachable in practice.
        return (sum(lats) / n, sum(lngs) / n)
    mx /= norm
    my /= norm
    mz /= norm
    mean_lat = math.degrees(math.asin(max(-1.0, min(1.0, mz))))
    mean_lng = math.degrees(math.atan2(my, mx))
    return (mean_lat, mean_lng)


def build_enu_ref(gps: Dict[str, Tuple[float, float, float]]) -> EnuRef:
    """Use mean of supplied (lat, lon, alt) triples as the ENU origin.

    QC2-2 #14: requires ≥3 GPS-tagged points (matches WorldToPixelProjector).
    QC2-2 #3: longitude mean uses spherical unit-vector method, otherwise a
    Fiji-area shoot at lng ±179.9 lands the ENU origin at lng 0 (Indian
    Ocean) and silently corrupts every projection by ~40 000 km.
    """
    if len(gps) < 3:
        raise ValueError(
            f"build_enu_ref requires ≥3 GPS-tagged points, got {len(gps)}"
        )
    lats = [g[0] for g in gps.values()]
    lons = [g[1] for g in gps.values()]
    alts_arr = np.array([g[2] for g in gps.values()])
    mean_lat, mean_lon = lonlat_mean_via_unit_vectors(lats, lons)
    return EnuRef(float(mean_lat), float(mean_lon), float(alts_arr.mean()))


# ── Umeyama similarity transform (Umeyama 1991) ────────────────────
def umeyama(src: np.ndarray, dst: np.ndarray) -> Tuple[float, np.ndarray, np.ndarray]:
    """Best-fit similarity (s, R, t) so that s * R @ src_i + t ≈ dst_i.

    src, dst: (N, 3) arrays. Returns (scale, 3x3 rotation, 3-vector translation).
    """
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    if src.shape != dst.shape or src.shape[1] != 3:
        raise ValueError(f"umeyama: shape mismatch {src.shape} vs {dst.shape}")
    n = src.shape[0]
    if n < 3:
        raise ValueError(f"umeyama: need >= 3 correspondences, got {n}")
    mu_s = src.mean(0)
    mu_d = dst.mean(0)
    sc = src - mu_s
    dc = dst - mu_d
    H = sc.T @ dc / n
    U, S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    var_s = (sc ** 2).sum() / n
    if var_s <= 0:
        raise ValueError("umeyama: source points are degenerate (zero variance)")
    s = float(np.trace(np.diag(S) @ D) / var_s)
    t = mu_d - s * R @ mu_s
    return s, R, t


# ── SfM pose extraction from a pycolmap.Reconstruction ─────────────
@dataclass
class CameraPose:
    """Pose of a single registered image in COLMAP world frame.

    cam_from_world: x_cam = R @ x_world + t  (the COLMAP convention).
    world_xyz is the camera centre in COLMAP world coordinates (-R^T @ t).
    """
    name: str
    image_id: int
    camera_id: int
    R: np.ndarray         # 3x3
    t: np.ndarray         # length 3
    world_xyz: np.ndarray # length 3


def poses_from_reconstruction(recon) -> Dict[str, CameraPose]:
    """Pull out every registered image's pose. `recon` is pycolmap.Reconstruction."""
    out: Dict[str, CameraPose] = {}
    for img_id, image in recon.images.items():
        if not image.has_pose:
            continue
        T = image.cam_from_world
        # pycolmap occasionally exposes this as a method, sometimes a property —
        # tolerate both so the worker survives a minor-version bump.
        T = T() if callable(T) else T
        R = T.rotation.matrix()
        t = T.translation
        out[image.name] = CameraPose(
            name=image.name,
            image_id=img_id,
            camera_id=image.camera_id,
            R=np.asarray(R, dtype=float),
            t=np.asarray(t, dtype=float),
            world_xyz=(-np.asarray(R, dtype=float).T @ np.asarray(t, dtype=float)),
        )
    return out


# ── Projection: ENU world point → image pixel via SfM pose ─────────
class WorldToPixelProjector:
    """Holds the GPS↔SfM similarity and projects ENU points onto images.

    Build with the SfM reconstruction + the per-image GPS dict. Then call
    project(enu_xyz, image_name) to get a pixel (or None if behind camera).
    """

    def __init__(
        self,
        recon,
        poses: Dict[str, CameraPose],
        gps: Dict[str, Tuple[float, float, float]],
    ):
        self.recon = recon
        self.poses = poses
        self.gps = gps

        common = sorted(n for n in poses if n in gps)
        if len(common) < 3:
            raise ValueError(
                f"need ≥3 GPS-tagged registered images for alignment, got {len(common)}"
            )
        self.enu_ref = build_enu_ref({n: gps[n] for n in common})
        self.sfm_pts = np.stack([poses[n].world_xyz for n in common])
        self.enu_pts = np.stack([self.enu_ref.to_enu(*gps[n]) for n in common])
        self.scale, self.R_global, self.t_global = umeyama(self.sfm_pts, self.enu_pts)
        aligned = (self.sfm_pts @ self.R_global.T) * self.scale + self.t_global
        self.residuals = np.linalg.norm(aligned - self.enu_pts, axis=1)
        self.aligned_names = common

    # ENU (metres) ↔ SfM-world coordinate
    def enu_to_sfm(self, enu: np.ndarray) -> np.ndarray:
        return self.R_global.T @ ((np.asarray(enu, dtype=float) - self.t_global) / self.scale)

    def sfm_to_enu(self, sfm_xyz: np.ndarray) -> np.ndarray:
        return (self.R_global @ np.asarray(sfm_xyz, dtype=float)) * self.scale + self.t_global

    # Project a world point onto a specific image
    def project(self, enu_xyz: np.ndarray, image_name: str) -> Optional[Tuple[float, float]]:
        pose = self.poses.get(image_name)
        if pose is None:
            return None
        sfm_w = self.enu_to_sfm(enu_xyz)
        cam = pose.R @ sfm_w + pose.t
        if cam[2] <= 0:
            return None  # behind camera
        camera = self.recon.cameras[pose.camera_id]
        uv = camera.img_from_cam(cam)
        return (float(uv[0]), float(uv[1]))

    # Per-image residual breakdown for the SfmResult
    def per_image_residuals(self) -> Dict[str, float]:
        return {name: float(r) for name, r in zip(self.aligned_names, self.residuals)}

    def residual_summary(self) -> Dict[str, float]:
        r = self.residuals
        return {
            "mean_m": float(r.mean()),
            "median_m": float(np.median(r)),
            "max_m": float(r.max()),
            "min_m": float(r.min()),
            "count": int(r.size),
        }
