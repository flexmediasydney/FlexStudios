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

    intr_w = float(intr.get("width") or DEFAULT_W)
    intr_h = float(intr.get("height") or DEFAULT_H)
    fx_mm = float(intr.get("fx_mm") or DEFAULT_FX_MM)
    fy_mm = float(intr.get("fy_mm") or fx_mm)
    sensor_w_mm = float(intr.get("sensor_w_mm") or DEFAULT_SENSOR_W_MM)
    sensor_h_mm = float(intr.get("sensor_h_mm") or DEFAULT_SENSOR_H_MM)

    # Convert to focal-length-in-pixels at the *intrinsic* image size, then
    # rescale to the actual annotated image size (so downstream resampling
    # of the drone JPG before render still projects correctly).
    fx_px_intr = (fx_mm / sensor_w_mm) * intr_w
    fy_px_intr = (fy_mm / sensor_h_mm) * intr_h

    sx = image_w / intr_w
    sy = image_h / intr_h
    fx_px = fx_px_intr * sx
    fy_px = fy_px_intr * sy

    cx_px = intr.get("cx_px")
    cy_px = intr.get("cy_px")
    if cx_px is None:
        cx_px = image_w / 2.0
    else:
        cx_px = float(cx_px) * sx
    if cy_px is None:
        cy_px = image_h / 2.0
    else:
        cy_px = float(cy_px) * sy

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
    """
    cos_lat = math.cos(math.radians(dlat))
    dE = (tlon - dlon) * 111319 * cos_lat
    dN = (tlat - dlat) * 111319
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


def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    """Geodesic distance in metres between two WGS84 points."""
    R = 6371008.8
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1r) * math.cos(lat2r) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


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
        sec_rgb = _hex_to_rgb(
            label_style.get("secondary_text_color") or label_style.get("text_color", "#000000")
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
        t = content.get("text", "ADDRESS")
        fs = int(content.get("text_size_px", 40))
        font = _get_font(_resolve_font_family(content.get("text_font"), bold=True), fs)
        tw, th = _measure_text(t, font)
        pad = 22
        bw = tw + pad * 2
        bh = th + pad * 2
        bx1 = x - bw // 2
        bx2 = x + bw // 2
        by2 = y - 40
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

        cv2.circle(canvas_bgr, (x, y), 8, fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.circle(canvas_bgr, (x, y), 8, stroke, max(2, sw), cv2.LINE_AA)
        cv2.line(canvas_bgr, (x, by2), (x, y - 8), fill, 2, cv2.LINE_AA)

    elif mode == "custom_svg":
        # Rasterise an SVG. content_b64 is strongly preferred (no network
        # call); content.url is a last-resort path that's restricted to a
        # small allowlist of https hosts to defend against SSRF — otherwise
        # urllib would happily fetch file:// or 169.254.169.254 (AWS IMDS).
        # Rejected/failed URL fetches render a red 'X' placeholder rather
        # than crashing the whole render.
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
            url = content["url"]
            if not _custom_svg_url_is_safe(url):
                placeholder_reason = (
                    f"url rejected by allowlist (must be https + on "
                    f"flexmedia.sydney/flexstudios.app/cdn.flexmedia.sydney/"
                    f"*.dropboxusercontent.com): {url[:120]}"
                )
            else:
                try:
                    import urllib.request
                    req = urllib.request.Request(
                        url,
                        headers={"User-Agent": "flexstudios-drone-render/1.0"},
                    )
                    with urllib.request.urlopen(req, timeout=8) as r:
                        svg_bytes = r.read()
                except Exception as e:
                    placeholder_reason = f"url fetch failed ({e})"
        else:
            placeholder_reason = "no svg source provided"

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
        line_top_y = y - 260
        color = fill
        cv2.line(canvas_bgr, (x, y), (x, line_top_y + 40), color, 3, cv2.LINE_AA)
        cv2.circle(canvas_bgr, (x, y), 8, color, -1, cv2.LINE_AA)
        box_size = 80
        bx1 = x - box_size // 2
        bx2 = x + box_size // 2
        by1 = line_top_y - box_size // 2
        by2 = line_top_y + box_size // 2
        cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), fill, -1, cv2.LINE_AA)
        if sw > 0:
            cv2.rectangle(canvas_bgr, (bx1, by1), (bx2, by2), stroke, sw, cv2.LINE_AA)
        icon_color = _hex_to_bgr(content.get("icon_color", "#000000"))
        icr = 24
        cy_ic = (by1 + by2) // 2
        roof = np.array(
            [
                (x - icr - 2, cy_ic - icr // 3 + 2),
                (x + icr + 2, cy_ic - icr // 3 + 2),
                (x, cy_ic - icr),
            ],
            dtype=np.int32,
        )
        cv2.fillConvexPoly(canvas_bgr, roof, icon_color, cv2.LINE_AA)
        cv2.rectangle(
            canvas_bgr,
            (x - icr + 2, cy_ic - icr // 3 + 2),
            (x + icr - 2, cy_ic + icr - 2),
            icon_color,
            -1,
            cv2.LINE_AA,
        )
        dw = 8
        cv2.rectangle(canvas_bgr, (x - dw, cy_ic + 2), (x + dw, cy_ic + icr - 2), fill, -1)

    return canvas_bgr


# ─────────────────────────────────────────────────────────────────────────────
# Boundary layer pass
# ─────────────────────────────────────────────────────────────────────────────
def _project_polygon(polygon_latlon, scene, w, h, intrinsics=None) -> Optional[np.ndarray]:
    """Project a list of [lat, lon] tuples to pixel coords. Returns Nx2 int32 or None."""
    pts = []
    for lat, lon in polygon_latlon:
        px = _gps_to_px(
            lat, lon, scene["lat"], scene["lon"], scene["alt"],
            scene["yaw"], scene["pitch"], w, h,
            intrinsics=intrinsics,
        )
        if px is None:
            return None
        pts.append(px)
    return np.array(pts, dtype=np.int32)


def _apply_exterior_treatment(canvas_bgr: np.ndarray, polygon_px: np.ndarray, treatment: dict) -> np.ndarray:
    """Blur/darken/desaturate/hue-shift everything OUTSIDE the polygon."""
    h, w = canvas_bgr.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [polygon_px], 255)
    inv_mask = cv2.bitwise_not(mask)

    treated = canvas_bgr.copy()

    blur_strength = int(treatment.get("blur_strength_px", 0))
    if treatment.get("blur_enabled", False) and blur_strength > 0:
        k = blur_strength | 1  # must be odd
        treated = cv2.GaussianBlur(treated, (k, k), 0)

    darken = float(treatment.get("darken_factor", 1.0))
    sat = float(treatment.get("saturation_factor", 1.0))
    light = float(treatment.get("lightness_factor", 1.0))
    hue_shift = int(treatment.get("hue_shift_degrees", 0))

    if darken != 1.0 or sat != 1.0 or light != 1.0 or hue_shift != 0:
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
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, polygon_latlon, cfg: dict, w: int, h: int
) -> np.ndarray:
    """Label each polygon edge with its geodesic length."""
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
    for i in range(n):
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

        bbox = font.getbbox(label)
        tw_px = bbox[2] - bbox[0]
        th_px = bbox[3] - bbox[1]
        # Center text on (tx, ty)
        anchor_x = tx - tw_px // 2 - bbox[0]
        anchor_y = ty - th_px // 2 - bbox[1]

        # Outline: render text in outline color shifted N/E/S/W and corners
        if outline_w > 0:
            for dx in range(-outline_w, outline_w + 1):
                for dy in range(-outline_w, outline_w + 1):
                    if dx == 0 and dy == 0:
                        continue
                    draw.text(
                        (anchor_x + dx, anchor_y + dy),
                        label,
                        font=font,
                        fill=outline_rgb + (255,),
                    )
        draw.text((anchor_x, anchor_y), label, font=font, fill=text_rgb + (255,))

    return _composite_overlay_onto_bgr(canvas_bgr, overlay)


def _draw_sqm_total(
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, polygon_latlon, cfg: dict, w: int, h: int
) -> np.ndarray:
    """Overlay total area (sqm) — uses geodesic shoelace approx via local ENU projection."""
    if not cfg.get("enabled", False):
        return canvas_bgr

    # Compute area via local equirectangular ENU on the polygon centroid
    lat0 = sum(ll[0] for ll in polygon_latlon) / len(polygon_latlon)
    lon0 = sum(ll[1] for ll in polygon_latlon) / len(polygon_latlon)
    cos_lat0 = math.cos(math.radians(lat0))
    enu = [
        ((lon - lon0) * 111319 * cos_lat0, (lat - lat0) * 111319)
        for lat, lon in polygon_latlon
    ]
    n = len(enu)
    s = 0.0
    for i in range(n):
        x1, y1 = enu[i]
        x2, y2 = enu[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    area_sqm = abs(s) / 2.0
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
    canvas_bgr: np.ndarray, polygon_px: np.ndarray, cfg: dict, scene: dict, w: int, h: int
) -> np.ndarray:
    """Overlay an address line near/inside the boundary."""
    if not cfg.get("enabled", False):
        return canvas_bgr

    template = cfg.get("text_template", "{address}")
    address = scene.get("address", "")
    text = template.replace("{address}", address).replace(
        "{street_number}", scene.get("street_number", "")
    ).replace("{street_name}", scene.get("street_name", ""))

    if not text.strip():
        return canvas_bgr

    fs = int(cfg.get("font_size_px", 36))
    font = _get_font(_resolve_font_family(cfg.get("font_family"), bold=True), fs)
    text_rgb = _hex_to_rgb(cfg.get("text_color", "#FFFFFF")) or (255, 255, 255)
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
    """Apply the boundary pass per theme.boundary block + scene.polygon_latlon."""
    boundary_cfg = theme.get("boundary", {})
    if not boundary_cfg.get("enabled", False):
        return canvas_bgr

    polygon_latlon = scene.get("polygon_latlon")
    if not polygon_latlon or len(polygon_latlon) < 3:
        return canvas_bgr  # nothing to draw

    polygon_px = _project_polygon(polygon_latlon, scene, w, h, intrinsics=intrinsics)
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

    # 3. Side measurements
    sm_cfg = boundary_cfg.get("side_measurements", {})
    if sm_cfg:
        canvas_bgr = _draw_side_measurements(canvas_bgr, polygon_px, polygon_latlon, sm_cfg, w, h)

    # 4. SQM total
    sqm_cfg = boundary_cfg.get("sqm_total", {})
    if sqm_cfg:
        canvas_bgr = _draw_sqm_total(canvas_bgr, polygon_px, polygon_latlon, sqm_cfg, w, h)

    # 5. Address overlay
    addr_cfg = boundary_cfg.get("address_overlay", {})
    if addr_cfg:
        canvas_bgr = _draw_address_overlay(canvas_bgr, polygon_px, addr_cfg, scene, w, h)

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


def render(image_bytes: bytes, theme_config: dict, scene: dict) -> bytes:
    """
    Render an annotated drone image with the given theme + scene.

    Args:
        image_bytes:  raw bytes of the drone JPG/PNG
        theme_config: theme dict (validated against the v1 schema)
        scene: {
            "lat": float,           # drone shot latitude
            "lon": float,           # drone shot longitude
            "alt": float,           # drone altitude AGL
            "yaw": float,           # flight yaw (heading) degrees
            "pitch": float,         # gimbal pitch degrees (negative = down)
            "property_lat": float,  # target property latitude
            "property_lon": float,  # target property longitude
            "pois": [               # optional list of POIs
                {"name": str, "lat": float, "lon": float, "distance_m": float, "type": str}
            ],
            "polygon_latlon":       # optional list of [lat, lon] tuples for boundary
                [[lat,lon], ...],
            "address": str,         # optional, used by boundary.address_overlay
            "street_number": str,   # optional
            "street_name": str,     # optional
            "camera_intrinsics": {  # optional — when present, used in place of the
                "width": int,       # M3P defaults so non-M3P drones project correctly.
                "height": int,      # Should be threaded through by the drone-render
                "fx_mm": float,     # Edge Function from drone_shots.exif (#18).
                "fy_mm": float,         # optional, defaults to fx_mm
                "sensor_w_mm": float,   # optional, defaults to 17.3 (M3P)
                "sensor_h_mm": float,   # optional, defaults to 13.0 (M3P)
                "cx_px": float,         # optional principal point x (default w/2)
                "cy_px": float,         # optional principal point y (default h/2)
            },
        }

    Returns:
        Rendered image bytes (JPEG, quality 92).
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

    for poi in pois[:6]:
        px = _gps_to_px(
            poi["lat"], poi["lon"],
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
            d = poi["distance_m"]
            secondary = f"{d/1000:.1f}km" if d > 999 else f"{d:.0f}m"
        canvas = _draw_poi_label(canvas, x, y, poi["name"], label_style, anchor_style, secondary, w, h)

    # ───── Property pin ─────
    if "property_lat" in scene and "property_lon" in scene:
        pp = _gps_to_px(
            scene["property_lat"], scene["property_lon"],
            scene["lat"], scene["lon"], scene["alt"],
            scene["yaw"], scene["pitch"], w, h,
            intrinsics=intrinsics,
        )
        if pp and 0 < pp[0] < w and 0 < pp[1] < h:
            canvas = _draw_property_pin(canvas, int(pp[0]), int(pp[1]), theme_config.get("property_pin", {}), w, h)

    # ───── Encode JPEG ─────
    ok, buf = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise RuntimeError("Failed to encode JPEG")
    return bytes(buf)
