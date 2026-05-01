"""Modal app: Pulse W15b.3 — video frame extractor.

Downloads a Pulse listing video (`pulse_listings.video_url`, typically REA-hosted
MP4 in the 30s-90s range), probes its duration with ffprobe, then extracts
frames at:

  1. A fixed sampling rate (`target_fps`, default 0.2 fps → one frame every 5s)
  2. Scene-change boundaries (ffmpeg `select='gt(scene,0.4)'`).

Each extracted frame is uploaded to the Supabase Storage bucket
`pulse-video-frames` (private; signed URLs only) at key
`<listing_id>/<idx>.jpg`. The endpoint returns:

    {
      ok: true,
      listing_id: str,
      total_duration_s: float,
      target_fps: float,
      frame_urls: [str],            # 1-hour signed URLs, in capture order
      frame_timestamps_s: [float],  # parallel array, t in seconds for each frame
      scene_changes_s: [float],     # raw scene-change timestamps (subset of above)
      frame_count: int,
      elapsed_seconds: float,
    }

Mirrors the auth + per-row failure pattern of `modal/photos-extract/main.py`:
  - Auth: `body._token` field MUST equal the `SUPABASE_SERVICE_ROLE_KEY` Modal
    secret (the Authorization header is ignored — same model as photos-extract).
  - Catastrophic failure → `{ok: false, error: "..."}` HTTP 4xx/5xx.
  - Per-frame upload failure is tolerated; the surviving frames are returned.

Limits:
  - Reject videos > 200 MB (configurable via PULSE_FRAME_MAX_BYTES env, default 200 MB).
  - Reject videos > 600s probed duration (defensive; REA videos are ≤ 90s).
  - Cap extracted frames at 60 (defensive; at 0.2 fps × 600s = 120 frames max
    sampling, scene changes can add more).

Deploy:
    modal deploy modal/pulse-video-frame-extractor/pulseVideoFrameExtractor.py

After deploy, take the printed URL and set on Supabase:
    supabase secrets set MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL=https://...modal.run \\
        --project-ref rjzdznwkxnzfekgcdkei
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Tuple

import modal


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "requests==2.32.3",
        "supabase==2.10.0",
        "fastapi[standard]",
        "httpx==0.27.2",
    )
)

app = modal.App("pulse-video-frame-extractor", image=image)


DEFAULT_TARGET_FPS = 0.2
DEFAULT_SCENE_THRESHOLD = 0.4
MAX_BYTES_DEFAULT = 200 * 1024 * 1024
MAX_DURATION_S_DEFAULT = 600.0
MAX_FRAMES = 60
SIGNED_URL_TTL_S = 3600
BUCKET_NAME = "pulse-video-frames"
DOWNLOAD_TIMEOUT_S = 90


def _download_video(video_url: str, dst: Path, max_bytes: int) -> int:
    """Stream-download `video_url` to `dst`. Returns bytes written.

    Raises if size exceeds `max_bytes` mid-stream OR HTTP status != 200.
    """
    import requests

    written = 0
    with requests.get(video_url, stream=True, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        if resp.status_code != 200:
            raise RuntimeError(
                f"video fetch returned HTTP {resp.status_code}: {resp.text[:240]}"
            )
        cl = resp.headers.get("Content-Length")
        if cl:
            try:
                if int(cl) > max_bytes:
                    raise RuntimeError(
                        f"video Content-Length {cl} exceeds max {max_bytes}"
                    )
            except ValueError:
                pass
        with open(dst, "wb") as f:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                written += len(chunk)
                if written > max_bytes:
                    raise RuntimeError(
                        f"video size exceeded {max_bytes} bytes (streamed {written})"
                    )
                f.write(chunk)
    return written


def _probe_duration_s(video_path: Path) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    proc = subprocess.run(cmd, check=False, capture_output=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'ignore')[:240]}"
        )
    out = proc.stdout.decode("utf-8", "replace").strip()
    if not out:
        raise RuntimeError("ffprobe returned empty duration")
    try:
        return float(out)
    except ValueError as e:
        raise RuntimeError(f"ffprobe duration parse failed: {out!r}: {e}")


def _extract_fps_frames(video_path: Path, work_dir: Path, target_fps: float) -> List[Tuple[float, Path]]:
    """Extract one frame every (1/target_fps) seconds. Returns (t, path) list."""
    out_pattern = work_dir / "fps_%04d.jpg"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(video_path),
        "-vf", f"fps={target_fps}",
        "-q:v", "3",
        str(out_pattern),
    ]
    proc = subprocess.run(cmd, check=False, capture_output=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg fps-sample failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'ignore')[:240]}"
        )
    interval = 1.0 / target_fps if target_fps > 0 else 5.0
    frames: List[Tuple[float, Path]] = []
    for i, p in enumerate(sorted(work_dir.glob("fps_*.jpg")), start=1):
        t = (i - 1) * interval
        frames.append((t, p))
    return frames


def _extract_scene_frames(video_path: Path, work_dir: Path, threshold: float) -> List[Tuple[float, Path]]:
    """Extract scene-change frames. Returns (t, path) list.

    Uses ffmpeg's `select=gt(scene,X)` filter and `showinfo` to harvest pts
    timestamps. We post-process the stderr to recover (idx → pts_time) mapping.
    """
    out_pattern = work_dir / "scene_%04d.jpg"
    cmd = [
        "ffmpeg", "-hide_banner",
        "-i", str(video_path),
        "-vf", f"select='gt(scene\\,{threshold})',showinfo",
        "-vsync", "vfr",
        "-q:v", "3",
        str(out_pattern),
    ]
    proc = subprocess.run(cmd, check=False, capture_output=True, timeout=180)
    if proc.returncode != 0:
        print(
            f"[pulse-video-frame-extractor] scene-detect failed ({proc.returncode}): "
            f"{proc.stderr.decode('utf-8', 'ignore')[:240]} — continuing without scene frames"
        )
        return []
    stderr = proc.stderr.decode("utf-8", "replace")
    pts_times: List[float] = []
    for line in stderr.splitlines():
        if "pts_time:" in line:
            try:
                t = float(line.split("pts_time:")[1].split()[0])
                pts_times.append(t)
            except Exception:
                continue
    paths = sorted(work_dir.glob("scene_*.jpg"))
    n = min(len(paths), len(pts_times))
    return [(pts_times[i] if i < len(pts_times) else 0.0, paths[i]) for i in range(n)]


def _merge_frames(
    fps_frames: List[Tuple[float, Path]],
    scene_frames: List[Tuple[float, Path]],
    cap: int,
) -> Tuple[List[Tuple[float, Path]], List[float]]:
    """De-duplicate (within 1s) and cap. Returns (merged, scene_change_ts)."""
    scene_ts = sorted([t for t, _ in scene_frames])
    seen_ts: List[float] = []
    merged: List[Tuple[float, Path]] = []
    for t, p in sorted(fps_frames + scene_frames, key=lambda x: x[0]):
        if any(abs(t - st) < 1.0 for st in seen_ts):
            continue
        seen_ts.append(t)
        merged.append((t, p))
        if len(merged) >= cap:
            break
    return merged, scene_ts


def _upload_and_sign(
    listing_id: str,
    frames: List[Tuple[float, Path]],
    supabase_url: str,
    service_role_key: str,
) -> List[Tuple[float, str]]:
    """Upload each frame to `pulse-video-frames` and return parallel signed URL list."""
    from supabase import create_client
    client = create_client(supabase_url, service_role_key)
    out: List[Tuple[float, str]] = []
    for idx, (t, fpath) in enumerate(frames):
        key = f"{listing_id}/{idx}.jpg"
        try:
            with open(fpath, "rb") as f:
                body = f.read()
            client.storage.from_(BUCKET_NAME).upload(
                key,
                body,
                file_options={"content-type": "image/jpeg", "upsert": "true"},
            )
            signed = client.storage.from_(BUCKET_NAME).create_signed_url(
                key, SIGNED_URL_TTL_S
            )
            url = signed.get("signedURL") or signed.get("signed_url") or signed.get("signedUrl")
            if not url:
                raise RuntimeError(f"signed URL not returned: {signed!r}")
            out.append((t, url))
        except Exception as e:
            print(f"[pulse-video-frame-extractor] frame {idx} upload failed: {e}")
            traceback.print_exc()
            continue
    return out


@app.function(
    cpu=2.0,
    memory=4096,
    timeout=300,
    secrets=[
        modal.Secret.from_name("supabase-pulse-frame-extractor"),
    ],
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=False)
def extract_frames(payload: Dict[str, Any]):
    """HTTP-callable frame extractor. See module docstring for the full contract."""
    from fastapi.responses import JSONResponse

    started_at = time.time()
    expected = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    supabase_url = os.environ.get("SUPABASE_URL", "")
    if not expected or not supabase_url:
        return JSONResponse(
            {"ok": False, "error": "Modal secret missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL"},
            status_code=500,
        )

    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "JSON object required"}, status_code=400)
    body_token = payload.get("_token")
    if not body_token or body_token != expected:
        return JSONResponse({"ok": False, "error": "invalid or missing _token"}, status_code=401)

    listing_id = payload.get("listing_id")
    video_url = payload.get("video_url")
    target_fps = float(payload.get("target_fps") or DEFAULT_TARGET_FPS)
    scene_threshold = float(payload.get("scene_threshold") or DEFAULT_SCENE_THRESHOLD)

    if not listing_id or not isinstance(listing_id, str):
        return JSONResponse({"ok": False, "error": "listing_id required (string)"}, status_code=400)
    if not video_url or not isinstance(video_url, str):
        return JSONResponse({"ok": False, "error": "video_url required (string)"}, status_code=400)
    if target_fps <= 0 or target_fps > 5:
        return JSONResponse(
            {"ok": False, "error": "target_fps must be in (0, 5]"},
            status_code=400,
        )

    max_bytes = int(os.environ.get("PULSE_FRAME_MAX_BYTES") or MAX_BYTES_DEFAULT)
    max_duration_s = float(os.environ.get("PULSE_FRAME_MAX_DURATION_S") or MAX_DURATION_S_DEFAULT)

    work_root = Path(tempfile.mkdtemp(prefix="pulse-video-frames-"))
    video_path = work_root / f"{listing_id}.mp4"
    frames_dir = work_root / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    try:
        bytes_in = _download_video(video_url, video_path, max_bytes)
        print(f"[pulse-video-frame-extractor] downloaded {bytes_in} bytes for listing {listing_id}")

        duration_s = _probe_duration_s(video_path)
        if duration_s > max_duration_s:
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"video duration {duration_s:.1f}s exceeds max {max_duration_s:.1f}s",
                },
                status_code=400,
            )

        fps_frames = _extract_fps_frames(video_path, frames_dir, target_fps)
        scene_frames = _extract_scene_frames(video_path, frames_dir, scene_threshold)
        merged, scene_ts = _merge_frames(fps_frames, scene_frames, MAX_FRAMES)

        uploaded = _upload_and_sign(
            listing_id=listing_id,
            frames=merged,
            supabase_url=supabase_url,
            service_role_key=expected,
        )
        frame_urls = [u for _, u in uploaded]
        frame_ts = [round(t, 3) for t, _ in uploaded]

        elapsed = round(time.time() - started_at, 2)
        return JSONResponse({
            "ok": True,
            "listing_id": listing_id,
            "video_url": video_url,
            "video_bytes": bytes_in,
            "total_duration_s": round(duration_s, 3),
            "target_fps": target_fps,
            "frame_count": len(frame_urls),
            "frame_urls": frame_urls,
            "frame_timestamps_s": frame_ts,
            "scene_changes_s": [round(t, 3) for t in scene_ts],
            "elapsed_seconds": elapsed,
        }, status_code=200)
    except Exception as e:
        msg = (str(e) or repr(e))[:500]
        print(f"[pulse-video-frame-extractor] failed: {msg}")
        traceback.print_exc()
        return JSONResponse({"ok": False, "error": msg}, status_code=500)
    finally:
        try:
            shutil.rmtree(work_root, ignore_errors=True)
        except Exception:
            pass
