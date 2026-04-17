-- Add email_domains array to agencies for direct email → agency matching
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS email_domains text[] DEFAULT '{}'::text[];

-- Index for lookups by domain
CREATE INDEX IF NOT EXISTS idx_agencies_email_domains ON agencies USING GIN (email_domains);

-- Backfill: derive domains from any existing agent emails that link to this agency
-- For each agency, find unique domains from agents.email (where email has an @), exclude generic providers
DO $$
DECLARE
  generic_domains text[] := ARRAY['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'me.com', 'live.com', 'protonmail.com', 'proton.me', 'aol.com', 'bigpond.com', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au'];
  own_domains text[] := ARRAY['flexmedia.sydney', 'flexstudios.app', 'flexstudios.com.au'];
BEGIN
  UPDATE agencies a
  SET email_domains = (
    SELECT COALESCE(array_agg(DISTINCT lower(split_part(ag.email, '@', 2))) FILTER (
      WHERE ag.email IS NOT NULL
        AND position('@' in ag.email) > 0
        AND NOT (lower(split_part(ag.email, '@', 2)) = ANY(generic_domains))
        AND NOT (lower(split_part(ag.email, '@', 2)) = ANY(own_domains))
    ), '{}'::text[])
    FROM agents ag
    WHERE ag.current_agency_id = a.id
  )
  WHERE EXISTS (
    SELECT 1 FROM agents ag
    WHERE ag.current_agency_id = a.id
      AND ag.email IS NOT NULL
      AND position('@' in ag.email) > 0
  );
END $$;

-- Report
SELECT name, email_domains, (SELECT count(*) FROM agents WHERE current_agency_id = agencies.id) as agent_count
FROM agencies
WHERE array_length(email_domains, 1) > 0
ORDER BY array_length(email_domains, 1) DESC
LIMIT 20;
