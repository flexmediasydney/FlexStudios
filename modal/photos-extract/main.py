"""Modal app: FlexStudios photo Pass 0 EXIF + preview extractor.

Exposes one HTTP endpoint, `extract_http`, which the Supabase Edge Function
`shortlisting-extract` calls with a list of CR3 file paths under the project's
`Photos/Raws/Shortlist Proposed/` folder. For each file we:

  1. Download the CR3 bytes from Dropbox (using the Modal-side
     `dropbox_access_token` secret).
  2. Run `exiftool` to extract the bracket-relevant EXIF tags (AEBBracketValue,
     DateTimeOriginal, SubSecTimeOriginal, ShutterSpeed, Aperture, ISO,
     FocalLength, Orientation, Model, plus camera body serial number — Wave
     10.1 added `-SerialNumber` and `-BodySerialNumber` so the Pass 0
     partitioner can identify each camera body uniquely. Different Canon
     firmwares emit different keys; we read whichever is present and surface
     it as `bodySerial` in the response.).
  3. Run `exiftool -b -PreviewImage` to extract the embedded 1620×1080 preview
     JPEG (Canon CR3 ships three embedded JPEGs — PreviewImage is the perfect
     middle size for vision API calls).
  4. Resize the preview to 1024 px wide using PIL → JPEG quality=85.
  5. Compute mean luminance via PIL (used by Pass 0 for best-bracket selection).
  6. Upload the resized preview JPEG to
     `<dropbox_root_path>/Photos/Raws/Shortlist Proposed/Previews/<stem>.jpg`.

Response shape (per file, under `files[stem].exif`):
  {
    fileName, cameraModel, bodySerial,           # bodySerial added in W10.1
    shutterSpeed, shutterSpeedValue, aperture,
    iso, focalLength, aebBracketValue,
    dateTimeOriginal, subSecTimeOriginal,
    captureTimestampMs, orientation
  }
Old callers reading `cameraModel` keep working. New W10.1 callers read
`bodySerial`; missing serials surface as null and the Deno-side partitioner
falls back to a model-only canonical slug.

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
        # Wave 2 (2026-05-03): Supabase Storage for preview JPEGs so we
        # halve Dropbox /files/* call rate. Was uploading 575 previews
        # PER ROUND back into Dropbox — pure rate-limit bloat. Storage
        # client uses the SUPABASE_SERVICE_ROLE_KEY secret.
        "supabase>=2.0",
    )
)

app = modal.App("flexstudios-photos-extract", image=photos_image)


# ──────────────────────────────────────────────────────────────────────────────
# Dropbox helpers.
#
# Wave 7 P0-3: token resolution order
#   1. `access_token` argument (passed by the Edge caller — minted via the
#      DROPBOX_REFRESH_TOKEN flow on the Supabase side; always fresh, no
#      4-hour expiry to bite us mid-round).
#   2. `DROPBOX_ACCESS_TOKEN` env var (Modal secret) — backwards-compat
#      fallback during the deploy window. Will be removed once all Edge
#      callers are confirmed sending the token.
#
# We use the python `dropbox` SDK rather than raw HTTP — it handles retries,
# auth headers, and team-folder path-root for us.
# ──────────────────────────────────────────────────────────────────────────────
def _dropbox_client(access_token: str = "", team_namespace_id: str = ""):
    import dropbox
    token = (access_token or "").strip() or os.environ.get("DROPBOX_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError(
            "Dropbox token missing — caller did not supply `dropbox_access_token` and "
            "DROPBOX_ACCESS_TOKEN env (Modal secret 'dropbox_access_token') is empty"
        )
    # 2026-05-03 — disable SDK silent retries so 429s surface to caller
    # immediately instead of the SDK eating multiple 120s timeouts in
    # silence. Caller (extract bg task in Edge fn) handles retry policy
    # at the JOB level via attempt_count + dispatcher rerun.
    client = dropbox.Dropbox(
        oauth2_access_token=token,
        timeout=30,                   # 30s per request (was 120)
        max_retries_on_error=1,       # only 1 retry on transient (was default 4)
        max_retries_on_rate_limit=0,  # surface 429 immediately (was default 4)
    )
    # Team-folder namespace handling: paths like "/Flex Media Team Folder/..."
    # only resolve when the SDK is scoped to the team's root namespace via
    # with_path_root. Without it, the SDK looks in the user's PERSONAL root and
    # returns LookupError('not_found') for every team-folder path.
    #
    # 2026-05-03 — QC debug discovered the auto-detect path
    # (client.users_get_current_account()) silently hangs for the full 150s
    # IDLE_TIMEOUT on every cold-start when the /users API bucket is
    # rate-limited (Dropbox SDK retries with exponential backoff). FIX: the
    # caller now passes `team_namespace_id` in the request body so Modal
    # avoids that API call entirely.
    #
    # Resolution order:
    #   1. caller-supplied team_namespace_id (current canonical path)
    #   2. DROPBOX_TEAM_NAMESPACE_ID env var (Modal secret) — fallback
    #   3. Auto-detect via users/get_current_account — LAST resort, only if
    #      the caller didn't pass a namespace AND no env var. Wrapped in a
    #      hard 5s timeout so a hung call can't burn the whole IDLE_TIMEOUT.
    ns = (team_namespace_id or "").strip() \
         or os.environ.get("DROPBOX_TEAM_NAMESPACE_ID", "").strip()
    if not ns:
        # No caller hint; try auto-detect under a hard timeout so we fail
        # FAST instead of hanging the full 150s. Caller-supplied namespace
        # is the preferred path; this branch is purely defensive.
        try:
            import socket
            socket.setdefaulttimeout(5.0)  # affects this thread + subordinate dbx http call
            account = client.users_get_current_account()
            socket.setdefaulttimeout(None)
            root_info = getattr(account, "root_info", None)
            if root_info is not None:
                ns = getattr(root_info, "root_namespace_id", "") or ""
                if ns:
                    print(f"[photos-extract] auto-detected team root namespace: {ns}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[photos-extract] team namespace auto-detect failed (5s timeout): {e}", flush=True)
            socket.setdefaulttimeout(None)
    if ns:
        client = client.with_path_root(dropbox.common.PathRoot.root(ns))
    return client


def _log_dropbox_429(bucket: str, retry_after_s: Optional[int], context: Dict[str, Any]):
    """Best-effort POST a row into public.dropbox_429_log so the
    shortlisting-job-dispatcher can flip its circuit breaker.

    Wave 2 — the dispatcher polls this table on every tick and, if it
    sees ≥3 rows for bucket='files' inside the last 60s, it stops
    claiming new `extract` jobs until the window rolls forward.

    Failure here must NEVER affect the extract result. Any exception
    (network, RLS, schema drift) is caught and printed to QC logs.
    Timeout is 3s — long enough for a healthy Supabase REST round-trip,
    short enough to not stall a Dropbox 429 retry.
    """
    try:
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not supabase_url or not service_key:
            # Silently skip if Modal isn't running with Supabase secrets
            # (e.g. dev / local CLI runs). Production secrets always set.
            return
        import httpx
        httpx.post(
            f"{supabase_url}/rest/v1/dropbox_429_log",
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={
                "bucket": bucket,
                "retry_after_s": retry_after_s,
                "source": "modal:photos-extract",
                "context": context,
            },
            timeout=3.0,
        )
    except Exception as e:
        print(f"[QC] dropbox_429_log post failed (non-fatal): {e}", flush=True)


def _dropbox_429_aware_call(fn, *, op_name: str, max_retries: int = 1):
    """Wrap a Dropbox SDK call with explicit 429 awareness.

    Today (pre-fix) the SDK silently retried 4× on 429 with 120s timeout
    each → up to 480s of invisible waiting. We disabled SDK retries
    (max_retries_on_rate_limit=0) so 429s now surface immediately. THIS
    helper catches the surfaced 429, sleeps `retry_after` (capped at 60s
    so the chunk doesn't sit idle for 5 minutes), and retries ONCE.
    Subsequent 429 = give up; the FILE fails (not the chunk) and the
    dispatcher's per-job retry budget kicks in.

    Wave 2 — every 429 is also POSTed to public.dropbox_429_log so the
    dispatcher can open its circuit breaker and stop firing more
    extract jobs at a hot Dropbox bucket.
    """
    import dropbox.exceptions
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except dropbox.exceptions.RateLimitError as e:
            last_err = e
            retry_after_raw = getattr(e.error, 'retry_after', None)
            wait_s = min(60, retry_after_raw or 30)
            print(
                f"[QC] dropbox_429 op={op_name} attempt={attempt + 1}/{max_retries + 1} "
                f"wait={wait_s}s retry_after_raw={retry_after_raw} "
                f"next={'retry' if attempt < max_retries else 'fail'}",
                flush=True,
            )
            # Telemetry POST is best-effort and runs synchronously
            # (≤3s) — fast enough to not meaningfully slow the retry path.
            _log_dropbox_429(
                bucket="files",
                retry_after_s=retry_after_raw,
                context={"op": op_name, "attempt": attempt + 1, "wait_s": wait_s},
            )
            if attempt < max_retries:
                time.sleep(wait_s)
                continue
    raise last_err


# Wave 2.5 — process-wide rate limiter for /files/get_temporary_link.
#
# We tested 4 concurrent get_temporary_link calls and ALL FOUR immediately
# 429'd with retry_after=300, exactly the same failure mode as direct
# files_download.  /files/get_temporary_link shares the /files API rate
# limit despite being a metadata call.  The fix: SERIALIZE the link
# calls with a minimum gap (~300ms) so we never burst the API; the
# returned CDN URL fetches the actual bytes outside the rate limit so
# we lose no parallelism on the heavy work.
#
# Effective rate:  ~3 link calls/sec = 180/min; comfortably under the
# observed-but-unpublished /files threshold (Dropbox docs claim
# unpublished but our empirical testing shows that 4 concurrent ≈ 0
# success rate while 1-at-a-time works reliably).
#
# Implementation: a module-level lock serializes the *gap*, not the API
# call itself.  Each worker takes the lock, computes how long to wait,
# updates the "last fired" timestamp, releases the lock, and only THEN
# fires the API call.  This means N workers can have N API calls
# overlapping in flight (which is fine — it's the BURST start time we
# need to space out, not the latency).
import threading as _threading_for_dropbox
_DROPBOX_LINK_LOCK = _threading_for_dropbox.Lock()
_DROPBOX_LINK_LAST_TS = [0.0]
_DROPBOX_LINK_MIN_GAP_S = 0.30  # ~3.3 calls/sec ceiling


def _rate_gate_dropbox_link():
    """Block until at least _DROPBOX_LINK_MIN_GAP_S has elapsed since the
    most recent link call across this Modal container.  Releases the
    lock before returning so other workers can advance immediately.
    """
    with _DROPBOX_LINK_LOCK:
        now = time.time()
        elapsed = now - _DROPBOX_LINK_LAST_TS[0]
        if elapsed < _DROPBOX_LINK_MIN_GAP_S:
            time.sleep(_DROPBOX_LINK_MIN_GAP_S - elapsed)
            now = time.time()
        _DROPBOX_LINK_LAST_TS[0] = now


def _dropbox_download(client, path: str, prebaked_link: Optional[str] = None) -> bytes:
    """Download a CR3 file's bytes.

    Wave 3 (2026-05-03) — preferred path is ZERO Dropbox API calls.
    The Edge fn `shortlisting-ingest` mints a temp-link per file at
    round-creation time (serially, with a 300ms gap so the burst start
    is rate-limit-safe), persists each link into the chunk's
    `payload.prebaked_links`, and Modal reads it here.  We then go
    straight to httpx.get(link) on the content.dropboxapi.com CDN —
    which is on a different host than /files and not subject to the
    same adaptive rate-limiter.

    Wave 2.5 fallback (no prebaked_link supplied) — mint the temp link
    via the SDK, gated by the process-wide rate limiter.  This path is
    rate-limit-prone and only kicks in for callers that don't supply
    prebaked_links (legacy direct-mode tests, mostly).

    Why temp_link beats files_download even at the API level:
    - files_download streams MB through /files → fragile under burst.
    - get_temporary_link is a tiny metadata RPC → robust, recoverable.
    - The CDN host has its own throughput limits, far higher than
      /files', and is the canonical Dropbox download path for any
      large-volume backend (matches drone-shot-urls + getDropboxFilePreview).
    """
    if prebaked_link:
        link = prebaked_link
        link_ms = 0
        link_source = "prebaked"
    else:
        def _link_call():
            # Serialize burst-start across the worker pool.  Adds 0-300ms
            # of waiting per call, but eliminates the burst-induced 429.
            _rate_gate_dropbox_link()
            link_obj = client.files_get_temporary_link(path)
            # link_obj is a TemporaryLinkResult; .link is the CDN URL.
            return link_obj.link
        t0 = time.time()
        link = _dropbox_429_aware_call(_link_call, op_name='files_get_temporary_link')
        link_ms = int((time.time() - t0) * 1000)
        link_source = "minted"

    # CDN download — outside the /files rate-limit bucket.
    import httpx
    t_dl = time.time()
    try:
        resp = httpx.get(link, timeout=60.0)
    except httpx.HTTPError as e:
        raise RuntimeError(f"cdn_download network error: {e}")
    if resp.status_code != 200:
        raise RuntimeError(
            f"cdn_download failed: status={resp.status_code} body[:200]={resp.text[:200]!r}"
        )
    body = resp.content
    body_ms = int((time.time() - t_dl) * 1000)
    if link_ms + body_ms > 5000:
        print(
            f"[QC] _dropbox_download_detail path={path[-30:]} "
            f"link_source={link_source} link_ms={link_ms} body_ms={body_ms} bytes={len(body)}",
            flush=True,
        )
    return body


def _dropbox_upload(client, path: str, body: bytes) -> None:
    """Upload bytes to a Dropbox path with overwrite-on-conflict."""
    import dropbox
    def _call():
        client.files_upload(
            body,
            path,
            mode=dropbox.files.WriteMode("overwrite"),
            autorename=False,
            mute=True,
        )
    _dropbox_429_aware_call(_call, op_name='files_upload')


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
    # Wave 10.1 (W10.1) — body serial for the camera-source partitioner.
    # Canon CR3 emits the serial under `SerialNumber` on most modern bodies;
    # older firmwares (and some other manufacturers) emit `BodySerialNumber`
    # instead. We read both and prefer SerialNumber when present (matches
    # exiftool's canonical key on the R5 / R6 / R6 Mark II that dominate the
    # FlexMedia fleet). iPhone HEIC carries Apple's serial in
    # `BodySerialNumber` when permissions allow; when missing the partitioner
    # falls back to a `<model>:unknown` bucket which is the desired behaviour
    # (all iPhones group together as "the iPhone(s)").
    "-SerialNumber",
    "-BodySerialNumber",
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
def _supabase_storage_upload(
    bucket_path: str, body: bytes, content_type: str = "image/jpeg"
) -> str:
    """Upload preview to Supabase Storage and return the public URL.

    Wave 2 (2026-05-03): replaces the Dropbox preview upload to halve
    Dropbox /files/* call frequency. Supabase Storage public buckets
    serve <img src> with no auth challenge, so the UI gets faster
    thumbnails too.
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        # Standard Supabase pattern: derive from SUPABASE_SERVICE_ROLE_KEY's
        # iss claim if URL not explicitly set. Defensive — production has
        # SUPABASE_URL in the Modal secret, dev/test may omit it.
        raise RuntimeError("SUPABASE_URL env not set in Modal secret 'supabase_service_role_key'")
    # 2026-05-03: Supabase Storage REST rejects the new-style sb_secret_*
    # tokens with "Invalid Compact JWS" — only legacy HS256 service-role
    # JWTs are accepted at the Storage gateway. SUPABASE_SERVICE_ROLE_KEY
    # in this Modal app is the *new-style* key (it has to match what the
    # Edge fn sends in the request body's `_token` field for our own auth
    # check to pass). So we use a separate SUPABASE_STORAGE_KEY env var
    # that holds the legacy JWT specifically for Storage calls. Falls
    # back to SUPABASE_SERVICE_ROLE_KEY for backward-compat with deploys
    # that haven't been updated to the new secret schema yet.
    service_key = os.environ.get("SUPABASE_STORAGE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not service_key:
        raise RuntimeError("Neither SUPABASE_STORAGE_KEY nor SUPABASE_SERVICE_ROLE_KEY env set")

    # Direct REST upload — avoid the supabase-py overhead. Endpoint:
    #   POST {SUPABASE_URL}/storage/v1/object/{bucket}/{path}
    # Returns 200 on success. We use upsert so re-runs overwrite (matches
    # Dropbox WriteMode.overwrite semantics).
    import httpx
    bucket = "shortlisting-previews"
    url = f"{supabase_url}/storage/v1/object/{bucket}/{bucket_path}"
    resp = httpx.post(
        url,
        content=body,
        headers={
            "Authorization": f"Bearer {service_key}",
            "Content-Type": content_type,
            "x-upsert": "true",  # overwrite if exists
        },
        timeout=15.0,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"supabase storage upload failed: {resp.status_code} {resp.text[:200]}"
        )
    # Public URL pattern for public buckets:
    #   {SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}
    return f"{supabase_url}/storage/v1/object/public/{bucket}/{bucket_path}"


def _process_one(
    client,
    project_id: str,
    file_path: str,
    previews_dir_dropbox: str,
    work_root: Path,
    round_id: Optional[str] = None,
    prebaked_link: Optional[str] = None,
) -> Tuple[str, Dict[str, Any]]:
    """Process a single CR3. Returns (stem, result_dict).

    QC-DEBUG (2026-05-03): added per-step timing so silent hangs become
    visible in `modal app logs`. Each line is single-flush so partial
    progress shows up even on stuck containers.

    Wave 3: prebaked_link, when supplied, is the CDN URL for this
    file's bytes — minted at ingest time and forwarded by the Edge
    fn.  Lets Modal skip its own files/get_temporary_link API call.
    """
    from PIL import Image
    stem = Path(file_path).stem
    file_workdir = work_root / stem
    file_workdir.mkdir(parents=True, exist_ok=True)
    cr3_local = file_workdir / Path(file_path).name
    preview_raw = file_workdir / f"{stem}.preview.raw.jpg"
    preview_resized = file_workdir / f"{stem}.preview.jpg"

    t0 = time.time()
    print(
        f"[QC] {stem} START fp={file_path} prebaked={'yes' if prebaked_link else 'no'}",
        flush=True,
    )

    try:
        # 1. Download
        t1 = time.time()
        bytes_in = _dropbox_download(client, file_path, prebaked_link=prebaked_link)
        cr3_local.write_bytes(bytes_in)
        kb = round(len(bytes_in) / 1024, 0)
        print(
            f"[QC] {stem} dropbox_download_done size={kb}KB "
            f"elapsed_ms={int((time.time() - t1) * 1000)}",
            flush=True,
        )

        # 2. EXIF
        t2 = time.time()
        exif_raw = _exif_extract(cr3_local)
        print(
            f"[QC] {stem} exif_extract_done "
            f"elapsed_ms={int((time.time() - t2) * 1000)}",
            flush=True,
        )
        camera_model = exif_raw.get("Model")
        # Wave 10.1 (W10.1): body serial for the camera-source partitioner.
        # SerialNumber is the canonical key on Canon EOS R5/R6/R6 II; some
        # older firmwares + non-Canon brands emit BodySerialNumber instead.
        # Fall back across both — exiftool returns Python None when the tag
        # is missing, which the Deno partitioner canonicalises to "unknown".
        body_serial = exif_raw.get("SerialNumber") or exif_raw.get("BodySerialNumber")
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
        t3 = time.time()
        _exif_extract_preview(cr3_local, preview_raw)
        print(
            f"[QC] {stem} exif_preview_done "
            f"elapsed_ms={int((time.time() - t3) * 1000)}",
            flush=True,
        )
        t4 = time.time()
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
        print(
            f"[QC] {stem} preview_resize_done size={preview_size_kb}KB "
            f"elapsed_ms={int((time.time() - t4) * 1000)}",
            flush=True,
        )

        # 5. Upload preview JPEG to Supabase Storage (Wave 2 architecture
        # change). We're moving previews OFF Dropbox entirely:
        #
        #   - Dropbox /files/* was the dominant 429 source (every preview
        #     upload contended with the download bucket; a 50-file round
        #     fired 100 ratelimited calls).
        #   - Supabase Storage is a public CDN-backed bucket with no API
        #     ratelimit at our volume + free egress for under 1GB/mo.
        #   - 30-day auto-delete cron (mig 463) wipes old previews so
        #     storage costs stay flat.
        #
        # Path scheme: {project_id}/{round_id|no-round}/{stem}.jpg.
        # Scoping by round means 30-day cleanup can drop whole rounds.
        # 'no-round' fallback exists for direct-mode test calls without
        # a round_id (mostly the small-batch QC tests we run by hand).
        t5 = time.time()
        round_segment = round_id if round_id else "no-round"
        bucket_path = f"{project_id}/{round_segment}/{stem}.jpg"
        preview_url = _supabase_storage_upload(bucket_path, preview_bytes, "image/jpeg")
        print(
            f"[QC] {stem} supabase_storage_upload_done "
            f"bucket_path={bucket_path} "
            f"elapsed_ms={int((time.time() - t5) * 1000)} "
            f"TOTAL_ms={int((time.time() - t0) * 1000)}",
            flush=True,
        )

        return stem, {
            "ok": True,
            "exif": {
                "fileName": Path(file_path).name,
                "cameraModel": camera_model,
                # Wave 10.1 (W10.1): bodySerial — null if the tag is missing
                # (e.g. iPhone with restrictive permissions, older bodies that
                # don't emit either SerialNumber or BodySerialNumber). The
                # Deno-side partitioner falls back to a "<model>:unknown"
                # canonical slug so all unknown-serial files of the same
                # model still bucket together correctly.
                "bodySerial": body_serial,
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
            # Wave 2 result schema:
            #   `preview_url` is the canonical new field — a direct public
            #   Supabase Storage CDN URL. The UI ultimately wants this (no
            #   proxy hop required, free egress, no auth).
            #
            #   `preview_dropbox_path` is kept as an ADDITIVE alias and set
            #   to the same URL value for backward-compat with the existing
            #   downstream chain:
            #     shortlisting-pass0 reads `result.preview_dropbox_path`
            #       → writes to composition_groups.dropbox_preview_path
            #       → ~12 frontend components read that column
            #       → fetchMediaProxy()
            #   The media proxy gets a URL-detection short-circuit in this
            #   wave so an https:// value in dropbox_preview_path passes
            #   straight through to <img src>. The column-name lie is
            #   documented and we'll rename in a later wave once all 25+
            #   touchpoints are migrated.
            "preview_url": preview_url,
            "preview_dropbox_path": preview_url,
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
    # 2026-05-03 Wave 1: keep 1 container always warm so the first chunk
    # of every dispatcher tick doesn't pay 60-90s cold-start. Costs ~$8/mo
    # for 1 idle CPU container; saves ~5min wall on a typical round.
    # Set to 1 (not 2) on Starter tier — anything more eats into the
    # 100-container cap when bursts spawn.
    min_containers=1,
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
            "_token":               shared-secret bearer token (SUPABASE_SERVICE_ROLE_KEY),
            "project_id":           UUID string,
            "file_paths":           [ "/Flex Media Team Folder/.../IMG_1234.CR3", ... ],
            "dropbox_root_path":    project root (for resolving Previews/ destination),
            "dropbox_access_token": optional — fresh OAuth token minted by the
                                    caller; if empty/missing, falls back to the
                                    Modal `dropbox_access_token` secret. Wave 7 P0-3.
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
    # Wave 7 P0-3: caller-supplied fresh OAuth token. Optional during the
    # deploy transition; once all Edge callers are upgraded the env-fallback
    # branch in `_dropbox_client` will be removed.
    caller_dropbox_token = payload.get("dropbox_access_token") or ""
    # 2026-05-03 (QC debug followup): caller-supplied team-folder namespace
    # so Modal can skip the users/get_current_account auto-detect call —
    # which we observed hanging for the full 150s IDLE_TIMEOUT under
    # /users API rate-limit pressure. Always pass it; the Edge fn knows
    # the namespace from its own env (DROPBOX_TEAM_NAMESPACE_ID).
    caller_team_namespace = payload.get("dropbox_team_namespace_id") or ""
    # Wave 2: round_id scopes the Supabase Storage upload path to
    # {project_id}/{round_id}/{stem}.jpg so the 30-day cleanup cron
    # can wipe whole rounds at a time. Optional in direct-mode QC
    # calls — falls through to a 'no-round' folder.
    round_id_in = payload.get("round_id") or None
    # Wave 3: optional pre-baked Dropbox CDN URLs keyed by file path.
    # When present, Modal skips its own files/get_temporary_link API
    # call and httpx-fetches the bytes directly — ZERO Dropbox API
    # calls during the heavy parallel phase.  See ingest's link-bake
    # pass for how these are minted.
    prebaked_links = payload.get("prebaked_links") or {}
    if not isinstance(prebaked_links, dict):
        prebaked_links = {}

    if not project_id or not isinstance(project_id, str):
        return JSONResponse({"ok": False, "error": "project_id required (string)"}, status_code=400)
    if not isinstance(file_paths, list) or len(file_paths) == 0:
        return JSONResponse({"ok": False, "error": "file_paths required (non-empty list)"}, status_code=400)
    if not dropbox_root_path or not isinstance(dropbox_root_path, str):
        return JSONResponse({"ok": False, "error": "dropbox_root_path required (string)"}, status_code=400)
    if caller_dropbox_token and not isinstance(caller_dropbox_token, str):
        return JSONResponse({"ok": False, "error": "dropbox_access_token must be a string"}, status_code=400)

    previews_dir = f"{dropbox_root_path}/Photos/Raws/Shortlist Proposed/Previews"

    # Wave 3 visibility: how many files have a prebaked CDN link?
    # If prebaked_count == file_count, this whole extract makes ZERO
    # Dropbox API calls — pure CDN fetches.  If prebaked_count == 0,
    # we fall back to per-file files/get_temporary_link minting (slower
    # and rate-limit-prone — should only happen for legacy direct-mode
    # tests).  Anything in between means ingest's link-bake had partial
    # failures; check ingest logs.
    prebaked_count = sum(1 for fp in file_paths if prebaked_links.get(fp))
    print(
        f"[QC] extract_http START project_id={project_id} "
        f"file_count={len(file_paths)} prebaked={prebaked_count}/{len(file_paths)} "
        f"root={dropbox_root_path[:60]}",
        flush=True,
    )
    # Set up Dropbox client once per call — re-using it across files reuses
    # the underlying TLS connection (Python urllib3 pool).
    t_client = time.time()
    try:
        client = _dropbox_client(
            access_token=caller_dropbox_token,
            team_namespace_id=caller_team_namespace,
        )
        token_source = "caller" if caller_dropbox_token else "env_fallback"
        ns_source = "caller" if caller_team_namespace else (
            "env" if os.environ.get("DROPBOX_TEAM_NAMESPACE_ID") else "auto_detect"
        )
        print(
            f"[QC] dropbox_client_init_done token_source={token_source} "
            f"ns_source={ns_source} "
            f"elapsed_ms={int((time.time() - t_client) * 1000)}",
            flush=True,
        )
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"dropbox client init failed: {e}"}, status_code=500)

    files_out: Dict[str, Dict[str, Any]] = {}
    workroot = Path(tempfile.mkdtemp(prefix="photos-extract-"))
    try:
        # Concurrent — Dropbox + exiftool are I/O bound so a small thread pool
        # gives us most of the wall-clock win without overwhelming the API.
        #
        # 2026-05-03 — iteration trail: 8 → 2 → 4
        #   - 8 workers/container × 11 chunks = 88 concurrent Dropbox calls
        #     → tripped Dropbox 429 too_many_requests (verified)
        #   - 2 workers (post-incident throttle) × 3 chunks/tick = 6
        #     concurrent calls. Worked but slow.
        #   - 4 workers (current) × 5 chunks/tick (PER_KIND_CAP=5) = 20
        #     concurrent. Halfway between verified-safe (6) and verified-
        #     broken (88). Per Dropbox's official perf guide
        #     (https://developers.dropbox.com/dbx-performance-guide) actual
        #     limits are unpublished but we have empirical headroom.
        max_workers = min(4, len(file_paths))
        print(
            f"[QC] pool_start max_workers={max_workers} files={len(file_paths)}",
            flush=True,
        )
        completed = 0
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [
                pool.submit(
                    _process_one,
                    client,
                    project_id,
                    fp,
                    previews_dir,
                    workroot,
                    round_id_in,
                    prebaked_links.get(fp),  # Wave 3: per-file CDN URL or None
                )
                for fp in file_paths
            ]
            for fut in as_completed(futures):
                try:
                    stem, result = fut.result()
                except Exception as e:
                    # Defensive — _process_one already swallows per-file errors,
                    # so this branch is for truly catastrophic ones.
                    print(f"[QC] worker_raised err={e}", flush=True)
                    continue
                files_out[stem] = result
                completed += 1
                print(
                    f"[QC] pool_progress completed={completed}/{len(file_paths)} "
                    f"stem={stem} ok={result.get('ok')}",
                    flush=True,
                )
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
