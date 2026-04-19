-- 201_legacy_reconciliation_lazy_candidates.sql
-- Fix the Legacy Pulse Reconciliation page hanging on load.
--
-- The legacy_reconciliation_review RPC was computing top-3 pulse_agent +
-- top-3 pulse_agency candidates for EVERY row returned (up to 25 per call).
-- Each candidate lookup was a Seq Scan over 8,810 pulse_agents or 2,557
-- pulse_agencies with per-row legacy_normalize_person_name() calls that PG
-- couldn't push through a functional GIN index. Net: ~1.5s × 25 rows × 2
-- lookups = ~75s of CPU crammed into a 15s timeout window → page blank.
--
-- Fix: split into two RPCs.
--   1. legacy_reconciliation_review_fast — returns the rows without
--      candidates. O(1) per row. Lands in <200ms.
--   2. legacy_reconciliation_candidates_for(p_legacy_id) — returns top-3
--      agent + top-3 agency candidates for ONE row. Called lazily by the UI
--      when a row is expanded / clicked. ~500ms per call, tolerable.
--
-- The old legacy_reconciliation_review (with candidates baked in) stays for
-- any external caller — just gets LIMIT 5 default so it doesn't timeout.

BEGIN;

-- ── Fast review: rows only, no candidate computation ─────────────────────
CREATE OR REPLACE FUNCTION legacy_reconciliation_review_fast(
  p_filter text DEFAULT 'unlinked',
  p_search text DEFAULT NULL,
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH filtered AS (
    SELECT lp.*,
      (SELECT full_name FROM pulse_agents WHERE id = lp.linked_pulse_agent_id)     AS linked_pulse_agent_name,
      (SELECT name      FROM pulse_agencies WHERE id = lp.linked_pulse_agency_id)  AS linked_pulse_agency_name,
      (SELECT linked_agent_id  FROM pulse_agents   WHERE id = lp.linked_pulse_agent_id)   AS derived_crm_contact_id,
      (SELECT linked_agency_id FROM pulse_agencies WHERE id = lp.linked_pulse_agency_id)  AS derived_crm_agency_id,
      (SELECT is_in_crm FROM pulse_agents   WHERE id = lp.linked_pulse_agent_id)   AS agent_in_crm,
      (SELECT is_in_crm FROM pulse_agencies WHERE id = lp.linked_pulse_agency_id)  AS agency_in_crm
    FROM legacy_projects lp
    WHERE
      CASE p_filter
        WHEN 'unlinked'    THEN lp.linked_pulse_agent_id IS NULL
                              AND lp.linked_pulse_agency_id IS NULL
        WHEN 'agent_only'  THEN lp.linked_pulse_agent_id IS NOT NULL
                              AND lp.linked_pulse_agency_id IS NULL
        WHEN 'agency_only' THEN lp.linked_pulse_agency_id IS NOT NULL
                              AND lp.linked_pulse_agent_id IS NULL
        WHEN 'linked'      THEN lp.linked_pulse_agent_id IS NOT NULL
                              AND lp.linked_pulse_agency_id IS NOT NULL
        ELSE TRUE
      END
      AND (p_search IS NULL
           OR lp.agent_name   ILIKE '%' || p_search || '%'
           OR lp.agency_name  ILIKE '%' || p_search || '%'
           OR lp.raw_address  ILIKE '%' || p_search || '%'
           OR lp.client_email ILIKE '%' || p_search || '%')
    ORDER BY lp.completed_date DESC NULLS LAST, lp.imported_at DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',                     f.id,
      'raw_address',            f.raw_address,
      'agent_name',             f.agent_name,
      'agency_name',            f.agency_name,
      'client_name',            f.client_name,
      'client_email',           f.client_email,
      'completed_date',         f.completed_date,
      'price',                  f.price,
      'package_name_legacy',    f.package_name_legacy,
      'mapped_package_name',    f.mapped_package_name,
      'linked_pulse_agent_id',  f.linked_pulse_agent_id,
      'linked_pulse_agency_id', f.linked_pulse_agency_id,
      'linked_pulse_agent_name',  f.linked_pulse_agent_name,
      'linked_pulse_agency_name', f.linked_pulse_agency_name,
      'derived_crm_contact_id', f.derived_crm_contact_id,
      'derived_crm_agency_id',  f.derived_crm_agency_id,
      'agent_in_crm',           COALESCE(f.agent_in_crm, false),
      'agency_in_crm',          COALESCE(f.agency_in_crm, false),
      'pulse_agent_linkage_confidence',  f.pulse_agent_linkage_confidence,
      'pulse_agency_linkage_confidence', f.pulse_agency_linkage_confidence,
      'pulse_agent_linkage_source',      f.pulse_agent_linkage_source,
      'pulse_agency_linkage_source',     f.pulse_agency_linkage_source,
      'linkage_reviewed_at',             f.linkage_reviewed_at
    ) ORDER BY f.completed_date DESC NULLS LAST, f.imported_at DESC)
    FROM filtered f
    ), '[]'::jsonb),
    'total', (SELECT count(*)::int FROM legacy_projects lp
       WHERE
         CASE p_filter
           WHEN 'unlinked'    THEN lp.linked_pulse_agent_id IS NULL AND lp.linked_pulse_agency_id IS NULL
           WHEN 'agent_only'  THEN lp.linked_pulse_agent_id IS NOT NULL AND lp.linked_pulse_agency_id IS NULL
           WHEN 'agency_only' THEN lp.linked_pulse_agency_id IS NOT NULL AND lp.linked_pulse_agent_id IS NULL
           WHEN 'linked'      THEN lp.linked_pulse_agent_id IS NOT NULL AND lp.linked_pulse_agency_id IS NOT NULL
           ELSE TRUE END
         AND (p_search IS NULL
              OR lp.agent_name   ILIKE '%' || p_search || '%'
              OR lp.agency_name  ILIKE '%' || p_search || '%'
              OR lp.raw_address  ILIKE '%' || p_search || '%'
              OR lp.client_email ILIKE '%' || p_search || '%'))
  );
$$;

-- ── Per-row candidate lookup (lazy, on-demand) ──────────────────────────
-- Called when the user expands a row or clicks a suggestion dropdown.
-- Scans pulse_agents / pulse_agencies ONCE and only for this single legacy
-- row's name strings.
CREATE OR REPLACE FUNCTION legacy_reconciliation_candidates_for(p_legacy_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH lp AS (
    SELECT agent_name, agency_name FROM legacy_projects WHERE id = p_legacy_id
  ),
  agent_cands AS (
    SELECT jsonb_build_object(
             'id',           pa.id,
             'name',         pa.full_name,
             'email',        pa.email,
             'is_in_crm',    COALESCE(pa.is_in_crm, false),
             'crm_agent_id', pa.linked_agent_id,
             'score', round(similarity(
                        legacy_normalize_person_name((SELECT agent_name FROM lp)),
                        legacy_normalize_person_name(pa.full_name))::numeric, 3)
           ) AS c,
           similarity(
             legacy_normalize_person_name((SELECT agent_name FROM lp)),
             legacy_normalize_person_name(pa.full_name)) AS s
    FROM pulse_agents pa
    WHERE pa.full_name IS NOT NULL
      AND legacy_normalize_person_name((SELECT agent_name FROM lp)) IS NOT NULL
      AND similarity(
            legacy_normalize_person_name((SELECT agent_name FROM lp)),
            legacy_normalize_person_name(pa.full_name)) > 0.25
    ORDER BY s DESC
    LIMIT 3
  ),
  agency_cands AS (
    SELECT jsonb_build_object(
             'id',            pag.id,
             'name',          pag.name,
             'is_in_crm',     COALESCE(pag.is_in_crm, false),
             'crm_agency_id', pag.linked_agency_id,
             'score', round(similarity(
                        legacy_normalize_person_name((SELECT agency_name FROM lp)),
                        legacy_normalize_person_name(pag.name))::numeric, 3)
           ) AS c,
           similarity(
             legacy_normalize_person_name((SELECT agency_name FROM lp)),
             legacy_normalize_person_name(pag.name)) AS s
    FROM pulse_agencies pag
    WHERE pag.name IS NOT NULL
      AND legacy_normalize_person_name((SELECT agency_name FROM lp)) IS NOT NULL
      AND similarity(
            legacy_normalize_person_name((SELECT agency_name FROM lp)),
            legacy_normalize_person_name(pag.name)) > 0.25
    ORDER BY s DESC
    LIMIT 3
  )
  SELECT jsonb_build_object(
    'legacy_id', p_legacy_id,
    'candidate_agents',   COALESCE((SELECT jsonb_agg(c ORDER BY (c->>'score') DESC) FROM agent_cands),   '[]'::jsonb),
    'candidate_agencies', COALESCE((SELECT jsonb_agg(c ORDER BY (c->>'score') DESC) FROM agency_cands), '[]'::jsonb)
  );
$$;

COMMIT;
