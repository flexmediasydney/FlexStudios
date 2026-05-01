# pulse-video-frame-extractor — Pulse W15b.3 Modal worker

Extracts frames from a Pulse listing video (`pulse_listings.video_url`,
typically REA-hosted MP4 in the 30s-90s range) so the W15b.1
`pulse-listing-vision-extract` pipeline can run vision analysis on per-frame
JPEGs. Called by the Supabase Edge Function `pulse-video-frame-extractor`.

## What it does

For each video:

1. Streams the MP4 from `video_url` to `/tmp/<listing_id>.mp4` (rejected if the
   stream exceeds `PULSE_FRAME_MAX_BYTES`, default 200 MB).
2. Probes duration with `ffprobe` (rejected if > `PULSE_FRAME_MAX_DURATION_S`,
   default 600s).
3. Extracts frames in two passes:
   - Fixed-rate sampling at `target_fps` (default 0.2 fps → one frame every 5s)
   - Scene-change boundaries via `ffmpeg -vf select='gt(scene,0.4)'`
4. Merges + de-dups (within ±1s) and caps at 60 frames.
5. Uploads each surviving frame to Supabase Storage bucket `pulse-video-frames`
   at key `<listing_id>/<idx>.jpg`.
6. Returns 1-hour signed URLs + the parallel timestamp arrays so the orchestrator
   can correlate "drone footage at t=30s" → which signed URL to feed vision.

## Deploy

```sh
~/Library/Python/3.9/bin/modal deploy modal/pulse-video-frame-extractor/pulseVideoFrameExtractor.py
```

After deploy, Modal prints the URL for `extract_frames`, e.g.:

```
https://joseph-89037--pulse-video-frame-extractor-extract-frames.modal.run
```

## Modal secrets required

Create one named Modal secret:

| Name                              | Variables                                                         | Notes |
| --------------------------------- | ----------------------------------------------------------------- | ----- |
| `supabase-pulse-frame-extractor`  | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`                       | Same values as the Supabase project. SERVICE_ROLE_KEY also acts as the body `_token` shared secret. |
|                                   | `PULSE_FRAME_MAX_BYTES` (optional, default 209715200 = 200 MB)    | Hard size cap. |
|                                   | `PULSE_FRAME_MAX_DURATION_S` (optional, default 600.0)            | Hard duration cap. |

## Configure the Edge Function side

```sh
~/.bin/supabase secrets set MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL=https://<workspace>--pulse-video-frame-extractor-extract-frames.modal.run \
    --project-ref rjzdznwkxnzfekgcdkei
```

## Sample test invocation

```sh
TOKEN="$SUPABASE_SERVICE_ROLE_KEY"
URL="https://<workspace>--pulse-video-frame-extractor-extract-frames.modal.run"

curl -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_token": "'"$TOKEN"'",
    "listing_id": "00000000-0000-0000-0000-000000000000",
    "video_url": "https://i.realestate.com.au/.../sample.mp4",
    "target_fps": 0.2
  }' | jq .
```

## Function contract

- **Auth:** `body._token` must equal `SUPABASE_SERVICE_ROLE_KEY` Modal secret.
- **Catastrophic failure:** invalid token / oversize / duration exceeded /
  ffprobe fail → top-level `ok: false` with HTTP 4xx/5xx.
- **Per-frame upload failure:** logged + skipped; surviving frames are returned.
- **Timeout:** 300 seconds per call.
