import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { startRun, endRun, recordError } from '../_shared/observability.ts';

/**
 * pulseCircuitReset — programmatic companion to the DS05 UI reset button.
 *
 * The UI reset (see flexmedia-src/src/components/pulse/tabs/PulseDataSources.jsx
 * `handleForceReset`) writes directly to pulse_source_circuit_breakers via
 * the authenticated_full_access RLS policy. That path works for admin-in-browser
 * clicks but is awkward for scripts, runbooks, remediation cron, or external
 * monitors that want to auto-heal a tripped breaker. This endpoint exposes the
 * same operation as a JSON POST with an optional `requeue_dead_letter` flag to
 * also rehydrate stuck queue items — capped at 100 rows per call to avoid
 * pathological rehydration when a source has been failing for days.
 *
 * POST body:
 *   { source_id: string, requeue_dead_letter?: boolean }
 *
 * Auth: master_admin OR service_role (mirrors pulseFireWorker's guard).
 *
 * Returns:
 *   { ok: true, source_id, previous_state, requeued_count }
 *
 * Observability: emits a pulse_sync_logs row via the shared observability
 * module so every reset is auditable from the Data Sources run-history UI,
 * alongside the existing pulse_timeline row.
 */

const DEAD_LETTER_REQUEUE_CAP = 100;

serveWithAudit('pulseCircuitReset', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // ── Auth guard ─────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401);
    if (user.role !== 'master_admin') return errorResponse('Forbidden', 403);
  }

  // ── Parse body ─────────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({}));
  if (body?._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: 'pulseCircuitReset' });
  }

  const source_id = typeof body?.source_id === 'string' ? body.source_id.trim() : '';
  const requeue_dead_letter = body?.requeue_dead_letter === true;

  if (!source_id) {
    return errorResponse('source_id is required', 400);
  }

  const admin = getAdminClient();
  const triggeredBy = isServiceRole ? 'cron' : 'admin';
  const triggeredByName = `pulseCircuitReset:${user?.email || 'service_role'}`;

  // ── Open observability run ─────────────────────────────────────────────
  let ctx;
  try {
    ctx = await startRun({
      admin,
      sourceId: source_id,
      syncType: 'pulse_circuit_reset',
      triggeredBy,
      triggeredByName,
      inputConfig: {
        source_id,
        requeue_dead_letter,
        actor_id: user?.id ?? null,
        actor_email: user?.email ?? null,
      },
    });
  } catch (startErr: any) {
    // If we can't even open a sync_log, fall back to the pre-observability
    // behaviour — do the reset anyway so the caller isn't blocked by a logging
    // outage.
    console.warn('[pulseCircuitReset] startRun failed, proceeding without observability:', startErr?.message);
  }

  try {
    // ── Validate source exists ───────────────────────────────────────────
    const { data: srcCfg, error: srcErr } = await admin
      .from('pulse_source_configs')
      .select('source_id')
      .eq('source_id', source_id)
      .maybeSingle();

    if (srcErr) {
      if (ctx) {
        recordError(ctx, srcErr, 'fatal');
        await endRun(ctx, {
          status: 'failed',
          errorMessage: `Failed to validate source_id: ${srcErr.message}`,
          sourceLabel: `${source_id} · validation failed`,
          suburb: 'circuit reset',
        });
      }
      return errorResponse(`Failed to validate source_id: ${srcErr.message}`, 500);
    }
    if (!srcCfg) {
      if (ctx) {
        await endRun(ctx, {
          status: 'failed',
          errorMessage: `Unknown source_id: ${source_id}`,
          sourceLabel: `${source_id} · unknown source`,
          suburb: 'circuit reset',
        });
      }
      return errorResponse(`Unknown source_id: ${source_id}`, 404);
    }

    // ── Read current breaker state (for `previous_state` in response) ────
    const { data: currentBreaker } = await admin
      .from('pulse_source_circuit_breakers')
      .select('state, consecutive_failures, opened_at, reopen_at')
      .eq('source_id', source_id)
      .maybeSingle();
    const previous_state: string = (currentBreaker as any)?.state || 'closed';
    const previous_failures: number = (currentBreaker as any)?.consecutive_failures || 0;

    if (ctx) {
      console.log(
        `[${ctx.invocationId}] pulseCircuitReset source=${source_id} ` +
        `previous_state=${previous_state} previous_failures=${previous_failures} ` +
        `requeue_dead_letter=${requeue_dead_letter}`,
      );
    }

    // ── Reset the breaker ────────────────────────────────────────────────
    const { error: resetErr } = await admin
      .from('pulse_source_circuit_breakers')
      .update({
        state: 'closed',
        consecutive_failures: 0,
        opened_at: null,
        reopen_at: null,
      })
      .eq('source_id', source_id);

    if (resetErr) {
      if (ctx) {
        recordError(ctx, resetErr, 'fatal');
        await endRun(ctx, {
          status: 'failed',
          errorMessage: `Failed to reset breaker: ${resetErr.message}`,
          sourceLabel: `${source_id} · reset failed`,
          suburb: 'circuit reset',
          customSummary: { previous_state, previous_failures },
        });
      }
      return errorResponse(`Failed to reset breaker: ${resetErr.message}`, 500);
    }

    // ── Optional: requeue dead-letter items ──────────────────────────────
    let requeued_count = 0;
    if (requeue_dead_letter) {
      // Select IDs first so we can cap + return an exact count. UPDATE-with-
      // limit via the JS client isn't directly supported on this schema.
      const { data: deadRows, error: selErr } = await admin
        .from('pulse_fire_queue')
        .select('id')
        .eq('source_id', source_id)
        .eq('status', 'dead_letter')
        .limit(DEAD_LETTER_REQUEUE_CAP);

      if (selErr) {
        if (ctx) {
          recordError(ctx, selErr, 'fatal');
          await endRun(ctx, {
            status: 'failed',
            errorMessage: `Failed to query dead_letter items: ${selErr.message}`,
            sourceLabel: `${source_id} · dead_letter query failed`,
            suburb: 'circuit reset',
            customSummary: { previous_state, previous_failures },
          });
        }
        return errorResponse(`Failed to query dead_letter items: ${selErr.message}`, 500);
      }

      const ids = (deadRows || []).map((r: any) => r.id);
      if (ids.length > 0) {
        const { error: upErr, count } = await admin
          .from('pulse_fire_queue')
          .update({ status: 'pending' }, { count: 'exact' })
          .in('id', ids);

        if (upErr) {
          if (ctx) {
            recordError(ctx, upErr, 'fatal');
            await endRun(ctx, {
              status: 'failed',
              errorMessage: `Failed to requeue dead_letter items: ${upErr.message}`,
              sourceLabel: `${source_id} · requeue failed`,
              suburb: 'circuit reset',
              customSummary: { previous_state, previous_failures, attempted_requeue: ids.length },
            });
          }
          return errorResponse(`Failed to requeue dead_letter items: ${upErr.message}`, 500);
        }
        requeued_count = count ?? ids.length;
      }
    }

    // ── Timeline audit row (non-fatal: breaker already reset) ────────────
    try {
      const { error: tlErr } = await admin.from('pulse_timeline').insert({
        entity_type: 'system',
        event_type: 'circuit_reset',
        event_category: 'system',
        source: 'admin',
        title: `Circuit breaker reset for ${source_id}`,
        description: 'Manual reset via pulseCircuitReset endpoint',
        new_value: {
          source_id,
          previous_state,
          requeue_dead_letter,
          requeued_count,
          actor_id: user?.id ?? null,
          actor_email: user?.email ?? null,
          sync_log_id: ctx?.syncLogId ?? null,
        },
      });
      if (tlErr) {
        if (ctx) recordError(ctx, tlErr, 'warn');
        else console.warn('[pulseCircuitReset] timeline insert failed:', tlErr.message);
      }
    } catch (err: any) {
      if (ctx) recordError(ctx, err, 'warn');
      else console.warn('[pulseCircuitReset] timeline insert threw:', err?.message);
    }

    // ── Close observability run ──────────────────────────────────────────
    if (ctx) {
      const scopeTag = requeue_dead_letter
        ? `requeued ${requeued_count}`
        : 'reset only';
      await endRun(ctx, {
        status: 'completed',
        recordsFetched: requeue_dead_letter ? requeued_count : 0,
        recordsUpdated: requeue_dead_letter ? requeued_count : 1,
        sourceLabel: `${source_id} · circuit reset · ${scopeTag}`,
        suburb: 'circuit reset',
        recordsDetail: {
          previous_state,
          previous_failures,
          new_state: 'closed',
          requeue_dead_letter,
          requeued_count,
        },
        customSummary: {
          source_id,
          previous_state,
          previous_failures,
          requeue_dead_letter,
          requeued_count,
          actor_id: user?.id ?? null,
          actor_email: user?.email ?? null,
        },
      });
    }

    return jsonResponse({
      ok: true,
      source_id,
      previous_state,
      requeued_count,
      sync_log_id: ctx?.syncLogId ?? null,
    });
  } catch (error: any) {
    console.error('pulseCircuitReset error:', error);
    if (ctx) {
      recordError(ctx, error, 'fatal');
      try {
        await endRun(ctx, {
          status: 'failed',
          errorMessage: error?.message || String(error),
          sourceLabel: `${source_id} · fatal`,
          suburb: 'circuit reset',
        });
      } catch { /* best-effort */ }
    }
    return errorResponse(`pulseCircuitReset failed: ${error?.message || error}`, 500);
  }
});
