"""
FlexStudios drone render engine.

Productionised version of the spike POC at ~/flexmedia-drone-spike/production_ready/
theme_engine.py — config-driven theme rendering with bundled fonts (DejaVu),
anchor-flip logic, and boundary layer support.

Public API:
    render(image_bytes, theme_config, scene) -> bytes
    load_theme(theme_path) -> dict
    list_seed_themes() -> list[str]
"""

from .render_engine import (
    render,
    load_theme,
    list_seed_themes,
    SCHEMA_VERSION,
)

__all__ = ["render", "load_theme", "list_seed_themes", "SCHEMA_VERSION"]
