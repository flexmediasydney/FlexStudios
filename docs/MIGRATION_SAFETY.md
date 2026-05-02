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
- Before authoring, run `git fetch origin main && ls supabase/migrations/ |
  sort -V | tail -5` to find the next number — and when working in a
  multi-agent dispatch, **also check `supabase_migrations.schema_migrations`
  on the live DB** since another agent may have applied a number that
  hasn't merged to main yet
- Drone, shortlisting, pulse, and other modules **share** the same numbering
  space — there is no per-module sequence
- Never re-use a number; if a migration is reverted in code, increment past it

### Filename collisions in multi-agent dispatch

When multiple agents are dispatched in parallel, they each pick "the next
free number" independently and can land on the same `NNN` prefix. Both
migrations apply cleanly to prod (timestamp-based `version` column in
`supabase_migrations.schema_migrations` is distinct), so the DB state is
unaffected — but disk filenames collide.

Observed collisions to date: `113_*` (2 files), `396_*` (2 files), `413_*`
(2 files), `421_*` (2 files). Each was resolved by renaming the
later-landing migration to `(N+1)_description.sql` after the fact via a
`git mv` chore commit.

**Going forward**: master orchestrator should pre-allocate migration numbers
when dispatching multiple SQL-touching agents in parallel. Inline brief:
"Use migration number XXX. Do not pick 'next free' yourself — already
allocated by orchestrator."

### Ephemeral-worktree freshness

Every code-touching agent runs in an isolated worktree branched from
`origin/main` at dispatch time. If the agent fetches once at start and
then runs for 30+ minutes, it is reading a snapshot of `main` from
half-an-hour ago. Two failure modes:

1. **Stale-mainfile false positives during QC**: a QC agent inspects
   `vite.config.js` (or some other recently-touched file) at minute 5,
   sees the *old* version, and reports "X did not ship." Meanwhile X has
   been merged into `origin/main` for 20 minutes. The agent's worktree
   simply never refetched.
2. **Migration filename collisions on push**: agent A and agent B both
   pick `NNN_*.sql` because both were branched off the same SHA before
   either landed.

**Discipline** (encoded into the agent brief, not optional):

- Immediately before reading any source file the agent intends to reason
  about: `git fetch origin main && git rebase origin/main` from the
  worktree. If rebase produces conflicts the agent must surface them, not
  silently proceed.
- Immediately before pushing: same fetch + rebase. If a file the agent
  modified moved on `main`, the agent re-applies the change against the
  new shape rather than force-pushing the stale version.
- For migrations specifically, also re-check `ls supabase/migrations/ |
  sort -V | tail -5` AND `select max(version) from
  supabase_migrations.schema_migrations` after the rebase; another agent
  may have applied a migration to prod that hasn't appeared in `main` yet.

The cost of a `git fetch` is a second. The cost of a stale-worktree false
positive is a re-dispatch loop, sometimes with the user already burned
once on a "no it really did ship" cycle.

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

## PostgREST relationship inference

PostgREST builds an in-memory schema cache at startup (and on `NOTIFY pgrst,
'reload schema'`) that includes every FK constraint visible in the
`information_schema`. Embedded selects of the form

```
GET /rest/v1/composition_classifications?select=*,composition_groups(*)
```

are resolved against that cache. If the FK is **missing**, PostgREST
returns the canonical 400:

```
Could not find a relationship between 'composition_classifications' and
'composition_groups' in the schema cache
```

regardless of whether the column referencing the parent exists, is
populated correctly, or even has the right type. The cache only sees
declared relationships.

### Symptom

- Edge function calls `.from('composition_classifications').select('*,
  composition_groups(*)')` and dies 1-3s after pickup with the message
  above
- Querying both tables independently works fine
- The FK column is present, NOT NULL, and populated with valid parent ids

### Detection

```sql
-- list FK constraints on the child
SELECT conname, conrelid::regclass, confrelid::regclass, convalidated
  FROM pg_constraint
 WHERE conrelid = 'composition_classifications'::regclass
   AND contype  = 'f';
```

If the parent reference column has no matching row in `pg_constraint`,
PostgREST cannot infer the embed.

### Fix

Add the FK as `NOT VALID`. PostgREST sees the relationship metadata
regardless of validation state, so the embed unblocks immediately
without forcing a backfill of any orphans:

```sql
-- migration: 430_composition_classifications_fk_to_groups_not_valid.sql

-- Forward
ALTER TABLE composition_classifications
  ADD CONSTRAINT composition_classifications_group_id_fkey
  FOREIGN KEY (group_id)
  REFERENCES composition_groups (id)
  ON DELETE RESTRICT
  NOT VALID;

-- Tell PostgREST to refresh its schema cache so the next request picks up
-- the new relationship without waiting for the next pgrst restart.
NOTIFY pgrst, 'reload schema';

-- Rollback (manual):
--   ALTER TABLE composition_classifications
--     DROP CONSTRAINT composition_classifications_group_id_fkey;
--   NOTIFY pgrst, 'reload schema';
```

`NOT VALID` skips the existing-row check at constraint-creation time but
**still validates new INSERTs and UPDATEs**. Any orphan rows that exist
today survive untouched; cleanup + `VALIDATE CONSTRAINT` is a follow-up
migration. See migration 430 for the canonical form (committed in
`28c3145` on the same day Stage 4 broke).

### Why this happens to us

Edge functions written before PostgREST embeds were on the menu sometimes
modelled relationships in application code (separate `.from()` calls
joined client-side). When a later edge function adopts the embed shape,
the FK that "obviously should exist" was never declared. Add it as
`NOT VALID` the moment you discover the gap; do not block the unblock on
orphan cleanup.

## Gemini response-schema state-count limit

Gemini's structured-output runtime compiles the `responseSchema` into a
constraint automaton at request time. If the automaton's state count
crosses an internal threshold (Google has not published the exact number;
empirically ~hundreds of states once enums multiply with nested object
shapes), Gemini returns:

```
The specified schema produces a constraint that has too many states for
serving. Typical causes: long property/enum names, long array length
limits, complex value matchers.
```

The threshold is per-schema, not per-call, so the same schema fails
deterministically once the request hits it.

### Symptom

- A new Stage / pass / call adds either an extra closed enum, a
  deeply-nested object shape, or an additional string field with a long
  description, and the call 400s on every retry with the message above
- The same enum was fine on a *smaller* schema (e.g. Stage 1 today still
  serves the 60-entry `slot_id` enum because Stage 1's overall schema is
  light enough)

### Detection

- Watch the edge function logs for the literal `too many states for
  serving` substring
- Note which schema fields you most-recently added; the regression is
  almost always cumulative

### Fix

Drop the closed enum and teach the canonical list via `description`
instead. Persist-time normalisation already collapses drift / aliases on
our side, so the structural guarantee survives the schema-time loosening:

```ts
// before — closed enum, joins the state machine
slot_id: {
  type: SchemaType.STRING,
  enum: [...CANONICAL_SLOT_IDS],   // 60 entries
  description: 'Canonical slot id'
}

// after — open string, canonical list lives in the description so the
// model still sees it; normaliseSlotId() at persist time collapses
// drift, drops unrecognised values with a warning
slot_id: {
  type: SchemaType.STRING,
  description:
    'Canonical slot id. MUST be one of: ' +
    CANONICAL_SLOT_IDS.join(', ') +
    '. Drift / unrecognised ids are dropped at persist time.'
}
```

See commit `bbb4337` (Stage 4 slot_id enum drop) and the parallel
`photographer_techniques` enum drop earlier in the same day for two
canonical examples.

### When to drop a closed enum

Heuristics, in order of weight:

1. **Stage already fails with `too many states`**: drop now, no further
   discussion.
2. **Schema has 10+ string fields with long descriptions** AND adds a
   60+-entry enum: pre-emptively use the description form, even if the
   first call works — the next field added will tip you over.
3. **Schema has nested object arrays** with their own enums: keep at
   most one closed enum; convert the rest to description-only.
4. **Schema is small (Stage 1, single-purpose call)**: closed enums are
   fine. The state-count budget is not the constraint.

If you drop a closed enum, the persistence layer **must** have a
normaliser that maps drift back to the canonical set (or drops the value
with a warning). See `slotEnumeration.ts::normaliseSlotId()` for the
pattern: collapse aliases, log unrecognised, never crash.

### Build-time enforcement (W11.7.17 hotfix-6)

After three enum-drop fixes in a single day (commits `a03ced9`, `bbb4337`,
`9325f46`) the schema sat one new closed enum away from tripping again.
`supabase/functions/_shared/visionPrompts/blocks/schemaStateCount.test.ts`
computes a deterministic state-count proxy across every Gemini
responseSchema in the tree — Stage 1 (all 4 source variants) and Stage 4 —
and FAILS the build if the proxy exceeds the pinned `STAGE1_STATE_COUNT_LIMIT`
or `STAGE4_STATE_COUNT_LIMIT`. The proxy sums enum cardinalities, node
counts, `required` entries and weighted description chars; thresholds are
today's known-good baseline + ~10% headroom. Bumping a threshold requires
editing the test file with PR-visible rationale, so a regression cannot
slip past review unannounced. See the test docstring for the full formula
and the "how to bump" guidance.

## When in doubt

If a migration touches a heavily-used table, a foreign key, or any column
that the dispatcher reads in a hot path: pause. Write the rollback first.
Run a dry-run on a copy. Get a second pair of eyes. Then ship.

The cost of "I'll do it carefully" failing is sometimes a multi-hour
recovery; the cost of taking 30 minutes to write a rollback is 30 minutes.
