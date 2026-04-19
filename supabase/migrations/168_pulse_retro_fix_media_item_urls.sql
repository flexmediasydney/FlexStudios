-- 168_pulse_retro_fix_media_item_urls.sql
-- Retro-fix the 1,075 enriched listings whose media_items[].url fields were
-- stored as BARE REA CDN URLs (which 302-redirect to placeholder.png).
--
-- Adds the "800x600-fit,format=webp/" size/format prefix into the first path
-- segment for every photo/floorplan/thumb URL that lacks one, so the browser
-- gets a real WebP instead of a grey placeholder. Videos (YouTube etc.) are
-- left alone. Idempotent — skips URLs that already have a prefix.
--
-- The forward fix (pulseDetailEnrich rewrites at write time) is in the
-- corresponding TS edge-function commit. This migration patches the
-- already-written rows.
--
-- Example rewrite:
--   before: https://i3.au.reastatic.net/HASH/image.jpg
--   after:  https://i3.au.reastatic.net/800x600-fit,format=webp/HASH/image.jpg

BEGIN;

-- Helper: rewrite a single URL string to the display variant if applicable.
CREATE OR REPLACE FUNCTION pulse_rewrite_rea_display_url(p_url text, p_variant text DEFAULT '800x600-fit,format=webp')
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_parts text[];
  v_first text;
BEGIN
  IF p_url IS NULL OR position('reastatic.net' IN p_url) = 0 THEN
    RETURN p_url;
  END IF;

  -- Strip scheme + host to isolate the path
  -- e.g. 'https://i3.au.reastatic.net/HASH/image.jpg' → path = '/HASH/image.jpg'
  IF p_url !~ '^https?://[^/]+/' THEN
    RETURN p_url;  -- malformed
  END IF;

  DECLARE
    v_scheme_host text := substring(p_url FROM '^https?://[^/]+');
    v_path        text := substring(p_url FROM length(v_scheme_host) + 1);
    v_path_nolead text := ltrim(v_path, '/');
  BEGIN
    IF v_path_nolead = '' THEN
      RETURN p_url;
    END IF;

    v_parts := string_to_array(v_path_nolead, '/');
    v_first := v_parts[1];

    -- Already has a prefix if the first segment contains a comma, starts with
    -- NxN (dimensions), or "format=".
    IF v_first LIKE '%,%' OR v_first ~ '^\d+x\d+' OR v_first LIKE 'format=%' THEN
      RETURN p_url;
    END IF;

    RETURN v_scheme_host || '/' || p_variant || '/' || v_path_nolead;
  END;
END;
$$;

-- Helper: rewrite every {url, thumb} in a media_items jsonb array
CREATE OR REPLACE FUNCTION pulse_rewrite_media_items_urls(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_type text;
  v_url text;
  v_thumb text;
  v_new jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN p_items;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS value LOOP
    v_type := v_item->>'type';
    v_url := v_item->>'url';
    v_thumb := v_item->>'thumb';

    -- Videos keep their YouTube URL as-is; only rewrite the thumb
    IF v_type = 'video' THEN
      v_new := jsonb_set(v_item, '{thumb}', to_jsonb(pulse_rewrite_rea_display_url(v_thumb, '160x120-fit,format=webp')));
    ELSE
      v_new := jsonb_set(v_item, '{url}', to_jsonb(pulse_rewrite_rea_display_url(v_url)));
      IF v_thumb IS NOT NULL THEN
        v_new := jsonb_set(v_new, '{thumb}', to_jsonb(pulse_rewrite_rea_display_url(v_thumb, '160x120-fit,format=webp')));
      END IF;
    END IF;

    v_out := v_out || v_new;
  END LOOP;

  RETURN v_out;
END;
$$;

-- ── Inline self-test ──────────────────────────────────────────────────────
DO $$
BEGIN
  -- Bare URL gets prefix
  ASSERT pulse_rewrite_rea_display_url('https://i3.au.reastatic.net/ABC/image.jpg')
       = 'https://i3.au.reastatic.net/800x600-fit,format=webp/ABC/image.jpg', 'bare rewrite';
  -- Already-prefixed URL unchanged
  ASSERT pulse_rewrite_rea_display_url('https://i3.au.reastatic.net/800x600-fit,format=webp/ABC/image.jpg')
       = 'https://i3.au.reastatic.net/800x600-fit,format=webp/ABC/image.jpg', 'idempotent';
  -- Non-REA URL untouched
  ASSERT pulse_rewrite_rea_display_url('https://www.youtube.com/watch?v=XYZ')
       = 'https://www.youtube.com/watch?v=XYZ', 'non-rea passthrough';
  -- NULL untouched
  ASSERT pulse_rewrite_rea_display_url(NULL) IS NULL, 'null passthrough';
  -- Custom variant
  ASSERT pulse_rewrite_rea_display_url('https://i3.au.reastatic.net/ABC/image.jpg', '160x120-fit,format=webp')
       = 'https://i3.au.reastatic.net/160x120-fit,format=webp/ABC/image.jpg', 'custom variant';
  RAISE NOTICE 'pulse_rewrite_rea_display_url self-tests passed';
END $$;

-- ── Retro-fix ─────────────────────────────────────────────────────────────
-- Only touch rows where media_items has content AND at least one url is bare.
-- Safe to re-run — idempotent via the rewrite helper.

WITH target AS (
  SELECT id, media_items FROM pulse_listings
  WHERE media_items IS NOT NULL
    AND jsonb_typeof(media_items) = 'array'
    AND jsonb_array_length(media_items) > 0
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(media_items) AS it
      WHERE (it->>'url') ~ '^https?://[^/]*reastatic\.net/[A-Fa-f0-9]{32,}'
        AND (it->>'url') !~ '/[^/]*,[^/]*/[A-Fa-f0-9]{32,}'
    )
)
UPDATE pulse_listings l
SET media_items = pulse_rewrite_media_items_urls(l.media_items)
FROM target
WHERE l.id = target.id;

-- Also retro-fix the `images` jsonb array if any entries are bare URLs.
-- Legacy scrape path stored prefixed URLs but a few rows have bare entries.
WITH target_imgs AS (
  SELECT id FROM pulse_listings
  WHERE images IS NOT NULL
    AND jsonb_typeof(images) = 'array'
    AND jsonb_array_length(images) > 0
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(images) AS img
      WHERE (
        (jsonb_typeof(img) = 'string' AND (img #>> '{}') ~ '^https?://[^/]*reastatic\.net/[A-Fa-f0-9]{32,}' AND (img #>> '{}') !~ '/[^/]*,[^/]*/')
        OR
        (jsonb_typeof(img) = 'object' AND (img->>'url') ~ '^https?://[^/]*reastatic\.net/[A-Fa-f0-9]{32,}' AND (img->>'url') !~ '/[^/]*,[^/]*/')
      )
    )
)
UPDATE pulse_listings l
SET images = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(img) = 'string' THEN to_jsonb(pulse_rewrite_rea_display_url(img #>> '{}'))
      WHEN jsonb_typeof(img) = 'object' AND img ? 'url' THEN jsonb_set(img, '{url}', to_jsonb(pulse_rewrite_rea_display_url(img->>'url')))
      ELSE img
    END
  )
  FROM jsonb_array_elements(l.images) AS img
)
FROM target_imgs
WHERE l.id = target_imgs.id;

-- Also retro-fix `floorplan_urls` (text[]) and `hero_image` + `video_thumb_url`
-- if any of those are bare. hero_image is usually prefixed (from
-- pulseRegionalListings) but covering edge cases.
UPDATE pulse_listings
SET hero_image = pulse_rewrite_rea_display_url(hero_image)
WHERE hero_image IS NOT NULL
  AND hero_image LIKE '%reastatic.net%'
  AND hero_image !~ '/[^/]*,[^/]*/';

UPDATE pulse_listings
SET video_thumb_url = pulse_rewrite_rea_display_url(video_thumb_url, '160x120-fit,format=webp')
WHERE video_thumb_url IS NOT NULL
  AND video_thumb_url LIKE '%reastatic.net%'
  AND video_thumb_url !~ '/[^/]*,[^/]*/';

UPDATE pulse_listings
SET floorplan_urls = ARRAY(
  SELECT pulse_rewrite_rea_display_url(elem) FROM unnest(floorplan_urls) AS elem
)
WHERE floorplan_urls IS NOT NULL
  AND array_length(floorplan_urls, 1) > 0
  AND EXISTS (
    SELECT 1 FROM unnest(floorplan_urls) AS elem
    WHERE elem LIKE '%reastatic.net%' AND elem !~ '/[^/]*,[^/]*/'
  );

COMMIT;
