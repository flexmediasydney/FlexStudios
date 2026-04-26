"""Modal app: drone SfM worker.

Exposes `run_sfm_for_shoot(image_urls, exif_metadata)` which runs the
pycolmap pipeline (extract → match → incremental reconstruction) and aligns
the result to GPS via Umeyama. Output is a structured dict containing
per-image WGS84 camera poses + alignment residuals.

Also exposes an HTTP endpoint `sfm_http(payload)` — a fastapi-backed entry
point used by the drone-job-dispatcher Edge Function. It accepts
`{ _token, shoot_id }`, calls back to Supabase via the service-role key to
look up nadir_grid shots + signed Dropbox URLs (drone-shot-urls), runs the
SfM pipeline, persists the resulting per-image poses to drone_shots.sfm_pose
+ inserts a drone_sfm_runs row, and returns a small status payload.

Auth: shared-secret bearer token in the `_token` body field, matching the
Modal secret FLEXSTUDIOS_RENDER_TOKEN (re-used — same secret as render_http).

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
# fastapi[standard] is required for @modal.fastapi_endpoint.
# httpx is used by sfm_http to call back to Supabase.
# ──────────────────────────────────────────────────────────────────
sfm_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libimage-exiftool-perl", "libgl1", "libglib2.0-0")
    .pip_install(
        "pycolmap==3.13.0",
        "opencv-python-headless==4.10.0.84",
        "numpy<2",
        "requests==2.32.3",
        "fastapi[standard]",
        "httpx==0.27.2",
    )
    .add_local_python_source("projection")
)

app = modal.App("flexstudios-drone-sfm", image=sfm_image)


# ──────────────────────────────────────────────────────────────────
# The actual pipeline. Runs inside the Modal container.
# ──────────────────────────────────────────────────────────────────
def _sfm_core(
    work: Path,
    image_urls: List[Dict[str, Any]],
    exif_metadata: Optional[Dict[str, Dict[str, float]]],
    target_width: int,
    max_features: int,
) -> Dict[str, Any]:
    """Shared SfM pipeline body.

    Both `run_sfm_for_shoot` (the Modal-decorated entrypoint) and
    `_run_sfm_pipeline_inline` (called from sfm_http when we're already
    inside a container) wrap this. Previously the body was copy-pasted
    between the two — 160 lines of drift-prone duplication. (QC2 #10.)

    Caller is responsible for creating + cleaning up `work` (a temp dir).
    """
    import cv2
    import numpy as np
    import pycolmap

    from projection import (
        WorldToPixelProjector,
        poses_from_reconstruction,
    )

    t0 = time.time()
    img_dir = work / "images"
    img_dir.mkdir(exist_ok=True)
    sparse_dir = work / "sparse"
    sparse_dir.mkdir(exist_ok=True)
    db_path = work / "database.db"

    # ── 1. Materialise images locally (downscale + EXIF copy) ───────
    print(f"[sfm] preparing {len(image_urls)} images at width={target_width}")
    fetched_names: List[str] = []
    for entry in image_urls:
        # QC2-2 #2: entry["name"] is API-supplied. A crafted name like
        # "../../etc/passwd.jpg" would resolve via `img_dir / name` to a
        # path outside the worker's tempdir — reading it back via PIL/cv2
        # is harmless but cv2.imwrite + exiftool would happily write
        # arbitrary bytes there. Defence-in-depth: strip any directory
        # component and reject suspicious bytes outright.
        raw_name = entry.get("name")
        if not isinstance(raw_name, str) or not raw_name:
            print(f"[sfm]   skip (missing name): {entry!r}")
            continue
        if any(c in raw_name for c in ("/", "\\", "\x00")) or ".." in raw_name:
            # Security: log + skip. Don't echo the full string to logs in case
            # it's hostile (we still log a fingerprint for forensics).
            print(
                f"[sfm]   SECURITY: rejected path-traversal name "
                f"(len={len(raw_name)}, starts={raw_name[:8]!r})"
            )
            continue
        name = Path(raw_name).name  # belt-and-braces: Path().name strips dirs
        if not name or name in (".", ".."):
            print(f"[sfm]   SECURITY: rejected degenerate name {raw_name!r}")
            continue
        dst = img_dir / name
        raw_bytes = _fetch_bytes(entry)
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

    # Where pycolmap wrote the largest reconstruction's binary files
    # (cameras.bin / images.bin / points3D.bin). The caller may tar this dir
    # for Dropbox upload (see Bug 4 / sparse_bin_dropbox_path).
    sparse_recon_dir = sparse_dir / str(largest_key)

    t_sfm = time.time() - t0 - t_fetch

    # ── 5. Pull SfM camera centres + GPS, fit similarity, compute poses ─
    poses = poses_from_reconstruction(recon)
    gps = _gather_gps(img_dir, list(poses.keys()), exif_metadata or {})
    if len(gps) < 3:
        raise RuntimeError(
            f"only {len(gps)} GPS-tagged registered images — need ≥3 for alignment"
        )

    proj = WorldToPixelProjector(recon, poses, gps)

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
            "rotation_world_to_cam": pose.R.tolist(),
            "translation_world_to_cam": pose.t.tolist(),
            "residual_m": proj.per_image_residuals().get(name),
        })

    residual_summary = proj.residual_summary()

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

    # ── 6. Pack the sparse reconstruction for Dropbox upload ─────────
    # E10 / Bug 4: persisting sparse_bin_dropbox_path on drone_sfm_runs lets
    # downstream consumers (Pin Editor, future bundle-adjustment passes)
    # rehydrate the COLMAP recon offline. The largest reconstruction's
    # cameras.bin / images.bin / points3D.bin live in sparse_dir/<key>/.
    # We tar.gz them in-memory so the wrapper can stream the bytes without
    # racing the temp-dir cleanup.
    import tarfile
    sparse_archive_bytes: Optional[bytes] = None
    try:
        if sparse_recon_dir.exists():
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tar:
                tar.add(str(sparse_recon_dir), arcname="sparse")
            sparse_archive_bytes = buf.getvalue()
            print(
                f"[sfm] sparse archive packed: {len(sparse_archive_bytes):,} bytes "
                f"(from {sparse_recon_dir})"
            )
        else:
            print(
                f"[sfm] WARN sparse_recon_dir missing — no archive will be uploaded "
                f"({sparse_recon_dir})"
            )
    except Exception as e:
        # Pack failure is non-fatal here — the caller will see no archive
        # bytes and surface a clear marker on the run row.
        print(f"[sfm] WARN sparse archive pack failed: {e}")

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
        # Sparse recon archive — bytes that the caller (sfm_http) uploads to
        # Dropbox via dropboxTestHelper Edge Function. Not part of the
        # canonical schema_version 1 response (omitted from non-HTTP entry
        # points anyway), but present here so the wrapper can stream it
        # before tempdir cleanup.
        "_sparse_archive_bytes": sparse_archive_bytes,
        # Note: ortho path intentionally omitted — Stream B's render worker
        # owns ortho generation; sparse cloud + poses are all downstream needs.
        "ortho_path": None,
    }


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
    work = Path(tempfile.mkdtemp(prefix="sfm_"))
    try:
        result = _sfm_core(work, image_urls, exif_metadata, target_width, max_features)
        # _sparse_archive_bytes is an internal field used only by the HTTP
        # path (Bug 4 / sparse_bin_dropbox_path upload). The Modal-decorated
        # remote() entrypoint is called by the test fixture which doesn't
        # need it — drop to keep the response payload <bandwidth_limit and
        # schema-clean.
        result.pop("_sparse_archive_bytes", None)
        return result
    finally:
        # Modal containers reuse hot disks across invocations; without this
        # the per-shoot temp dirs accumulate and eventually fill the disk.
        shutil.rmtree(work, ignore_errors=True)


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
# HTTP endpoint — for invocation from the drone-job-dispatcher Edge Function
# ──────────────────────────────────────────────────────────────────
# Uses the same `flexstudios-render-token` Modal secret as the render worker,
# AND a `flexstudios-supabase` secret bundle that carries
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY so we can call back to the
# drone-shot-urls Edge Function and persist results to the database.
NADIR_GRID_MIN_SHOTS_FOR_SFM = 10  # below this, SfM is unreliable on a single grid


@app.function(
    cpu=4.0,
    memory=4096,
    timeout=900,
    secrets=[
        modal.Secret.from_name("flexstudios-render-token"),
        modal.Secret.from_name("flexstudios-supabase"),
    ],
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=False)
def sfm_http(payload: Dict[str, Any]):
    """HTTP-callable wrapper around run_sfm_for_shoot.

    POST body:
        {
            "_token":  shared-secret bearer token (FLEXSTUDIOS_RENDER_TOKEN),
            "shoot_id": UUID of the drone_shoots row to process
        }

    Behaviour:
      1. Auth via _token body field (mirrors render_http).
      2. Call drone-shot-urls Edge Function with shoot_id to receive a list of
         nadir_grid shots + 4h temporary Dropbox download URLs.
      3. Insert a drone_sfm_runs row with status='running'.
      4. If <NADIR_GRID_MIN_SHOTS_FOR_SFM images: skip with status='failed'
         (insufficient inputs). This is graceful — single-image shoots like
         the Carrington test fixture will return ok=false but the dispatch
         path is still exercised.
      5. Otherwise: run the existing run_sfm_for_shoot pipeline locally
         (we're already inside the Modal container — call the helper directly,
         not via .remote()).
      6. UPDATE drone_shots.sfm_pose + registered_in_sfm for each registered
         camera. UPDATE the drone_sfm_runs row with status='succeeded' +
         residual stats.
      7. Return { ok, shoot_id, images_registered, residual_median_m, sfm_run_id, error? }.
    """
    import os
    from fastapi import HTTPException
    import httpx

    expected = os.environ.get("FLEXSTUDIOS_RENDER_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=500, detail="server token not configured")

    body_token = (payload or {}).get("_token") if isinstance(payload, dict) else None
    if not body_token or body_token != expected:
        raise HTTPException(status_code=401, detail="invalid or missing _token")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON object required")

    shoot_id = payload.get("shoot_id")
    if not shoot_id or not isinstance(shoot_id, str):
        raise HTTPException(status_code=400, detail="shoot_id required (string)")

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not service_key:
        raise HTTPException(
            status_code=500,
            detail="SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured in flexstudios-supabase secret",
        )

    rest_headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    # ── Step 1: insert a drone_sfm_runs row with status='running' ──
    run_id: Optional[str] = None
    started_at = time.time()
    with httpx.Client(timeout=30.0) as client:
        r = client.post(
            f"{supabase_url}/rest/v1/drone_sfm_runs",
            headers={**rest_headers, "Prefer": "return=representation"},
            json={"shoot_id": shoot_id, "status": "running"},
        )
        if r.status_code in (200, 201) and r.json():
            run_id = r.json()[0]["id"]
        else:
            print(f"[sfm_http] drone_sfm_runs insert failed: {r.status_code} {r.text[:300]}")

    def _finalise_run(
        ok: bool,
        *,
        error_msg: Optional[str] = None,
        n_registered: Optional[int] = None,
        n_points: Optional[int] = None,
        residual_median: Optional[float] = None,
        residual_max: Optional[float] = None,
        sparse_bin_dropbox_path: Optional[str] = None,
    ) -> None:
        if not run_id:
            return
        update: Dict[str, Any] = {
            "status": "succeeded" if ok else "failed",
            "finished_at": _iso_utc_now(),
        }
        if error_msg is not None:
            update["error_message"] = error_msg[:1000]
        if n_registered is not None:
            update["images_registered"] = n_registered
        if n_points is not None:
            update["points_3d"] = n_points
        if residual_median is not None:
            update["residual_median_m"] = round(float(residual_median), 2)
        if residual_max is not None:
            update["residual_max_m"] = round(float(residual_max), 2)
        if sparse_bin_dropbox_path is not None:
            # Bug 4 / E10: persist the Dropbox path of the uploaded sparse
            # archive so downstream rehydration can find it. On upload
            # failure the caller passes an "upload_failed:<reason>" sentinel
            # rather than NULL — we keep the field non-NULL so dashboards
            # can distinguish "never attempted" from "attempted+failed".
            update["sparse_bin_dropbox_path"] = sparse_bin_dropbox_path[:1000]
        try:
            with httpx.Client(timeout=30.0) as c2:
                r2 = c2.patch(
                    f"{supabase_url}/rest/v1/drone_sfm_runs?id=eq.{run_id}",
                    headers=rest_headers,
                    json=update,
                )
                if r2.status_code >= 300:
                    print(f"[sfm_http] drone_sfm_runs update failed: {r2.status_code} {r2.text[:300]}")
        except Exception as e:
            print(f"[sfm_http] drone_sfm_runs update exception: {e}")

    def _update_shoot_status(status: str) -> None:
        try:
            with httpx.Client(timeout=30.0) as c2:
                c2.patch(
                    f"{supabase_url}/rest/v1/drone_shoots?id=eq.{shoot_id}",
                    headers=rest_headers,
                    json={"status": status},
                )
        except Exception as e:
            print(f"[sfm_http] drone_shoots status update failed: {e}")

    _update_shoot_status("sfm_running")

    # ── Step 2: fetch shot list + temp URLs from Edge Function ──
    try:
        with httpx.Client(timeout=120.0) as client:
            r = client.post(
                f"{supabase_url}/functions/v1/drone-shot-urls",
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "Content-Type": "application/json",
                    "x-caller-context": "modal:sfm_http",
                },
                json={"shoot_id": shoot_id, "role_filter": ["nadir_grid"]},
            )
            if r.status_code >= 300:
                msg = f"drone-shot-urls returned {r.status_code}: {r.text[:300]}"
                _finalise_run(False, error_msg=msg)
                _update_shoot_status("sfm_failed")
                return {"ok": False, "shoot_id": shoot_id, "sfm_run_id": run_id, "error": msg}
            urls_resp = r.json()
            shot_list = urls_resp.get("shots") or []
            project_id: Optional[str] = urls_resp.get("project_id")
    except Exception as e:
        msg = f"drone-shot-urls call failed: {e}"
        _finalise_run(False, error_msg=msg)
        _update_shoot_status("sfm_failed")
        return {"ok": False, "shoot_id": shoot_id, "sfm_run_id": run_id, "error": msg}

    n_in = len(shot_list)
    if n_in < NADIR_GRID_MIN_SHOTS_FOR_SFM:
        msg = (
            f"insufficient nadir_grid images for SfM: have {n_in}, "
            f"need >= {NADIR_GRID_MIN_SHOTS_FOR_SFM}"
        )
        print(f"[sfm_http] {msg}")
        _finalise_run(False, error_msg=msg, n_registered=0)
        _update_shoot_status("sfm_failed")
        return {
            "ok": False,
            "shoot_id": shoot_id,
            "sfm_run_id": run_id,
            "images_input": n_in,
            "error": msg,
        }

    # ── Step 3: build pipeline input ──
    image_urls = [
        {"name": s["filename"], "url": s["url"]}
        for s in shot_list
    ]
    # Build EXIF override from drone_shots row (we already have lat/lon/alt).
    exif_metadata: Dict[str, Dict[str, float]] = {}
    for s in shot_list:
        if (
            s.get("gps_lat") is not None
            and s.get("gps_lon") is not None
            and s.get("relative_altitude") is not None
        ):
            exif_metadata[s["filename"]] = {
                "lat": float(s["gps_lat"]),
                "lon": float(s["gps_lon"]),
                "alt": float(s["relative_altitude"]),
            }
    filename_to_shot_id = {s["filename"]: s["shot_id"] for s in shot_list}

    # ── Step 4: run the SfM pipeline locally (we're already in the container) ──
    try:
        result = _run_sfm_pipeline_inline(
            image_urls=image_urls,
            exif_metadata=exif_metadata or None,
        )
    except Exception as e:
        msg = f"SfM pipeline raised: {e}"
        print(f"[sfm_http] {msg}")
        _finalise_run(False, error_msg=msg)
        _update_shoot_status("sfm_failed")
        return {"ok": False, "shoot_id": shoot_id, "sfm_run_id": run_id, "error": msg}

    # ── Step 5: persist per-image sfm_pose to drone_shots ──
    n_registered = int(result.get("n_registered_images", 0))
    residuals = result.get("alignment_residuals_m") or {}
    residual_median = residuals.get("median_m")
    residual_max = residuals.get("max_m")

    # Batch sfm_pose via the upsert_sfm_poses RPC (migration 262). One
    # round-trip vs N PATCHes — saves 1-3 s of pure latency on a 30-shot
    # nadir grid. Falls back to the per-row PATCH path if the RPC is
    # missing (older deploys), so a hot-fix worker on an old DB still
    # works. (QC2 #11.)
    cameras = result.get("cameras", [])
    pose_failures = 0
    skipped_unknown = 0
    pose_payload_batch: List[Dict[str, Any]] = []
    for cam in cameras:
        name = cam.get("name")
        sid = filename_to_shot_id.get(name)
        if not sid:
            skipped_unknown += 1
            continue
        pose_payload_batch.append({
            "shot_id": sid,
            "sfm_pose": {
                "image_id": cam.get("image_id"),
                "camera_id": cam.get("camera_id"),
                "world_xyz_sfm": cam.get("world_xyz_sfm"),
                "enu_xyz_m": cam.get("enu_xyz_m"),
                "wgs84": cam.get("wgs84"),
                "rotation_world_to_cam": cam.get("rotation_world_to_cam"),
                "translation_world_to_cam": cam.get("translation_world_to_cam"),
                "residual_m": cam.get("residual_m"),
            },
        })

    rpc_ok = False
    if pose_payload_batch:
        try:
            with httpx.Client(timeout=60.0) as client:
                rr = client.post(
                    f"{supabase_url}/rest/v1/rpc/upsert_sfm_poses",
                    headers=rest_headers,
                    json={"payload": pose_payload_batch},
                )
                if rr.status_code in (200, 201, 204):
                    rpc_ok = True
                    try:
                        n_upd = rr.json()
                        print(f"[sfm_http] upsert_sfm_poses RPC ok: {n_upd} rows updated")
                    except Exception:
                        print(f"[sfm_http] upsert_sfm_poses RPC ok ({rr.status_code})")
                else:
                    print(
                        f"[sfm_http] upsert_sfm_poses RPC failed: "
                        f"{rr.status_code} {rr.text[:300]} — falling back to per-row PATCH"
                    )
        except Exception as e:
            print(f"[sfm_http] upsert_sfm_poses RPC exception: {e} — falling back to per-row PATCH")

    if not rpc_ok and pose_payload_batch:
        # Per-row PATCH fallback (legacy path). Subagent X's bulk POST +
        # merge-duplicates attempt fails because drone_shots has NOT NULL
        # columns; PATCH-by-id avoids that.
        with httpx.Client(timeout=30.0) as client:
            for entry in pose_payload_batch:
                sid = entry["shot_id"]
                try:
                    rr = client.patch(
                        f"{supabase_url}/rest/v1/drone_shots?id=eq.{sid}",
                        headers={**rest_headers, "Prefer": "return=minimal"},
                        json={
                            "sfm_pose": entry["sfm_pose"],
                            "registered_in_sfm": True,
                        },
                    )
                    if rr.status_code >= 300:
                        pose_failures += 1
                        print(
                            f"[sfm_http] sfm_pose PATCH failed for shot {sid}: "
                            f"{rr.status_code} {rr.text[:200]}"
                        )
                except Exception as e:
                    pose_failures += 1
                    print(f"[sfm_http] sfm_pose PATCH exception for shot {sid}: {e}")
    if skipped_unknown:
        print(f"[sfm_http] skipped {skipped_unknown} cameras with no matching shot_id")

    # ── Step 5b: compute property-pin centroid from registered nadir cameras ──
    # The nadir grid is flown directly above the building, so the GPS centroid
    # of the registered nadir cameras lands on the rooftop — much better than
    # Google's geocode of the street address (which often falls on the kerb
    # for unit blocks). PATCH projects.confirmed_lat/lng so the renderer
    # prefers it over geocoded_lat/lng. Best-effort: never abort the SfM run
    # on failure here; the renderer's geocoded fallback still works.
    #
    # Only writes when confirmed_source IS NULL (never confirmed) or
    # 'sfm' (a previous auto-write) — operator manual confirmations are
    # protected by the or= filter on the PATCH URL.
    #
    # Centroid math: convert each (lat, lng) to a unit vector on the sphere,
    # sum + renormalise, convert back. This is correct anywhere on the globe
    # including near the antimeridian (the previous arithmetic mean of lng
    # wrapped incorrectly when grids straddled ±180°). Cost is negligible —
    # ≤30 grid cameras per shoot. (QC2 finding #9.)
    if project_id and cameras:
        # All registered cameras come from a nadir_grid-filtered shot list
        # (drone-shot-urls is called with role_filter=['nadir_grid']), so by
        # construction every entry in `cameras` is a nadir camera here. The
        # `nadir_only` branch below is the same set; the fallback to "all
        # cameras" is left as a defensive comment for future role expansion.
        nadir_cameras = cameras  # already nadir_grid-only by upstream filter
        n_nadir = len(nadir_cameras)
        selected = nadir_cameras if n_nadir > 0 else cameras  # graceful degrade
        n_selected = len(selected)

        lats: List[float] = []
        lngs: List[float] = []
        for cam in selected:
            wgs84 = cam.get("wgs84") or {}
            lat = wgs84.get("lat")
            lon = wgs84.get("lon")
            if lat is None or lon is None:
                continue
            lats.append(float(lat))
            lngs.append(float(lon))

        if lats and lngs:
            mean_lat, mean_lng = _lonlat_mean_via_unit_vectors(lats, lngs)
            print(
                f"[sfm] property centroid → ({mean_lat:.6f}, {mean_lng:.6f}) "
                f"from {len(lats)} nadir cameras (unit-vector mean)"
            )
            try:
                with httpx.Client(timeout=30.0) as client:
                    rp = client.patch(
                        f"{supabase_url}/rest/v1/projects"
                        f"?id=eq.{project_id}"
                        f"&or=(confirmed_source.is.null,confirmed_source.eq.sfm)",
                        headers={**rest_headers, "Prefer": "return=minimal"},
                        json={
                            "confirmed_lat": mean_lat,
                            "confirmed_lng": mean_lng,
                            "confirmed_source": "sfm",
                            "confirmed_at": _iso_utc_now(),
                            "confirmed_by": None,  # NULL = automated
                        },
                    )
                    if rp.status_code >= 300:
                        print(
                            f"[sfm] property centroid PATCH failed: "
                            f"{rp.status_code} {rp.text[:200]}"
                        )
                    else:
                        print(f"[sfm] property centroid PATCH ok: {rp.status_code}")
            except Exception as e:
                # Best-effort: never abort the SfM run on this PATCH.
                print(f"[sfm] property centroid PATCH exception: {e}")
        else:
            print(
                f"[sfm] property centroid skipped: "
                f"{n_selected} cameras selected but none had usable wgs84"
            )
    else:
        if not project_id:
            print("[sfm] property centroid skipped: no project_id from drone-shot-urls")
        else:
            print("[sfm] property centroid skipped: no registered cameras")

    # Mirror residual median to drone_shoots (UI surfaces it on shoot detail).
    try:
        with httpx.Client(timeout=30.0) as client:
            client.patch(
                f"{supabase_url}/rest/v1/drone_shoots?id=eq.{shoot_id}",
                headers=rest_headers,
                json={
                    "status": "sfm_complete",
                    "sfm_residual_median_m": (
                        round(float(residual_median), 2) if residual_median is not None else None
                    ),
                },
            )
    except Exception as e:
        print(f"[sfm_http] drone_shoots residual update failed: {e}")

    # ── Step 6: upload sparse recon archive to Dropbox ──
    # Bug 4 / E10: previously sparse_bin_dropbox_path was never written →
    # always NULL on succeeded runs. Pin Editor's per-shot fallback (#85)
    # already protects it from breaking, but the field needs a non-NULL
    # marker for dashboards / future bundle-adjustment passes / audit.
    #
    # Strategy: we don't carry Dropbox OAuth credentials inside the Modal
    # container. Instead, call the existing dropboxTestHelper Edge Function
    # with content_b64 — it already proxies file writes via the canonical
    # Dropbox shared client (folder_kind='enrichment_sfm_meshes'). Modal's
    # service-role bearer token bypasses the master_admin RBAC check there.
    sparse_bytes = result.get("_sparse_archive_bytes")
    sparse_path_value: str
    if not project_id:
        sparse_path_value = "upload_failed:no_project_id"
        print("[sfm_http] sparse upload skipped: no project_id from drone-shot-urls")
    elif not sparse_bytes:
        sparse_path_value = "upload_failed:no_archive_packed"
        print("[sfm_http] sparse upload skipped: _sparse_archive_bytes missing from result")
    else:
        sparse_path_value = _upload_sparse_to_dropbox(
            supabase_url=supabase_url,
            service_key=service_key,
            project_id=project_id,
            shoot_id=shoot_id,
            archive_bytes=sparse_bytes,
        )

    _finalise_run(
        True,
        n_registered=n_registered,
        n_points=int(result.get("n_points3d", 0)),
        residual_median=residual_median,
        residual_max=residual_max,
        sparse_bin_dropbox_path=sparse_path_value,
        # Surface upload failures in error_message so dashboards see them
        # — but NOT in run.status (that stays 'succeeded' because the SfM
        # itself succeeded; the upload is downstream-of-success per spec).
        error_msg=(
            sparse_path_value
            if sparse_path_value.startswith("upload_failed:")
            else None
        ),
    )

    elapsed = time.time() - started_at
    return {
        "ok": True,
        "shoot_id": shoot_id,
        "sfm_run_id": run_id,
        "images_input": n_in,
        "images_registered": n_registered,
        "residual_median_m": (
            round(float(residual_median), 3) if residual_median is not None else None
        ),
        "residual_max_m": (
            round(float(residual_max), 3) if residual_max is not None else None
        ),
        "pose_update_failures": pose_failures,
        "elapsed_s": round(elapsed, 2),
    }


def _iso_utc_now() -> str:
    """ISO-8601 UTC timestamp accepted by Postgres TIMESTAMPTZ."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _lonlat_mean_via_unit_vectors(
    lats: List[float], lngs: List[float]
) -> Tuple[float, float]:
    """Thin wrapper around projection.lonlat_mean_via_unit_vectors.

    Kept here for backwards compatibility — earlier QC iterations had this
    helper inline in sfm_worker, but build_enu_ref also needs it (QC2-2 #3),
    so the canonical implementation now lives in projection.py.
    """
    from projection import lonlat_mean_via_unit_vectors
    return lonlat_mean_via_unit_vectors(lats, lngs)


def _upload_sparse_to_dropbox(
    *,
    supabase_url: str,
    service_key: str,
    project_id: str,
    shoot_id: str,
    archive_bytes: bytes,
) -> str:
    """Upload sparse recon archive via dropboxTestHelper Edge Function.

    Returns either the Dropbox path (e.g. "/FlexMedia/Projects/.../sparse_<id>.tar.gz")
    on success, or an "upload_failed:<reason>" sentinel on failure. The
    sentinel is intentionally non-NULL so dashboards can distinguish
    "never attempted" (NULL) from "attempted but failed" (sentinel).

    Why route through dropboxTestHelper rather than calling Dropbox directly:
    the Modal worker does not carry Dropbox OAuth credentials. dropboxTestHelper
    accepts service-role auth, takes a folder_kind ('enrichment_sfm_meshes'
    resolves to 06_ENRICHMENT/sfm_meshes inside the project's Dropbox root),
    and proxies the upload through the canonical _shared/dropbox.ts client.
    """
    import httpx
    import base64 as _b64

    archive_size = len(archive_bytes)
    print(
        f"[sfm_http] uploading sparse archive: {archive_size:,} bytes "
        f"shoot={shoot_id} project={project_id}"
    )
    if archive_size == 0:
        return "upload_failed:empty_archive"

    # dropboxTestHelper hard-caps content_b64 implicitly via Edge Function
    # request body limit (~50 MB). Sparse recons for a 10-30 image grid are
    # typically <5 MB; anything larger likely indicates a bug in the
    # reconstruction step but we still attempt + record the failure.
    if archive_size > 40 * 1024 * 1024:
        print(f"[sfm_http] WARN sparse archive >40MB; upload may be rejected")

    filename = f"sparse_{shoot_id}.tar.gz"
    payload = {
        "project_id": project_id,
        "folder_kind": "enrichment_sfm_meshes",
        "filename": filename,
        # dropboxTestHelper decodes content_b64 → Uint8Array → upload
        "content_b64": _b64.b64encode(archive_bytes).decode("ascii"),
    }
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
    }
    url = f"{supabase_url}/functions/v1/dropboxTestHelper"

    try:
        # Generous timeout — the Edge Function refreshes Dropbox tokens +
        # uploads; small archives should finish in <10 s, large ones <60 s.
        with httpx.Client(timeout=180.0) as client:
            r = client.post(url, headers=headers, json=payload)
        if r.status_code >= 300:
            body_excerpt = (r.text or "")[:200].replace("\n", " ")
            print(
                f"[sfm_http] sparse upload HTTP {r.status_code}: "
                f"{body_excerpt}"
            )
            return f"upload_failed:http_{r.status_code}"
        try:
            data = r.json()
        except Exception as e:
            print(f"[sfm_http] sparse upload response not JSON: {e}")
            return "upload_failed:invalid_response"
        if not data.get("success"):
            print(f"[sfm_http] sparse upload reported !success: {data}")
            return "upload_failed:helper_reported_failure"
        path = (data.get("uploaded") or {}).get("path")
        if not path or not isinstance(path, str):
            print(f"[sfm_http] sparse upload no path in response: {data}")
            return "upload_failed:no_path_in_response"
        print(f"[sfm_http] sparse upload OK: {path}")
        return path
    except Exception as e:
        msg = str(e)[:160]
        print(f"[sfm_http] sparse upload exception: {msg}")
        return f"upload_failed:exception:{msg[:80]}"


def _run_sfm_pipeline_inline(
    image_urls: List[Dict[str, Any]],
    exif_metadata: Optional[Dict[str, Dict[str, float]]] = None,
    target_width: int = 2000,
    max_features: int = 8000,
) -> Dict[str, Any]:
    """Inline body of run_sfm_for_shoot — runs in the current container.

    The original `run_sfm_for_shoot` is a Modal-decorated function and
    would spawn a fresh container if called via .remote(). We're already
    inside a Modal container (sfm_http), so just call _sfm_core directly.

    Body extracted into _sfm_core (QC2 #10) — was a 160-line copy-paste.
    """
    work = Path(tempfile.mkdtemp(prefix="sfm_"))
    try:
        return _sfm_core(work, image_urls, exif_metadata, target_width, max_features)
    finally:
        # Hot-disk caveat — see run_sfm_for_shoot.
        shutil.rmtree(work, ignore_errors=True)


# ──────────────────────────────────────────────────────────────────
# Local entrypoint: `modal run modal/drone_sfm/sfm_worker.py::test_aukerman`
# Streams the local fixture up to the cloud and asserts on residuals.
# ──────────────────────────────────────────────────────────────────
# Default fixture path for Joseph's local dev box. Other contributors should
# set SFM_FIXTURE_DIR to their own checkout location.
_DEFAULT_FIXTURE_DIR = os.environ.get(
    "SFM_FIXTURE_DIR",
    "/Users/josephsaad/flexmedia-drone-spike/odm_datasets/odm_data_aukerman-master/images",
)


@app.local_entrypoint()
def test_aukerman(
    fixture_dir: str = _DEFAULT_FIXTURE_DIR,
    every_nth: int = 2,
    max_residual_median_m: float = 1.5,
    max_residual_max_m: float = 5.0,
    min_registration_ratio: float = 0.95,
):
    """Run SfM on the Aukerman fixture and assert on quality.

    Defaults match the spike: every 2nd image (39/77), median residual must
    be <1.5m, registration ≥95% of submitted images.

    Override the fixture path via the SFM_FIXTURE_DIR env var or the
    --fixture-dir CLI flag (e.g. `modal run … --fixture-dir /path/to/images`).
    """
    fixture = Path(fixture_dir).expanduser()
    if not fixture.exists():
        raise SystemExit(
            f"fixture dir not found: {fixture}\n"
            f"  Set SFM_FIXTURE_DIR=/path/to/images or pass --fixture-dir."
        )

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
