-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 403 — Wave 15b.3: pulse-video-frames storage bucket
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.3)
--
-- Purpose:
--   Private storage bucket for per-frame JPEGs extracted from Pulse listing
--   videos by the Modal `pulse-video-frame-extractor` worker. The Modal worker
--   writes one JPEG per frame at key `<listing_id>/<idx>.jpg` and emits a
--   short-lived (1 hour) signed URL for each one so the W15b.1 vision pipeline
--   can read it. The signed URL is the only way to access these objects;
--   there is no anonymous read path.
--
-- Why a NEW bucket (not pulse-listings)?
--   * Different lifecycle: video frames are ephemeral by design (we only need
--     them long enough for vision analysis to complete). A future janitor can
--     delete objects older than N days without touching the listing-image
--     bucket.
--   * Different access pattern: signed-URL only (1h TTL).
--   * Cost provenance: storage usage attributable to W15b.3 specifically.
--
-- RLS:
--   * Storage buckets enforce access via storage.objects RLS, not at the
--     bucket level. Default behaviour for `public=false`: anonymous + auth
--     users can't read; service-role bypasses RLS to write + sign.
--   * Signed URLs created with `client.storage.from(bucket).createSignedUrl`
--     bypass RLS for the lifetime of the signature, which is the only way
--     vision API calls (which arrive without a Supabase JWT) can fetch the
--     frame JPEGs.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('pulse-video-frames', 'pulse-video-frames', false)
ON CONFLICT (id) DO NOTHING;
