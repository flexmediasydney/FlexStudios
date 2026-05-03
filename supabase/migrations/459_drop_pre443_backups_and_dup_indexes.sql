-- 459_drop_pre443_backups_and_dup_indexes.sql
--
-- Today's static QC + Supabase advisor sweep surfaced two clusters of
-- low-hanging fruit:
--
-- 1. Three RLS-DISABLED [ERROR] lints on tables that are dead weight:
--      _shortlisting_slot_allocations_pre_443_backup
--      _shortlisting_slot_definitions_pre_443_backup
--      _shortlisting_slot_position_preferences_pre_443_backup
--    All created by mig 443 as belt-and-suspenders backups before the
--    slot-model retirement. The active engine has been running on the
--    new gallery_positions/shortlisting_position_decisions schema for a
--    week with no rollback needed. Drop them. The mig 443 rollback path
--    can be reconstituted from the migration file itself if ever needed.
--
-- 2. Two `duplicate_index` [WARN] lints — exact-pair duplicates that
--    waste disk + amplify writes:
--      public.projects        idx_projects_tonomo_order  ↔  idx_projects_tonomo_order_id
--      public.pulse_signals   idx_pulse_signals_idempotency  ↔  ux_pulse_signals_idem
--
-- These two clusters together clear 5 advisor lints (3 ERROR + 2 WARN)
-- and remove the only ERROR-level RLS gaps on the project, all without
-- touching live engine paths. The bigger RLS fan-out (545 stacked
-- permissive policies + 63 init-plan refactors) is deferred to a
-- separate cleanup wave.

DROP TABLE IF EXISTS public._shortlisting_slot_allocations_pre_443_backup;
DROP TABLE IF EXISTS public._shortlisting_slot_definitions_pre_443_backup;
DROP TABLE IF EXISTS public._shortlisting_slot_position_preferences_pre_443_backup;

-- Drop the LATER-named/newer of each duplicate pair. The original index
-- (without the trailing variant suffix) stays.
DROP INDEX IF EXISTS public.idx_projects_tonomo_order_id;
DROP INDEX IF EXISTS public.ux_pulse_signals_idem;
