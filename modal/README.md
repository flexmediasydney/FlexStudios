# Modal workers (FlexStudios drone module)

## drone_sfm

Modal app: `flexstudios-drone-sfm`. Function: `run_sfm_for_shoot`.

CPU-only, 4 vCPU / 4 GB / 900s timeout. Runs in the workspace's default region.

### Deploy

```sh
~/Library/Python/3.9/bin/modal deploy modal/drone_sfm/sfm_worker.py
```

### Test against the Aukerman fixture

```sh
~/Library/Python/3.9/bin/modal run modal/drone_sfm/sfm_worker.py::test_aukerman
```

Asserts: ≥95% registered, median GPS residual <1.5 m, max <5 m.

### Function contract

```python
run_sfm_for_shoot(image_urls, exif_metadata=None, target_width=2000, max_features=8000)
```

`image_urls` is a list of `{"name": str, "url"|"bytes_b64"|"path": str}`.
`exif_metadata` is an optional `{name: {"lat", "lon", "alt"}}` override.

Returns a dict with `n_registered_images`, `n_points3d`,
`alignment_residuals_m` (mean / median / max), `cameras` (per-image WGS84
pose + rotation matrix + per-image residual), and `intrinsics`.

Ortho generation is intentionally not part of this worker — the render
worker (Stream B) consumes the sparse cloud + camera poses.
