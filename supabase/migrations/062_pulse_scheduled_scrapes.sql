-- 062: Scheduled Industry Pulse scraping via pg_cron
-- Tiered approach: high-priority suburbs scraped more frequently

-- ═══ REA Listings — twice daily for high-priority suburbs (priority >= 8) ═══
-- Runs at 6am and 2pm AEST (20:00 and 04:00 UTC)
-- ~20 suburbs, ~7 min per run
SELECT cron.schedule(
  'pulse-rea-listings-high',
  '0 20,4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseScheduledScrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source_id":"rea_listings","min_priority":8,"batch_size":10}'::jsonb
  );
  $$
);

-- ═══ REA Listings — full sweep weekly (all suburbs, Sunday 3am AEST = Saturday 17:00 UTC) ═══
SELECT cron.schedule(
  'pulse-rea-listings-full',
  '0 17 * * 6',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseScheduledScrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source_id":"rea_listings","min_priority":0,"batch_size":10,"max_batches":20}'::jsonb
  );
  $$
);

-- ═══ REA Agents — weekly (Monday 4am AEST = Sunday 18:00 UTC) ═══
SELECT cron.schedule(
  'pulse-rea-agents-weekly',
  '0 18 * * 0',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseScheduledScrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source_id":"rea_agents","min_priority":0,"batch_size":10,"max_batches":20}'::jsonb
  );
  $$
);

-- ═══ Domain Agents — weekly (Wednesday 4am AEST = Tuesday 18:00 UTC) ═══
SELECT cron.schedule(
  'pulse-domain-agents-weekly',
  '0 18 * * 2',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseScheduledScrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source_id":"domain_agents","min_priority":0,"batch_size":10,"max_batches":20}'::jsonb
  );
  $$
);

-- ═══ Domain Agencies — bi-weekly (1st and 15th of month, 5am AEST = 19:00 UTC) ═══
SELECT cron.schedule(
  'pulse-domain-agencies-biweekly',
  '0 19 1,15 * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseScheduledScrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source_id":"domain_agencies","min_priority":0,"batch_size":10,"max_batches":20}'::jsonb
  );
  $$
);
