-- 275_drop_redundant_drone_renders_shot_index.sql
-- QC6 #27: idx_drone_renders_shot is a single-column btree on (shot_id).
-- The composite idx_drone_renders_shot_created_at already covers any
-- (shot_id) lookup as a prefix-match — Postgres uses leading columns of a
-- composite for equality predicates without scanning the trailing
-- timestamp. Maintaining both indexes doubles the write cost on every
-- drone_renders INSERT/UPDATE without buying any read benefit.
--
-- We use IF EXISTS so reruns are safe. CONCURRENTLY avoids holding the
-- table lock during the drop (drone_renders sees ~1 write/sec during peak
-- ingest; a momentary lock would queue render writes briefly).

DROP INDEX CONCURRENTLY IF EXISTS public.idx_drone_renders_shot;
