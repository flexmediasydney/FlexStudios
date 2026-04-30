# FlexMedia Shortlisting Engine — Deployment Runbook

This runbook covers deployment, configuration, and routine operations for the
shortlisting engine. It is the single source of truth for "what does the
engine actually need to run in production?"

Last updated: Wave 7 burst P0-2 (2026-04-27).
Project ref: `rjzdznwkxnzfekgcdkei`.
Engine entry-point: `pg_cron` ticks `shortlisting-job-dispatcher` every minute.

---

## First-time deployment checklist

Run in this order. Each step is idempotent on its own.

1. **Apply all migrations.** From repo root:
   ```
   SUPABASE_ACCESS_TOKEN=<token> npx supabase db push --project-ref rjzdznwkxnzfekgcdkei
   ```
   Migrations are numbered in `supabase/migrations/`. The shortlisting set
   begins at `282_shortlisting_rounds.sql` and currently runs through
   `334_shortlisting_revoke_authenticated_claim_resurrect.sql`. Future
   migrations append in numeric order. See `docs/MIGRATION_SAFETY.md` for the
   additive-then-subtractive pattern this repo uses.

2. **Deploy all shortlisting edge functions.** From repo root, for each fn:
   ```
   SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy <fn-name> \
     --project-ref rjzdznwkxnzfekgcdkei
   ```
   The current shortlisting fn inventory is in the
   "Edge function inventory" section below. Deploys are independent and
   idempotent — re-deploying is safe.

3. **Set required Supabase secrets.** Most importantly,
   `SHORTLISTING_DISPATCHER_JWT` (see "Required secrets" below). Without it,
   the dispatcher cannot chain-call the per-pass functions and every round
   stalls after the first claim. Round 2 (2026-04-26) hit this exactly.

4. **Verify pg_cron jobs.** Connect via SQL Editor and run:
   ```sql
   SELECT jobname, schedule, active FROM cron.job
   WHERE jobname ILIKE 'shortlisting-%' OR jobname ILIKE 'shortlist-%'
   ORDER BY jobname;
   ```
   Expected:
   - `shortlisting-job-dispatcher` schedule `* * * * *` active=true
     (mig 292 — every minute)
   - `shortlisting-events-retention` schedule `30 3 * * *` active=true
     (mig 331 — daily 03:30 UTC, prunes events older than 90 days)

5. **Smoke test each fn's `_health_check`.** Send `{ "_health_check": true }`
   to each fn's URL with a valid service-role JWT in `Authorization: Bearer`.
   Each must return HTTP 200 with `{ _version, _fn, ... }`. The dispatcher
   ALSO returns `{ secrets_ok: true }`; if it returns HTTP 503, see the
   Troubleshooting section below.

   Example for the dispatcher:
   ```
   curl -X POST -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"_health_check": true}' \
     https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/shortlisting-job-dispatcher
   ```

   For an admin UI, see `Settings → Operations Health` (added in Wave 7
   P0-2). It pings every shortlisting fn and surfaces the dispatcher's
   `secrets_ok` field as a critical-secret indicator.

---

## Required secrets

All secrets are set as Supabase function-environment variables via:
```
SUPABASE_ACCESS_TOKEN=<token> npx supabase secrets set \
  KEY=value [KEY2=value2 ...] --project-ref rjzdznwkxnzfekgcdkei
```

### `SHORTLISTING_DISPATCHER_JWT` (CRITICAL)

The dispatcher uses this secret to authenticate when chain-calling per-pass
edge functions (`extract → pass0 → pass1 → pass2 → pass3`). It MUST be a real
service-role JWT (HS256/ES256) — `sb_secret_*` env values are NOT JWTs and
will fail signature verification at the downstream gateway.

**Round 2 incident (2026-04-26).** This secret was missing in production.
Dispatcher claimed jobs fine but every chain-call silently 401'd. Discovery
cost ~15 minutes of debugging. Wave 7 burst P0-2 strengthened detection so
the same outage now surfaces immediately via:
- Dispatcher `_health_check` returns HTTP 503 when missing/malformed
- Module-load `console.error` / `console.warn` warns at cold-start
- `Settings → Operations Health` admin page shows red badge

**To set:**
```
SUPABASE_ACCESS_TOKEN=<your-token> npx supabase secrets set \
  SHORTLISTING_DISPATCHER_JWT=<jwt-value> \
  --project-ref rjzdznwkxnzfekgcdkei
```

**Where to obtain the JWT:**
- The Supabase project's anon vs service-role keys are at
  `Dashboard → Settings → API → Project API keys`. The service-role key is
  a real JWT (3 dot-separated parts; payload contains `role: 'service_role'`).
- OR: a vault-stored service-role JWT can be reused. The `pulse_cron_jwt`
  secret in vault is one. Read via SQL:
  ```sql
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'pulse_cron_jwt';
  ```

**Validation.** After setting, call the dispatcher's health-check
(see step 5 above). Should return HTTP 200 with `{ secrets_ok: true }`.
If you instead get HTTP 503 with body `{ ok: false, error: "...not set..." }`
or `{ ok: false, error: "...malformed..." }`, the secret didn't take effect
or has the wrong shape — re-set it.

### Other required secrets

These are read by various shortlisting functions and the shared helpers
(`_shared/dropbox.ts`, `_shared/anthropicVision.ts`, etc).

| Secret | Where used | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | every fn (auto-provided by Supabase platform) | API base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | every fn (auto-provided) | Admin DB client |
| `SUPABASE_ANON_KEY` | every fn (auto-provided) | RLS client |
| `SHORTLISTING_DISPATCHER_JWT` | dispatcher | chain-call auth — see above |
| `DROPBOX_REFRESH_TOKEN` | `_shared/dropbox.ts`, `shortlisting-debug-mint-dropbox-token` | OAuth refresh |
| `DROPBOX_APP_KEY` | `_shared/dropbox.ts` | OAuth client identification |
| `DROPBOX_APP_SECRET` | `_shared/dropbox.ts` | OAuth client secret |
| `DROPBOX_TEAM_NAMESPACE_ID` | `_shared/dropbox.ts` | team-folder scoping |
| `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | `_shared/anthropicVision.ts` (used by pass0/pass1/pass2/pass3 + benchmark + training extractor) + `_shared/visionAdapter/adapters/anthropic.ts` (W11.8) | Claude vision API |
| `GEMINI_API_KEY` | `_shared/visionAdapter/adapters/google.ts` + `vendor-retroactive-compare` (W11.8) | Google Gemini vision API — required when any per-pass `vision.*.vendor` engine_setting is `"google"` or when the retroactive comparison fn is asked to compare a Google variant |
| `MODAL_PHOTOS_EXTRACT_URL` | `shortlisting-extract` | Modal worker endpoint for CR3 EXIF/JPEG extraction |
| `PASS1_CONCURRENCY` (optional) | `shortlisting-pass1` | concurrency cap for parallel Sonnet calls (default 8 at time of writing) |

The first three (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`) are always available in the Supabase function runtime
and do not need manual setting.

### Adding `GEMINI_API_KEY` (Wave 11.8 — Google Gemini vision)

Wave 11.8 ships the multi-vendor vision adapter (`_shared/visionAdapter/`).
The Anthropic adapter reuses `ANTHROPIC_API_KEY` (already set). The Google
adapter requires a separate `GEMINI_API_KEY` Supabase secret.

`GEMINI_API_KEY` is **already provisioned in production** (Joseph 2026-04-29,
prior to W11.8 deployment). The instructions below are reference for any
future region or staging environment that needs it.

To set it manually:

```bash
SUPABASE_ACCESS_TOKEN=<token> npx supabase secrets set \
  --project-ref <project-ref> \
  GEMINI_API_KEY=<your-google-ai-studio-key>
```

Obtain the key from <https://aistudio.google.com/app/apikey>. Use a project-
scoped key (not a personal key) so it survives the source human leaving the
team.

To verify the secret is set without leaking it:

```bash
SUPABASE_ACCESS_TOKEN=<token> npx supabase secrets list \
  --project-ref <project-ref>
```

The secret is read by:
- `_shared/visionAdapter/adapters/google.ts` — fires for any per-pass call
  whose `vision.*.vendor` engine_setting is `"google"` (today: none in
  production by default)
- `vendor-retroactive-compare` — fires when the operator selects a Google
  variant in the Vendor Comparison admin page

The adapter throws `MissingVendorCredential` (with `env_var: "GEMINI_API_KEY"`)
when the secret is unset — surfaces in logs and as a toast in the admin UI
rather than a generic 5xx.

---

## Routine operations

### How to manually re-run a round

If a round is stuck or you want to retry a phase:

1. From the SQL Editor, find the round:
   ```sql
   SELECT id, project_id, round_number, status, latest_phase
   FROM shortlisting_rounds
   WHERE project_id = '<project-id>'
   ORDER BY round_number DESC LIMIT 5;
   ```

2. Reset the phase you want to re-run via the existing RPC. The function
   `enqueue_shortlisting_pass` (mig 288 / 330) takes a `force_reset` flag.
   Examples:
   - Re-run pass0: re-enqueue with kind=`pass0`
   - Re-run extract for one bracket: see the
     `shortlisting-debug-restore` function

3. The next dispatcher tick (within ~60 seconds) will pick up the new
   pending job.

### How to clear a stuck job

Use the debug functions added in Wave 6:

- `shortlisting-debug-inventory` — list all jobs/rounds/events for a
  project, including stuck-in-running ones.
- `shortlisting-debug-restore` — reset a round to `status='extract_done'`
  (or other intermediate state) so it can be re-run from a known phase.
- `shortlisting-debug-mint-dropbox-token` — mint a fresh Dropbox access
  token for one-shot use (e.g. when Modal's static token expires).

The dispatcher itself self-heals jobs stuck in `running` for >20 minutes by
resetting them to `pending` (see `STALE_CLAIM_MIN` in dispatcher source).

### How to inspect dispatcher health

Three options, in order of UI-friendliness:

1. **Admin UI.** `Settings → Operations Health` (Wave 7 P0-2). Pings every
   shortlisting fn's `_health_check` endpoint, shows green/red status,
   highlights the dispatcher's `secrets_ok` field as a critical-secret
   indicator. Auto-refreshes every 60s.
2. **Shortlisting Command Center.** `/ShortlistingCommandCenter` shows
   per-round + per-job status. Useful for round-level investigation.
3. **Raw curl.** Call `_health_check` directly (see step 5 of first-time
   deployment).

### How to add a new edge function to the dispatcher chain

Today's dispatcher hardcodes the kind→fn map and the chain order:

```ts
// shortlisting-job-dispatcher/index.ts
const KIND_TO_FUNCTION = {
  ingest:  "shortlisting-ingest",
  extract: "shortlisting-extract",
  pass0:   "shortlisting-pass0",
  pass1:   "shortlisting-pass1",
  pass2:   "shortlisting-pass2",
  pass3:   "shortlisting-pass3",
};
```

To add e.g. `pass4`:

1. Build the new fn under `supabase/functions/shortlisting-pass4/`,
   following the contract in `pass3` (read `{ job_id }`, look up round,
   process, return JSON).
2. Add `pass4: "shortlisting-pass4"` to `KIND_TO_FUNCTION`.
3. Update the chain map in `chainNextKind()`: change `pass2: "pass3"` to
   `pass2: "pass3"` (existing) and add `pass3: "pass4"`. Mark `pass4` as
   terminal where the code currently treats `pass3` as terminal.
4. Add a kind constraint in DB (`shortlisting_jobs.kind` values are
   typically validated by RPC; check `claim_shortlisting_jobs` and
   `enqueue_shortlisting_pass` for any explicit allowlist).
5. Re-deploy dispatcher + the new fn. Smoke-test both `_health_check`
   endpoints.

---

## Troubleshooting common failures

### "Extract jobs succeed but pass0 fails with 'no usable EXIF signals'"

The Modal worker's `DROPBOX_ACCESS_TOKEN` static secret has expired
(tokens last ~4 hours). Workaround until P0-3 lands: mint a fresh token
via `shortlisting-debug-mint-dropbox-token`, then redeploy the Modal
worker with the new token in its env.

P0-3 (in the Wave 7 backlog) eliminates this entirely — `shortlisting-extract`
will mint a fresh token per Modal call and pass it in the request body, so
Modal stops reading the static secret.

### "SHORTLISTING_DISPATCHER_JWT not set" (HTTP 503 from health-check)

Set the secret per the "Required secrets" section above. Validate by
re-running the health-check. If still failing, ensure you used a real
service-role JWT (3 dot-separated parts, payload `role: 'service_role'`),
not an `sb_secret_*` env value.

### "SHORTLISTING_DISPATCHER_JWT is malformed" (HTTP 503 from health-check)

Wave 7 P0-2 added a structural shape check at health-probe time. The
secret has the wrong shape — most likely an `sb_secret_*` env value or the
publishable key. Re-fetch the service-role JWT from
`Dashboard → Settings → API → Project API keys` and re-set.

### "shortlist-lock times out at 150s"

Today's lock fn does per-file `move_v2` calls in a 6-worker concurrent
loop. Rounds with >50 file moves can hit Dropbox's per-namespace rate limit
within the 150s gateway budget, leaving partial state. Round 2 hit this
exactly — required ~30 minutes of `revert status / re-invoke / observe`
recovery cycles.

**Permanent fix:** P0-1 in the Wave 7 backlog rewrites the lock to use
Dropbox `/files/move_batch_v2` (single async call accepting up to 10,000
entries) plus a polling shape. ETA: ~1 week of work.

**Today's recovery loop:** revert the round's `status` from `locked` back
to `lock_pending` via SQL, re-invoke `shortlist-lock`. Repeat until done.
Painful but unblocks rounds.

### "pg_advisory_lock concurrent_dispatch returned"

Usually a transient overlap — two cron ticks racing. Single-flight
enforcement (mig 292 + dispatcher logic) does the right thing: the loser
exits cleanly with HTTP 200 and `skipped: 'concurrent_dispatch'`.

If this becomes persistent (more than once per ~10 minutes), see Wave 7
backlog item P1-11 — the suspected cause is PostgREST's connection-pool
routing a `pg_advisory_unlock` call to a different connection than the
acquire, leaving stale session-scoped locks until session recycle. P1-11
proposes switching to `pg_advisory_xact_lock` (transaction-scoped) or a
row-based mutex.

---

## Edge function inventory

The current shortlisting fn set, with one-line descriptions. Re-deploy any
of these via `npx supabase functions deploy <name> --project-ref ...`.

| Function | Purpose |
| --- | --- |
| `shortlisting-job-dispatcher` | pg_cron-triggered every minute. Claims pending jobs and chain-calls per-pass fns. Uses `SHORTLISTING_DISPATCHER_JWT`. |
| `shortlisting-ingest` | Round entry-point. Resolves project → bracket-detect → enqueues N×extract jobs (50 files per chunk). |
| `shortlisting-extract` | Per-bracket: downloads CR3 from Dropbox, calls Modal for EXIF + small JPEG, persists `composition_classifications`. |
| `shortlisting-pass0` | Per-round: technical filter (sharpness, exposure). Filters obvious rejects. |
| `shortlisting-pass1` | Per-round: per-image room/composition/score classification (Sonnet vision). |
| `shortlisting-pass2` | Per-round: slot-fill + alternates. Uses universe block to fill `shortlisting_slot_definitions`. |
| `shortlisting-pass3` | Per-round (terminal): coverage check + notification dispatch. Reads `shortlisting_jobs.result` from prior passes. |
| `shortlist-lock` | Round-finalize: copy/move approved photos to confirmed/editor folders in Dropbox. (P0-1 backlog rewrites with `move_batch_v2`.) |
| `shortlisting-overrides` | Records human overrides (drag-drop in swimlane). Used by Pass 2 + learning loop. |
| `shortlisting-finals-watcher` | Watches `_finals` Dropbox folder for editor uploads, marks rounds `finals_received`. |
| `shortlisting-benchmark-runner` | Replays N stratified locked rounds for tier/weight calibration. |
| `shortlisting-training-extractor` | Extracts training pairs (AI choice vs human override) for Wave 8 fine-tuning. |
| `shortlisting-debug-inventory` | Admin debug: list all jobs/rounds/events for a project. |
| `shortlisting-debug-restore` | Admin debug: reset a round to a known intermediate state. |
| `shortlisting-debug-mint-dropbox-token` | Admin debug: mint fresh Dropbox access token (one-shot). |
| `drone-shortlist-lock` | Drone variant of `shortlist-lock`. Sibling module — same lock pattern. |

---

## Migration application path

Migrations live in `supabase/migrations/` and are numbered. The shortlisting
set runs from 282 onwards. Apply via:

```
SUPABASE_ACCESS_TOKEN=<token> npx supabase db push --project-ref rjzdznwkxnzfekgcdkei
```

For schema changes that touch existing data (column rename, FK change, etc),
follow the additive-then-subtractive pattern documented in
`docs/MIGRATION_SAFETY.md`:

1. Add new column/table additively (NOT NULL DEFAULT or nullable + backfill)
2. Update reads in code to fall back to old column when new is missing
3. Update writes in code to write both
4. Backfill old → new
5. Update reads to prefer new
6. After observation period, drop old column

The shortlisting engine has used this pattern for every schema-breaking
change so far (e.g. mig 295 learning loop schema, mig 326 unique pass
constraint). Joseph's hard rule: NO destructive migrations land before the
new column is reading-stable.

---

## Wave 7 backlog references

This runbook reflects engine state as of Wave 7 burst P0-2. Open work:

- **P0-1** (`shortlist-lock` rewrite using `move_batch_v2`) — eliminates
  the 30-minute lock recovery cycle. ETA ~1 week.
- **P0-3** (Modal Dropbox token refresh from edge function) — eliminates
  the static-token expiry failure mode in extract → pass0 chain. ETA half-day.
- **P1-1 / P1-2** — pass2 prompt iterations (proposed_slots, consecutive-group
  coherence). Engine accuracy lift.

See `docs/WAVE_7_BACKLOG.md` for the full list with priorities + effort
estimates.
