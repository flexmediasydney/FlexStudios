"""Aukerman regression test for the SfM worker.

Two ways to run this:

1. As a Modal local-entrypoint (preferred — runs the actual deployed worker):
       modal run modal/drone_sfm/sfm_worker.py::test_aukerman

2. As a plain Python script (calls the same entrypoint via Modal's Python SDK):
       python modal/drone_sfm/test_aukerman.py

Both paths assert on the spike-baseline thresholds:
  - ≥95% of submitted images registered
  - median GPS residual <1.5m
  - max GPS residual <5m
"""
from __future__ import annotations

import base64
import sys
import time
from pathlib import Path

DEFAULT_FIXTURE = Path(
    "/Users/josephsaad/flexmedia-drone-spike/"
    "odm_datasets/odm_data_aukerman-master/images"
)


def main(
    fixture_dir: Path = DEFAULT_FIXTURE,
    every_nth: int = 2,
    max_median_m: float = 1.5,
    max_max_m: float = 5.0,
    min_reg_ratio: float = 0.95,
) -> int:
    if not fixture_dir.exists():
        print(f"FAIL: fixture not found: {fixture_dir}", file=sys.stderr)
        return 1

    paths = sorted(fixture_dir.glob("*.JPG"))[::every_nth]
    if not paths:
        print(f"FAIL: no JPGs under {fixture_dir}", file=sys.stderr)
        return 1

    # Lazy-import so this file is also runnable as a local entrypoint module.
    from sfm_worker import app, run_sfm_for_shoot

    payload = [
        {"name": p.name, "bytes_b64": base64.b64encode(p.read_bytes()).decode("ascii")}
        for p in paths
    ]

    print(f"submitting {len(payload)} images …")
    t0 = time.time()
    with app.run():
        result = run_sfm_for_shoot.remote(payload)
    elapsed = time.time() - t0

    n_in = result["n_fetched_images"]
    n_reg = result["n_registered_images"]
    ratio = n_reg / max(n_in, 1)
    r = result["alignment_residuals_m"]

    print(f"roundtrip:   {elapsed:.1f}s")
    print(f"registered:  {n_reg}/{n_in}  ({ratio:.1%})")
    print(f"3D points:   {result['n_points3d']}")
    print(f"residuals:   mean={r['mean_m']:.2f}m  median={r['median_m']:.2f}m  max={r['max_m']:.2f}m  (n={r['count']})")

    failures = []
    if ratio < min_reg_ratio:
        failures.append(f"registration {ratio:.1%} < {min_reg_ratio:.0%}")
    if r["median_m"] > max_median_m:
        failures.append(f"median {r['median_m']:.2f}m > {max_median_m}m")
    if r["max_m"] > max_max_m:
        failures.append(f"max {r['max_m']:.2f}m > {max_max_m}m")
    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1

    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
