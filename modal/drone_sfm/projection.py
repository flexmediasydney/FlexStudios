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

    def to_enu(self, lat: float, lon: float, alt: float) -> np.ndarray:
        dE = (lon - self.lon) * EARTH_M_PER_DEG * math.cos(math.radians(self.lat))
        dN = (lat - self.lat) * EARTH_M_PER_DEG
        dU = alt - self.alt
        return np.array([dE, dN, dU], dtype=float)

    def from_enu(self, enu: np.ndarray) -> Tuple[float, float, float]:
        dE, dN, dU = float(enu[0]), float(enu[1]), float(enu[2])
        lon = self.lon + dE / (EARTH_M_PER_DEG * math.cos(math.radians(self.lat)))
        lat = self.lat + dN / EARTH_M_PER_DEG
        alt = self.alt + dU
        return (lat, lon, alt)


def build_enu_ref(gps: Dict[str, Tuple[float, float, float]]) -> EnuRef:
    """Use mean of supplied (lat, lon, alt) triples as the ENU origin."""
    lats = np.array([g[0] for g in gps.values()])
    lons = np.array([g[1] for g in gps.values()])
    alts = np.array([g[2] for g in gps.values()])
    return EnuRef(float(lats.mean()), float(lons.mean()), float(alts.mean()))


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
