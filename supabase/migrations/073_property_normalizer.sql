-- Migration 073: Property layer foundation (P1-P3)
-- P1: compute_property_key() normalizer
-- P2: properties identity table + generated columns + triggers + backfill
-- P3: property_full_v + properties_health_v views

-- ==========================================================================
-- P1: THE NORMALIZER
-- Single source of truth for address → property_key conversion.
-- Generated columns use this. Triggers use this. Frontend NEVER calls this.
-- Safety rule: returns NULL if no street number / too short / PO Box.
--
-- NOTE: PostgreSQL regexp_replace uses POSIX regex. Word boundary is \y, NOT \b.
-- ==========================================================================

CREATE OR REPLACE FUNCTION compute_property_key(raw_address text) RETURNS text AS $$
DECLARE
  normalized text;
BEGIN
  IF raw_address IS NULL OR length(trim(raw_address)) < 5 THEN
    RETURN NULL;
  END IF;

  normalized := lower(trim(raw_address));

  -- Reject PO Box addresses outright
  IF normalized ~* '\ypo\s*box\y' OR normalized ~* '\ypost\s*office\s*box\y' THEN
    RETURN NULL;
  END IF;

  -- Strip trailing country
  normalized := regexp_replace(normalized, ',?\s*australia\s*$', '', 'gi');

  -- Strip trailing state + postcode (e.g. "NSW 2134")
  normalized := regexp_replace(normalized, ',?\s*(nsw|vic|qld|sa|wa|act|tas|nt)\s+\d{4}\s*$', '', 'gi');
  -- Also handle if state appears without postcode at end
  normalized := regexp_replace(normalized, ',?\s*(nsw|vic|qld|sa|wa|act|tas|nt)\s*$', '', 'gi');

  -- Strip "Lot N," prefix (off-the-plan land lots) BEFORE unit prefixes
  -- (e.g. "Lot 5 / 50 Oxford St" should become "50 Oxford St", not "5/50")
  normalized := regexp_replace(normalized, '^\s*lot\s+\w+\s*[,/]\s*', '', 'gi');

  -- Strip building/level/floor prefixes — loop up to 4 times to handle stacked prefixes
  -- e.g. "Building A, Level 3, Suite 401, 100 Smith St"
  FOR i IN 1..4 LOOP
    normalized := regexp_replace(
      normalized,
      '^\s*(building|bldg|block|level|lvl|floor|fl|tower)\s+\w+\s*,?\s*',
      '',
      'gi'
    );
  END LOOP;

  -- Normalize unit prefixes: "Unit 9, 50 Oxford St" / "Apt 9 / 50 Oxford St" / "Suite 9, 50 ..." → "9/50 oxford st"
  -- Using \y (POSIX word boundary) instead of \b
  normalized := regexp_replace(
    normalized,
    '\y(unit|apt|apartment|suite|ste|u)\s+([a-z0-9]+)\s*[,/]?\s+(\d)',
    '\2/\3',
    'gi'
  );

  -- Normalize street type abbreviations (use \y for POSIX word boundaries)
  normalized := regexp_replace(normalized, '\yhighway\y', 'hwy', 'gi');
  normalized := regexp_replace(normalized, '\ycrescent\y', 'cres', 'gi');
  normalized := regexp_replace(normalized, '\yparade\y', 'pde', 'gi');
  normalized := regexp_replace(normalized, '\yterrace\y', 'tce', 'gi');
  normalized := regexp_replace(normalized, '\yboulevard\y', 'blvd', 'gi');
  normalized := regexp_replace(normalized, '\yparkway\y', 'pkwy', 'gi');
  normalized := regexp_replace(normalized, '\yesplanade\y', 'esp', 'gi');
  normalized := regexp_replace(normalized, '\yavenue\y', 'ave', 'gi');
  -- Street: must be after a number+words, to avoid "St James" — use \y boundary at start
  normalized := regexp_replace(normalized, '(\d+\s+[a-z\- ]+?)\s+street\y', '\1 st', 'gi');
  normalized := regexp_replace(normalized, '\yroad\y', 'rd', 'gi');
  normalized := regexp_replace(normalized, '\yplace\y', 'pl', 'gi');
  normalized := regexp_replace(normalized, '\yclose\y', 'cl', 'gi');
  normalized := regexp_replace(normalized, '\ycourt\y', 'ct', 'gi');
  normalized := regexp_replace(normalized, '\ydrive\y', 'dr', 'gi');
  normalized := regexp_replace(normalized, '\ylane\y', 'ln', 'gi');
  normalized := regexp_replace(normalized, '\ysquare\y', 'sq', 'gi');

  -- Collapse street number ranges: "50-52 Oxford St" → "50 oxford st"
  normalized := regexp_replace(normalized, '(\d+)\s*-\s*\d+', '\1', 'g');

  -- Collapse "50 & 52 Oxford St" → "50 Oxford St"
  normalized := regexp_replace(normalized, '(\d+)\s*&\s*\d+', '\1', 'g');

  -- Normalize suburb prefix abbreviations: "Mt Colah" / "Mt. Colah" → "mount colah"
  normalized := regexp_replace(normalized, '\ymt\.?\s+', 'mount ', 'gi');
  -- "St Leonards" / "St. Leonards" (suburb prefix) → "saint leonards"
  -- Only convert if "st" is followed by a capitalized word AND NOT a known street type context.
  -- Keep simple: if "st" is at the very start or after comma+space AND followed by a word, treat as "saint".
  normalized := regexp_replace(normalized, '(^|, )st\.?\s+([a-z])', '\1saint \2', 'gi');
  -- "Nth" / "Sth" → north/south (common AU directional abbreviations)
  normalized := regexp_replace(normalized, '\ynth\y', 'north', 'gi');
  normalized := regexp_replace(normalized, '\ysth\y', 'south', 'gi');

  -- Collapse multiple commas + whitespace, then strip ALL commas
  -- (comma vs no-comma before suburb is the most common duplicate source;
  --  stripping commas means "50 oxford st burwood" == "50 oxford st, burwood")
  normalized := regexp_replace(normalized, '\s*,\s*', ' ', 'g');
  normalized := regexp_replace(normalized, '\s+', ' ', 'g');
  normalized := trim(normalized);

  -- SAFETY GATE: if there's no digit (= no street number) OR too short, return NULL
  -- Otherwise we'd mass-merge an entire suburb.
  IF normalized !~ '\d' OR length(normalized) < 8 THEN
    RETURN NULL;
  END IF;

  RETURN normalized;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

COMMENT ON FUNCTION compute_property_key(text) IS
  'Single source of truth for address → property_key. Used by generated columns only. Returns NULL for unsafe inputs (no street number, too short, PO Box).';
