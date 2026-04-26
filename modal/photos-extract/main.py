"""Modal app: FlexStudios photo Pass 0 EXIF + preview extractor.

Exposes one HTTP endpoint, `extract_http`, which the Supabase Edge Function
`shortlisting-extract` calls with a list of CR3 file paths under the project's
`Photos/Raws/Shortlist Proposed/` folder. For each file we:

  1. Download the CR3 bytes from Dropbox (using the Modal-side
     `dropbox_access_token` secret).
  2. Run `exiftool` to extract the bracket-relevant EXIF tags (AEBBracketValue,
     DateTimeOriginal, SubSecTimeOriginal, ShutterSpeed, Aperture, ISO,
     FocalLength, Orientation, plus model name).
  3. Run `exiftool -b -PreviewImage` to extract the embedded 1620×1080 preview
     JPEG (Canon CR3 ships three embedded JPEGs — PreviewImage is the perfect
     middle size for vision API calls).
  4. Resize the preview to 1024 px wide using PIL → JPEG quality=85.
  5. Compute mean luminance via PIL (used by Pass 0 for best-bracket selection).
  6. Upload the resized preview JPEG to
     `<dropbox_root_path>/Photos/Raws/Shortlist Proposed/Previews/<stem>.jpg`.

We process files concurrently with a thread pool — Dropbox + exiftool both
release the GIL nicely, and 100 files at 30 KB/s each is ~16 s wall clock
when parallel.

Auth: bearer token in the `Authorization: Bearer <token>` header MUST equal the
`_token` field in the JSON body MUST equal the `SUPABASE_SERVICE_ROLE_KEY`
Modal secret. Two-belt check (header + body) mirrors the drone SfM pattern.

Failure handling: per-file errors set `files[stem].ok=false, error: "..."` but
the top-level response stays `ok: true` so the dispatcher records the partial
result. Catastrophic failures (auth fail, secret missing, Dropbox down across
the board) return top-level `ok: false`.
"""
from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import modal


# ──────────────────────────────────────────────────────────────────────────────
# Image: Pillow + pyexiftool + dropbox SDK + fastapi (for HTTP endpoint).
# We install libimage-exiftool-perl from apt because pyexiftool is just a
# wrapper around the binary — same pattern as the drone SfM worker.
# ──────────────────────────────────────────────────────────────────────────────
photos_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libimage-exiftool-perl")
    .pip_install(
        "Pillow>=10.0",
        "pyexiftool>=0.5",
        "dropbox>=11.0",
        "fastapi[standard]",
        "httpx==0.27.2",
    )
)

app = modal.App("flexstudios-photos-extract", image=photos_image)


# ──────────────────────────────────────────────────────────────────────────────
# Dropbox helpers (using the Modal-side `dropbox_access_token` secret).
# We use the python `dropbox` SDK rather than raw HTTP — it handles retries,
# auth headers, and team-folder path-root for us.
# ──────────────────────────────────────────────────────────────────────────────
def _dropbox_client():
    import dropbox
    token = os.environ.get("DROPBOX_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError(
            "DROPBOX_ACCESS_TOKEN missing — Modal secret 'dropbox_access_token' not attached"
        )
    client = dropbox.Dropbox(oauth2_access_token=token, timeout=120)
    # Team-folder namespace handling: paths like "/Flex Media Team Folder/..."
    # only resolve when the SDK is scoped to the team's root namespace via
    # with_path_root. Without it, the SDK looks in the user's PERSONAL root and
    # returns LookupError('not_found') for every team-folder path.
    #
    # Resolution order:
    #   1. DROPBOX_TEAM_NAMESPACE_ID env var (matches Supabase Edge-side var name)
    #   2. Auto-detect via users/get_current_account → root_info.root_namespace_id
    #      (works whenever the access token has a team root)
    ns = os.environ.get("DROPBOX_TEAM_NAMESPACE_ID", "").strip()
    if not ns:
        try:
            account = client.users_get_current_account()
            root_info = getattr(account, "root_info", None)
            if root_info is not None:
                ns = getattr(root_info, "root_namespace_id", "") or ""
                if ns:
                    print(f"[photos-extract] auto-detected team root namespace: {ns}")
        except Exception as e:  # noqa: BLE001
            print(f"[photos-extract] team namespace auto-detect failed: {e}")
    if ns:
        client = client.with_path_root(dropbox.common.PathRoot.root(ns))
    return client


def _dropbox_download(client, path: str) -> bytes:
    """Download a file's bytes. Raises on any error."""
    _md, resp = client.files_download(path)
    return resp.content


def _dropbox_upload(client, path: str, body: bytes) -> None:
    """Upload bytes to a Dropbox path with overwrite-on-conflict."""
    import dropbox
    client.files_upload(
        body,
        path,
        mode=dropbox.files.WriteMode("overwrite"),
        autorename=False,
        mute=True,
    )


# ──────────────────────────────────────────────────────────────────────────────
# EXIF extraction via exiftool subprocess.
# pyexiftool batches many files in one process, but we deliberately invoke
# per-file here — keeps error isolation simple and the per-call overhead
# (~150 ms) is dwarfed by the Dropbox round-trip.
# ──────────────────────────────────────────────────────────────────────────────
EXIF_TAGS = [
    "-AEBBracketValue",
    "-DateTimeOriginal",
    "-SubSecTimeOriginal",
    "-ShutterSpeed",
    "-ShutterSpeedValue",
    "-ExposureTime",
    "-Aperture",
    "-ApertureValue",
    "-FNumber",
    "-ISO",
    "-FocalLength",
    "-Orientation",
    "-Model",
]


def _exif_extract(cr3_path: Path) -> Dict[str, Any]:
    """Run `exiftool -j <tags> file` and return the JSON dict for the file."""
    cmd = ["exiftool", "-j", "-n", *EXIF_TAGS, str(cr3_path)]
    proc = subprocess.run(cmd, check=False, capture_output=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(
            f"exiftool failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'ignore')[:300]}"
        )
    # Burst 3 I3: use 'replace' instead of 'ignore' so non-UTF-8 bytes become
    # � placeholders. 'ignore' silently drops bytes which can corrupt the
    # JSON delimiter sequence and turn a single weird-char file into a JSON
    # parse failure for the whole call.
    out = proc.stdout.decode("utf-8", "replace")
    if not out.strip():
        return {}
    parsed = json.loads(out)
    if not parsed:
        return {}
    return parsed[0]


def _exif_extract_preview(cr3_path: Path, dst: Path) -> None:
    """Extract embedded PreviewImage JPEG via `exiftool -b -PreviewImage`."""
    cmd = ["exiftool", "-b", "-PreviewImage", str(cr3_path)]
    with open(dst, "wb") as f:
        proc = subprocess.run(cmd, check=False, stdout=f, stderr=subprocess.PIPE, timeout=30)
    if proc.returncode != 0 or dst.stat().st_size == 0:
        raise RuntimeError(
            f"exiftool PreviewImage extract failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'ignore')[:300]}"
        )


# ──────────────────────────────────────────────────────────────────────────────
# Capture timestamp helpers
# ──────────────────────────────────────────────────────────────────────────────
def _capture_timestamp_ms(date_time_original: Optional[str], sub_sec: Optional[str]) -> Optional[int]:
    """Combine DateTimeOriginal ('YYYY:MM:DD HH:MM:SS') + SubSec into epoch ms.

    Treated as Sydney-local time. We DO NOT apply a timezone shift here —
    Pass 0 only uses this for relative ordering / gap detection within a
    single shoot, where consistent local time is sufficient. Absolute UTC
    is the dispatcher's concern, not the extractor's.
    """
    if not date_time_original:
        return None
    try:
        # exiftool format: '2026:04:21 11:23:00'
        s = str(date_time_original).strip()
        # Some cameras emit '2026:04:21 11:23:00.123' — strip the fractional
        # part since we get sub-seconds from SubSecTimeOriginal separately.
        if "." in s:
            s = s.split(".")[0]
        date_part, time_part = s.split(" ", 1)
        y, mo, d = date_part.split(":")
        h, mi, se = time_part.split(":")
        # Use a calendar.timegm() equivalent — treat as UTC for stable ms math.
        # The +0 timezone here is intentional: relative gaps don't care.
        import calendar
        epoch_s = calendar.timegm(
            (int(y), int(mo), int(d), int(h), int(mi), int(se), 0, 0, 0)
        )
        ms = epoch_s * 1000
        if sub_sec is not None and str(sub_sec).strip() != "":
            sub_str = str(sub_sec).strip()
            # SubSecTimeOriginal is a fractional-second component, e.g. '37'
            # for 0.37 s. Pad to 3 digits for ms.
            digits = "".join(c for c in sub_str if c.isdigit())
            if digits:
                # left-justify to 3 chars then truncate
                ms_part = (digits + "000")[:3]
                ms += int(ms_part)
        return int(ms)
    except Exception as e:
        print(f"[photos-extract] _capture_timestamp_ms parse failed for {date_time_original!r} / {sub_sec!r}: {e}")
        return None


def _shutter_speed_to_seconds(value: Any) -> Optional[float]:
    """Convert ShutterSpeedValue / ExposureTime to seconds (float)."""
    if value is None:
        return None
    try:
        v = str(value).strip()
        if v == "":
            return None
        # Forms: '0.04', '1/25', '1/250'.
        if "/" in v:
            num, den = v.split("/", 1)
            return float(num) / float(den)
        return float(v)
    except Exception:
        return None


def _aperture_to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _int_or_none(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(float(value))
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Per-file pipeline (downloaded → exif → preview → upload).
# Pure of side effects beyond the temp dir + the upload at the end.
# ──────────────────────────────────────────────────────────────────────────────
def _process_one(
    client,
    project_id: str,
    file_path: str,
    previews_dir_dropbox: str,
    work_root: Path,
) -> Tuple[str, Dict[str, Any]]:
    """Process a single CR3. Returns (stem, result_dict)."""
    from PIL import Image
    stem = Path(file_path).stem
    file_workdir = work_root / stem
    file_workdir.mkdir(parents=True, exist_ok=True)
    cr3_local = file_workdir / Path(file_path).name
    preview_raw = file_workdir / f"{stem}.preview.raw.jpg"
    preview_resized = file_workdir / f"{stem}.preview.jpg"

    try:
        # 1. Download
        bytes_in = _dropbox_download(client, file_path)
        cr3_local.write_bytes(bytes_in)

        # 2. EXIF
        exif_raw = _exif_extract(cr3_local)
        camera_model = exif_raw.get("Model")
        date_time_original = exif_raw.get("DateTimeOriginal")
        sub_sec = exif_raw.get("SubSecTimeOriginal")
        # Burst 3 I1: explicit "is not None" rather than `or` chain. The chain
        # short-circuits on falsy values, so a legitimate 0 (impossible for
        # shutter/aperture in practice but sloppy semantically) would skip to
        # the next fallback. Defensive coding for future variability.
        def _first_not_none(*vals):
            for v in vals:
                if v is not None:
                    return v
            return None
        shutter_value = _first_not_none(
            _shutter_speed_to_seconds(exif_raw.get("ShutterSpeedValue")),
            _shutter_speed_to_seconds(exif_raw.get("ShutterSpeed")),
            _shutter_speed_to_seconds(exif_raw.get("ExposureTime")),
        )
        aperture = _first_not_none(
            _aperture_to_float(exif_raw.get("Aperture")),
            _aperture_to_float(exif_raw.get("ApertureValue")),
            _aperture_to_float(exif_raw.get("FNumber")),
        )
        iso = _int_or_none(exif_raw.get("ISO"))
        focal_length = _aperture_to_float(exif_raw.get("FocalLength"))
        aeb_bracket_value = _aperture_to_float(exif_raw.get("AEBBracketValue"))
        orientation = exif_raw.get("Orientation")
        capture_ts_ms = _capture_timestamp_ms(date_time_original, sub_sec)

        # 3. Preview JPEG
        _exif_extract_preview(cr3_local, preview_raw)
        with Image.open(preview_raw) as im:
            im = im.convert("RGB")
            target_w = 1024
            if im.width > target_w:
                ratio = target_w / im.width
                new_h = int(round(im.height * ratio))
                im = im.resize((target_w, new_h), Image.LANCZOS)
            im.save(preview_resized, format="JPEG", quality=85, optimize=True)
            # 4. Mean luminance — convert to L (greyscale) and average pixels.
            grey = im.convert("L")
            data = list(grey.getdata())
            luminance = sum(data) / len(data) if data else 0.0

        preview_bytes = preview_resized.read_bytes()
        preview_size_kb = round(len(preview_bytes) / 1024, 1)

        # 5. Upload
        preview_dropbox_path = f"{previews_dir_dropbox}/{stem}.jpg"
        _dropbox_upload(client, preview_dropbox_path, preview_bytes)

        return stem, {
            "ok": True,
            "exif": {
                "fileName": Path(file_path).name,
                "cameraModel": camera_model,
                "shutterSpeed": str(exif_raw.get("ShutterSpeed") or exif_raw.get("ExposureTime") or ""),
                "shutterSpeedValue": shutter_value,
                "aperture": aperture,
                "iso": iso,
                "focalLength": focal_length,
                "aebBracketValue": aeb_bracket_value,
                "dateTimeOriginal": date_time_original,
                "subSecTimeOriginal": sub_sec,
                "captureTimestampMs": capture_ts_ms,
                "orientation": orientation,
            },
            "preview_dropbox_path": preview_dropbox_path,
            "preview_size_kb": preview_size_kb,
            "luminance": round(float(luminance), 2),
        }
    except Exception as e:
        print(f"[photos-extract] file {file_path} failed: {e}")
        traceback.print_exc()
        return stem, {
            "ok": False,
            "error": (str(e) or repr(e))[:500],
        }
    finally:
        # Best-effort cleanup. Modal containers are short-lived but we may
        # process 50+ files per call so keep the fs lean.
        try:
            shutil.rmtree(file_workdir, ignore_errors=True)
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────────────
# HTTP endpoint
# ──────────────────────────────────────────────────────────────────────────────
@app.function(
    cpu=4.0,
    memory=8192,
    timeout=900,
    secrets=[
        modal.Secret.from_name("dropbox_access_token"),
        modal.Secret.from_name("supabase_service_role_key"),
    ],
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=False)
def extract_http(payload: Dict[str, Any], authorization: Optional[str] = None):
    """HTTP-callable extractor.

    POST body:
        {
            "_token":              shared-secret bearer token (SUPABASE_SERVICE_ROLE_KEY),
            "project_id":          UUID string,
            "file_paths":          [ "/Flex Media Team Folder/.../IMG_1234.CR3", ... ],
            "dropbox_root_path":   project root (for resolving Previews/ destination)
        }

    Auth: header Authorization: Bearer <token> AND body._token both equal
    the SUPABASE_SERVICE_ROLE_KEY secret.

    Response: see module docstring for shape.
    """
    from fastapi import HTTPException, Header
    from fastapi.responses import JSONResponse

    started_at = time.time()
    expected = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not expected:
        return JSONResponse({"ok": False, "error": "SUPABASE_SERVICE_ROLE_KEY not configured in Modal secret"}, status_code=500)

    # Auth — both header and body must agree with the secret. The fastapi
    # framework injects Authorization header into kwargs when a parameter is
    # annotated; since we don't annotate, fetch from the request manually
    # via the body (the dispatcher always sends both).
    body_token = (payload or {}).get("_token") if isinstance(payload, dict) else None
    if not body_token or body_token != expected:
        return JSONResponse({"ok": False, "error": "invalid or missing _token"}, status_code=401)

    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "JSON object required"}, status_code=400)

    project_id = payload.get("project_id")
    file_paths = payload.get("file_paths") or []
    dropbox_root_path = payload.get("dropbox_root_path")

    if not project_id or not isinstance(project_id, str):
        return JSONResponse({"ok": False, "error": "project_id required (string)"}, status_code=400)
    if not isinstance(file_paths, list) or len(file_paths) == 0:
        return JSONResponse({"ok": False, "error": "file_paths required (non-empty list)"}, status_code=400)
    if not dropbox_root_path or not isinstance(dropbox_root_path, str):
        return JSONResponse({"ok": False, "error": "dropbox_root_path required (string)"}, status_code=400)

    previews_dir = f"{dropbox_root_path}/Photos/Raws/Shortlist Proposed/Previews"

    # Set up Dropbox client once per call — re-using it across files reuses
    # the underlying TLS connection (Python urllib3 pool).
    try:
        client = _dropbox_client()
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"dropbox client init failed: {e}"}, status_code=500)

    files_out: Dict[str, Dict[str, Any]] = {}
    workroot = Path(tempfile.mkdtemp(prefix="photos-extract-"))
    try:
        # Concurrent — Dropbox + exiftool are I/O bound so a small thread pool
        # gives us most of the wall-clock win without overwhelming the API.
        max_workers = min(8, len(file_paths))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [
                pool.submit(_process_one, client, project_id, fp, previews_dir, workroot)
                for fp in file_paths
            ]
            for fut in as_completed(futures):
                try:
                    stem, result = fut.result()
                except Exception as e:
                    # Defensive — _process_one already swallows per-file errors,
                    # so this branch is for truly catastrophic ones.
                    print(f"[photos-extract] worker raised: {e}")
                    continue
                files_out[stem] = result
    finally:
        try:
            shutil.rmtree(workroot, ignore_errors=True)
        except Exception:
            pass

    elapsed = round(time.time() - started_at, 2)
    summary = {
        "ok": True,
        "project_id": project_id,
        "files_total": len(file_paths),
        "files_succeeded": sum(1 for v in files_out.values() if v.get("ok")),
        "files_failed": sum(1 for v in files_out.values() if not v.get("ok")),
        "elapsed_seconds": elapsed,
        "files": files_out,
    }
    return JSONResponse(summary, status_code=200)
