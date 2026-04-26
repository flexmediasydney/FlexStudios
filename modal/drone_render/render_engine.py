"""
Productionised drone theme render engine.

Lifted from ~/flexmedia-drone-spike/production_ready/theme_engine.py and hardened:

    1. PIL ImageFont.truetype() for ALL text rendering. The spike used
       cv2.putText with FONT_HERSHEY_SIMPLEX which renders em-dash and
       middle-dot as `???`. We bundle DejaVu Sans / DejaVu Sans Bold
       (Bitstream Vera license, free for any use) in modal/drone_render/fonts/.
       PIL is imported once and the same font cache is reused across all calls.

    2. Anchor-flip logic. When the desired anchor length above the target
       would be < `anchor_line.flip_below_target_threshold_px` (default 80),
       the label is positioned BELOW the target instead of above. The label
       box geometry is unchanged; only the y position and the anchor line
       direction are inverted.

    3. Boundary layer pass. Per IMPLEMENTATION_PLAN_V2.md §3.3 `boundary`:
        - line styles: solid / dashed / dotted, configurable width/color/radius
        - drop shadow on the line (offset + gaussian blur)
        - exterior treatment: blur, darken, hue shift, sat, lightness
        - side measurements: per-edge geodesic length
        - SQM total overlay (with optional shadow)
        - address overlay inside boundary

The render() function is callable as a pure Python function so the Modal
worker can `from modal.drone_render import render` and invoke it directly.

INPUT: image_bytes + theme_config (dict) + scene (dict)
OUTPUT: rendered image bytes (JPEG)
"""

from __future__ import annotations

import io
import json
import math
import os
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ─────────────────────────────────────────────────────────────────────────────
# Camera intrinsics defaults — Mavic 3 Pro wide @ 24mm-equiv (matches the spike).
#
# These are FALLBACK values only. When the caller supplies
# `scene.camera_intrinsics` (populated from EXIF make/model/focal — see #18),
# the per-shot values override these. Without per-drone intrinsics, POIs
# project to the wrong pixel for any non-M3P drone (e.g. Mavic 2 Pro is
# 4000x2250 with fx≈10mm, completely different geometry).
#
# TODO: drone-render Edge Function should populate scene.camera_intrinsics
#       from drone_shots.exif (already extracted per #18) so we never fall
#       back to defaults in production.
# ─────────────────────────────────────────────────────────────────────────────
DEFAULT_W, DEFAULT_H = 5280, 3956
DEFAULT_FX_MM, DEFAULT_FY_MM = 12.29, 12.29  # focal length mm (M3P wide @ 24mm equiv)
DEFAULT_SENSOR_W_MM, DEFAULT_SENSOR_H_MM = 17.3, 13.0


def _safe_float(
    value, default: float, *, allow_zero: bool = False, allow_neg: bool = False
) -> float:
    """Coerce `value` to a finite float, falling back to `default`.

    The previous `float(intr.get(k) or DEFAULT)` pattern is broken for two
    reasons (QC2 finding #3):
      1. `bool(NaN) is True`, so `float(NaN) or DEFAULT` returns NaN.
      2. `bool(0.0) is False`, so a legitimate zero is silently swapped for
         the default. (For optional principal point `cx`, `0` is invalid
         anyway, but for things like `hue_shift_degrees` it isn't.)

    This helper:
      - returns `default` for None / non-numeric / NaN / inf
      - returns `default` when the value is non-positive (unless allow_zero/
        allow_neg explicitly permits it).
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return float(default)
    if not math.isfinite(f):
        return float(default)
    if not allow_neg and f < 0:
        return float(default)
    if not allow_zero and f == 0:
        return float(default)
    return f


def _resolve_intrinsics(scene: dict, image_w: int, image_h: int) -> tuple:
    """Pick camera intrinsics for projection.

    Preference order:
      1. scene.camera_intrinsics.{width, height, fx_mm, fy_mm?, cx_px?, cy_px?}
         — when present, fx_mm/fy_mm are interpreted in the same sensor frame
         as DEFAULT_SENSOR_W_MM/H_MM unless the caller also supplies
         sensor_w_mm/sensor_h_mm, and pixel scaling is anchored to the
         supplied intrinsic width/height. This means a Mavic 2 Pro shot
         (4000x2250, fx≈10mm) projects to the right pixel even when the
         actual delivered image was downscaled.
      2. Defaults (Mavic 3 Pro wide).

    Returns: (fx_px, fy_px, cx_px, cy_px) — all in *image pixels* of the
    image we're actually annotating (image_w/image_h).
    """
    intr = (scene or {}).get("camera_intrinsics") or {}

    # Validate every numeric field via _safe_float — this defends against:
    #   - JSON serialised NaN ("NaN" → float('nan') → bool=True passes `or`)
    #   - explicit zero or negative values (focal length 0 → div-by-zero
    #     downstream; sensor width 0 → infinite fx_px_intr)
    #   - strings, None, missing keys
    intr_w = _safe_float(intr.get("width"), DEFAULT_W)
    intr_h = _safe_float(intr.get("height"), DEFAULT_H)
    fx_mm = _safe_float(intr.get("fx_mm"), DEFAULT_FX_MM)
    fy_mm = _safe_float(intr.get("fy_mm"), fx_mm)
    sensor_w_mm = _safe_float(intr.get("sensor_w_mm"), DEFAULT_SENSOR_W_MM)
    sensor_h_mm = _safe_float(intr.get("sensor_h_mm"), DEFAULT_SENSOR_H_MM)

    # Convert to focal-length-in-pixels at the *intrinsic* image size, then
    # rescale to the actual annotated image size (so downstream resampling
    # of the drone JPG before render still projects correctly).
    fx_px_intr = (fx_mm / sensor_w_mm) * intr_w
    fy_px_intr = (fy_mm / sensor_h_mm) * intr_h

    # image_w / image_h come from cv2.imdecode shape — should always be
    # positive and finite, but cheap to defend.
    image_w_safe = _safe_float(image_w, DEFAULT_W)
    image_h_safe = _safe_float(image_h, DEFAULT_H)
    sx = image_w_safe / intr_w
    sy = image_h_safe / intr_h
    fx_px = fx_px_intr * sx
    fy_px = fy_px_intr * sy

    # Principal point: 0 is invalid (centre is image_w/2, not 0). Negative
    # values are also nonsense. _safe_float swaps both for default.
    cx_raw = intr.get("cx_px")
    cy_raw = intr.get("cy_px")
    if cx_raw is None:
        cx_px = image_w_safe / 2.0
    else:
        cx_px = _safe_float(cx_raw, image_w_safe / 2.0) * sx
    if cy_raw is None:
        cy_px = image_h_safe / 2.0
    else:
        cy_px = _safe_float(cy_raw, image_h_safe / 2.0) * sy

    return (fx_px, fy_px, cx_px, cy_px)

SCHEMA_VERSION = "1.0"

THIS_DIR = Path(__file__).resolve().parent
FONTS_DIR = THIS_DIR / "fonts"
THEMES_DIR = THIS_DIR / "themes"

# Default font fallbacks — we ship DejaVu but allow override via font_family.
FONT_BOLD_PATH = str(FONTS_DIR / "DejaVuSans-Bold.ttf")
FONT_REGULAR_PATH = str(FONTS_DIR / "DejaVuSans.ttf")

# Internal font cache (path, size) -> PIL ImageFont
_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}

# ─────────────────────────────────────────────────────────────────────────────
# SSRF protection for property_pin custom_svg URLs.
# urllib.request.urlopen(any_url) accepts file://, http://169.254.169.254 (AWS
# metadata IMDS), internal Modal endpoints, etc. Lock down to https-only and
# a small allowlist of expected CDN hostnames. Theme authors should always
# prefer content_b64; URL is a last-resort path retained for back-compat.
# ─────────────────────────────────────────────────────────────────────────────
_CUSTOM_SVG_ALLOWED_HOSTS_EXACT = {
    "flexmedia.sydney",
    "flexstudios.app",
    "cdn.flexmedia.sydney",
}
_CUSTOM_SVG_ALLOWED_HOST_SUFFIXES = (
    ".dropboxusercontent.com",
)


def _custom_svg_url_is_safe(url: str) -> bool:
    """Return True iff `url` is https + on the small allowlist of trusted hosts.

    Rejects: any non-https scheme (file://, http://, gopher://, ftp://, …),
             any host not in the exact-match set or *.dropboxusercontent.com.
    """
    try:
        from urllib.parse import urlparse
        p = urlparse(url)
    except Exception:
        return False
    if (p.scheme or "").lower() != "https":
        return False
    host = (p.hostname or "").lower()
    if not host:
        return False
    if host in _CUSTOM_SVG_ALLOWED_HOSTS_EXACT:
        return True
    for suffix in _CUSTOM_SVG_ALLOWED_HOST_SUFFIXES:
        if host.endswith(suffix):
            return True
    return False


def _make_svg_placeholder(target_w: int) -> "Image.Image":
    """Return a transparent PIL image with a red 'X' to flag rejected SVG URLs.

    Used in place of crashing the whole render when custom_svg.url is
    blocked or fetch fails. Render output stays valid — the caller can see
    the placeholder and fix the theme config.
    """
    side = max(16, int(target_w))
    placeholder = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(placeholder)
    line_w = max(2, side // 16)
    inset = side // 8
    pdraw.line(
        [(inset, inset), (side - inset, side - inset)],
        fill=(255, 32, 32, 230),
        width=line_w,
    )
    pdraw.line(
        [(side - inset, inset), (inset, side - inset)],
        fill=(255, 32, 32, 230),
        width=line_w,
    )
    return placeholder


def _get_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    """Cached ImageFont.truetype loader. Falls back to bundled DejaVu Bold."""
    size = max(8, int(size))
    key = (path, size)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    try:
        f = ImageFont.truetype(path, size)
    except (OSError, IOError):
        f = ImageFont.truetype(FONT_BOLD_PATH, size)
    _FONT_CACHE[key] = f
    return f


def _resolve_font_family(family: Optional[str], bold: bool = True) -> str:
    """
    Map a logical font_family ("Inter", "DejaVu Sans", None) to a bundled TTF path.
    Currently only DejaVu is bundled; everything else falls back to it.
    """
    if not family:
        return FONT_BOLD_PATH if bold else FONT_REGULAR_PATH
    # Hooks for future bundled families: "Inter" / "Helvetica" / etc.
    return FONT_BOLD_PATH if bold else FONT_REGULAR_PATH


# ─────────────────────────────────────────────────────────────────────────────
# Color helpers
# ─────────────────────────────────────────────────────────────────────────────
def _hex_to_bgr(hex_color: Optional[str], default=(255, 255, 255)) -> Optional[tuple]:
    if hex_color is None or hex_color == "transparent":
        return None
    h = hex_color.lstrip("#")
    if len(h) == 6:
        r = int(h[0:2], 16)
        g = int(h[2:4], 16)
        b = int(h[4:6], 16)
        return (b, g, r)
    return default


def _hex_to_rgb(hex_color: Optional[str], default=(255, 255, 255)) -> Optional[tuple]:
    if hex_color is None or hex_color == "transparent":
        return None
    h = hex_color.lstrip("#")
    if len(h) == 6:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return default


def _hex_to_rgba(hex_color: Optional[str], alpha: int = 255) -> Optional[tuple]:
    rgb = _hex_to_rgb(hex_color)
    if rgb is None:
        return None
    return (rgb[0], rgb[1], rgb[2], alpha)


# ─────────────────────────────────────────────────────────────────────────────
# Geometry — GPS to pixel projection (matches spike formulation exactly).
# ─────────────────────────────────────────────────────────────────────────────
def _gps_to_px(tlat, tlon, dlat, dlon, alt, heading, pitch, w, h, intrinsics=None):
    """Project a target lat/lon to pixel coords on the image.

    `intrinsics`: optional (fx_px, fy_px, cx_px, cy_px) tuple. When None we
    fall back to the legacy default Mavic 3 Pro intrinsics scaled to (w, h).

    Defensive guards:
      - Antimeridian wrap: when the drone and target straddle ±180°, naive
        (tlon - dlon) yields a ~360° (≈40 000 km) error. Normalise the
        difference into (-180, 180] so the projection stays correct anywhere
        on the globe (was QC2 finding #1 — Sydney + Auckland test pair was
        producing dE ≈ −40 000 000 m).
      - Pole singularity: cos(89.999°) ≈ 1.7e-5, so dE explodes to ~1.8e16 m.
        Clamp dlat to ±89.9° to keep the equirectangular approximation finite
        (anything closer to the poles than that has worse problems than this
        warning).
    """
    if dlat > 89.9 or dlat < -89.9:
        print(f"[_gps_to_px] WARN drone lat near pole ({dlat:.4f}); clamping to ±89.9 to avoid singularity")
    dlat_clamped = max(-89.9, min(89.9, dlat))
    cos_lat = math.cos(math.radians(dlat_clamped))
    # Antimeridian-safe longitude difference. Without normalisation a -179.9 →
    # 179.9 wrap reads as ~360°, mis-projecting POIs by ~40 000 km.
    dlon_diff = ((tlon - dlon + 540.0) % 360.0) - 180.0
    dE = dlon_diff * 111319 * cos_lat
    dN = (tlat - dlat_clamped) * 111319
    dU = -alt
    hr, pr = math.radians(heading), math.radians(pitch)
    cam_z = (
        math.cos(pr) * math.sin(hr),
        math.cos(pr) * math.cos(hr),
        math.sin(pr),
    )
    cam_x = (math.cos(hr), -math.sin(hr), 0.0)
    cam_y = (
        cam_z[1] * cam_x[2] - cam_z[2] * cam_x[1],
        cam_z[2] * cam_x[0] - cam_z[0] * cam_x[2],
        cam_z[0] * cam_x[1] - cam_z[1] * cam_x[0],
    )
    X_c = dE * cam_x[0] + dN * cam_x[1] + dU * cam_x[2]
    Y_c = dE * cam_y[0] + dN * cam_y[1] + dU * cam_y[2]
    Z_c = dE * cam_z[0] + dN * cam_z[1] + dU * cam_z[2]
    if Z_c <= 0:
        return None
    if intrinsics is None:
        fx = (DEFAULT_FX_MM / DEFAULT_SENSOR_W_MM) * w
        fy = (DEFAULT_FY_MM / DEFAULT_SENSOR_H_MM) * h
        cx, cy = w / 2, h / 2
    else:
        fx, fy, cx, cy = intrinsics
    return (fx * X_c / Z_c + cx, fy * Y_c / Z_c + cy)


def _render_template(template: str, scene: dict) -> str:
    """Substitute scene fields into a `{field}`-style template.

    Used by `_draw_address_overlay` (boundary block) AND `pill_with_address`
    (property pin) so both layers render the operator's typed address rather
    than the literal "{address}" string. (QC2 finding #16.)

    Supports: {address}, {street_number}, {street_name}, {suburb} (best-effort
    — if the scene doesn't carry the key the placeholder is replaced with "").
    """
    if not template or not isinstance(template, str):
        return template or ""
    out = template
    out = out.replace("{address}", str(scene.get("address") or ""))
    out = out.replace("{street_number}", str(scene.get("street_number") or ""))
    out = out.replace("{street_name}", str(scene.get("street_name") or ""))
    out = out.replace("{suburb}", str(scene.get("suburb") or ""))
    return out


def _fmt_distance(d) -> Optional[str]:
    """Format a distance (metres) for the POI secondary label.

    Returns ``None`` when the value is unrenderable so the caller skips the
    secondary line entirely. (QC2-2 #8.)

    Old `lambda d: f'{d/1000:.1f}km' if d > 999 else f'{d:.0f}m'`:
      - fmt(1e9) → '1000000.0km' blew the pill width clamp
      - fmt(0)   → '0m' rendered a meaningless "0 m" label for "unset"
      - fmt(NaN) → 'nanm'
      - fmt(-100) → '-100m' (negative distance is meaningless)
      - 999 → "999 m", 1000 → "1.0 km" (right of cliff is fine, but use
        >=1000 to make the boundary explicit)

    New behaviour:
      - None / non-numeric / NaN / inf → None
      - <= 0 → None ("unset" / nonsensical)
      - > 9999 → ">10km" (caps the label width regardless of input)
      - >= 1000 → "X.Ykm"
      - else → "Nm"
    """
    if d is None:
        return None
    try:
        f = float(d)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    if f <= 0:
        return None
    if f > 9999:
        return ">10km"
    if f >= 1000:
        return f"{f / 1000:.1f}km"
    return f"{f:.0f}m"


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    """Geodesic distance in metres between two WGS84 points."""
    R = 6371008.8
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1r) * math.cos(lat2r) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _lonlat_mean_via_unit_vectors(lats, lons):
    """Spherical mean of lat/lng via unit-vector sum + renormalise.

    Mirrors modal/drone_sfm/projection.lonlat_mean_via_unit_vectors. We can't
    cross-import (the Modal render image only bundles drone_render/, not
    drone_sfm/), so this is a local copy.

    Naive arithmetic mean of longitudes wraps incorrectly anywhere near the
    antimeridian (Fiji/NZ at lon ±179.9 averages to lon 0 — Indian Ocean —
    so the ENU centroid is ~40 000 km away and the shoelace area is wrong by
    orders of magnitude). The unit-vector form is correct anywhere on the
    globe. (QC2-2 #5.)

    Returns (mean_lat, mean_lon) in degrees.
    """
    n = len(lats)
    if n == 0 or n != len(lons):
        return (0.0, 0.0)
    sx = sy = sz = 0.0
    for lat, lng in zip(lats, lons):
        lat_r = math.radians(lat)
        lng_r = math.radians(lng)
        cos_lat = math.cos(lat_r)
        sx += cos_lat * math.cos(lng_r)
        sy += cos_lat * math.sin(lng_r)
        sz += math.sin(lat_r)
    nf = float(n)
    mx, my, mz = sx / nf, sy / nf, sz / nf
    norm = math.sqrt(mx * mx + my * my + mz * mz)
    if norm < 1e-12:
        # Antipodal cancellation — fall back to arithmetic mean.
        return (sum(lats) / nf, sum(lons) / nf)
    mx /= norm
    my /= norm
    mz /= norm
    mean_lat = math.degrees(math.asin(max(-1.0, min(1.0, mz))))
    mean_lon = math.degrees(math.atan2(my, mx))
    return (mean_lat, mean_lon)


# ─────────────────────────────────────────────────────────────────────────────
# PIL text rendering helpers (draw onto a numpy BGR canvas via temp RGBA layer).
# ─────────────────────────────────────────────────────────────────────────────
def _measure_text(text: str, font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    """Return (width, height) of the text using the font's ascent/descent."""
    bbox = font.getbbox(text)
    return (bbox[2] - bbox[0], bbox[3] - bbox[1])


def _bgr_to_rgba_overlay(width: int, height: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    """Create a transparent RGBA layer for compositing PIL text onto BGR canvas."""
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    return layer, ImageDraw.Draw(layer)


def _composite_overlay_onto_bgr(canvas_bgr: np.ndarray, overlay_rgba: Image.Image) -> np.ndarray:
    """Alpha-composite an RGBA PIL overlay onto a BGR numpy canvas. Returns updated BGR."""
    base_rgba = Image.fromarray(cv2.cvtColor(canvas_bgr, cv2.COLOR_BGR2RGB)).convert("RGBA")
    composed = Image.alpha_composite(base_rgba, overlay_rgba).convert("RGB")
    return cv2.cvtColor(np.array(composed), cv2.COLOR_RGB2BGR)


# ─────────────────────────────────────────────────────────────────────────────
# POI label + anchor — with FLIP-BELOW logic.
# ─────────────────────────────────────────────────────────────────────────────
def _draw_anchor_line(img: np.ndarray, x_top, y_top, x_bot, y_bot, style: dict):
    """Draw anchor line/bar/dashed from (x_top,y_top) to (x_bot,y_bot)."""
    shape = style.get("shape", "thin")
    width = style.get("width_px", 3)
    color = _hex_to_bgr(style.get("color", "#FFFFFF"))

    x_top, y_top, x_bot, y_bot = int(x_top), int(y_top), int(x_bot), int(y_bot)

    if shape == "thick_bar":
        # Vertical bar from y_top to y_bot at x = x_top, full width.
        y_a, y_b = sorted([y_top, y_bot])
        cv2.rectangle(
            img,
            (x_top - width // 2, y_a),
            (x_top + width // 2, y_b),
            color,
            -1,
            cv2.LINE_AA,
        )
    elif shape == "dashed":
        dash_len = 14
        gap = 10
        dy = y_bot - y_top
        n = int(abs(dy) // (dash_len + gap)) if (dash_len + gap) > 0 else 0
        sign = 1 if dy >= 0 else -1
        for i in range(n):
            y1 = y_top + sign * i * (dash_len + gap)
            y2 = y1 + sign * dash_len
            cv2.line(img, (x_top, int(y1)), (x_top, int(y2)), color, width, cv2.LINE_AA)
    elif shape == "gradient":
        # Vertical(-ish) gradient from marker end (x_bot,y_bot, full alpha)
        # to label end (x_top,y_top, ~30% alpha). PIL has no native gradient
        # line, so we composite alpha-blended segments via an RGBA layer.
        h_img, w_img = img.shape[:2]
        overlay = Image.new("RGBA", (w_img, h_img), (0, 0, 0, 0))
        gdraw = ImageDraw.Draw(overlay)
        # color comes as BGR (or None) — convert back to RGB for PIL
        if color is None:
            r_g_b = (255, 255, 255)
        else:
            r_g_b = (color[2], color[1], color[0])
        steps = max(24, int(math.hypot(x_top - x_bot, y_top - y_bot) // 4))
        a_start = 255  # alpha at marker end
        a_end = int(255 * 0.30)  # alpha at label end
        for i in range(steps):
            t0 = i / steps
            t1 = (i + 1) / steps
            sx = x_bot + (x_top - x_bot) * t0
            sy = y_bot + (y_top - y_bot) * t0
            ex = x_bot + (x_top - x_bot) * t1
            ey = y_bot + (y_top - y_bot) * t1
            # interpolate alpha along the line: full at i=0 (marker), faded at i=steps (label)
            t_mid = (t0 + t1) / 2
            a = int(a_start + (a_end - a_start) * t_mid)
            gdraw.line(
                [(sx, sy), (ex, ey)],
                fill=(r_g_b[0], r_g_b[1], r_g_b[2], a),
                width=max(1, int(width)),
            )
        # Composite back onto BGR canvas in-place
        composed = _composite_overlay_onto_bgr(img, overlay)
        img[:, :, :] = composed
    else:  # "thin"
        cv2.line(img, (x_top, y_top), (x_bot, y_bot), color, width, cv2.LINE_AA)

    # End marker at target
    em = style.get("end_marker", {})
    em_shape = em.get("shape", "none")
    if em_shape == "none":
        return
    size = em.get("size_px", 14)
    fill = _hex_to_bgr(em.get("fill_color", "#FFFFFF"))
    stroke = _hex_to_bgr(em.get("stroke_color", "#FFFFFF"))
    sw = em.get("stroke_width_px", 0)

    if em_shape == "dot":
        cv2.circle(img, (x_bot, y_bot), size // 2, fill, -1, cv2.LINE_AA)
    elif em_shape == "circle":
        cv2.circle(img, (x_bot, y_bot), size // 2, fill, -1, cv2.LINE_AA)
        cv2.circle(img, (x_bot, y_bot), size // 2, stroke, max(2, sw), cv2.LINE_AA)
    elif em_shape == "diamond":
        s = size // 2
        pts = np.array(
            [[x_bot, y_bot - s], [x_bot + s, y_bot], [x_bot, y_bot + s], [x_bot - s, y_bot]],
            dtype=np.int32,
        )
        cv2.fillConvexPoly(img, pts, fill, cv2.LINE_AA)
        if sw > 0:
            cv2.polylines(img, [pts], True, stroke, sw, cv2.LINE_AA)
    elif em_shape == "cross":
        s = size // 2
        cv2.line(img, (x_bot - s, y_bot), (x_bot + s, y_bot), fill, max(2, sw))
        cv2.line(img, (x_bot, y_bot - s), (x_bot, y_bot + s), fill, max(2, sw))


def _draw_poi_label(
    canvas_bgr: np.ndarray,
    x_target: int,
    y_target: int,
    text: str,
    label_style: dict,
    anchor_style: dict,
    secondary_text: Optional[str] = None,
    w: int = DEFAULT_W,
    h: int = DEFAULT_H,
) -> np.ndarray:
    """
    Place a label NEAR the target with an anchor line.

    Default placement is ABOVE target. If desired anchor length above
    would be less than `anchor_line.flip_below_target_threshold_px`,
    we flip the label to BELOW the target.

    Returns the updated canvas (BGR numpy).
    """
    fs = int(label_style.get("font_size_px", 36))
    text_case = label_style.get("text_case", "uppercase")
    if text_case == "uppercase":
        text = text.upper()
    elif text_case == "titlecase":
        text = text.title()

    font_family = label_style.get("font_family")
    font_main = _get_font(_resolve_font_family(font_family, bold=True), fs)

    pad = label_style.get(
        "padding_px", {"top": 12, "right": 24, "bottom": 12, "left": 24}
    )

    # Measure
    tw, th = _measure_text(text, font_main)
    sec_h = 0
    sec_w = 0
    font_sec = None
    if secondary_text:
        sec_size = max(12, int(fs * 0.75))
        font_sec = _get_font(_resolve_font_family(font_family, bold=True), sec_size)
        sec_w, sec_h = _measure_text(secondary_text.upper(), font_sec)

    bw = max(tw, sec_w) + pad["left"] + pad["right"]
    bh = th + (sec_h + 6 if secondary_text else 0) + pad["top"] + pad["bottom"]

    # Desired anchor length and flip threshold
    desired_anchor = int(anchor_style.get("max_length_px", 220))
    min_anchor = int(anchor_style.get("min_length_px", 40))
    flip_thresh = int(anchor_style.get("flip_below_target_threshold_px", 80))

    # Compute "above" placement bounds
    by2_above = int(y_target - desired_anchor)
    by1_above = by2_above - bh

    # If by1 would clamp into the top edge so badly that the resulting anchor
    # would be < flip_thresh, flip the label below the target.
    flip_below = False
    if by1_above < 20:
        clamped_by1 = 20
        clamped_by2 = clamped_by1 + bh
        clamped_anchor = y_target - clamped_by2
        if clamped_anchor < flip_thresh:
            flip_below = True

    # Compute label box position
    bx1 = int(x_target - bw / 2)
    bx2 = int(x_target + bw / 2)

    if flip_below:
        # Below target: anchor goes from target DOWN to label top
        by1 = int(y_target + max(min_anchor, flip_thresh))
        by2 = by1 + bh
        # Clamp to bottom
        if by2 > h - 20:
            by2 = h - 20
            by1 = by2 - bh
    else:
        by2 = max(by2_above, 20 + bh)
        by1 = by2 - bh
        # Clamp anchor: don't allow label box to leave frame
        if by1 < 20:
            by1 = 20
            by2 = by1 + bh

    # Clamp x into frame
    if bx1 < 20:
        bx1 = 20
        bx2 = bx1 + bw
    if bx2 > w - 20:
        bx2 = w - 20
        bx1 = bx2 - bw

    # Border + Fill on numpy canvas
    fill_color = _hex_to_bgr(label_style.get("fill", "#FFFFFF"))
    if fill_color is not None:
        cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), fill_color, -1, cv2.LINE_AA)

    border = label_style.get("border", {})
    bc = _hex_to_bgr(border.get("color"))
    bw_b = border.get("width_px", 0)
    if bc is not None and bw_b > 0:
        cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), bc, bw_b, cv2.LINE_AA)

    # PIL text — composite via overlay
    overlay, draw = _bgr_to_rgba_overlay(w, h)
    text_rgb = _hex_to_rgb(label_style.get("text_color", "#000000")) or (0, 0, 0)
    text_x = bx1 + pad["left"]
    text_y = by1 + pad["top"]
    # PIL anchors to glyph bounding box; account for getbbox's top offset
    bbox_main = font_main.getbbox(text)
    draw.text((text_x - bbox_main[0], text_y - bbox_main[1]), text, font=font_main, fill=text_rgb + (255,))

    if secondary_text:
        # Bug #18 — schema is `secondary_text.color` (nested) but historic
        # render code only read `secondary_text_color` (flat). Read the
        # nested form first so themes saved via the editor (which only
        # writes the nested key) display correctly. Falls back through
        # the flat form, then text_color, then black.
        nested_sec_color = (label_style.get("secondary_text") or {}).get("color")
        sec_rgb = _hex_to_rgb(
            nested_sec_color
            or label_style.get("secondary_text_color")
            or label_style.get("text_color", "#000000")
        ) or (0, 0, 0)
        bbox_sec = font_sec.getbbox(secondary_text.upper())
        draw.text(
            (text_x - bbox_sec[0], text_y + th + 6 - bbox_sec[1]),
            secondary_text.upper(),
            font=font_sec,
            fill=sec_rgb + (255,),
        )

    canvas_bgr = _composite_overlay_onto_bgr(canvas_bgr, overlay)

    # Anchor line: from label box edge to target
    if flip_below:
        _draw_anchor_line(canvas_bgr, (bx1 + bx2) // 2, by1, x_target, y_target, anchor_style)
    else:
        _draw_anchor_line(canvas_bgr, (bx1 + bx2) // 2, by2, x_target, y_target, anchor_style)

    return canvas_bgr


# ─────────────────────────────────────────────────────────────────────────────
# Property pin
# ─────────────────────────────────────────────────────────────────────────────
def _draw_property_pin(canvas_bgr: np.ndarray, x: int, y: int, pin_style: dict, w: int, h: int) -> np.ndarray:
    """Draw the property pin per `pin_style.mode`."""
    mode = pin_style.get("mode", "pill_with_address")
    size = pin_style.get("size_px", 120)
    fill = _hex_to_bgr(pin_style.get("fill_color", "#FFFFFF"))
    stroke = _hex_to_bgr(pin_style.get("stroke_color", "#FFFFFF"))
    sw = pin_style.get("stroke_width_px", 0)
    content = pin_style.get("content", {})

    x, y = int(x), int(y)

    if mode in ("teardrop_with_logo", "teardrop_with_monogram", "teardrop_with_icon", "teardrop_plain"):
        head_r = size // 2
        head_y = y - size + head_r
        cv2.circle(canvas_bgr, (x, head_y), head_r, fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.circle(canvas_bgr, (x, head_y), head_r, stroke, sw, cv2.LINE_AA)
        tip = np.array(
            [
                (x - int(head_r * 0.5), head_y + int(head_r * 0.8)),
                (x + int(head_r * 0.5), head_y + int(head_r * 0.8)),
                (x, y),
            ],
            dtype=np.int32,
        )
        cv2.fillConvexPoly(canvas_bgr, tip, fill, cv2.LINE_AA)
        if sw > 0:
            cv2.polylines(canvas_bgr, [tip], True, stroke, sw, cv2.LINE_AA)

        ct = content.get("type", "none")
        if ct in ("monogram", "text", "logo"):
            t = content.get("text") or content.get("monogram") or ""
            fs = int(content.get("text_size_px", 22 if ct == "monogram" else 30))
            font = _get_font(_resolve_font_family(content.get("text_font"), bold=True), fs)
            tc = _hex_to_rgb(content.get("text_color", "#FFFFFF")) or (255, 255, 255)
            tw, th = _measure_text(t, font)
            overlay, draw = _bgr_to_rgba_overlay(w, h)
            bbox = font.getbbox(t)
            draw.text(
                (x - tw // 2 - bbox[0], head_y - th // 2 - bbox[1]),
                t,
                font=font,
                fill=tc + (255,),
            )
            canvas_bgr = _composite_overlay_onto_bgr(canvas_bgr, overlay)
        elif ct == "icon":
            icn = content.get("icon_name", "home")
            tc = _hex_to_bgr(content.get("text_color", "#000000"))
            if icn == "home":
                icr = int(head_r * 0.55)
                cv2.rectangle(
                    canvas_bgr,
                    (x - icr, head_y - icr // 3),
                    (x + icr, head_y + icr),
                    tc,
                    -1,
                    cv2.LINE_AA,
                )
                roof = np.array(
                    [
                        (x - icr - 6, head_y - icr // 3),
                        (x + icr + 6, head_y - icr // 3),
                        (x, head_y - icr - 6),
                    ],
                    dtype=np.int32,
                )
                cv2.fillConvexPoly(canvas_bgr, roof, tc, cv2.LINE_AA)
                dw = icr // 3
                dh = icr // 2
                door_color = _hex_to_bgr(pin_style.get("fill_color", "#FFFFFF"))
                cv2.rectangle(
                    canvas_bgr,
                    (x - dw // 2, head_y + icr - dh),
                    (x + dw // 2, head_y + icr),
                    door_color,
                    -1,
                )

    elif mode == "pill_with_address":
        # Substitute {address} / {street_number} / {street_name} like
        # _draw_address_overlay does. Without this, themes that ship the
        # template "{address}" had the literal string drawn on the pill.
        # (QC2 finding #16.)
        raw_text = content.get("text", "ADDRESS")
        scene_for_pill = pin_style.get("__scene__") or {}
        t = _render_template(raw_text, scene_for_pill)
        if not t:
            t = raw_text  # last-ditch fallback when scene didn't carry the address
        fs = int(content.get("text_size_px", 40))
        font = _get_font(_resolve_font_family(content.get("text_font"), bold=True), fs)
        tw, th = _measure_text(t, font)

        # Optional size_px-proportional geometry. Default OFF (size_scale_legacy
        # = true) so existing themes' visual output is byte-identical. New
        # themes opt in by setting `size_scale_legacy=false` in pin_style;
        # then pad / tip-offset / circle radius scale with size/120 so the
        # pin actually responds to size_px on small variants.
        # (QC2 finding #14 — without scaling the pill ignores size_px entirely.)
        legacy_scale = bool(pin_style.get("size_scale_legacy", True))
        if legacy_scale:
            pad = 22
            tip_offset = 40
            tip_circle_r = 8
        else:
            scale = max(0.25, min(4.0, size / 120.0))
            pad = max(8, int(round(22 * scale)))
            tip_offset = max(12, int(round(40 * scale)))
            tip_circle_r = max(3, int(round(8 * scale)))
        bw = tw + pad * 2
        bh = th + pad * 2

        # Ellipsis truncation when the rendered text won't fit the canvas
        # (QC2-2 #10). Without this, a wide address bar (5000 px text on a
        # 1080 px canvas) lands bx1 deep negative after the second X-clamp;
        # cv2.rectangle clips fine but PIL draw.text starts off-screen and
        # the label is invisible. We fit the *rendered* text to (w - 40)
        # accounting for the pill's pad on both sides, dropping characters
        # from the end and appending "…" until it fits.
        max_pill_w = max(40, int(w) - 40)
        if bw > max_pill_w and len(t) > 1:
            ellipsis = "…"
            avail = max_pill_w - pad * 2
            if avail < 0:
                avail = 0
            ell_w, _ = _measure_text(ellipsis, font)
            # Binary search for the largest prefix that fits with the ellipsis.
            lo, hi = 0, len(t) - 1
            best = 0
            while lo <= hi:
                mid = (lo + hi) // 2
                cand = t[:mid].rstrip() + ellipsis
                cw, _ = _measure_text(cand, font)
                if cw <= avail:
                    best = mid
                    lo = mid + 1
                else:
                    hi = mid - 1
            if best > 0:
                t = t[:best].rstrip() + ellipsis
            else:
                # Even the ellipsis alone doesn't fit — render just the ellipsis.
                t = ellipsis
            tw, th = _measure_text(t, font)
            bw = tw + pad * 2
            bh = th + pad * 2

        bx1 = x - bw // 2
        bx2 = x + bw // 2
        by2 = y - tip_offset
        by1 = by2 - bh

        # Clamp into frame (matching _draw_poi_label clamp logic — QC2 #17).
        # If the pill would clip the right edge, push it left; if the top is
        # cropped, drop the pill below the target instead of off-screen.
        if bx1 < 20:
            bx1 = 20
            bx2 = bx1 + bw
        if bx2 > w - 20:
            bx2 = w - 20
            bx1 = bx2 - bw
        if by1 < 20:
            # Flip below the target (mirroring _draw_poi_label flip-below)
            by1 = y + tip_offset
            by2 = by1 + bh
            if by2 > h - 20:
                by2 = h - 20
                by1 = by2 - bh

        cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), stroke, sw, cv2.LINE_AA)

        overlay, draw = _bgr_to_rgba_overlay(w, h)
        tc = _hex_to_rgb(content.get("text_color", "#000000")) or (0, 0, 0)
        bbox = font.getbbox(t)
        draw.text(
            (bx1 + pad - bbox[0], by1 + pad - bbox[1]),
            t,
            font=font,
            fill=tc + (255,),
        )
        canvas_bgr = _composite_overlay_onto_bgr(canvas_bgr, overlay)

        cv2.circle(canvas_bgr, (x, y), tip_circle_r, fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.circle(canvas_bgr, (x, y), tip_circle_r, stroke, max(2, sw), cv2.LINE_AA)
        # Connector line: from pill bottom (or top, if flipped) to the
        # target circle. Pick the side closest to the target.
        if by2 < y:
            cv2.line(canvas_bgr, (x, by2), (x, y - tip_circle_r), fill, max(2, tip_circle_r // 4), cv2.LINE_AA)
        else:
            cv2.line(canvas_bgr, (x, by1), (x, y + tip_circle_r), fill, max(2, tip_circle_r // 4), cv2.LINE_AA)

    elif mode == "custom_svg":
        # Rasterise an SVG. content_b64 is the ONLY supported source path —
        # the previous content.url fallback opened an 8-second blocking HTTP
        # fetch on every render, made the worker dependent on whichever CDN
        # the theme author cribbed the SVG from, and (despite the SSRF
        # allowlist) was a security-sensitive surface area we don't need.
        # Rejected/missing sources render a red 'X' placeholder rather than
        # crashing the whole render. (QC2 finding #18.)
        target_w = max(8, int(size))
        svg_bytes: Optional[bytes] = None
        placeholder_reason: Optional[str] = None

        b64 = content.get("content_b64")
        if b64:
            try:
                import base64 as _b64
                svg_bytes = _b64.b64decode(b64)
            except Exception as e:
                placeholder_reason = f"invalid content_b64 ({e})"
        elif content.get("url"):
            placeholder_reason = (
                "custom_svg.url support has been removed — embed the SVG via "
                "content_b64 (base64) instead. URL-fetch was a synchronous 8 s "
                "blocking call inside the renderer."
            )
        else:
            placeholder_reason = "no svg source provided (set content_b64)"

        if placeholder_reason or not svg_bytes:
            print(f"custom_svg: {placeholder_reason or 'empty svg bytes'}; rendering placeholder")
            svg_img = _make_svg_placeholder(target_w)
            sw_img = svg_img.size[0]
            sh_img = svg_img.size[1]
            paste_x = max(0, min(x - sw_img // 2, w - sw_img))
            paste_y = max(0, min(y - sh_img, h - sh_img))
            overlay, _ = _bgr_to_rgba_overlay(w, h)
            overlay.paste(svg_img, (paste_x, paste_y), svg_img)
            return _composite_overlay_onto_bgr(canvas_bgr, overlay)

        try:
            import cairosvg  # type: ignore
        except ImportError:
            print("custom_svg: cairosvg not installed; skipping pin")
            return canvas_bgr

        try:
            png_bytes = cairosvg.svg2png(
                bytestring=svg_bytes,
                output_width=target_w,
            )
        except Exception as e:
            print(f"custom_svg: rasterise failed ({e}); skipping pin")
            return canvas_bgr

        try:
            svg_img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        except Exception as e:
            print(f"custom_svg: png decode failed ({e}); skipping pin")
            return canvas_bgr

        sw_img = svg_img.size[0]
        sh_img = svg_img.size[1]
        # Anchor: pin tip = (x, y). We treat (x, y) as bottom-centre of the SVG
        # so a typical map pin's tip lands on the pixel.
        paste_x = x - sw_img // 2
        paste_y = y - sh_img
        if paste_x < 0 or paste_y < 0 or paste_x + sw_img > w or paste_y + sh_img > h:
            # Clamp into frame (best-effort; oversize SVG would clip)
            paste_x = max(0, min(paste_x, w - sw_img))
            paste_y = max(0, min(paste_y, h - sh_img))

        overlay, _ = _bgr_to_rgba_overlay(w, h)
        overlay.paste(svg_img, (paste_x, paste_y), svg_img)
        canvas_bgr = _composite_overlay_onto_bgr(canvas_bgr, overlay)

    elif mode == "line_up_with_house_icon":
        # Scale the connector length from a hardcoded 260 px (which clipped on
        # 1080-tall variants) to size_px-proportional, then clamp so the icon
        # box never sits more than h/4 from the target. (QC2 #15 + #17.)
        line_offset = max(120, int(size * 2.2))
        line_top_y = y - line_offset
        # Clamp icon box into frame: keep at least h//4 between target and
        # icon centre when room is tight, never let the icon clip the top.
        box_size = max(40, int(size * 0.66))
        if line_top_y - box_size // 2 < 20:
            line_top_y = max(20 + box_size // 2, y - h // 4)
        color = fill
        cv2.line(canvas_bgr, (x, y), (x, line_top_y + box_size // 2), color, 3, cv2.LINE_AA)
        cv2.circle(canvas_bgr, (x, y), max(4, box_size // 10), color, -1, cv2.LINE_AA)
        bx1 = x - box_size // 2
        bx2 = x + box_size // 2
        by1 = line_top_y - box_size // 2
        by2 = line_top_y + box_size // 2
        # X-clamp: keep the icon box on-canvas (mirror _draw_poi_label).
        if bx1 < 20:
            bx1 = 20
            bx2 = bx1 + box_size
        if bx2 > w - 20:
            bx2 = w - 20
            bx1 = bx2 - box_size
        cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), stroke, sw, cv2.LINE_AA)
        icon_color = _hex_to_bgr(content.get("icon_color", "#000000"))
        icr = max(8, box_size // 3)
        cy_ic = (by1 + by2) // 2
        cx_ic = (bx1 + bx2) // 2
        roof = np.array(
            [
                (cx_ic - icr - 2, cy_ic - icr // 3 + 2),
                (cx_ic + icr + 2, cy_ic - icr // 3 + 2),
                (cx_ic, cy_ic - icr),
            ],
            dtype=np.int32,
        )
        cv2.fillConvexPoly(canvas_bgr, roof, icon_color, cv2.LINE_AA)
        cv2.rectangle(
            canvas_bgr,
            (cx_ic - icr + 2, cy_ic - icr // 3 + 2),
            (cx_ic + icr - 2, cy_ic + icr - 2),
            icon_color,
            -1,
            cv2.LINE_AA,
        )
        dw = max(3, icr // 3)
        cv2.rectangle(canvas_bgr, (cx_ic - dw, cy_ic + 2), (cx_ic + dw, cy_ic + icr - 2), fill, -1)

    return canvas_bgr


# ─────────────────────────────────────────────────────────────────────────────
# Boundary layer pass
# ─────────────────────────────────────────────────────────────────────────────
def _lerp_latlon(ll1, ll2, t):
    """Antimeridian-safe lat/lon linear interpolation at parameter t in [0,1].

    Latitude lerps trivially. Longitude is interpolated via the unit-vector
    method on the equatorial circle so a (lon1=179.9, lon2=-179.9, t=0.5)
    pair maps to ±180° rather than 0° (Indian Ocean). At polar latitudes the
    longitude difference itself is meaningless, but the unit-vector form
    degrades gracefully — a pole-spanning polygon edge isn't a real-world
    drone scene anyway.

    Args:
      ll1: (lat, lon) tuple at t=0
      ll2: (lat, lon) tuple at t=1
      t:   parameter in [0, 1]
    Returns:
      (lat, lon) tuple at parameter t.
    """
    lat1, lon1 = ll1[0], ll1[1]
    lat2, lon2 = ll2[0], ll2[1]
    # Lat: simple lerp (no wrap; lat is already constrained to [-90, 90]).
    lat = lat1 + (lat2 - lat1) * t
    # Lon: interpolate the cosine/sine on the unit circle, then atan2 back.
    # This is the antimeridian-safe equivalent of a plain numeric lerp.
    lon1_r = math.radians(lon1)
    lon2_r = math.radians(lon2)
    x = math.cos(lon1_r) + (math.cos(lon2_r) - math.cos(lon1_r)) * t
    y = math.sin(lon1_r) + (math.sin(lon2_r) - math.sin(lon1_r)) * t
    if x == 0.0 and y == 0.0:
        # Antipodal pair — meaningless edge; fall back to lon1.
        return (lat, lon1)
    lon = math.degrees(math.atan2(y, x))
    return (lat, lon)


def _project_polygon(polygon_latlon, scene, w, h, intrinsics=None):
    """Project a list of [lat, lon] tuples to pixel coords.

    Returns ``(polygon_px, polygon_latlon_clipped)`` where:
      - ``polygon_px`` is an Nx2 int32 array (pixel coords)
      - ``polygon_latlon_clipped`` is a list of (lat, lon) tuples, length N,
        IN THE SAME ORDER as polygon_px

    Returns ``(None, None)`` if the polygon is fully outside the near-plane
    or has fewer than 3 surviving vertices.

    Performs Sutherland-Hodgman clipping against the camera near-plane (Z_c > 0)
    in CAMERA SPACE before projecting to pixels. The previous behaviour
    (return None if any single vertex was behind the camera) caused the entire
    boundary to disappear when the drone was tilted such that one corner of
    the polygon fell behind the focal plane — even though the visible portion
    of the boundary covers most of the frame. (QC2 finding #2.)

    QC2-2 #1: when SH inserts an intersection vertex on edge AB at parameter t,
    the corresponding lat/lon is also interpolated (antimeridian-safe) and
    returned in parallel — otherwise downstream side_measurements / sqm_total
    iterating ``range(len(polygon_px))`` would IndexError into the original
    (shorter) polygon_latlon array.

    Worst case: a triangle whose 1 visible vertex is in front of the camera
    is clipped to a triangle (one vertex + two edge intersections).
    """
    if not polygon_latlon:
        return None, None

    # Resolve intrinsics + drone pose once (per-vertex re-derivation matched
    # the legacy _gps_to_px signature, but for the clip we need the underlying
    # camera-space coords).
    dlat = scene["lat"]
    dlon = scene["lon"]
    if dlat > 89.9 or dlat < -89.9:
        print(f"[_project_polygon] WARN drone lat near pole ({dlat:.4f}); clamping")
    dlat_clamped = max(-89.9, min(89.9, dlat))
    cos_lat = math.cos(math.radians(dlat_clamped))
    alt = scene["alt"]
    hr = math.radians(scene["yaw"])
    pr = math.radians(scene["pitch"])
    cam_z = (math.cos(pr) * math.sin(hr), math.cos(pr) * math.cos(hr), math.sin(pr))
    cam_x = (math.cos(hr), -math.sin(hr), 0.0)
    cam_y = (
        cam_z[1] * cam_x[2] - cam_z[2] * cam_x[1],
        cam_z[2] * cam_x[0] - cam_z[0] * cam_x[2],
        cam_z[0] * cam_x[1] - cam_z[1] * cam_x[0],
    )
    if intrinsics is None:
        fx = (DEFAULT_FX_MM / DEFAULT_SENSOR_W_MM) * w
        fy = (DEFAULT_FY_MM / DEFAULT_SENSOR_H_MM) * h
        cx, cy = w / 2, h / 2
    else:
        fx, fy, cx, cy = intrinsics

    def latlon_to_cam(lat, lon):
        # Antimeridian-safe lon difference (mirrors _gps_to_px).
        dlon_diff = ((lon - dlon + 540.0) % 360.0) - 180.0
        dE = dlon_diff * 111319 * cos_lat
        dN = (lat - dlat_clamped) * 111319
        dU = -alt
        Xc = dE * cam_x[0] + dN * cam_x[1] + dU * cam_x[2]
        Yc = dE * cam_y[0] + dN * cam_y[1] + dU * cam_y[2]
        Zc = dE * cam_z[0] + dN * cam_z[1] + dU * cam_z[2]
        return (Xc, Yc, Zc)

    cam_pts = [latlon_to_cam(lat, lon) for lat, lon in polygon_latlon]

    # Sutherland-Hodgman: keep vertices with Z > Z_NEAR; for an edge crossing
    # the plane, append the interpolated intersection (cam-space + lat/lon).
    Z_NEAR = 0.1  # 10 cm in front of the camera; > 0 to avoid div-by-zero
    n = len(cam_pts)
    if n == 0:
        return None, None
    output_cam: list = []
    output_ll: list = []
    behind_count = 0
    for i in range(n):
        cur = cam_pts[i]
        prev = cam_pts[(i - 1) % n]
        cur_ll = (polygon_latlon[i][0], polygon_latlon[i][1])
        prev_ll = (polygon_latlon[(i - 1) % n][0], polygon_latlon[(i - 1) % n][1])
        cur_in = cur[2] > Z_NEAR
        prev_in = prev[2] > Z_NEAR
        if cur_in:
            if not prev_in:
                # Entering — append intersection of (prev → cur) with z=Z_NEAR
                t = (Z_NEAR - prev[2]) / (cur[2] - prev[2])
                ix = prev[0] + t * (cur[0] - prev[0])
                iy = prev[1] + t * (cur[1] - prev[1])
                output_cam.append((ix, iy, Z_NEAR))
                output_ll.append(_lerp_latlon(prev_ll, cur_ll, t))
            output_cam.append(cur)
            output_ll.append(cur_ll)
        else:
            behind_count += 1
            if prev_in:
                # Leaving — append intersection of (prev → cur) with z=Z_NEAR
                t = (Z_NEAR - prev[2]) / (cur[2] - prev[2])
                ix = prev[0] + t * (cur[0] - prev[0])
                iy = prev[1] + t * (cur[1] - prev[1])
                output_cam.append((ix, iy, Z_NEAR))
                output_ll.append(_lerp_latlon(prev_ll, cur_ll, t))

    if behind_count > 0:
        print(
            f"[_project_polygon] near-plane clip: {behind_count}/{n} vertices "
            f"behind camera; clipped polygon has {len(output_cam)} verts"
        )

    if len(output_cam) < 3:
        # Less than a triangle remaining — nothing to draw.
        return None, None

    pts = []
    pts_ll = []
    for (Xc, Yc, Zc), ll in zip(output_cam, output_ll):
        if Zc <= 0:
            continue
        pts.append((fx * Xc / Zc + cx, fy * Yc / Zc + cy))
        pts_ll.append(ll)

    if len(pts) < 3:
        return None, None
    return np.array(pts, dtype=np.int32), pts_ll


def _apply_exterior_treatment(canvas_bgr: np.ndarray, polygon_px: np.ndarray, treatment: dict) -> np.ndarray:
    """Blur/darken/desaturate/hue-shift everything OUTSIDE the polygon.

    Early-returns the original canvas when EVERY treatment is a no-op
    (blur disabled OR strength 0; all factors == 1.0; hue_shift == 0).
    Without this guard, themes that ship with the block present-but-
    inactive still trigger 80–150 ms per render of canvas copies + mask
    fills + per-pixel writes for zero visual change. (QC2 finding #7.)
    """
    blur_strength = int(treatment.get("blur_strength_px", 0))
    blur_active = bool(treatment.get("blur_enabled", False)) and blur_strength > 0
    darken = float(treatment.get("darken_factor", 1.0))
    sat = float(treatment.get("saturation_factor", 1.0))
    light = float(treatment.get("lightness_factor", 1.0))
    hue_shift = int(treatment.get("hue_shift_degrees", 0))
    color_active = (darken != 1.0) or (sat != 1.0) or (light != 1.0) or (hue_shift != 0)

    if not blur_active and not color_active:
        return canvas_bgr  # no-op short-circuit

    h, w = canvas_bgr.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [polygon_px], 255)
    inv_mask = cv2.bitwise_not(mask)

    treated = canvas_bgr.copy()

    if blur_active:
        k = blur_strength | 1  # must be odd
        treated = cv2.GaussianBlur(treated, (k, k), 0)

    if color_active:
        hsv = cv2.cvtColor(treated, cv2.COLOR_BGR2HSV).astype(np.float32)
        if hue_shift != 0:
            # OpenCV hue is 0..179 (180 = full circle)
            hsv[..., 0] = (hsv[..., 0] + (hue_shift / 360.0) * 180) % 180
        if sat != 1.0:
            hsv[..., 1] = np.clip(hsv[..., 1] * sat, 0, 255)
        if light != 1.0 or darken != 1.0:
            hsv[..., 2] = np.clip(hsv[..., 2] * light * darken, 0, 255)
        treated = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    # Composite: keep interior original, exterior treated
    result = canvas_bgr.copy()
    result[inv_mask == 255] = treated[inv_mask == 255]
    return result


def _draw_boundary_line(canvas_bgr: np.ndarray, polygon_px: np.ndarray, line_cfg: dict) -> np.ndarray:
    """Draw a styled boundary line (solid/dashed/dotted) with optional drop shadow."""
    style = line_cfg.get("style", "solid")
    width = int(line_cfg.get("width_px", 6))
    color = _hex_to_bgr(line_cfg.get("color", "#FFFFFF"))

    # Drop shadow
    shadow = line_cfg.get("shadow", {})
    if shadow.get("enabled", False):
        sh_color = _hex_to_bgr(shadow.get("color", "#000000"))
        ox = int(shadow.get("offset_x_px", 0))
        oy = int(shadow.get("offset_y_px", 4))
        blur = int(shadow.get("blur_px", 6))
        h, w = canvas_bgr.shape[:2]
        shadow_layer = np.zeros((h, w, 3), dtype=np.uint8)
        shifted_poly = polygon_px.copy()
        shifted_poly[:, 0] += ox
        shifted_poly[:, 1] += oy
        cv2.polylines(shadow_layer, [shifted_poly], True, sh_color, width, cv2.LINE_AA)
        if blur > 0:
            k = blur | 1
            shadow_layer = cv2.GaussianBlur(shadow_layer, (k, k), 0)
        # Alpha-composite shadow onto canvas
        shadow_alpha = (cv2.cvtColor(shadow_layer, cv2.COLOR_BGR2GRAY) > 0).astype(np.float32) * 0.6
        for c in range(3):
            canvas_bgr[..., c] = (
                canvas_bgr[..., c] * (1 - shadow_alpha) + shadow_layer[..., c] * shadow_alpha
            ).astype(np.uint8)

    if style == "solid":
        cv2.polylines(canvas_bgr, [polygon_px], True, color, width, cv2.LINE_AA)
    elif style == "dashed":
        _draw_dashed_polygon(canvas_bgr, polygon_px, color, width, dash=20, gap=14)
    elif style == "dotted":
        _draw_dashed_polygon(canvas_bgr, polygon_px, color, width, dash=2, gap=14)

    return canvas_bgr


def _draw_dashed_polygon(canvas_bgr: np.ndarray, pts: np.ndarray, color, width: int, dash: int, gap: int):
    """Draw a closed polygon as dashed/dotted segments."""
    n = len(pts)
    for i in range(n):
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        seg_len = float(np.linalg.norm(p2 - p1))
        if seg_len < 1:
            continue
        ux = (p2[0] - p1[0]) / seg_len
        uy = (p2[1] - p1[1]) / seg_len
        d = 0.0
        while d < seg_len:
            d_end = min(d + dash, seg_len)
            x1 = int(p1[0] + ux * d)
            y1 = int(p1[1] + uy * d)
            x2 = int(p1[0] + ux * d_end)
            y2 = int(p1[1] + uy * d_end)
            cv2.line(canvas_bgr, (x1, y1), (x2, y2), color, width, cv2.LINE_AA)
            d = d_end + gap


def _draw_side_measurements(
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, polygon_latlon, cfg: dict, w: int, h: int,
    side_overrides: dict | None = None,
) -> np.ndarray:
    """Label each polygon edge with its geodesic length.

    ``side_overrides`` (Wave 5 P2 S5): operator overrides from the new
    Boundary Editor — keyed by stringified edge index ("0", "1", ...) into
    the polygon as the EDITOR sees it. Each entry may carry:
      - ``hide: bool``           — if true, skip the label for that edge
      - ``label_offset_px: [dx, dy]`` — additive nudge to the (tx, ty)
        anchor point (after the outward-from-centroid offset is applied)

    Caveat: when ``_project_polygon`` Sutherland-Hodgman clips a vertex behind
    the camera, intersection vertices are inserted, so polygon_px (length N)
    can be longer than the operator's saved polygon (length M). In that case
    the override indexes don't align with the rendered edges. We document
    the misalignment by logging once per render — the editor's polygon view
    must reflect the SH-clipped polygon for overrides to track precisely.
    For typical operator usage (polygon fully in frame, M == N), the indexes
    line up directly.
    """
    if not cfg.get("enabled", False):
        return canvas_bgr
    unit = cfg.get("unit", "metres")
    decimals = int(cfg.get("decimals", 1))
    fs = int(cfg.get("font_size_px", 28))
    text_rgb = _hex_to_rgb(cfg.get("text_color", "#FFFFFF")) or (255, 255, 255)
    outline_rgb = _hex_to_rgb(cfg.get("text_outline_color", "#000000")) or (0, 0, 0)
    outline_w = int(cfg.get("text_outline_width_px", 3))
    font = _get_font(_resolve_font_family(cfg.get("font_family"), bold=True), fs)
    position = cfg.get("position", "outside")

    # Centroid for "outside" direction calc
    cx = polygon_px[:, 0].mean()
    cy = polygon_px[:, 1].mean()

    overlay, draw = _bgr_to_rgba_overlay(w, h)
    n = len(polygon_px)
    overrides_map = side_overrides if isinstance(side_overrides, dict) else {}
    for i in range(n):
        # Per-edge operator overrides — keyed by stringified edge index.
        ov = overrides_map.get(str(i)) if overrides_map else None
        if isinstance(ov, dict) and ov.get("hide") is True:
            continue
        p1 = polygon_px[i]
        p2 = polygon_px[(i + 1) % n]
        ll1 = polygon_latlon[i]
        ll2 = polygon_latlon[(i + 1) % n]
        length_m = _haversine_m(ll1[0], ll1[1], ll2[0], ll2[1])
        if unit == "feet":
            length_v = length_m * 3.28084
            label = f"{length_v:.{decimals}f}ft"
        else:
            label = f"{length_m:.{decimals}f}m"

        mx = (p1[0] + p2[0]) / 2
        my = (p1[1] + p2[1]) / 2
        # Outward unit vector (away from centroid)
        out_x = mx - cx
        out_y = my - cy
        out_len = (out_x ** 2 + out_y ** 2) ** 0.5 + 1e-6
        ox = out_x / out_len
        oy = out_y / out_len
        offset = 28 if position == "outside" else -28
        tx = int(mx + ox * offset)
        ty = int(my + oy * offset)
        # Operator nudge — add [dx, dy] to the centred anchor point.
        if isinstance(ov, dict):
            nudge = ov.get("label_offset_px")
            if isinstance(nudge, (list, tuple)) and len(nudge) == 2:
                try:
                    tx += int(nudge[0])
                    ty += int(nudge[1])
                except (TypeError, ValueError):
                    pass  # malformed payload — ignore the nudge silently

        bbox = font.getbbox(label)
        tw_px = bbox[2] - bbox[0]
        th_px = bbox[3] - bbox[1]
        # Center text on (tx, ty)
        anchor_x = tx - tw_px // 2 - bbox[0]
        anchor_y = ty - th_px // 2 - bbox[1]

        # Single draw.text call with stroke_width/stroke_fill (PIL ≥9.2.0).
        # The previous N×N loop was 49 calls per side at outline_w=3, so a
        # 4-side polygon = 196 PIL text renders. (QC2 finding #13.)
        if outline_w > 0:
            draw.text(
                (anchor_x, anchor_y),
                label,
                font=font,
                fill=text_rgb + (255,),
                stroke_width=outline_w,
                stroke_fill=outline_rgb + (255,),
            )
        else:
            draw.text((anchor_x, anchor_y), label, font=font, fill=text_rgb + (255,))

    return _composite_overlay_onto_bgr(canvas_bgr, overlay)


def _draw_sqm_total(
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, polygon_latlon, cfg: dict, w: int, h: int,
    centroid_offset_px: list | tuple | None = None,
    value_override: float | int | None = None,
) -> np.ndarray:
    """Overlay total area (sqm) — uses geodesic shoelace approx via local ENU projection.

    Wave 5 P2 S5 — operator overrides from the new Boundary Editor:
      - ``centroid_offset_px`` ([dx, dy]): when ``cfg.position == 'centroid'``
        this is added to the computed centroid anchor (does not affect any
        of the named corner positions). Other positions ignore the override
        because the operator can simply pick a different position in the
        Inspector if they want a corner anchor.
      - ``value_override`` (numeric): replaces the geodesic-shoelace computed
        area. The renderer still substitutes the raw integer into the
        ``{sqm}`` template, so themes that ship "{sqm} sqm approx" produce
        e.g. "999 sqm approx". To set the entire string the editor should
        set this AND set the theme's text_template to "{sqm}" — but the
        v1 editor only exposes the numeric override.
    """
    if not cfg.get("enabled", False):
        return canvas_bgr

    # Compute area via local equirectangular ENU on the polygon centroid.
    # lat: simple arithmetic mean (lat doesn't wrap; bounded to [-90, 90]).
    # lon: spherical unit-vector mean — naive (sum/N) maps a Fiji property
    #      polygon spanning ±180° to lon0 = 0° (Indian Ocean), then the
    #      shoelace area is wrong by orders of magnitude (the ENU dE values
    #      become ~20 000 km instead of a few metres). (QC2-2 #5.)
    lats_only = [ll[0] for ll in polygon_latlon]
    lons_only = [ll[1] for ll in polygon_latlon]
    lat0 = sum(lats_only) / len(lats_only)
    _, lon0 = _lonlat_mean_via_unit_vectors(lats_only, lons_only)
    cos_lat0 = math.cos(math.radians(lat0))
    # Antimeridian-safe lon difference per vertex (mirrors _gps_to_px /
    # _project_polygon). Without this, even with a correct lon0, vertices
    # on the opposite side of ±180° produce dE ≈ ±40 000 km.
    enu = []
    for lat, lon in polygon_latlon:
        dlon_diff = ((lon - lon0 + 540.0) % 360.0) - 180.0
        enu.append((dlon_diff * 111319 * cos_lat0, (lat - lat0) * 111319))
    n = len(enu)
    s = 0.0
    for i in range(n):
        x1, y1 = enu[i]
        x2, y2 = enu[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    area_sqm = abs(s) / 2.0
    # Operator override wins over the computed area.
    if value_override is not None:
        try:
            area_sqm = float(value_override)
        except (TypeError, ValueError):
            pass  # malformed → fall back to computed area
    sqm_int = int(round(area_sqm))

    template = cfg.get("text_template", "{sqm} sqm approx")
    text = template.replace("{sqm}", f"{sqm_int:,}")

    fs = int(cfg.get("font_size_px", 64))
    font = _get_font(_resolve_font_family(cfg.get("font_family"), bold=True), fs)
    text_rgb = _hex_to_rgb(cfg.get("text_color", "#FFFFFF")) or (255, 255, 255)
    bg_hex = cfg.get("bg_color", "transparent")
    bg_rgba = _hex_to_rgba(bg_hex, alpha=200) if bg_hex != "transparent" else None

    # Position
    pos = cfg.get("position", "centroid")
    if pos == "centroid":
        cx = int(polygon_px[:, 0].mean())
        cy = int(polygon_px[:, 1].mean())
    elif pos == "top_left":
        cx = int(polygon_px[:, 0].min()) + 60
        cy = int(polygon_px[:, 1].min()) + 60
    elif pos == "top_right":
        cx = int(polygon_px[:, 0].max()) - 60
        cy = int(polygon_px[:, 1].min()) + 60
    elif pos == "bottom_left":
        cx = int(polygon_px[:, 0].min()) + 60
        cy = int(polygon_px[:, 1].max()) - 60
    else:  # bottom_right
        cx = int(polygon_px[:, 0].max()) - 60
        cy = int(polygon_px[:, 1].max()) - 60

    # Operator centroid offset — only meaningful for the centroid anchor;
    # named-corner positions are explicit operator choices, no nudge needed.
    if pos == "centroid" and isinstance(centroid_offset_px, (list, tuple)) and len(centroid_offset_px) == 2:
        try:
            cx += int(centroid_offset_px[0])
            cy += int(centroid_offset_px[1])
        except (TypeError, ValueError):
            pass  # malformed payload — keep centroid as-is

    bbox = font.getbbox(text)
    tw_px = bbox[2] - bbox[0]
    th_px = bbox[3] - bbox[1]
    anchor_x = cx - tw_px // 2 - bbox[0]
    anchor_y = cy - th_px // 2 - bbox[1]

    overlay, draw = _bgr_to_rgba_overlay(w, h)

    if bg_rgba is not None:
        pad = int(fs * 0.4)
        draw.rectangle(
            [
                cx - tw_px // 2 - pad,
                cy - th_px // 2 - pad,
                cx + tw_px // 2 + pad,
                cy + th_px // 2 + pad,
            ],
            fill=bg_rgba,
        )

    # Drop shadow on text
    shadow = cfg.get("shadow", {})
    if shadow.get("enabled", False):
        sh_rgb = _hex_to_rgb(shadow.get("color", "#000000")) or (0, 0, 0)
        ox = int(shadow.get("offset_x_px", 2))
        oy = int(shadow.get("offset_y_px", 4))
        # Pre-blur via PIL filter on a temp layer
        tmp_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        tmp_draw = ImageDraw.Draw(tmp_layer)
        tmp_draw.text((anchor_x + ox, anchor_y + oy), text, font=font, fill=sh_rgb + (200,))
        blur_px = int(shadow.get("blur_px", 6))
        if blur_px > 0:
            tmp_layer = tmp_layer.filter(ImageFilter.GaussianBlur(blur_px))
        overlay = Image.alpha_composite(overlay, tmp_layer)
        draw = ImageDraw.Draw(overlay)

    draw.text((anchor_x, anchor_y), text, font=font, fill=text_rgb + (255,))
    return _composite_overlay_onto_bgr(canvas_bgr, overlay)


def _draw_address_overlay(
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, cfg: dict, scene: dict, w: int, h: int,
    position_latlng_override: list | tuple | None = None,
    text_override: str | None = None,
) -> np.ndarray:
    """Overlay an address line near/inside the boundary.

    Wave 5 P2 S5 — operator overrides from the new Boundary Editor:
      - ``position_latlng_override`` ([lat, lng]): when set, the anchor is
        projected via ``_gps_to_px`` instead of being derived from the
        polygon centroid + cfg.position. Lets the operator drag the label
        to any spot inside the property even if the centroid sits on a
        roof/driveway.
      - ``text_override`` (str): replaces the templated text from
        ``_render_template(cfg.text_template, scene)``. The operator types
        the literal label (e.g. "Lot 27 — 8/2 Everton Rd") and we render
        verbatim, no template substitution. Empty/whitespace strings are
        treated as "no override" so the auto template still wins.

    The override is silently ignored when projection lands off-frame (px
    is None — happens if the operator drags the label well outside the
    visible image envelope on a tilted shot). Falls back to the centroid
    placement in that case so the address is never lost.
    """
    if not cfg.get("enabled", False):
        return canvas_bgr

    # Text resolution: operator override > templated render.
    override_str = text_override.strip() if isinstance(text_override, str) else ""
    if override_str:
        text = override_str
    else:
        template = cfg.get("text_template", "{address}")
        text = _render_template(template, scene)

    if not text.strip():
        return canvas_bgr

    fs = int(cfg.get("font_size_px", 36))
    font = _get_font(_resolve_font_family(cfg.get("font_family"), bold=True), fs)
    text_rgb = _hex_to_rgb(cfg.get("text_color", "#FFFFFF")) or (255, 255, 255)

    # Anchor resolution: operator lat/lng override > cfg.position.
    cx: int | None = None
    cy: int | None = None
    if isinstance(position_latlng_override, (list, tuple)) and len(position_latlng_override) == 2:
        try:
            ov_lat = float(position_latlng_override[0])
            ov_lng = float(position_latlng_override[1])
            px = _gps_to_px(
                ov_lat, ov_lng,
                scene["lat"], scene["lon"], scene["alt"],
                scene["yaw"], scene["pitch"], w, h,
            )
            if px is not None:
                cx = int(px[0])
                cy = int(px[1])
        except (TypeError, ValueError, KeyError):
            cx = None  # fall through to the centroid path below

    if cx is None or cy is None:
        # No override or override projection failed — use the legacy
        # centroid-based positioning.
        pos = cfg.get("position", "centroid")
        cx = int(polygon_px[:, 0].mean())
        cy = int(polygon_px[:, 1].mean())
        if pos == "below_sqm":
            cy = int(polygon_px[:, 1].mean()) + 80
        elif pos == "above_sqm":
            cy = int(polygon_px[:, 1].mean()) - 80

    bbox = font.getbbox(text)
    tw_px = bbox[2] - bbox[0]
    th_px = bbox[3] - bbox[1]
    anchor_x = cx - tw_px // 2 - bbox[0]
    anchor_y = cy - th_px // 2 - bbox[1]

    overlay, draw = _bgr_to_rgba_overlay(w, h)
    if cfg.get("shadow_enabled", False):
        for dx in (-2, -1, 1, 2):
            for dy in (-2, -1, 1, 2):
                draw.text(
                    (anchor_x + dx, anchor_y + dy),
                    text,
                    font=font,
                    fill=(0, 0, 0, 180),
                )
    draw.text((anchor_x, anchor_y), text, font=font, fill=text_rgb + (255,))
    return _composite_overlay_onto_bgr(canvas_bgr, overlay)


def _render_boundary(
    canvas_bgr: np.ndarray, theme: dict, scene: dict, w: int, h: int, intrinsics=None
) -> np.ndarray:
    """Apply the boundary pass per theme.boundary block + scene.polygon_latlon.

    Wave 5 P2 S5 — when ``scene.boundary_overrides`` is set, the operator's
    Boundary Editor tweaks (per-edge hide / nudge, sqm centroid offset and
    value override, address overlay position lat/lng + text override) are
    threaded through to the per-feature draw functions. Master toggles
    (side_measurements_enabled, sqm_total_enabled, address_overlay_enabled)
    are handled here rather than via theme cfg overlay so the operator can
    suppress an entire feature without editing the theme.
    """
    boundary_cfg = theme.get("boundary", {})
    if not boundary_cfg.get("enabled", False):
        return canvas_bgr

    polygon_latlon = scene.get("polygon_latlon")
    if not polygon_latlon or len(polygon_latlon) < 3:
        return canvas_bgr  # nothing to draw

    # Pull the operator's overrides bundle. Empty dict → no overrides; same
    # behaviour as v1 (theme-only) renders.
    bo = scene.get("boundary_overrides") or {}
    if not isinstance(bo, dict):
        bo = {}

    # _project_polygon returns BOTH px array and parallel-clipped lat/lon —
    # SH clipping inserts intersection vertices, so the original
    # polygon_latlon (length M) cannot be paired with polygon_px (length N>=M)
    # any more. The clipped lat/lon is what side_measurements + sqm_total
    # must iterate (QC2-2 #1).
    polygon_px, polygon_latlon_clipped = _project_polygon(
        polygon_latlon, scene, w, h, intrinsics=intrinsics
    )
    if polygon_px is None:
        return canvas_bgr

    # 1. Exterior treatment first (so line + text sit on top)
    treatment = boundary_cfg.get("exterior_treatment", {})
    if treatment:
        canvas_bgr = _apply_exterior_treatment(canvas_bgr, polygon_px, treatment)

    # 2. Boundary line
    line_cfg = boundary_cfg.get("line")
    if line_cfg:
        canvas_bgr = _draw_boundary_line(canvas_bgr, polygon_px, line_cfg)

    # 3. Side measurements (master toggle override + per-edge dict)
    sm_cfg = boundary_cfg.get("side_measurements", {})
    side_master = bo.get("side_measurements_enabled", True)
    if sm_cfg and side_master is not False:
        canvas_bgr = _draw_side_measurements(
            canvas_bgr, polygon_px, polygon_latlon_clipped, sm_cfg, w, h,
            side_overrides=bo.get("side_measurements_overrides"),
        )

    # 4. SQM total (master toggle + centroid offset + value override)
    sqm_cfg = boundary_cfg.get("sqm_total", {})
    sqm_master = bo.get("sqm_total_enabled", True)
    if sqm_cfg and sqm_master is not False:
        canvas_bgr = _draw_sqm_total(
            canvas_bgr, polygon_px, polygon_latlon_clipped, sqm_cfg, w, h,
            centroid_offset_px=bo.get("sqm_total_position_offset_px"),
            value_override=bo.get("sqm_total_value_override"),
        )

    # 5. Address overlay (master toggle + lat/lng anchor + text override)
    addr_cfg = boundary_cfg.get("address_overlay", {})
    addr_master = bo.get("address_overlay_enabled", True)
    if addr_cfg and addr_master is not False:
        canvas_bgr = _draw_address_overlay(
            canvas_bgr, polygon_px, addr_cfg, scene, w, h,
            position_latlng_override=bo.get("address_overlay_position_latlng"),
            text_override=bo.get("address_overlay_text_override"),
        )

    return canvas_bgr


# ─────────────────────────────────────────────────────────────────────────────
# Validation — minimal in-house JSON schema check (no jsonschema dep at runtime).
# ─────────────────────────────────────────────────────────────────────────────
class ThemeValidationError(ValueError):
    pass


def _validate_theme(theme: dict) -> None:
    """Lightweight validation. Full JSON Schema in themes/__schema__.json."""
    if not isinstance(theme, dict):
        raise ThemeValidationError("theme must be a dict")
    if "theme_name" not in theme:
        raise ThemeValidationError("theme.theme_name is required")
    pin = theme.get("property_pin", {})
    valid_modes = {
        "pill_with_address", "teardrop_with_logo", "teardrop_with_monogram",
        "teardrop_with_icon", "teardrop_plain", "line_up_with_house_icon", "custom_svg",
    }
    if pin and pin.get("mode") and pin["mode"] not in valid_modes:
        raise ThemeValidationError(f"property_pin.mode must be one of {valid_modes}, got {pin['mode']}")
    al = theme.get("anchor_line", {})
    if al.get("shape") and al["shape"] not in {"thin", "thick_bar", "dashed", "gradient", "none"}:
        raise ThemeValidationError(f"anchor_line.shape invalid: {al['shape']}")
    # custom_svg pin requires either content_b64 or url in pin.content
    if pin and pin.get("mode") == "custom_svg":
        c = pin.get("content", {}) or {}
        if not (c.get("content_b64") or c.get("url")):
            raise ThemeValidationError(
                "property_pin.mode=custom_svg requires content.content_b64 (base64 SVG) "
                "or content.url (https URL)"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────
def load_theme(theme_path_or_name) -> dict:
    """
    Load a theme from a JSON file path, or by seed name (e.g. 'flexmedia_default').

    Returns the validated theme dict. Raises ThemeValidationError on invalid config.
    """
    p = Path(theme_path_or_name)
    if not p.exists():
        # try seed
        candidate = THEMES_DIR / f"{theme_path_or_name}.json"
        if candidate.exists():
            p = candidate
        else:
            raise FileNotFoundError(f"Theme not found: {theme_path_or_name}")
    with open(p) as f:
        theme = json.load(f)
    _validate_theme(theme)
    return theme


def list_seed_themes() -> list[str]:
    """Return the list of bundled seed theme names (without .json suffix)."""
    if not THEMES_DIR.exists():
        return []
    out = []
    for p in sorted(THEMES_DIR.glob("*.json")):
        if p.name.startswith("__"):
            continue
        out.append(p.stem)
    return out


def encode_jpeg(canvas_bgr: np.ndarray, quality: int = 92) -> bytes:
    """Encode a BGR numpy canvas as JPEG bytes.

    Centralised so callers (render() + render_http variants loop) all use the
    same flag set, and so the variants loop can encode-once instead of
    decode-then-encode after `render()`. (QC2 finding #12.)
    """
    q = max(1, min(100, int(quality)))
    ok, buf = cv2.imencode(".jpg", canvas_bgr, [cv2.IMWRITE_JPEG_QUALITY, q])
    if not ok:
        raise RuntimeError("Failed to encode JPEG")
    return bytes(buf)


def render_canvas(image_bytes: bytes, theme_config: dict, scene: dict) -> np.ndarray:
    """
    Render an annotated drone image with the given theme + scene.
    Returns the BGR numpy canvas — caller is responsible for encoding.

    The variants pipeline calls this directly to avoid the wasted JPEG
    encode → cv2.imdecode round trip that `render()` -> bytes -> imdecode
    forced. (QC2 finding #12.)
    """
    _validate_theme(theme_config)

    # Decode image
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")
    h, w = img.shape[:2]

    canvas = img.copy()

    # Resolve per-shot camera intrinsics. When scene.camera_intrinsics is
    # populated (from EXIF make/model/focal — see #18) this gives correct
    # POI projection on Mavic 2 Pro / Mini / etc. Otherwise we fall back to
    # the Mavic 3 Pro defaults (which is what the original spike used).
    intrinsics = _resolve_intrinsics(scene, w, h)

    # ───── Boundary pass FIRST (so POIs and pin sit on top) ─────
    canvas = _render_boundary(canvas, theme_config, scene, w, h, intrinsics=intrinsics)

    # ───── POI labels ─────
    pois = scene.get("pois", [])
    anchor_style = theme_config.get("anchor_line", {})
    label_style = theme_config.get("poi_label", {})
    show_dist = label_style.get("secondary_text", {}).get("enabled", False) or label_style.get(
        "show_distance_as_secondary", False
    )

    # Master toggle: skip the entire POI loop when poi_label.enabled is false.
    # Defaults to True so existing themes without the field still render POIs.
    poi_labels_enabled = label_style.get("enabled", True)
    if poi_labels_enabled:
        # Per-shot pin cap from theme (clamped 0-50). 0 → no POIs rendered.
        max_pins = int(theme_config.get("poi_selection", {}).get("max_pins_per_shot", 6))
        max_pins = max(0, min(50, max_pins))
        for poi in pois[:max_pins]:
            # Wrap the entire per-POI body so one bad input (string distance,
            # missing lat/lon, missing name, etc.) skips that POI instead of
            # aborting the whole render. (QC2 findings #4 + #5.)
            try:
                # Coerce lat/lon — JSON sometimes carries them as strings when
                # the POI source is a third-party API.
                try:
                    poi_lat = float(poi["lat"])
                    poi_lon = float(poi["lon"])
                except (KeyError, TypeError, ValueError) as e:
                    print(f"[poi] skip {poi.get('name', '?')}: missing/invalid lat/lon ({e})")
                    continue

                px = _gps_to_px(
                    poi_lat, poi_lon,
                    scene["lat"], scene["lon"], scene["alt"],
                    scene["yaw"], scene["pitch"], w, h,
                    intrinsics=intrinsics,
                )
                if px is None:
                    continue
                if not (-200 < px[0] < w + 200 and -200 < px[1] < h + 200):
                    continue
                x, y = int(px[0]), int(px[1])
                secondary = None
                if show_dist and "distance_m" in poi:
                    # Distance arrives as a string surprisingly often (Google
                    # Places returns it stringly-typed in some response shapes).
                    # _fmt_distance returns None for NaN / 0 / negative /
                    # non-numeric — caller skips the secondary line entirely.
                    # (QC2-2 #8.)
                    secondary = _fmt_distance(poi.get("distance_m"))
                name = poi.get("name")
                if not name or not isinstance(name, str):
                    print(f"[poi] skip: missing/invalid name (poi={poi!r})")
                    continue
                canvas = _draw_poi_label(canvas, x, y, name, label_style, anchor_style, secondary, w, h)
            except Exception as e:
                print(f"[poi] skip {poi.get('name', '?') if isinstance(poi, dict) else '?'}: {e}")
                continue

    # ───── Custom pins (operator-saved via Pin Editor) ─────
    # Read from drone_custom_pins (loaded by drone-render). Each entry is
    # either world-anchored (project to pixel via _gps_to_px) or pixel-
    # anchored (drawn at the stored pixel coords). content/style_overrides
    # are passed through verbatim from the row; we merge style_overrides
    # over the theme's poi_label defaults so operator colour edits apply
    # but the typeface/padding/anchor-line behaviour matches the theme.
    custom_pins = scene.get("custom_pins", []) or []
    for cp in custom_pins:
        try:
            # Resolve target pixel
            if cp.get("world_lat") is not None and cp.get("world_lng") is not None:
                px = _gps_to_px(
                    cp["world_lat"], cp["world_lng"],
                    scene["lat"], scene["lon"], scene["alt"],
                    scene["yaw"], scene["pitch"], w, h,
                    intrinsics=intrinsics,
                )
                if px is None:
                    continue
                if not (-200 < px[0] < w + 200 and -200 < px[1] < h + 200):
                    continue
                x, y = int(px[0]), int(px[1])
            elif cp.get("pixel_x") is not None and cp.get("pixel_y") is not None:
                x, y = int(cp["pixel_x"]), int(cp["pixel_y"])
            else:
                continue

            pin_type = cp.get("pin_type", "poi_manual")
            content = cp.get("content") or {}
            style = cp.get("style_overrides") or {}
            # Merge non-null style_overrides into the theme label_style. The
            # operator's colour override (e.g. "color":"#3B82F6") becomes
            # text_color/fill via the theme schema, so we keep the merge
            # narrow: any explicit override wins, missing keys inherit.
            merged_style = {**label_style, **{k: v for k, v in style.items() if v is not None}}
            if pin_type == "text":
                text = content.get("text") or content.get("label") or ""
                if text:
                    # Pixel-anchored text labels render WITHOUT an anchor line
                    # (they're stuck to a point on the frame, not floating
                    # above a feature). Pass an anchor_style with width_px=0
                    # AND end_marker.shape='none' so _draw_anchor_line still
                    # runs but produces no visible artifact.
                    no_anchor_style = {
                        "shape": "thin",
                        "width_px": 0,
                        "color": merged_style.get("fill", "#FFFFFF"),
                        "end_marker": {"shape": "none"},
                    }
                    canvas = _draw_poi_label(
                        canvas, x, y, text, merged_style, no_anchor_style, None, w, h,
                    )
            elif pin_type == "poi_manual":
                label = content.get("label") or content.get("name") or content.get("text") or ""
                if label:
                    # W3-PINS: AI-source pins (drone-pois materialised) carry
                    # distance_m in content. When the theme exposes the
                    # secondary-text slot, render the distance below the label
                    # like the legacy POI loop did. Operator pins (source
                    # absent or 'manual') still render label-only unless
                    # content explicitly carries distance_m.
                    secondary = None
                    if show_dist:
                        # _fmt_distance returns None for NaN / 0 / negative /
                        # non-numeric — caller skips the secondary line.
                        # (QC2-2 #8.)
                        secondary = _fmt_distance(content.get("distance_m"))
                    canvas = _draw_poi_label(
                        canvas, x, y, label, merged_style, anchor_style, secondary, w, h,
                    )
            else:
                # 'line' and 'measurement' pin types are reserved for Wave 2;
                # log + skip so the renderer doesn't crash on early adopter
                # data.
                print(f"[render] custom pin type '{pin_type}' not yet supported, skipping")
        except Exception as e:
            print(f"[render] custom pin {cp.get('pin_type')} failed: {e}")
            continue

    # ───── Property pin ─────
    # Master toggle: skip the entire property-pin block when property_pin.enabled is false.
    # Defaults to True so existing themes without the field still render the pin.
    property_pin_cfg = theme_config.get("property_pin", {})
    property_pin_enabled = property_pin_cfg.get("enabled", True)
    if property_pin_enabled and "property_lat" in scene and "property_lon" in scene:
        pp = _gps_to_px(
            scene["property_lat"], scene["property_lon"],
            scene["lat"], scene["lon"], scene["alt"],
            scene["yaw"], scene["pitch"], w, h,
            intrinsics=intrinsics,
        )
        if pp and 0 < pp[0] < w and 0 < pp[1] < h:
            # Pass scene through inside pin_style under the dunder key
            # `__scene__` so pill_with_address can substitute {address} via
            # _render_template. We keep this as a sentinel field instead of
            # changing _draw_property_pin's signature so older theme configs
            # (and the test suite) keep working unchanged.
            pin_cfg_with_scene = {**property_pin_cfg, "__scene__": scene}
            canvas = _draw_property_pin(canvas, int(pp[0]), int(pp[1]), pin_cfg_with_scene, w, h)

    return canvas


def render(image_bytes: bytes, theme_config: dict, scene: dict) -> bytes:
    """
    Public API: render an annotated drone image and return JPEG bytes.

    For variants pipelines that need the BGR ndarray (to slice/resize without
    a JPEG round-trip), call `render_canvas()` directly and encode each
    variant via `encode_jpeg()`.
    """
    canvas = render_canvas(image_bytes, theme_config, scene)
    return encode_jpeg(canvas, quality=92)
