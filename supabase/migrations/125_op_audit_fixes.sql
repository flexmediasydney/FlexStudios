-- 125_op_audit_fixes.sql
-- Operational audit round — three fixes bundled:
--
--   OP01  rea_agents silent-zero-fetched (80% of suburbs always 0):
--         (a) [EMPIRICALLY DISPROVEN 2026-04-18 — see (c).] Initially we
--             thought updating pulse_source_configs.actor_input.location
--             from "{suburb} NSW" to the postcode-qualified "{suburb-full}"
--             token (which pulseFireScrapes inflates to "<name> NSW
--             <postcode>") would disambiguate the websift actor's fuzzy
--             match. A/B tested both formats back-to-back:
--                 "Strathfield NSW"       → 0 records
--                 "Strathfield NSW 2135"  → 0 records
--             The actor returned 0 for BOTH formats in the same minute, and
--             had returned 72 for "Strathfield NSW" only hours earlier.
--             Conclusion: root cause is actor-side (rate limit, index drift,
--             or internal regression in websift/realestateau) — NOT the
--             input-string format. This migration reverts the config change
--             so the {suburb} NSW template is in force.
--         (b) New function pulse_detect_silent_zero(source_id, suburb, hours)
--             returning TRUE when 3+ consecutive runs for that (source, suburb)
--             returned records_fetched=0. UI / alerting can poll this. Also
--             usable for a future auto-circuit-break trigger.
--         (c) Recommendation (documented, not auto-applied): switch REA
--             agent-profile scraping to a URL-based actor (the listings
--             pipeline already uses azzouzana with a realestate.com.au/<type>/
--             in-<suburb-slug>,+nsw+<postcode>/list-N URL, which works
--             reliably because the URL IS the canonical suburb key). Build
--             a pulse_source_configs entry for a websift alternative that
--             takes startUrl, or replace websift with a different actor.
--
--   OP02  Reconcile 20 rows where rea_detail_enrich status='failed' but the
--         error_message contains 'schema-mismatch' — those runs wrote their
--         data to pulse_listings successfully; only the status label was wrong
--         because PostgREST silently dropped a column-mismatch UPDATE. Without
--         this reconcile, daily error-rate dashboards count them as real
--         failures.
--
--   OP03  (Non-DB portion — edge function changes live in pulseDataSync;
--         this migration just documents the companion deploy.)
--
-- All three pieces are idempotent. The UPDATE in OP02 is scoped to
-- (status='failed' AND source_id='rea_detail_enrich' AND error_message LIKE
-- '%schema-mismatch%') which can only match the known 20-row cohort. Re-running
-- the migration is safe — subsequent rows that already carry the
-- "[RECONCILED — ...]" suffix are skipped by the LIKE guard.

BEGIN;

-- ── OP01a: rea_agents actor_input is INTENTIONALLY left at "{suburb} NSW" ───
-- Original migration draft bumped this to "{suburb-full}" (postcode-qualified)
-- but that regressed the working suburbs without fixing the broken ones — the
-- actor just returns 0 intermittently regardless of location format (see
-- header comment for the A/B test). We keep the config untouched. The
-- pulseFireScrapes function still supports the {suburb-full} token so a
-- future actor swap can use it without another code deploy.
--
-- This is here as a no-op UPDATE so the migration is explicit about the
-- decision (rather than silently having no OP01a section). Running it does
-- nothing when the config already matches.
UPDATE pulse_source_configs
SET actor_input = jsonb_set(
      actor_input,
      '{location}',
      '"{suburb} NSW"'::jsonb,
      true
    ),
    updated_at = NOW()
WHERE source_id = 'rea_agents'
  AND actor_input->>'location' IS DISTINCT FROM '{suburb} NSW';

-- ── OP01b: pulse_detect_silent_zero(source_id, suburb, lookback_hours) ──────
-- Returns TRUE when the last 3 consecutive completed non-error runs for the
-- (source_id, suburb) pair all have records_fetched=0. "Consecutive" here
-- means: ordered by started_at DESC, skipping runs that failed for a real
-- reason (status='failed'). We only consider status IN ('completed','timed_out')
-- so a legit error doesn't count as a silent-zero signal.
--
-- lookback_hours bounds how far back we'll consider. 3 consecutive runs older
-- than the window don't count as "silent zero now" — the source may have been
-- off for legit reasons.
CREATE OR REPLACE FUNCTION pulse_detect_silent_zero(
  p_source_id TEXT,
  p_suburb TEXT,
  p_lookback_hours INT DEFAULT 24
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_last_three INT[];
BEGIN
  -- Collect the most recent 3 eligible runs (completed or timed_out, within
  -- the lookback window) and check if all three have records_fetched=0.
  SELECT ARRAY_AGG(records_fetched ORDER BY started_at DESC)
    INTO v_last_three
    FROM (
      SELECT records_fetched, started_at
        FROM pulse_sync_logs
        WHERE source_id = p_source_id
          AND suburb = p_suburb
          AND status IN ('completed', 'timed_out')
          AND started_at > NOW() - (p_lookback_hours || ' hours')::INTERVAL
        ORDER BY started_at DESC
        LIMIT 3
    ) recent;

  -- If we don't have 3 runs in the window, the signal isn't strong enough.
  IF v_last_three IS NULL OR ARRAY_LENGTH(v_last_three, 1) < 3 THEN
    RETURN FALSE;
  END IF;

  -- Otherwise: silent zero iff all three are 0.
  RETURN v_last_three[1] = 0 AND v_last_three[2] = 0 AND v_last_three[3] = 0;
END;
$$;

COMMENT ON FUNCTION pulse_detect_silent_zero(TEXT, TEXT, INT) IS
  'OP01: returns TRUE if the last 3 non-error runs for (source_id, suburb) in '
  'the lookback window all returned 0 records. UI alerting + optional auto '
  'circuit-break trigger read from this.';

-- ── OP02: Reconcile rea_detail_enrich schema-mismatch false failures ───────
-- The 20 affected rows already carry the long diagnostic error message. We
-- rewrite status→completed and append a [RECONCILED — ...] marker so error-
-- rate dashboards exclude them (WHERE error_message LIKE '%[RECONCILED%'
-- pattern for exclusion). We don't nullify error_message because the original
-- diagnostic is useful for post-mortem trace.
UPDATE pulse_sync_logs
SET status = 'completed',
    error_message = error_message
      || E'\n[RECONCILED — data was written successfully, status label drift from pre-fix deploy]'
WHERE source_id = 'rea_detail_enrich'
  AND status = 'failed'
  AND error_message ILIKE '%schema-mismatch%'
  AND error_message NOT ILIKE '%[RECONCILED%';  -- idempotency guard

COMMIT;
