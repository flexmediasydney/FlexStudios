-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 391 — Wave 11.6.16: iter-5 enrichment persistence columns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-6-16-iter5-persistence.md
--
-- Background — why this migration exists:
--   Stage 1 (`shortlisting-shape-d`) prompts Gemini for 36 fields per image
--   (defined in `_shared/visionPrompts/blocks/stage1ResponseSchema.ts`).
--   Gemini emits all 36 fields. Production persist (`persistOneClassification`)
--   was only writing the 20 base fields — every iter-5 enrichment value was
--   discarded silently. This migration adds the 17 missing columns so the
--   persist layer can store what it has been paying for since iter-5 shipped.
--
--   The fields here mirror the `iter-5 enrichments` block of the Stage 1
--   schema — see line 119 onward in stage1ResponseSchema.ts. Names match the
--   schema exactly (snake_case) except for `listing_copy.headline` and
--   `listing_copy.paragraphs`, which are flattened to `listing_copy_headline`
--   and `listing_copy_paragraphs` — Postgres column-name idioms favour flat
--   over nested JSONB when the sub-shape is fixed and small.
--
-- Index strategy:
--   - Single-column btree on style_archetype + shot_intent: filterable in the
--     swimlane toolbar dropdown (W11.6.16 part B), so a partial index on
--     "not null" keeps the index tight.
--   - Partial btree on requires_human_review (round_id) where TRUE: the
--     swimlane "Needs your eye" badge query filters per-round per-flag, very
--     selective when only a few cards trip the flag.
--   - GIN on appeal_signals / concern_signals / searchable_keywords: array
--     containment + overlap queries powering the toolbar's chip filters
--     ("any of these signals") and the search input's keyword ILIKE.
--
-- Rollback (manual; only if defects surface in production):
--   ALTER TABLE composition_classifications
--     DROP COLUMN style_archetype,
--     DROP COLUMN era_hint,
--     DROP COLUMN material_palette_summary,
--     DROP COLUMN embedding_anchor_text,
--     DROP COLUMN searchable_keywords,
--     DROP COLUMN shot_intent,
--     DROP COLUMN appeal_signals,
--     DROP COLUMN concern_signals,
--     DROP COLUMN buyer_persona_hints,
--     DROP COLUMN retouch_priority,
--     DROP COLUMN retouch_estimate_minutes,
--     DROP COLUMN gallery_position_hint,
--     DROP COLUMN social_first_friendly,
--     DROP COLUMN requires_human_review,
--     DROP COLUMN confidence_per_field,
--     DROP COLUMN listing_copy_headline,
--     DROP COLUMN listing_copy_paragraphs;
--   (DROP INDEX statements implicit via column drop.)
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS style_archetype TEXT,
  ADD COLUMN IF NOT EXISTS era_hint TEXT,
  ADD COLUMN IF NOT EXISTS material_palette_summary TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS embedding_anchor_text TEXT,
  ADD COLUMN IF NOT EXISTS searchable_keywords TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS shot_intent TEXT,
  ADD COLUMN IF NOT EXISTS appeal_signals TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS concern_signals TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS buyer_persona_hints TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS retouch_priority TEXT,
  ADD COLUMN IF NOT EXISTS retouch_estimate_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS gallery_position_hint TEXT,
  ADD COLUMN IF NOT EXISTS social_first_friendly BOOLEAN,
  ADD COLUMN IF NOT EXISTS requires_human_review BOOLEAN,
  ADD COLUMN IF NOT EXISTS confidence_per_field JSONB,
  ADD COLUMN IF NOT EXISTS listing_copy_headline TEXT,
  ADD COLUMN IF NOT EXISTS listing_copy_paragraphs TEXT;

COMMENT ON COLUMN composition_classifications.style_archetype IS
  'Wave 11.6.16: architectural typology label, anchored against the Sydney '
  'primer in the Stage 1 system prompt. Examples: "Federation cottage", '
  '"1980s brick veneer ranch", "post-war fibro pavilion", "1960s Sydney School '
  'pavilion", "contemporary project home". When the building period or style '
  'is unclear, "uncertain provenance".';

COMMENT ON COLUMN composition_classifications.era_hint IS
  'Wave 11.6.16: likely construction era or refurbishment hint emitted by '
  'Stage 1 (e.g. "circa 1955-1965", "post-war", "1980s with 2021 renovation").';

COMMENT ON COLUMN composition_classifications.material_palette_summary IS
  'Wave 11.6.16: top 3 materials by visual weight in this frame, as specific '
  'phrases ("face brick", "Caesarstone benchtop", "spotted gum flooring").';

COMMENT ON COLUMN composition_classifications.embedding_anchor_text IS
  'Wave 11.6.16: ~50-word concise summary optimised for vector embedding '
  '(downstream pgvector similarity search). Powers the swimlane keyword '
  'search ILIKE.';

COMMENT ON COLUMN composition_classifications.searchable_keywords IS
  'Wave 11.6.16: 5-12 single-word/hyphenated keyword tokens for SEO/search. '
  'GIN-indexed for array containment queries from the swimlane filter input.';

COMMENT ON COLUMN composition_classifications.shot_intent IS
  'Wave 11.6.16: photographer''s likely intent for this frame. One of: '
  'hero_establishing | scale_clarification | lifestyle_anchor | material_proof '
  '| indoor_outdoor_connection | detail_specimen | record_only | '
  'reshoot_candidate.';

COMMENT ON COLUMN composition_classifications.appeal_signals IS
  'Wave 11.6.16: marketing-relevant positives visible in this image '
  '(snake_case tokens). Filterable in the swimlane via "any-of" chips.';

COMMENT ON COLUMN composition_classifications.concern_signals IS
  'Wave 11.6.16: marketing-relevant negatives visible in this image '
  '(snake_case tokens). Filterable in the swimlane via "any-of" chips.';

COMMENT ON COLUMN composition_classifications.buyer_persona_hints IS
  'Wave 11.6.16: likely buyer personas this image speaks to (up to 3).';

COMMENT ON COLUMN composition_classifications.retouch_priority IS
  'Wave 11.6.16: editor-time priority. "urgent" = blocks shortlist, '
  '"recommended" = improves but not blocking, "none" = no retouch needed.';

COMMENT ON COLUMN composition_classifications.retouch_estimate_minutes IS
  'Wave 11.6.16: rough editor-time estimate in minutes. 0 when '
  'retouch_priority="none".';

COMMENT ON COLUMN composition_classifications.gallery_position_hint IS
  'Wave 11.6.16: pre-Stage-4 preference for gallery position. "lead_image" | '
  '"early_gallery" | "late_gallery" | "archive_only".';

COMMENT ON COLUMN composition_classifications.social_first_friendly IS
  'Wave 11.6.16: TRUE if the image survives a 1:1 Instagram crop without '
  'losing its hero feature.';

COMMENT ON COLUMN composition_classifications.requires_human_review IS
  'Wave 11.6.16: TRUE when Stage 1 self-flags uncertainty — surfaces a '
  '"Needs your eye" badge on the swimlane card.';

COMMENT ON COLUMN composition_classifications.confidence_per_field IS
  'Wave 11.6.16: 0-1 self-reported confidence per field as JSONB '
  '({room_type, scoring, classification}). Drop below 0.7 = operator should '
  'eyeball.';

COMMENT ON COLUMN composition_classifications.listing_copy_headline IS
  'Wave 11.6.16: per-image listing-copy headline (5-12 words, tier-keyed). '
  'Flattened from the nested listing_copy.headline emitted by Stage 1.';

COMMENT ON COLUMN composition_classifications.listing_copy_paragraphs IS
  'Wave 11.6.16: per-image listing-copy 2-3 paragraph caption block. '
  'Flattened from the nested listing_copy.paragraphs emitted by Stage 1.';

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_classif_style_archetype
  ON composition_classifications (style_archetype)
  WHERE style_archetype IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_shot_intent
  ON composition_classifications (shot_intent)
  WHERE shot_intent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_requires_human_review
  ON composition_classifications (round_id)
  WHERE requires_human_review = TRUE;

CREATE INDEX IF NOT EXISTS idx_classif_appeal_signals_gin
  ON composition_classifications USING gin (appeal_signals);

CREATE INDEX IF NOT EXISTS idx_classif_concern_signals_gin
  ON composition_classifications USING gin (concern_signals);

CREATE INDEX IF NOT EXISTS idx_classif_searchable_keywords_gin
  ON composition_classifications USING gin (searchable_keywords);

NOTIFY pgrst, 'reload schema';
