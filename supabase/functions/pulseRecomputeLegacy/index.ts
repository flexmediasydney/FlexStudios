/**
 * pulseRecomputeLegacy - recompute the missed-opportunity substrate so existing
 * rows in pulse_listing_missed_opportunity reflect the just-imported legacy
 * projects (Pipedrive / other historical sources).
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * After agent 1's legacy_projects import finishes, agent 3's migration 187
 * updates pulse_compute_listing_quote() to also treat legacy_projects.
 * property_key matches as "captured", and stamps captured_by_active /
 * captured_by_legacy onto each substrate row. But existing rows carry the
 * pre-migration snapshot. They do not self-heal until mark-stale fires OR
 * something calls pulse_compute_listing_quote(listing_id) again.
 *
 * This endpoint sweeps the substrate in batches of 500, selecting rows whose
 * captured_by_* columns disagree with the current EXISTS check against
 * legacy_projects (matched by property_key). For each batch we call
 * pulse_compute_listing_quote(listing_id) which rewrites the row idempotently.
 *
 * ── Defensive design ─────────────────────────────────────────────────────
 * Migration 187 may not have landed yet when this function is deployed.
 * We probe for the captured_by_legacy column at runtime and fall back to a
 * "recompute everything that has a property_key overlap with legacy_projects"
 * path. Either way the substrate converges.
 *
 * ── Budget ───────────────────────────────────────────────────────────────
 * Hard 50k row cap per invocation (enough for Sydney-wide drift) with a
 * 4-minute wall-clock guardrail to stay inside the 5-min edge-function ceiling.
 * The nightly cron (`pulse-legacy-recompute`, migration 188) runs this
 * repeatedly if drift exceeds the cap.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────
 * service_role (cron) OR master_admin (UI button in Settings/LegacyImport).
 *
 * POST body:
 *   { mode?: 'stale_only' | 'all_overlap', max_rows?: number }
 *     mode defaults to 'stale_only'. 'all_overlap' is the conservative
 *     fallback used right after import when the captured_by_* columns exist
 *     but are null on every pre-migration row.
 *
 * Returns:
 *   { ok: true, sync_log_id, stale_rows, recomputed, errors, duration_ms,
 *     had_more: boolean }  // had_more=true means another invocation needed
 */

import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { startRun, endRun, recordError } from '../_shared/observability.ts';

const GENERATOR = 'pulseRecomputeLegacy';
const BATCH_SIZE = 500;
const MAX_ROWS_PER_INVOCATION = 50_000;
const WALL_CLOCK_BUDGET_MS = 4 * 60 * 1000; // 4 minutes

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // ── Auth gate ──────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (user.role !== 'master_admin') return errorResponse('Forbidden: master_admin only.', 403, req);
  }

  const body = await req.json().catch(() => ({}));
  if (body?._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR });
  }

  const mode: 'stale_only' | 'all_overlap' =
    body?.mode === 'all_overlap' ? 'all_overlap' : 'stale_only';
  const maxRows = Math.min(
    MAX_ROWS_PER_INVOCATION,
    Math.max(1, Number(body?.max_rows) || MAX_ROWS_PER_INVOCATION),
  );

  const admin = getAdminClient();
  const triggeredBy = isServiceRole ? 'cron' : 'admin';
  const triggeredByName = `pulseRecomputeLegacy:${user?.email || 'service_role'}`;

  // ── Open observability run ─────────────────────────────────────────────
  let ctx: any = null;
  try {
    ctx = await startRun({
      admin,
      sourceId: 'pulse_recompute_legacy',
      syncType: 'pulse_recompute_legacy',
      triggeredBy,
      triggeredByName,
      inputConfig: {
        mode,
        max_rows: maxRows,
        actor_id: user?.id ?? null,
        actor_email: user?.email ?? null,
      },
    });
  } catch (startErr: any) {
    console.warn(`[${GENERATOR}] startRun failed, proceeding:`, startErr?.message);
  }

  const startedAt = Date.now();
  let totalStale = 0;
  let totalRecomputed = 0;
  let totalErrors = 0;
  let hadMore = false;

  try {
    // ── Detect whether captured_by_legacy column exists (migration 187) ──
    // Soft probe: SELECT 0 rows of the column. If the column is missing,
    // postgrest returns an error and we fall back to the "recompute every
    // substrate row whose property_key appears in legacy_projects" path.
    let hasCapturedByLegacyCol = false;
    try {
      const { error: selErr } = await admin
        .from('pulse_listing_missed_opportunity')
        .select('captured_by_legacy')
        .limit(0);
      hasCapturedByLegacyCol = !selErr;
    } catch {
      hasCapturedByLegacyCol = false;
    }

    if (ctx) {
      console.log(
        `[${ctx.invocationId}] pulseRecomputeLegacy mode=${mode} ` +
        `has_captured_by_legacy_col=${hasCapturedByLegacyCol} max_rows=${maxRows}`,
      );
    }

    // ── Stage 1: find listing_ids needing recompute ──────────────────────
    // Strategy: select from pulse_listing_missed_opportunity where the current
    // captured_by_legacy bit disagrees with the EXISTS check against
    // legacy_projects on property_key. In 'all_overlap' mode we just return
    // every pulse_listing_missed_opportunity row whose property_key has any
    // legacy_projects overlap — ignores current captured_by_legacy entirely.
    //
    // We do this via a single query using the admin client. Chunked by LIMIT.
    const staleIds: string[] = [];

    // Single query via `.or` / `.in` doesn't express EXISTS cleanly in postgrest.
    // Fall back to an explicit SQL-via-RPC would need a new routine; instead,
    // we fetch property_keys from legacy_projects once (they're bounded — all
    // imported projects — typically a few thousand), then filter substrate
    // rows by property_key IN (...).
    const { data: legacyKeys, error: legacyErr } = await admin
      .from('legacy_projects')
      .select('property_key')
      .not('property_key', 'is', null);

    if (legacyErr) {
      if (ctx) recordError(ctx, legacyErr, 'fatal');
      throw new Error(`Failed to list legacy property_keys: ${legacyErr.message}`);
    }

    const legacyKeySet = new Set<string>(
      (legacyKeys || []).map((r: any) => r.property_key).filter(Boolean),
    );

    if (ctx) {
      console.log(`[${ctx.invocationId}] legacy_keys_distinct=${legacyKeySet.size}`);
    }

    if (legacyKeySet.size === 0) {
      // Nothing to reconcile — exit cleanly.
      if (ctx) {
        await endRun(ctx, {
          status: 'completed',
          recordsFetched: 0,
          recordsUpdated: 0,
          sourceLabel: 'pulse_recompute_legacy · no legacy keys',
          suburb: 'legacy recompute',
          customSummary: {
            mode,
            legacy_keys_distinct: 0,
            stale_rows: 0,
            recomputed: 0,
          },
        });
      }
      return jsonResponse({
        ok: true,
        sync_log_id: ctx?.syncLogId ?? null,
        stale_rows: 0,
        recomputed: 0,
        errors: 0,
        duration_ms: Date.now() - startedAt,
        had_more: false,
      });
    }

    // Page through pulse_listing_missed_opportunity rows whose property_key
    // is in the legacy set. We only need listing_id + the captured_by_legacy
    // bit (if column exists) to decide staleness.
    //
    // postgrest `in()` filter limit ~1000 items before URL blows up — chunk
    // the legacy keys in batches of 500 and union the results.
    const legacyKeys_arr = Array.from(legacyKeySet);
    const LEGACY_CHUNK = 500;

    outer: for (let i = 0; i < legacyKeys_arr.length; i += LEGACY_CHUNK) {
      const chunk = legacyKeys_arr.slice(i, i + LEGACY_CHUNK);
      const select = hasCapturedByLegacyCol
        ? 'listing_id, captured_by_legacy'
        : 'listing_id';
      const { data: rows, error } = await admin
        .from('pulse_listing_missed_opportunity')
        .select(select)
        .in('property_key', chunk)
        .limit(maxRows);
      if (error) {
        if (ctx) recordError(ctx, error, 'error');
        totalErrors++;
        continue;
      }
      for (const row of rows || []) {
        const r: any = row;
        if (!r?.listing_id) continue;
        if (mode === 'stale_only' && hasCapturedByLegacyCol) {
          // Row is stale if captured_by_legacy is NOT true (would become true).
          // We intentionally re-compute any NULL row; a proper column value
          // of TRUE means it's already aware.
          if (r.captured_by_legacy === true) continue;
        }
        staleIds.push(r.listing_id);
        if (staleIds.length >= maxRows) {
          hadMore = true;
          break outer;
        }
      }
    }

    totalStale = staleIds.length;
    if (ctx) {
      console.log(`[${ctx.invocationId}] stale_candidates=${totalStale}`);
    }

    // ── Stage 2: recompute in batches of 500 ─────────────────────────────
    // pulse_compute_listing_quote() is idempotent: UPSERT into the substrate.
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
        hadMore = true;
        if (ctx) {
          console.warn(`[${ctx.invocationId}] wall-clock budget exceeded at row ${i}`);
        }
        break;
      }
      const batch = staleIds.slice(i, i + BATCH_SIZE);
      // Fire RPCs sequentially — Postgres can handle parallel but the
      // compute function takes locks on the substrate upsert and parallel
      // calls on overlapping listings would serialize anyway. Sequential
      // is simpler and well under the budget.
      for (const listing_id of batch) {
        const { error } = await admin.rpc('pulse_compute_listing_quote', { p_listing_id: listing_id });
        if (error) {
          if (ctx) recordError(ctx, error, 'warn');
          totalErrors++;
          continue;
        }
        totalRecomputed++;
      }
      if (ctx && (i / BATCH_SIZE) % 10 === 0) {
        console.log(`[${ctx.invocationId}] progress: ${totalRecomputed}/${totalStale} recomputed`);
      }
    }

    // ── Close run ────────────────────────────────────────────────────────
    if (ctx) {
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: totalStale,
        recordsUpdated: totalRecomputed,
        sourceLabel: `pulse_recompute_legacy · ${totalRecomputed} / ${totalStale} recomputed`,
        suburb: 'legacy recompute',
        recordsDetail: {
          mode,
          legacy_keys_distinct: legacyKeySet.size,
          stale_rows: totalStale,
          recomputed: totalRecomputed,
          errors: totalErrors,
          had_more: hadMore,
          had_captured_by_legacy_col: hasCapturedByLegacyCol,
        },
        customSummary: {
          mode,
          stale_rows: totalStale,
          recomputed: totalRecomputed,
          errors: totalErrors,
          had_more: hadMore,
        },
      });
    }

    return jsonResponse({
      ok: true,
      sync_log_id: ctx?.syncLogId ?? null,
      stale_rows: totalStale,
      recomputed: totalRecomputed,
      errors: totalErrors,
      duration_ms: Date.now() - startedAt,
      had_more: hadMore,
    });
  } catch (error: any) {
    console.error(`${GENERATOR} error:`, error);
    if (ctx) {
      recordError(ctx, error, 'fatal');
      try {
        await endRun(ctx, {
          status: 'failed',
          errorMessage: error?.message || String(error),
          sourceLabel: `pulse_recompute_legacy · fatal`,
          suburb: 'legacy recompute',
          customSummary: {
            stale_rows: totalStale,
            recomputed: totalRecomputed,
            errors: totalErrors + 1,
          },
        });
      } catch { /* best-effort */ }
    }
    return errorResponse(`${GENERATOR} failed: ${error?.message || error}`, 500);
  }
});
