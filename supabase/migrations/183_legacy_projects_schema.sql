-- 183_legacy_projects_schema.sql
-- Independent substrate for historical projects imported from Pipedrive (and
-- future one-offs from other CRMs). Market Share "captured" checks read from
-- legacy_projects.property_key in addition to projects.property_key, so these
-- rows count toward our coverage — WITHOUT polluting the operational
-- projects table (no triggers, no schedules, no pricing recomputes).
--
-- Split out from projects deliberately:
--   • legacy has no REA listing IDs, no package ids, no normalized agents
--   • legacy prices use line items from the old Pipedrive product catalog
--   • Market Share only needs {property_key, completed_date, coords, agent,
--     price, package-if-mapped} — none of the operational workflow columns
--
-- The helper legacy_normalize_address() reuses the same slug conventions as
-- compute_property_key() in migration 073, so a key produced here collides
-- with a key produced there when the two addresses describe the same property.
--
-- Contract to parallel agents (FROZEN post-commit):
--   • legacy_projects columns below
--   • legacy_import_batches columns below
--   • legacy_normalize_address(text) RETURNS jsonb
--   • BEFORE trigger populates property_key/suburb/postcode/state on insert/update

BEGIN;

-- ── 1. legacy_import_batches ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS legacy_import_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL,
  filename            text,
  format              text CHECK (format IN ('csv','json')),
  column_mapping      jsonb,
  row_count           int,
  imported_count      int,
  geocoded_count      int,
  mapped_count        int,
  error_count         int,
  status              text CHECK (status IN ('pending','in_progress','completed','failed','rolled_back')) DEFAULT 'pending',
  started_at          timestamptz,
  completed_at        timestamptz,
  created_by_user_id  uuid,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legacy_import_batches_status  ON legacy_import_batches(status);
CREATE INDEX IF NOT EXISTS idx_legacy_import_batches_source  ON legacy_import_batches(source);

COMMENT ON TABLE legacy_import_batches IS
  'One row per CSV/JSON import run. Tracks progress + rollback checkpoints.';

-- ── 2. legacy_projects ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS legacy_projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                text NOT NULL,
  external_id           text,
  raw_address           text NOT NULL,
  property_key          text,
  suburb                text,
  postcode              text,
  state                 text,
  latitude              numeric,
  longitude             numeric,
  geocoded_at           timestamptz,
  geocoded_source       text,

  project_name          text,
  completed_date        date,

  package_name_legacy   text,
  products_legacy       jsonb DEFAULT '[]'::jsonb,
  mapped_package_id     uuid REFERENCES packages(id) ON DELETE SET NULL,
  mapped_package_name   text,
  mapping_confidence    numeric,
  mapping_source        text,

  price                 numeric,
  currency              text DEFAULT 'AUD',

  agent_name            text,
  agency_name           text,
  client_name           text,
  client_email          text,
  client_phone          text,

  raw_payload           jsonb,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  import_batch_id       uuid REFERENCES legacy_import_batches(id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Dedup: same batch + same pipedrive id should collide, not duplicate.
  -- external_id can be NULL (early Pipedrive rows had none), so partial unique.
  CONSTRAINT legacy_projects_source_external_unique UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_projects_property_key
  ON legacy_projects(property_key) WHERE property_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_projects_coords
  ON legacy_projects(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_projects_completed
  ON legacy_projects(completed_date);
CREATE INDEX IF NOT EXISTS idx_legacy_projects_suburb
  ON legacy_projects(suburb);
CREATE INDEX IF NOT EXISTS idx_legacy_projects_mapped_package
  ON legacy_projects(mapped_package_id) WHERE mapped_package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_projects_agent_agency
  ON legacy_projects(agent_name, agency_name);
CREATE INDEX IF NOT EXISTS idx_legacy_projects_import_batch
  ON legacy_projects(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_projects_geocoded_pending
  ON legacy_projects(imported_at) WHERE geocoded_at IS NULL;

COMMENT ON TABLE legacy_projects IS
  'Historical projects imported from legacy CRMs (Pipedrive etc). Feeds Market Share '
  '"captured" via property_key match. Independent of operational projects table.';

-- ── 3. legacy_normalize_address helper ──────────────────────────────────────
-- Returns jsonb {property_key, suburb, postcode, state}.
-- property_key output matches compute_property_key() for the same address, so
-- Market Share can JOIN legacy_projects.property_key against pulse_listings.property_key
-- without a second normalizer pass.
DROP FUNCTION IF EXISTS legacy_normalize_address(text);
CREATE OR REPLACE FUNCTION legacy_normalize_address(p_addr text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  raw         text;
  s           text;
  i           int;
  prev        text;
  v_postcode  text;
  v_state     text;
  v_suburb    text;
  m           text[];
  tail        text;
  key_out     text;
BEGIN
  IF p_addr IS NULL OR length(trim(p_addr)) < 5 THEN
    RETURN jsonb_build_object(
      'property_key', NULL,
      'suburb',       NULL,
      'postcode',     NULL,
      'state',        NULL
    );
  END IF;

  raw := trim(p_addr);

  -- Strip "Australia" suffix variants for clean postcode extraction
  raw := regexp_replace(raw, ',?\s*\maustralia\M\s*$', '', 'gi');

  -- Extract postcode (4 digits near end)
  v_postcode := (regexp_match(raw, '(\d{4})(?!.*\d)'))[1];

  -- Extract state (case-insensitive)
  v_state := upper((regexp_match(raw, '\m(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\M', 'i'))[1]);

  -- Extract suburb.
  -- Strategy: take text between the street token (after last comma) and the
  -- state/postcode. Handles both comma-separated and space-separated inputs.
  --   "12 High St, Strathfield NSW 2135"      → "Strathfield"
  --   "12 High Street Strathfield"            → "Strathfield"
  --   "Unit 5/12 High St Strathfield 2135"    → "Strathfield"
  --   "12 High St, Strathfield, NSW, 2135"    → "Strathfield"
  tail := raw;
  -- Drop postcode + state occurrences
  tail := regexp_replace(tail, '\m(NSW|VIC|QLD|SA|WA|ACT|TAS|NT)\M', '', 'gi');
  tail := regexp_replace(tail, '\m\d{4}\M', '', 'g');
  -- Clean trailing commas / whitespace
  tail := regexp_replace(tail, '[,\s]+$', '', 'g');

  -- If there's a comma left, take everything after the LAST comma as suburb.
  -- Otherwise, look for a street-type token and take everything AFTER it as
  -- the suburb (handles "12 High St Strathfield" and "100 Pacific Hwy North Sydney").
  IF position(',' IN tail) > 0 THEN
    v_suburb := trim(regexp_replace(tail, '.*,\s*', ''));
  ELSE
    m := regexp_match(
      tail,
      '\m(?:st|street|rd|road|ave|avenue|pde|parade|ct|court|dr|drive|pl|place|cl|close|ln|lane|hwy|highway|cres|crescent|tce|terrace|blvd|boulevard|pkwy|parkway|sq|square|esp|esplanade|way|walk|loop|circuit|cct)\M\s+([A-Za-z][A-Za-z\-'']+(?:\s+[A-Za-z][A-Za-z\-'']+){0,2})\s*$',
      'i'
    );
    IF m IS NOT NULL THEN
      v_suburb := trim(m[1]);
    END IF;
  END IF;

  -- Safety: never return a street-type as the suburb.
  IF v_suburb IS NOT NULL
     AND lower(v_suburb) ~ '^(st|street|rd|road|ave|avenue|pde|parade|ct|court|dr|drive|pl|place|cl|close|ln|lane|hwy|highway|cres|crescent|tce|terrace|blvd|boulevard|pkwy|parkway|sq|square|esp|esplanade|way|walk|loop|circuit|cct)$' THEN
    v_suburb := NULL;
  END IF;

  -- Title-case suburb for display
  IF v_suburb IS NOT NULL THEN
    v_suburb := initcap(lower(v_suburb));
  END IF;

  -- ── Build property_key via the same pipeline as compute_property_key ─────
  s := lower(raw);

  IF s ~ 'address available on request' THEN
    key_out := NULL;
  ELSIF s ~ '^\s*p\.?\s*o\.?\s*box\s' THEN
    key_out := NULL;
  ELSE
    s := regexp_replace(s, ',?\s*\maustralia\M', '', 'gi');
    s := regexp_replace(s, '\m(nsw|vic|qld|sa|wa|act|tas|nt)\s*,?\s*\d{4}\M', '', 'gi');
    s := regexp_replace(s, ',?\s*\m(nsw|vic|qld|sa|wa|act|tas|nt)\M\s*$', '', 'gi');
    s := regexp_replace(s, ',?\s*\d{4}\s*$', '', 'gi');
    -- Re-strip trailing state once postcode is gone (handles ", NSW, 2135")
    s := regexp_replace(s, ',?\s*\m(nsw|vic|qld|sa|wa|act|tas|nt)\M\s*$', '', 'gi');

    FOR i IN 1..3 LOOP
      s := regexp_replace(s, '^\s*lot\s+\w+\s*[,/]?\s+', '', 'gi');
      s := regexp_replace(s, '^\s*(building|bldg|level|lvl|floor|fl)\s+\w+\s*,?\s*', '', 'gi');
    END LOOP;

    s := regexp_replace(s, '\m(unit|apt|apartment|suite|ste)\s+([a-z0-9]+)\s*[,/]\s*', '\2/', 'gi');

    s := regexp_replace(s, '\mhighway\M', 'hwy', 'gi');
    s := regexp_replace(s, '\mcrescent\M', 'cres', 'gi');
    s := regexp_replace(s, '\mparade\M', 'pde', 'gi');
    s := regexp_replace(s, '\mterrace\M', 'tce', 'gi');
    s := regexp_replace(s, '\mboulevard\M', 'blvd', 'gi');
    s := regexp_replace(s, '\mparkway\M', 'pkwy', 'gi');
    s := regexp_replace(s, '\mesplanade\M', 'esp', 'gi');
    s := regexp_replace(s, '\mavenue\M', 'ave', 'gi');
    s := regexp_replace(s, '\mstreet\M', 'st', 'gi');
    s := regexp_replace(s, '\mroad\M', 'rd', 'gi');
    s := regexp_replace(s, '\mplace\M', 'pl', 'gi');
    s := regexp_replace(s, '\mclose\M', 'cl', 'gi');
    s := regexp_replace(s, '\mcourt\M', 'ct', 'gi');
    s := regexp_replace(s, '\mdrive\M', 'dr', 'gi');
    s := regexp_replace(s, '\mlane\M', 'ln', 'gi');
    s := regexp_replace(s, '\msquare\M', 'sq', 'gi');

    s := regexp_replace(s, '(\d+)\s*-\s*\d+', '\1', 'g');

    s := regexp_replace(s, ',', ' ', 'g');
    s := regexp_replace(s, '\s+', ' ', 'g');
    s := trim(s);

    FOR i IN 1..3 LOOP
      prev := s;
      s := regexp_replace(s, '\m(\w+(?:\s+\w+){0,3})\s+\1\M', '\1', 'gi');
      EXIT WHEN s = prev;
    END LOOP;

    s := trim(s);

    IF s !~ '\d' OR length(s) < 8 THEN
      key_out := NULL;
    ELSE
      key_out := s;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'property_key', key_out,
    'suburb',       v_suburb,
    'postcode',     v_postcode,
    'state',        v_state
  );
END;
$fn$;

COMMENT ON FUNCTION legacy_normalize_address IS
  'Parse AU address string into {property_key, suburb, postcode, state}. '
  'property_key matches compute_property_key() for the same address.';

-- ── 4. BEFORE trigger — populate parsed fields on insert/update ─────────────
CREATE OR REPLACE FUNCTION legacy_projects_parse_address()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parsed jsonb;
BEGIN
  IF NEW.raw_address IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only run parser if any target field is NULL (permits manual overrides to stick)
  IF NEW.property_key IS NULL
     OR NEW.suburb IS NULL
     OR NEW.postcode IS NULL
     OR NEW.state IS NULL THEN
    parsed := legacy_normalize_address(NEW.raw_address);
    NEW.property_key := COALESCE(NEW.property_key, parsed->>'property_key');
    NEW.suburb       := COALESCE(NEW.suburb,       parsed->>'suburb');
    NEW.postcode     := COALESCE(NEW.postcode,     parsed->>'postcode');
    NEW.state        := COALESCE(NEW.state,        parsed->>'state');
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legacy_projects_parse_address ON legacy_projects;
CREATE TRIGGER trg_legacy_projects_parse_address
  BEFORE INSERT OR UPDATE OF raw_address ON legacy_projects
  FOR EACH ROW EXECUTE FUNCTION legacy_projects_parse_address();

-- ── 5. Self-tests ───────────────────────────────────────────────────────────
DO $$
DECLARE
  r jsonb;
BEGIN
  -- Standard "Street + Suburb + State + Postcode" format
  r := legacy_normalize_address('12 High St, Strathfield NSW 2135');
  ASSERT r->>'property_key' = '12 high st strathfield',
    format('T1 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Strathfield',   format('T1 suburb: %s', r->>'suburb');
  ASSERT r->>'postcode' = '2135',        format('T1 postcode: %s', r->>'postcode');
  ASSERT r->>'state' = 'NSW',            format('T1 state: %s', r->>'state');

  -- Unit prefix → slash
  r := legacy_normalize_address('Unit 5/12 High St Strathfield 2135');
  ASSERT r->>'property_key' = '5/12 high st strathfield',
    format('T2 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Strathfield',   format('T2 suburb: %s', r->>'suburb');
  ASSERT r->>'postcode' = '2135',        format('T2 postcode: %s', r->>'postcode');

  -- No comma, no state, no postcode
  r := legacy_normalize_address('12 High Street Strathfield');
  ASSERT r->>'property_key' = '12 high st strathfield',
    format('T3 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Strathfield',   format('T3 suburb: %s', r->>'suburb');
  ASSERT r->>'postcode' IS NULL,         format('T3 postcode: %s', r->>'postcode');
  ASSERT r->>'state' IS NULL,            format('T3 state: %s', r->>'state');

  -- Street type normalization: Road → rd
  r := legacy_normalize_address('88 Willoughby Road, Crows Nest NSW 2065');
  ASSERT r->>'property_key' = '88 willoughby rd crows nest',
    format('T4 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Crows Nest',    format('T4 suburb: %s', r->>'suburb');

  -- Slashed unit with no keyword prefix
  r := legacy_normalize_address('3/45 Ocean Avenue, Bondi NSW 2026');
  ASSERT r->>'property_key' = '3/45 ocean ave bondi',
    format('T5 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Bondi',         format('T5 suburb: %s', r->>'suburb');

  -- Two-word suburb
  r := legacy_normalize_address('100 Pacific Hwy, North Sydney NSW 2060');
  ASSERT r->>'property_key' = '100 pacific hwy north sydney',
    format('T6 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'North Sydney',  format('T6 suburb: %s', r->>'suburb');

  -- Street number range collapses to first
  r := legacy_normalize_address('50-52 Castlereagh Street, Sydney NSW 2000');
  ASSERT r->>'property_key' = '50 castlereagh st sydney',
    format('T7 property_key: %s', r->>'property_key');
  ASSERT r->>'postcode' = '2000',        format('T7 postcode: %s', r->>'postcode');

  -- VIC address
  r := legacy_normalize_address('42 Chapel Street, Prahran VIC 3181');
  ASSERT r->>'property_key' = '42 chapel st prahran',
    format('T8 property_key: %s', r->>'property_key');
  ASSERT r->>'state' = 'VIC',            format('T8 state: %s', r->>'state');
  ASSERT r->>'postcode' = '3181',        format('T8 postcode: %s', r->>'postcode');

  -- Crescent abbreviation
  r := legacy_normalize_address('7 Sunset Crescent, Mosman NSW 2088');
  ASSERT r->>'property_key' = '7 sunset cres mosman',
    format('T9 property_key: %s', r->>'property_key');

  -- Apartment comma form
  r := legacy_normalize_address('Apt 12, 99 Bay Street, Double Bay NSW 2028');
  ASSERT r->>'property_key' = '12/99 bay st double bay',
    format('T10 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Double Bay',    format('T10 suburb: %s', r->>'suburb');

  -- PO Box should produce null key
  r := legacy_normalize_address('PO Box 42, Sydney NSW 2000');
  ASSERT r->>'property_key' IS NULL,     format('T11 property_key: %s', r->>'property_key');

  -- Junk "address available on request"
  r := legacy_normalize_address('Address available on request');
  ASSERT r->>'property_key' IS NULL,     format('T12 property_key: %s', r->>'property_key');

  -- Australia suffix stripped
  r := legacy_normalize_address('12 High St, Strathfield NSW 2135, Australia');
  ASSERT r->>'property_key' = '12 high st strathfield',
    format('T13 property_key: %s', r->>'property_key');
  ASSERT r->>'postcode' = '2135',        format('T13 postcode: %s', r->>'postcode');

  -- Fully comma separated
  r := legacy_normalize_address('12 High St, Strathfield, NSW, 2135');
  ASSERT r->>'property_key' = '12 high st strathfield',
    format('T14 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Strathfield',   format('T14 suburb: %s', r->>'suburb');
  ASSERT r->>'postcode' = '2135',        format('T14 postcode: %s', r->>'postcode');

  -- NULL / too-short inputs
  r := legacy_normalize_address(NULL);
  ASSERT r->>'property_key' IS NULL,     format('T15 null: %s', r::text);
  r := legacy_normalize_address('x');
  ASSERT r->>'property_key' IS NULL,     format('T16 short: %s', r::text);

  -- Street-type at end is NOT treated as suburb when comma + actual suburb present
  r := legacy_normalize_address('27 Elizabeth Drive, Liverpool NSW 2170');
  ASSERT r->>'property_key' = '27 elizabeth dr liverpool',
    format('T17 property_key: %s', r->>'property_key');
  ASSERT r->>'suburb' = 'Liverpool',     format('T17 suburb: %s', r->>'suburb');

  RAISE NOTICE 'legacy_normalize_address: all 17 self-tests passed';
END $$;

COMMIT;
