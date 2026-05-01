-- Wave 11.6.8 — W7.10 P1-9: notification_routing_rules slack_channel + 8 seeded types
--
-- Origin: docs/WAVE_7_BACKLOG.md P1-9 ("Notification routing seed (9 spec types)").
-- Migration 294 shipped notification_routing_rules with 1 seeded type
-- (shortlist_ready_for_review). The W7.10 spec lists 9 notification types
-- with named recipients + Slack channels. Without the remaining 8 rows,
-- dispatch sites in shortlisting-pass3, shortlisting-shape-d-stage4, and
-- shortlist-lock either silently no-op (no rule + no default_roles) or fall
-- back to the in-code default_roles registry — neither matches the spec.
--
-- This migration:
--   1. Adds slack_channel TEXT NULL column so each routing rule can also
--      target a specific Slack channel (in addition to in-app fan-out via
--      recipient_roles + recipient_user_ids). Optional — most rows leave
--      it NULL today, but the 8 seeded W7.10 rows set it per spec.
--   2. Seeds the 8 remaining notification types listed in the spec.
--
-- ON CONFLICT (notification_type, version) DO NOTHING so re-running the
-- migration on a project where ops has already manually created some rules
-- is safe.
--
-- Slack delivery is wired separately — at fire-time the notificationService
-- (or a slackDispatcher hook) reads slack_channel and posts to that channel
-- if set. This migration only seeds the routing config; the actual Slack
-- adapter is out of scope for W11.6.8.

-- ============================================================================
-- 1. Schema: add slack_channel column
-- ============================================================================

ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS slack_channel TEXT NULL;

COMMENT ON COLUMN notification_routing_rules.slack_channel IS
  'Optional Slack channel name (e.g. ''#engine-alerts'') to ALSO post to when this rule fires. NULL = in-app only. Wave 11.6.8 (W7.10 P1-9): introduced for the 8 spec notification types that route to ops Slack channels in addition to in-app recipients.';

-- ============================================================================
-- 2. Seed: 8 remaining notification types per W7.10 spec
-- ============================================================================
--
-- Per spec section 19:
--   coverage_gap_error          → master_admin   + #engine-alerts
--   retouch_flags               → backend_lead   + #retouch-queue
--   out_of_scope_detected       → backend_lead   + #engine-alerts
--   shortlist_lock_failed       → master_admin   + #deploy-alerts
--   cost_cap_exceeded           → master_admin   + #engine-alerts
--   vendor_failover_triggered   → master_admin   + #engine-alerts
--   stage4_review_overdue       → admin          + #shortlist-review
--   master_listing_regenerated  → admin          + #listing-review
--
-- "backend_lead" is not a first-class user role today (the role enum is
-- master_admin/admin/manager/employee/contractor/photographer/image_editor/
-- video_editor/project_owner/assigned_users). We map backend_lead → admin
-- for the recipient_roles array (the engineering admin user-group) and rely
-- on Slack channel binding for the actual backend lead's awareness. When
-- the role enum eventually adds a dedicated 'backend_lead' role, ops can
-- INSERT a new version of these rows with the correct role and flip the
-- prior version's is_active=FALSE (mirrors the versioning contract from
-- mig 294's header doc).

INSERT INTO notification_routing_rules (
  notification_type,
  recipient_roles,
  recipient_user_ids,
  slack_channel,
  notes,
  is_active,
  version
)
VALUES
  (
    'coverage_gap_error',
    ARRAY['master_admin']::TEXT[],
    ARRAY[]::UUID[],
    '#engine-alerts',
    'W11.6.8 W7.10 seed: coverage gap detected during Pass 3. Routes to master_admin in-app + #engine-alerts Slack so ops sees missing-mandatory-slot conditions immediately.',
    TRUE,
    1
  ),
  (
    'retouch_flags',
    ARRAY['admin']::TEXT[],
    ARRAY[]::UUID[],
    '#retouch-queue',
    'W11.6.8 W7.10 seed: retouch flags surfaced during Pass 3 (compositions with flag_for_retouching=TRUE on the proposed shortlist). Routes to admin (backend lead proxy) + #retouch-queue Slack for retoucher pickup.',
    TRUE,
    1
  ),
  (
    'out_of_scope_detected',
    ARRAY['admin']::TEXT[],
    ARRAY[]::UUID[],
    '#engine-alerts',
    'W11.6.8 W7.10 seed: a classification was detected with an engine_role outside the project''s configured roles (e.g. drone shot in a non-drone project). Routes to admin (backend lead proxy) + #engine-alerts Slack for triage.',
    TRUE,
    1
  ),
  (
    'shortlist_lock_failed',
    ARRAY['master_admin']::TEXT[],
    ARRAY[]::UUID[],
    '#deploy-alerts',
    'W11.6.8 W7.10 seed: shortlist-lock function moved into ''failed'' stage (Dropbox batch failure, async poll timeout, or finalize error). Routes to master_admin in-app + #deploy-alerts Slack so ops can resume.',
    TRUE,
    1
  ),
  (
    'cost_cap_exceeded',
    ARRAY['master_admin']::TEXT[],
    ARRAY[]::UUID[],
    '#engine-alerts',
    'W11.6.8 W7.10 seed: Stage 4 (or other engine pass) pre-flight cost estimate exceeded engine_settings.cost_cap_per_round_usd. Routes to master_admin + #engine-alerts so the run is reviewed before retry.',
    TRUE,
    1
  ),
  (
    'vendor_failover_triggered',
    ARRAY['master_admin']::TEXT[],
    ARRAY[]::UUID[],
    '#engine-alerts',
    'W11.6.8 W7.10 seed: primary vendor (Gemini) failed after retries → fell over to Anthropic. Cost spikes ~12×; routes to master_admin + #engine-alerts so ops can investigate vendor health.',
    TRUE,
    1
  ),
  (
    'stage4_review_overdue',
    ARRAY['admin']::TEXT[],
    ARRAY[]::UUID[],
    '#shortlist-review',
    'W11.6.8 W7.10 seed: Stage 4 round in ''proposed'' status without operator review beyond the SLA window. Routes to admin + #shortlist-review. NOTE: cron emitter not yet wired in W11.6.8 — row reserved for the future overdue cron job (no live dispatch site yet).',
    TRUE,
    1
  ),
  (
    'master_listing_regenerated',
    ARRAY['admin']::TEXT[],
    ARRAY[]::UUID[],
    '#listing-review',
    'W11.6.8 W7.10 seed: operator-triggered master_listing rewrite (regenerate-master-listing → Stage 4 with payload.regenerate=true) completed. Routes to admin + #listing-review for QA on the new copy.',
    TRUE,
    1
  )
ON CONFLICT (notification_type, version) DO NOTHING;

-- ============================================================================
-- Reload PostgREST schema cache so the new column is visible immediately.
-- ============================================================================
NOTIFY pgrst, 'reload schema';
