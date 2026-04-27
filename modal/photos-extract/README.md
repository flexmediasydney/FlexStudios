# photos-extract — FlexStudios Pass 0 Modal worker

Extracts EXIF + embedded preview JPEGs from Canon CR3 files for the
FlexStudios shortlisting engine. Called by the Supabase Edge Function
`shortlisting-extract` on every Pass 0 round.

## What it does

For each CR3 file:

1. Downloads the file from Dropbox (uses Modal-side `dropbox_access_token` secret).
2. Runs `exiftool` to extract:
   - `AEBBracketValue`, `DateTimeOriginal`, `SubSecTimeOriginal`,
     `ShutterSpeedValue`, `ApertureValue`, `ISO`, `FocalLength`, `Orientation`, `Model`.
3. Runs `exiftool -b -PreviewImage` to extract the embedded 1620×1080 preview JPEG.
4. Resizes the preview to 1024 px wide (PIL, JPEG quality=85).
5. Computes mean luminance via PIL (used by the Pass 0 best-bracket selector — target 118/255).
6. Uploads the resized preview to
   `<dropbox_root_path>/Photos/Raws/Shortlist Proposed/Previews/<stem>.jpg`.

Files are processed concurrently (default 8-way thread pool). A 100-file batch
typically completes in 90–120 seconds wall clock.

## Deploy

```sh
~/Library/Python/3.9/bin/modal deploy modal/photos-extract/main.py
```

(Or whatever Python `modal` CLI you have installed — `pipx install modal`
works too.)

After deploy, Modal prints the URL for the `extract_http` endpoint, e.g.:

```
https://joseph-89037--flexstudios-photos-extract-extract-http.modal.run
```

## Modal secrets required

The function expects two named Modal secrets. Create them once via the Modal
dashboard or CLI:

| Name                        | Variables                                                     | Notes                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `dropbox_access_token`      | `DROPBOX_ACCESS_TOKEN`, optional `DROPBOX_TEAM_NAMESPACE_ID`  | **Wave 7 P0-3:** kept as a fallback only. The Edge caller now mints a fresh OAuth token on every invocation via the refresh-token flow and sends it in the request body as `dropbox_access_token`. The static Modal secret is consulted only when the body field is absent (legacy callers / manual curl tests). Will be removed once all callers are confirmed upgraded. |
| `supabase_service_role_key` | `SUPABASE_SERVICE_ROLE_KEY`                                   | Same value as the Supabase env var of the same name. Used for two-way bearer-token auth between the edge function and Modal.          |

## Configure the Edge Function side

After deploy, take the printed URL and set it on the Supabase project as a
secret so `shortlisting-extract` can find it:

```sh
~/.bin/supabase secrets set MODAL_PHOTOS_EXTRACT_URL=https://<workspace>--flexstudios-photos-extract-extract-http.modal.run --project-ref rjzdznwkxnzfekgcdkei
```

(Or use the Supabase dashboard → Edge Functions → Secrets.)

## Sample test invocation

```sh
TOKEN="$SUPABASE_SERVICE_ROLE_KEY"
URL="https://<workspace>--flexstudios-photos-extract-extract-http.modal.run"

curl -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_token": "'"$TOKEN"'",
    "project_id": "<some-uuid>",
    "dropbox_root_path": "/Flex Media Team Folder/Projects/<projectId>_<slug>",
    "dropbox_access_token": "'"$DROPBOX_ACCESS_TOKEN"'",
    "file_paths": [
      "/Flex Media Team Folder/Projects/<projectId>_<slug>/Photos/Raws/Shortlist Proposed/IMG_1234.CR3"
    ]
  }' | jq .
```

Expected response shape (truncated):

```json
{
  "ok": true,
  "project_id": "...",
  "files_total": 1,
  "files_succeeded": 1,
  "files_failed": 0,
  "elapsed_seconds": 4.21,
  "files": {
    "IMG_1234": {
      "ok": true,
      "exif": {
        "fileName": "IMG_1234.CR3",
        "cameraModel": "Canon EOS R6 Mark II",
        "shutterSpeed": "1/100",
        "shutterSpeedValue": 0.01,
        "aperture": 8.0,
        "iso": 100,
        "focalLength": 24,
        "aebBracketValue": -1.333,
        "dateTimeOriginal": "2026:04:21 11:23:45",
        "subSecTimeOriginal": "37",
        "captureTimestampMs": 1745234625370,
        "orientation": 1
      },
      "preview_dropbox_path": "/Flex Media Team Folder/.../Photos/Raws/Shortlist Proposed/Previews/IMG_1234.jpg",
      "preview_size_kb": 65.4,
      "luminance": 118.5
    }
  }
}
```

## Function contract

- **Auth:** `Authorization: Bearer <token>` header AND `_token` body field both
  must equal the `SUPABASE_SERVICE_ROLE_KEY` Modal secret. Mismatch → HTTP 401.
- **Dropbox auth:** caller-supplied `dropbox_access_token` body field is
  preferred (always fresh; minted by the Edge caller via DROPBOX_REFRESH_TOKEN +
  APP_KEY + APP_SECRET). Falls back to the `DROPBOX_ACCESS_TOKEN` env var if
  the body field is empty/missing. The container logs `dropbox token source:
  caller` or `env_fallback` for ops visibility.
- **Per-file failure:** sets `files[stem].ok = false, error: "..."` but the
  top-level `ok` stays `true` so the dispatcher records the partial result and
  doesn't retry the whole batch.
- **Catastrophic failure:** auth fail / Dropbox client init fail / missing
  required body field → top-level `ok: false` with HTTP 4xx/5xx.
- **Timeout:** 15 minutes per call. 100-file batches comfortably finish in
  ~2 minutes; the timeout is a safety net for network blips.
