# Migration Safety Patterns

Conventions for writing Postgres migrations safely against the production
Supabase database. Wave 0 burst 0.7.

This document is the load-bearing reference for every schema change going
forward. If a migration deviates from these patterns, document why in the
migration's leading comment.

---

## Numbering & ordering

- Migrations live in `supabase/migrations/` named `NNN_description.sql`
- `NNN` is a 3-digit zero-padded sequence number, monotonically increasing
- Before authoring, run `ls supabase/migrations/ | sort -n | tail -5` to find
  the next number
- Drone, shortlisting, pulse, and other modules **share** the same numbering
  space — there is no per-module sequence
- Never re-use a number; if a migration is reverted in code, increment past it

## The "additive then subtractive" rule

**Every breaking schema change ships in two migrations across two deploys**:

1. **Migration N** — *additive*: introduces the new shape **alongside** the
   old shape. Application code learns to read both, write both. Both old and
   new readers/writers coexist.
2. *(deploy + observe in production for at least one full processing cycle)*
3. **Migration N+M** — *subtractive*: drops the old shape. Application
   code stops reading or writing the old. Only after every code path has
   been verified to use the new shape.

This is the only reliable way to ship schema changes against a live database
without a coordinated downtime window. The engine's pg_cron + dispatcher
pattern means a migration can land while a job is mid-flight; if that job
references the old column on the new schema, it dies. Additive-then-subtractive
prevents the death.

### Examples

- **Renaming a column** — never rename in place. Add the new column, backfill
  it, update writers to write both, update readers to prefer new + fall back
  to old, *then in a later migration* drop the old.
- **Changing a column type** — same pattern. Add the new column with the new
  type, backfill from the old, switch writers, switch readers, drop old.
- **Adding a NOT NULL constraint to an existing nullable column** — first
  backfill all NULL rows (in batches; see below), then `ALTER COLUMN SET NOT
  NULL` in a later migration once you've confirmed zero NULLs remain.
- **Splitting one column into two** — same shape: add both new columns,
  backfill, dual-write from app code, switch readers, drop old.

## Forward + rollback in the same file

Every migration **MUST** include a rollback section as a comment block at
the bottom. Format:

```sql
-- Forward
ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS camera_source TEXT;

-- Rollback (run manually if this migration breaks production):
--
-- ALTER TABLE composition_groups DROP COLUMN IF EXISTS camera_source;
--
-- Note: this rollback is data-lossy if any rows have a non-null camera_source.
-- Rollback procedure for the lossy case: dump the column to a side table
-- before dropping, e.g.:
--   CREATE TABLE _rollback_composition_groups_camera_source AS
--     SELECT id, camera_source FROM composition_groups WHERE camera_source IS NOT NULL;
--   ALTER TABLE composition_groups DROP COLUMN camera_source;
```

Even when a migration is "obviously safe", document the rollback. It forces
us to think about reversibility before we commit.

## Backfill in batches, never in one statement

`UPDATE table SET col = expr` over millions of rows holds row-level locks
for the entire statement and can lock concurrent writers for minutes. Large
backfills must be batched.

Pattern:

```sql
-- Forward
DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE shortlisting_overrides
       SET client_sequence = COALESCE(client_sequence, 0)
     WHERE id IN (
       SELECT id FROM shortlisting_overrides
        WHERE client_sequence IS NULL
        LIMIT batch_size
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);  -- yield to other writers
  END LOOP;
END $$;
```

Rules of thumb:
- Batch size: 500–2000 for indexed updates; 100–500 for unindexed
- `pg_sleep(0.1)` between batches gives concurrent writers room
- For very large tables (>10M rows), prefer a separate background script
  that runs outside the migration

## Feature flags during the additive window

If application code can't safely run on both schemas without divergent
behaviour, gate the new code path behind a feature flag (env var, settings
table row, etc). Sequence:

1. Migration N: additive schema change
2. Application code checks the flag → reads/writes new shape if flag on,
   old shape if flag off. Default: off.
3. Deploy + verify the flag-on path works in a test environment.
4. Flip flag on in prod.
5. Observe for one processing cycle.
6. Migration N+M: subtractive schema change.
7. Remove the flag from application code.

Always default flags to *off* on first deploy so a bad flag value doesn't
silently activate untested code.

## Foreign keys: avoid `ON DELETE CASCADE` for engine tables

The shortlisting tables (rounds, compositions, classifications, events,
overrides, training_examples, retouch_flags, quarantine, jobs) all reference
each other in a tightly-coupled graph. A misclick in an admin tool that
deletes a round must NOT silently nuke 500 child rows.

Rules:
- Engine FK relationships use `ON DELETE RESTRICT` or `ON DELETE NO ACTION`
  by default
- If a parent must be deletable, write an explicit cleanup function that the
  delete path invokes (logged, audited)
- `ON DELETE SET NULL` is acceptable for soft-link relationships (e.g.
  `actor_id` on shortlisting_events when an auth user is deleted) — but
  the table column must be nullable

## Indexes: build CONCURRENTLY in production migrations

`CREATE INDEX` holds an `ACCESS EXCLUSIVE` lock for the entire build, which
freezes writes on large tables. Use `CREATE INDEX CONCURRENTLY` instead — it
takes longer but doesn't block writers.

Caveat: `CONCURRENTLY` cannot run inside a transaction. The Supabase
migration runner wraps each migration in a transaction by default. To work
around, split the index into its own migration file with a leading comment:

```sql
-- migration: 350_add_index_on_shortlisting_overrides_round_seq.sql
--
-- This migration uses CREATE INDEX CONCURRENTLY which cannot run inside a
-- transaction. Apply via the Supabase SQL editor with "Run as transaction"
-- DISABLED, or via the management API with `transaction = false`.

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_shortlisting_overrides_round_seq
  ON shortlisting_overrides(round_id, client_sequence)
  WHERE client_sequence IS NOT NULL;
```

For routine, small-table additive index additions, plain `CREATE INDEX
IF NOT EXISTS` inside a transaction is fine.

## RPCs: privilege boundary is service_role by default

Every new SECURITY DEFINER RPC defaults to `GRANT EXECUTE ... TO service_role`
**only**. To allow user-facing invocation, the caller must:
1. Have a verified business reason for that role to invoke directly
2. Add the role grant explicitly with a comment justifying why
3. Add a `get_user_role()` check inside the RPC body if the function performs
   any write that touches another user's data

The default is service_role-only because:
- It's the smallest blast radius
- pg_cron + dispatcher already runs under service_role
- Any frontend invocation should ideally route through an edge function
  (which has its own auth gating + observability)

See migration 334 (`shortlisting_revoke_authenticated_claim_resurrect.sql`)
for the rationale + retroactive correction of an over-permissive grant.

## Testing migrations

Before applying to prod:

1. **Local dry-run**: `supabase db reset` against a local clone, apply your
   migration, run an end-to-end smoke (or — once we have CI fixtures —
   replay a captured round)
2. **Branch deploy**: if the migration is risky, create a Supabase branch,
   apply there, point a staging env at it, exercise the engine
3. **Prod via MCP**: apply via the management MCP `apply_migration` call,
   not via `supabase db push`. The MCP path provides better atomicity +
   visibility into failures

After applying to prod:
- Watch `supabase functions logs <relevant-fn>` for at least one full
  processing cycle (15-20 min for a typical engine cycle)
- Spot-check the new column / table by running a sample query
- Verify the dispatcher cron has fired at least twice without errors

## Naming conventions

- Tables: `snake_case`, plural for collections (`composition_groups`),
  singular for caches (`drone_pois_cache`)
- Columns: `snake_case`, descriptive, prefer full words over abbreviations
- Foreign keys: `<related_table>_id`
- Indexes: `idx_<table>_<columns>` (e.g. `idx_shortlisting_overrides_round_seq`)
- Unique partial indexes: `uniq_<table>_<purpose>` (e.g.
  `uniq_shortlisting_jobs_pending_ingest_per_project`)
- Constraints: `<table>_<purpose>_chk` for check; `<table>_<columns>_uniq` for
  unique

## When in doubt

If a migration touches a heavily-used table, a foreign key, or any column
that the dispatcher reads in a hot path: pause. Write the rollback first.
Run a dry-run on a copy. Get a second pair of eyes. Then ship.

The cost of "I'll do it carefully" failing is sometimes a multi-hour
recovery; the cost of taking 30 minutes to write a rollback is 30 minutes.
