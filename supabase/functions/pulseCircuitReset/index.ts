import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

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

  try {
    // ── Validate source exists ───────────────────────────────────────────
    const { data: srcCfg, error: srcErr } = await admin
      .from('pulse_source_configs')
      .select('source_id')
      .eq('source_id', source_id)
      .maybeSingle();

    if (srcErr) {
      return errorResponse(`Failed to validate source_id: ${srcErr.message}`, 500);
    }
    if (!srcCfg) {
      return errorResponse(`Unknown source_id: ${source_id}`, 404);
    }

    // ── Read current breaker state (for `previous_state` in response) ────
    const { data: currentBreaker } = await admin
      .from('pulse_source_circuit_breakers')
      .select('state')
      .eq('source_id', source_id)
      .maybeSingle();
    const previous_state: string = (currentBreaker as any)?.state || 'closed';

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
        return errorResponse(`Failed to query dead_letter items: ${selErr.message}`, 500);
      }

      const ids = (deadRows || []).map((r: any) => r.id);
      if (ids.length > 0) {
        const { error: upErr, count } = await admin
          .from('pulse_fire_queue')
          .update({ status: 'pending' }, { count: 'exact' })
          .in('id', ids);

        if (upErr) {
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
        },
      });
      if (tlErr) {
        console.warn('[pulseCircuitReset] timeline insert failed:', tlErr.message);
      }
    } catch (err: any) {
      console.warn('[pulseCircuitReset] timeline insert threw:', err?.message);
    }

    return jsonResponse({
      ok: true,
      source_id,
      previous_state,
      requeued_count,
    });
  } catch (error: any) {
    console.error('pulseCircuitReset error:', error);
    return errorResponse(`pulseCircuitReset failed: ${error?.message || error}`, 500);
  }
});
