"""Modal app: drone SfM worker.

Exposes `run_sfm_for_shoot(image_urls, exif_metadata)` which runs the
pycolmap pipeline (extract → match → incremental reconstruction) and aligns
the result to GPS via Umeyama. Output is a structured dict containing
per-image WGS84 camera poses + alignment residuals.

Local-entrypoint `test_aukerman` runs the spike fixture against the deployed
function and asserts on residual quality.
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import modal


# ──────────────────────────────────────────────────────────────────
# Image: pycolmap + opencv + exiftool (exiftool is apt package).
# Pin numpy <2 because pycolmap 3.13 prebuilt wheels link against numpy 1.x.
# ──────────────────────────────────────────────────────────────────
sfm_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libimage-exiftool-perl", "libgl1", "libglib2.0-0")
    .pip_install(
        "pycolmap==3.13.0",
        "opencv-python-headless==4.10.0.84",
        "numpy<2",
        "requests==2.32.3",
    )
    .add_local_python_source("projection")
)

app = modal.App("flexstudios-drone-sfm", image=sfm_image)


# ──────────────────────────────────────────────────────────────────
# The actual pipeline. Runs inside the Modal container.
# ──────────────────────────────────────────────────────────────────
@app.function(cpu=4.0, memory=4096, timeout=900)
def run_sfm_for_shoot(
    image_urls: List[Dict[str, Any]],
    exif_metadata: Optional[Dict[str, Dict[str, float]]] = None,
    target_width: int = 2000,
    max_features: int = 8000,
) -> Dict[str, Any]:
    """Run SfM for a single drone shoot.

    Args:
      image_urls: list of dicts with one of these shapes:
          {"name": "DSC00229.JPG", "url": "https://signed.dropbox/..."}
          {"name": "DSC00229.JPG", "bytes_b64": "<base64 jpeg>"}
        Each item identifies one image.
      exif_metadata: optional override of GPS for each image, keyed by name:
          {"DSC00229.JPG": {"lat": 40.0, "lon": -82.0, "alt": 280.0}}
        If absent, we pull GPS from the JPEG EXIF using exiftool.
      target_width: downscale to this width before SfM (matches spike).
      max_features: SIFT max_num_features (matches spike).

    Returns: SfmResult-shaped dict (see test_aukerman + README for schema).
    """
    import cv2
    import numpy as np
    import pycolmap

    from projection import (
        EnuRef,
        WorldToPixelProjector,
        build_enu_ref,
        poses_from_reconstruction,
    )

    t0 = time.time()
    work = Path(tempfile.mkdtemp(prefix="sfm_"))
    img_dir = work / "images"
    img_dir.mkdir()
    sparse_dir = work / "sparse"
    sparse_dir.mkdir()
    db_path = work / "database.db"

    # ── 1. Materialise images locally (downscale + EXIF copy) ───────
    print(f"[sfm] preparing {len(image_urls)} images at width={target_width}")
    fetched_names: List[str] = []
    for entry in image_urls:
        name = entry["name"]
        dst = img_dir / name
        raw_bytes = _fetch_bytes(entry)
        # Decode + downscale.
        arr = np.frombuffer(raw_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            print(f"[sfm]   skip (decode failed): {name}")
            continue
        h, w = img.shape[:2]
        if w > target_width:
            scale = target_width / w
            img = cv2.resize(img, (target_width, int(h * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(dst), img, [cv2.IMWRITE_JPEG_QUALITY, 92])

        # Persist EXIF GPS so pycolmap & exiftool downstream both see it.
        # Strategy: write the original bytes to a sidecar then copy tags.
        if not exif_metadata or name not in exif_metadata:
            tmp_orig = dst.with_suffix(".orig.jpg")
            tmp_orig.write_bytes(raw_bytes)
            subprocess.run(
                ["exiftool", "-tagsFromFile", str(tmp_orig),
                 "-overwrite_original", str(dst)],
                check=False, capture_output=True,
            )
            tmp_orig.unlink(missing_ok=True)

        fetched_names.append(name)

    if len(fetched_names) < 3:
        raise RuntimeError(
            f"only fetched {len(fetched_names)} usable images; need ≥3 for SfM"
        )

    t_fetch = time.time() - t0

    # ── 2. SIFT feature extraction ─────────────────────────────────
    print(f"[sfm] extracting SIFT features (max_features={max_features})")
    extraction_opts = pycolmap.FeatureExtractionOptions()
    extraction_opts.max_image_size = target_width
    extraction_opts.sift.max_num_features = max_features
    pycolmap.extract_features(
        database_path=str(db_path),
        image_path=str(img_dir),
        camera_mode=pycolmap.CameraMode.SINGLE,
        camera_model="SIMPLE_RADIAL",
        extraction_options=extraction_opts,
    )

    # ── 3. Exhaustive matching ─────────────────────────────────────
    print("[sfm] exhaustive matching")
    pycolmap.match_exhaustive(database_path=str(db_path))

    # ── 4. Incremental reconstruction ──────────────────────────────
    print("[sfm] incremental mapping")
    maps = pycolmap.incremental_mapping(
        database_path=str(db_path),
        image_path=str(img_dir),
        output_path=str(sparse_dir),
    )
    if not maps:
        raise RuntimeError("incremental_mapping produced no reconstructions")
    largest_key = max(maps.keys(), key=lambda k: maps[k].num_reg_images())
    recon = maps[largest_key]
    n_reg = recon.num_reg_images()
    n_pts = len(recon.points3D)
    print(f"[sfm] reconstruction: {n_reg}/{len(fetched_names)} images, {n_pts} 3D points")

    t_sfm = time.time() - t0 - t_fetch

    # ── 5. Pull SfM camera centres + GPS, fit similarity, compute poses ─
    poses = poses_from_reconstruction(recon)
    gps = _gather_gps(img_dir, list(poses.keys()), exif_metadata or {})
    if len(gps) < 3:
        raise RuntimeError(
            f"only {len(gps)} GPS-tagged registered images — need ≥3 for alignment"
        )

    proj = WorldToPixelProjector(recon, poses, gps)

    # Per-image WGS84 camera positions: convert SfM → ENU → lat/lon/alt.
    cameras_out: List[Dict[str, Any]] = []
    for name, pose in poses.items():
        enu = proj.sfm_to_enu(pose.world_xyz)
        lat, lon, alt = proj.enu_ref.from_enu(enu)
        cameras_out.append({
            "name": name,
            "image_id": int(pose.image_id),
            "camera_id": int(pose.camera_id),
            "world_xyz_sfm": pose.world_xyz.tolist(),
            "enu_xyz_m": enu.tolist(),
            "wgs84": {"lat": lat, "lon": lon, "alt": alt},
            "rotation_world_to_cam": pose.R.tolist(),  # row-major 3x3
            "translation_world_to_cam": pose.t.tolist(),
            "residual_m": proj.per_image_residuals().get(name),
        })

    residual_summary = proj.residual_summary()

    # Camera intrinsics (single shared camera under CameraMode.SINGLE).
    intrinsics_out: List[Dict[str, Any]] = []
    for cam_id, cam in recon.cameras.items():
        intrinsics_out.append({
            "camera_id": int(cam_id),
            "model": cam.model_name if hasattr(cam, "model_name") else str(cam.model),
            "width": int(cam.width),
            "height": int(cam.height),
            "params": list(map(float, cam.params)),
        })

    enu_ref = proj.enu_ref
    elapsed = time.time() - t0
    print(
        f"[sfm] done in {elapsed:.1f}s "
        f"({t_fetch:.1f}s fetch + {t_sfm:.1f}s sfm + {elapsed - t_fetch - t_sfm:.1f}s align)"
    )

    return {
        "schema_version": 1,
        "ok": True,
        "n_input_images": len(image_urls),
        "n_fetched_images": len(fetched_names),
        "n_registered_images": int(n_reg),
        "n_points3d": int(n_pts),
        "alignment_reference_wgs84": {
            "lat": enu_ref.lat, "lon": enu_ref.lon, "alt": enu_ref.alt,
        },
        "alignment_scale": float(proj.scale),
        "alignment_residuals_m": residual_summary,
        "cameras": cameras_out,
        "intrinsics": intrinsics_out,
        "timing_s": {
            "fetch": t_fetch,
            "sfm": t_sfm,
            "total": elapsed,
        },
        # Note: ortho path intentionally omitted for now — Stream B's render
        # worker is responsible for ortho generation. We provide the sparse
        # cloud + per-image poses, which is everything downstream needs.
        "ortho_path": None,
    }


# ──────────────────────────────────────────────────────────────────
# Helpers (also run inside the container).
# ──────────────────────────────────────────────────────────────────
def _fetch_bytes(entry: Dict[str, Any]) -> bytes:
    """Return raw bytes for one image entry. Supports url, bytes_b64, path."""
    if "bytes_b64" in entry:
        return base64.b64decode(entry["bytes_b64"])
    if "path" in entry:
        # Local-mounted path inside the container (dev only).
        return Path(entry["path"]).read_bytes()
    if "url" in entry:
        import requests
        r = requests.get(entry["url"], timeout=120)
        r.raise_for_status()
        return r.content
    raise ValueError(f"image entry has no url/bytes_b64/path: {list(entry.keys())}")


def _gather_gps(
    img_dir: Path,
    names: List[str],
    overrides: Dict[str, Dict[str, float]],
) -> Dict[str, Tuple[float, float, float]]:
    """Read GPS for each image, falling back to exiftool when no override."""
    out: Dict[str, Tuple[float, float, float]] = {}
    needs_exif: List[str] = []
    for name in names:
        ov = overrides.get(name)
        if ov and "lat" in ov and "lon" in ov and "alt" in ov:
            out[name] = (float(ov["lat"]), float(ov["lon"]), float(ov["alt"]))
        else:
            needs_exif.append(name)

    if needs_exif:
        # Batch exiftool call — much faster than one-per-image.
        paths = [str(img_dir / n) for n in needs_exif]
        r = subprocess.run(
            ["exiftool", "-json", "-n",
             "-GPSLatitude", "-GPSLongitude", "-GPSAltitude", *paths],
            capture_output=True, text=True, check=False,
        )
        if r.returncode == 0 and r.stdout.strip():
            try:
                rows = json.loads(r.stdout)
            except json.JSONDecodeError:
                rows = []
            for row in rows:
                src = Path(row.get("SourceFile", ""))
                name = src.name
                try:
                    out[name] = (
                        float(row["GPSLatitude"]),
                        float(row["GPSLongitude"]),
                        float(row["GPSAltitude"]),
                    )
                except (KeyError, TypeError, ValueError):
                    continue
    return out


# ──────────────────────────────────────────────────────────────────
# Local entrypoint: `modal run modal/drone_sfm/sfm_worker.py::test_aukerman`
# Streams the local fixture up to the cloud and asserts on residuals.
# ──────────────────────────────────────────────────────────────────
@app.local_entrypoint()
def test_aukerman(
    fixture_dir: str = "/Users/josephsaad/flexmedia-drone-spike/odm_datasets/odm_data_aukerman-master/images",
    every_nth: int = 2,
    max_residual_median_m: float = 1.5,
    max_residual_max_m: float = 5.0,
    min_registration_ratio: float = 0.95,
):
    """Run SfM on the Aukerman fixture and assert on quality.

    Defaults match the spike: every 2nd image (39/77), median residual must
    be <1.5m, registration ≥95% of submitted images.
    """
    fixture = Path(fixture_dir).expanduser()
    if not fixture.exists():
        raise SystemExit(f"fixture dir not found: {fixture}")

    paths = sorted(fixture.glob("*.JPG"))[::every_nth]
    if not paths:
        raise SystemExit(f"no .JPG files found under {fixture}")

    print(f"[test] uploading {len(paths)} images from {fixture}")
    payload = []
    for p in paths:
        payload.append({
            "name": p.name,
            "bytes_b64": base64.b64encode(p.read_bytes()).decode("ascii"),
        })

    print("[test] dispatching to Modal …")
    t0 = time.time()
    result = run_sfm_for_shoot.remote(payload)
    elapsed = time.time() - t0

    print()
    print(f"[test] roundtrip: {elapsed:.1f}s")
    print(f"[test] registered:    {result['n_registered_images']} / "
          f"{result['n_fetched_images']} images")
    print(f"[test] 3D points:     {result['n_points3d']}")
    print(f"[test] alignment ref: ({result['alignment_reference_wgs84']['lat']:.6f}, "
          f"{result['alignment_reference_wgs84']['lon']:.6f}, "
          f"{result['alignment_reference_wgs84']['alt']:.1f}m)")
    r = result["alignment_residuals_m"]
    print(f"[test] residuals (m): mean={r['mean_m']:.2f}  "
          f"median={r['median_m']:.2f}  max={r['max_m']:.2f}  "
          f"(n={r['count']})")
    print(f"[test] timing:        fetch={result['timing_s']['fetch']:.1f}s  "
          f"sfm={result['timing_s']['sfm']:.1f}s  "
          f"total={result['timing_s']['total']:.1f}s")

    # Quality gates ─────────────────────────────────────────────
    n_in = result["n_fetched_images"]
    n_reg = result["n_registered_images"]
    ratio = n_reg / max(n_in, 1)
    failures = []
    if ratio < min_registration_ratio:
        failures.append(
            f"registration ratio {ratio:.2%} < {min_registration_ratio:.2%}"
        )
    if r["median_m"] > max_residual_median_m:
        failures.append(
            f"median residual {r['median_m']:.2f}m > {max_residual_median_m}m"
        )
    if r["max_m"] > max_residual_max_m:
        failures.append(
            f"max residual {r['max_m']:.2f}m > {max_residual_max_m}m"
        )
    if failures:
        print()
        for f in failures:
            print(f"[test] FAIL: {f}")
        raise SystemExit(1)
    print()
    print("[test] PASS")
