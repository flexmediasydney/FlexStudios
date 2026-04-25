"""Modal app: drone render worker.

Wraps `modal/drone_render/render_engine.py::render()` in a deployed Modal
function. The drone-render Edge Function calls this to produce annotated
drone images from (image_bytes, theme_config, scene) tuples.

Local entrypoint:  modal run modal/drone_render/render_worker.py::test_render

Deploy:            modal deploy modal/drone_render/render_worker.py
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

import modal


THIS_DIR = Path(__file__).resolve().parent


# ──────────────────────────────────────────────────────────────────
# Modal image
# ──────────────────────────────────────────────────────────────────
# We bundle the entire drone_render/ directory (render_engine.py + fonts/ + themes/)
# at /root/drone_render/. The render engine's THIS_DIR variable resolves to
# /root/drone_render and finds fonts/themes correctly.
render_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "Pillow==10.4.0",
        "opencv-python-headless==4.10.0.84",
        "numpy<2",
    )
    .add_local_dir(str(THIS_DIR), remote_path="/root/drone_render")
)

app = modal.App("flexstudios-drone-render", image=render_image)


# ──────────────────────────────────────────────────────────────────
# Main render function (deployed)
# ──────────────────────────────────────────────────────────────────
@app.function(cpu=2, memory=2048, timeout=180)
def run_render(image_bytes: bytes, theme_config: Dict[str, Any], scene: Dict[str, Any]) -> bytes:
    """
    Render one annotated drone image.

    Args:
        image_bytes: raw bytes of the source drone JPG/PNG
        theme_config: theme JSON config (per modal/drone_render/themes/__schema__.json)
        scene: {
            lat, lon, alt, yaw, pitch:                  drone EXIF
            property_lat, property_lon (optional):      property pin location
            pois (optional):                             [{name, lat, lon, distance_m, type}, ...]
            polygon_latlon (optional):                   boundary polygon as [[lat,lon], ...]
            address, street_number, street_name (opt):   used by boundary.address_overlay
        }

    Returns:
        JPEG bytes (quality 92, sRGB).
    """
    sys.path.insert(0, "/root/drone_render")
    from render_engine import render  # type: ignore  # noqa: E402

    return render(image_bytes, theme_config, scene)


# ──────────────────────────────────────────────────────────────────
# Variant rendering — for output_variants in theme config
# ──────────────────────────────────────────────────────────────────
@app.function(cpu=2, memory=2048, timeout=240)
def run_render_with_variants(
    image_bytes: bytes,
    theme_config: Dict[str, Any],
    scene: Dict[str, Any],
) -> Dict[str, bytes]:
    """
    Render the image once at full size, then resize/recompress per
    output_variants in the theme config.

    Returns: { variant_name: bytes, ... }

    If theme has no `output_variants`, returns { "default": <full-size> }.
    """
    sys.path.insert(0, "/root/drone_render")
    from render_engine import render  # type: ignore  # noqa: E402
    import io
    import cv2  # type: ignore
    import numpy as np  # type: ignore

    # First: render at full source resolution (gets the cleanest annotation)
    full_bytes = render(image_bytes, theme_config, scene)

    variants_cfg = theme_config.get("output_variants", [])
    if not variants_cfg:
        return {"default": full_bytes}

    out: Dict[str, bytes] = {}

    arr = np.frombuffer(full_bytes, dtype=np.uint8)
    full_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if full_img is None:
        return {"default": full_bytes}

    src_h, src_w = full_img.shape[:2]

    for v in variants_cfg:
        try:
            name = v.get("name", "variant")
            target_w = int(v.get("target_width_px", src_w))
            quality = int(v.get("quality", 90))
            aspect = v.get("aspect", "preserve")
            max_bytes = int(v.get("max_bytes") or 0)
            fmt = (v.get("format") or "JPEG").upper()

            # Resize
            if aspect == "preserve":
                target_h = int(round(src_h * target_w / src_w))
                resized = cv2.resize(full_img, (target_w, target_h), interpolation=cv2.INTER_AREA)
            elif aspect == "crop_1_1":
                short = min(src_w, src_h)
                cy = (src_h - short) // 2
                cx = (src_w - short) // 2
                resized = cv2.resize(
                    full_img[cy : cy + short, cx : cx + short],
                    (target_w, target_w),
                    interpolation=cv2.INTER_AREA,
                )
            elif aspect == "crop_16_9":
                target_h = int(round(target_w * 9 / 16))
                # crop centre band of 16:9 from source
                band_h = int(round(src_w * 9 / 16))
                if band_h <= src_h:
                    cy = (src_h - band_h) // 2
                    cropped = full_img[cy : cy + band_h, :, :]
                else:
                    cropped = full_img
                resized = cv2.resize(cropped, (target_w, target_h), interpolation=cv2.INTER_AREA)
            elif aspect == "crop_4_5":
                target_h = int(round(target_w * 5 / 4))
                band_w = int(round(src_h * 4 / 5))
                if band_w <= src_w:
                    cx = (src_w - band_w) // 2
                    cropped = full_img[:, cx : cx + band_w, :]
                else:
                    cropped = full_img
                resized = cv2.resize(cropped, (target_w, target_h), interpolation=cv2.INTER_AREA)
            else:
                target_h = int(round(src_h * target_w / src_w))
                resized = cv2.resize(full_img, (target_w, target_h), interpolation=cv2.INTER_AREA)

            # Encode (with quality stepping to honour max_bytes)
            ext = ".jpg" if fmt == "JPEG" else ".png" if fmt == "PNG" else ".jpg"
            params = (
                [cv2.IMWRITE_JPEG_QUALITY, quality]
                if fmt == "JPEG"
                else [cv2.IMWRITE_PNG_COMPRESSION, 6]
                if fmt == "PNG"
                else [cv2.IMWRITE_JPEG_QUALITY, quality]
            )

            ok, buf = cv2.imencode(ext, resized, params)
            if not ok:
                continue

            data = buf.tobytes()
            # Step down quality if over max_bytes (JPEG only)
            if max_bytes > 0 and fmt == "JPEG" and len(data) > max_bytes:
                q = quality
                while len(data) > max_bytes and q > 50:
                    q -= 5
                    ok, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, q])
                    if not ok:
                        break
                    data = buf.tobytes()

            out[name] = data
        except Exception as e:  # variant failures are non-fatal
            print(f"variant {v.get('name', '?')} failed: {e}")

    if not out:
        out["default"] = full_bytes
    return out


# ──────────────────────────────────────────────────────────────────
# Local entrypoint — sanity check
# ──────────────────────────────────────────────────────────────────
@app.local_entrypoint()
def test_render():
    """Render a synthetic test image with the FlexMedia default theme."""
    import io
    import cv2  # type: ignore  # noqa
    import numpy as np  # type: ignore  # noqa

    # Fixture: small grey image
    test_img = np.full((1200, 1600, 3), 128, dtype=np.uint8)
    cv2.rectangle(test_img, (400, 400), (1200, 800), (200, 200, 200), -1)
    cv2.putText(test_img, "FIXTURE", (700, 600), cv2.FONT_HERSHEY_SIMPLEX, 2, (255, 255, 255), 4)
    ok, buf = cv2.imencode(".jpg", test_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    image_bytes = buf.tobytes()
    print(f"Fixture image: {len(image_bytes)} bytes ({test_img.shape[1]}x{test_img.shape[0]})")

    # Default theme
    with open(THIS_DIR / "themes" / "flexmedia_default.json") as f:
        theme = json.load(f)
    print(f"Theme: {theme.get('theme_name', 'unknown')}")

    # Synthetic scene with 2 POIs at known angles
    scene = {
        "lat": -33.9447,
        "lon": 150.9425,
        "alt": 90.0,
        "yaw": 0.0,
        "pitch": -10.0,
        "property_lat": -33.9447,
        "property_lon": 150.9425,
        "pois": [
            {"name": "Test Park", "lat": -33.9420, "lon": 150.9425, "distance_m": 300, "type": "park"},
            {"name": "Test Station", "lat": -33.9430, "lon": 150.9450, "distance_m": 800, "type": "train"},
        ],
    }

    t0 = time.time()
    result = run_render.remote(image_bytes, theme, scene)
    elapsed = time.time() - t0

    out_path = THIS_DIR / "test_render_output.jpg"
    out_path.write_bytes(result)

    print(f"")
    print(f"==== Render OK ====")
    print(f"  Input:    {len(image_bytes):,} bytes")
    print(f"  Output:   {len(result):,} bytes")
    print(f"  Elapsed:  {elapsed:.2f}s")
    print(f"  Saved:    {out_path}")


if __name__ == "__main__":
    print("Use `modal run modal/drone_render/render_worker.py::test_render` instead.")
