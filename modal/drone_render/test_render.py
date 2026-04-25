"""
Sanity test: render the 6 seed themes on the Silver St 0821 fixture.

Validates:
    1. All themes load and validate against the schema.
    2. render() produces valid JPEG bytes.
    3. No `???` characters in the output (visual check via OCR not feasible
       offline — we instead verify fonts loaded successfully and bbox returns
       a reasonable size for em-dash characters).
    4. Optional: pixel-diff against ~/flexmedia-drone-spike/proofs/theme_*.jpg
       baselines if SPIKE_PROOFS env var is set.

Run: python modal/drone_render/test_render.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

# Allow running this file directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from modal.drone_render import render, load_theme, list_seed_themes
from modal.drone_render.render_engine import (
    FONT_BOLD_PATH, _get_font, _measure_text,
)


# Silver St fixture — same scene used in spike's theme_swatches.py.
# Primary path: full-res Dropbox file. Fallback: downscaled archive copy
# in the spike repo (used when sandbox blocks Dropbox CloudStorage).
FIXTURE_IMAGE = Path(
    "/Users/josephsaad/Library/CloudStorage/Dropbox-FlexMedia/"
    "Flex Media Team Folder/Flex Media - Working Folder/"
    "6:3 Silver St, Randwick/raw drones/Final Shortlist/DJI_20260423114953_0821_D.JPG"
)
FIXTURE_FALLBACK = Path(
    "/Users/josephsaad/flexmedia-drone-spike/archive/silver_baseline_0821.jpg"
)
SCENE_BASE = {
    "lat": -33.9125106666667,
    "lon": 151.236814361111,
    "alt": 90.1,
    "yaw": 126.9,
    "pitch": -9.6,
    "property_lat": -33.91324572389612,
    "property_lon": 151.2381473030376,
    "address": "6/3 Silver St, Randwick",
    "street_number": "6/3",
    "street_name": "Silver St",
}
POIS_PATH = Path("/Users/josephsaad/flexmedia-drone-spike/reference_data/pois_silver.json")

SPIKE_PROOFS_DIR = Path("/Users/josephsaad/flexmedia-drone-spike/proofs")
OUTPUT_DIR = Path(__file__).resolve().parent / "_test_output"

# Map seed theme name -> spike proof filename for pixel-diff comparison
SPIKE_PROOF_MAP = {
    "flexmedia_default": "theme_flexmedia_default.jpg",
    "minimalist_black": "theme_minimalist_black.jpg",
    "belle_property_style": "theme_belle_property.jpg",
    "classic_red_bar": "theme_classic_red_bar.jpg",
    "purple_minimal": "theme_purple_minimal.jpg",
    "yellow_house_style": "theme_yellow_house.jpg",
}


def _load_pois():
    with open(POIS_PATH) as f:
        all_pois = json.load(f)
    pick = ["Coogee Beach", "Royal Randwick Shopping Centre", "Sydney Children's Hospital"]
    out = []
    for name in pick:
        for p in all_pois:
            if p["name"] == name:
                out.append(p)
                break
    # Add Randwick train station explicitly
    for p in all_pois:
        if p["name"] == "Randwick" and p.get("type") == "train":
            out.append(p)
            break
    return out


def _font_renders_special_chars() -> bool:
    """Verify the bundled font can render em-dash and middle-dot."""
    f = _get_font(FONT_BOLD_PATH, 36)
    em_dash_w, _ = _measure_text("—", f)
    mid_dot_w, _ = _measure_text("·", f)
    # Both glyphs should produce a bbox > 0 if the font has them.
    return em_dash_w > 0 and mid_dot_w > 0


def _pixel_diff(a_path: Path, b_path: Path) -> tuple[float, int]:
    """Return (mean_abs_diff, pixel_count) between two JPEGs. Resizes smaller to larger."""
    a = cv2.imread(str(a_path))
    b = cv2.imread(str(b_path))
    if a is None or b is None:
        return float("nan"), 0
    if a.shape != b.shape:
        # Resize b to a's dims (spike proofs may have a banner appended; we crop)
        h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
        a = a[:h, :w]
        b = b[:h, :w]
    diff = cv2.absdiff(a, b).astype(np.float32)
    return float(diff.mean()), int(a.shape[0] * a.shape[1])


def main() -> int:
    fixture = FIXTURE_IMAGE
    try:
        # Trigger PermissionError early if Dropbox is sandboxed
        with open(fixture, "rb"):
            pass
    except (PermissionError, OSError):
        if FIXTURE_FALLBACK.exists():
            fixture = FIXTURE_FALLBACK
            print(f"Falling back to: {fixture.name} (Dropbox sandboxed)")
        else:
            print(f"  ERROR: fixture not found and no fallback")
            return 2

    print(f"Test fixture: {fixture.name}")
    if not fixture.exists():
        print(f"  ERROR: fixture not found at {fixture}")
        return 2

    if not _font_renders_special_chars():
        print("  ERROR: bundled font does not render em-dash/middle-dot")
        return 3
    print("  Font check: em-dash + middle-dot render correctly")

    pois = _load_pois()
    print(f"  Loaded {len(pois)} POIs")

    image_bytes = fixture.read_bytes()
    OUTPUT_DIR.mkdir(exist_ok=True)

    seeds = list_seed_themes()
    print(f"  Found {len(seeds)} seed themes: {seeds}")
    if len(seeds) != 6:
        print(f"  ERROR: expected 6 seed themes, found {len(seeds)}")
        return 4

    summary = []
    for seed in seeds:
        theme = load_theme(seed)
        scene = dict(SCENE_BASE)
        scene["pois"] = pois
        try:
            out_bytes = render(image_bytes, theme, scene)
        except Exception as e:
            summary.append((seed, False, f"render error: {e}", None, None))
            continue

        out_path = OUTPUT_DIR / f"theme_{seed}.jpg"
        out_path.write_bytes(out_bytes)

        # Verify it's a valid JPEG
        ok = out_bytes[:2] == b"\xff\xd8"
        size_kb = len(out_bytes) // 1024

        diff_mean = None
        spike_match = False
        spike_proof = SPIKE_PROOF_MAP.get(seed)
        if spike_proof and (SPIKE_PROOFS_DIR / spike_proof).exists():
            diff_mean, _ = _pixel_diff(out_path, SPIKE_PROOFS_DIR / spike_proof)
            # Spike proofs have a 110px banner on top; not pixel-perfect comparable.
            # We check that diff is within a wide tolerance (mean < 60 = visually similar).
            spike_match = diff_mean < 60

        summary.append((seed, ok, f"{size_kb} KB", diff_mean, spike_match))

    # Print summary
    print()
    print("=" * 80)
    print(f"{'Theme':<25} {'OK':<4} {'Size':<10} {'PixelDiff':<12} {'Match'}")
    print("-" * 80)
    all_ok = True
    for seed, ok, info, diff, spike_match in summary:
        diff_str = f"{diff:.1f}" if diff is not None else "n/a"
        match_str = "yes" if spike_match else ("close" if (diff is not None and diff < 100) else "no")
        marker = "OK" if ok else "FAIL"
        print(f"{seed:<25} {marker:<4} {info:<10} {diff_str:<12} {match_str}")
        if not ok:
            all_ok = False

    print("=" * 80)
    print(f"Outputs saved to: {OUTPUT_DIR}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
