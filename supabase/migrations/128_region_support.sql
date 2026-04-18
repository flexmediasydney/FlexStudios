-- 128_region_support.sql
-- Auditor 11 / Vision-alignment feature: Region filter across Pulse tabs.
--
-- `pulse_target_suburbs` already has a `region` column (added in 060) and most
-- rows already carry a region. This migration:
--   1) idempotently adds the column if it's ever missing,
--   2) backfills a consistent Greater Sydney region for any unseeded rows
--      using the Auditor-11 CASE table,
--   3) rebuilds the partial index the UI query plan relies on.
--
-- The table's suburb column is `name` (not `suburb`); the Auditor spec's
-- sample SQL uses `suburb` loosely — we map to the real column name.
-- The WHERE region IS NULL guard makes this safe to re-run; rows that already
-- carry a region (from migration 060's seed) are left untouched.

ALTER TABLE pulse_target_suburbs ADD COLUMN IF NOT EXISTS region TEXT;

UPDATE pulse_target_suburbs SET region = CASE
  WHEN name IN ('Manly','Dee Why','Mona Vale','Collaroy','Warriewood','Newport','Freshwater','Narrabeen','Brookvale','Seaforth','Belrose','Avalon','Fairlight','Queenscliff','Terrey Hills','Narraweena') THEN 'Northern Beaches'
  WHEN name IN ('Bondi','Double Bay','Paddington','Woollahra','Rose Bay','Vaucluse','Dover Heights','Bellevue Hill','Point Piper','Bondi Junction','Tamarama','Bronte','Coogee','Randwick','Kensington','Kingsford') THEN 'Eastern Suburbs'
  WHEN name IN ('Strathfield','Burwood','Ashfield','Homebush','Concord','Five Dock','Drummoyne','Leichhardt','Balmain','Rozelle','Lilyfield','Haberfield','Croydon','Enfield') THEN 'Inner West'
  WHEN name IN ('Castle Hill','Baulkham Hills','Cherrybrook','Pennant Hills','Thornleigh','Normanhurst','Wahroonga','Westleigh','Dural','Kellyville','Rouse Hill','Bella Vista') THEN 'Hills District'
  WHEN name IN ('Mosman','Neutral Bay','Cremorne','North Sydney','Kirribilli','Cammeray','Naremburn','St Leonards','Crows Nest','Waverton','McMahons Point','Wollstonecraft') THEN 'Lower North Shore'
  WHEN name IN ('Chatswood','Willoughby','Artarmon','Lane Cove','Gordon','Killara','Roseville','Pymble','Turramurra') THEN 'Upper North Shore'
  WHEN name IN ('Parramatta','Harris Park','Rosehill','Westmead','North Parramatta','Ermington','Rydalmere','Silverwater') THEN 'Parramatta'
  WHEN name IN ('Cronulla','Miranda','Sutherland','Caringbah','Woolooware','Gymea','Kirrawee','Menai','Illawong') THEN 'Sutherland Shire'
  WHEN name IN ('Liverpool','Campbelltown','Camden','Narellan','Oran Park','Leppington','Austral') THEN 'South West'
  WHEN name IN ('Penrith','Kingswood','St Marys','Glenmore Park','Jordan Springs','Emu Plains','Cambridge Park') THEN 'West'
  ELSE region
END
WHERE region IS NULL;

-- 060 already creates an idx_pulse_target_suburbs_region index (unfiltered).
-- The Auditor-11 spec requests a partial index that excludes NULLs for the
-- distinct-region DropDown query. Keep both — the partial wins for the
-- IS NOT NULL plan, the original stays for other uses.
CREATE INDEX IF NOT EXISTS idx_pulse_target_suburbs_region_notnull
  ON pulse_target_suburbs(region)
  WHERE region IS NOT NULL;
