/**
 * pulseReconcileCrmLinks
 * ──────────────────────
 * Thin wrapper around the `pulse_reconcile_crm_linkage` RPC (migration 191).
 * Calls the reconciler for both 'agency' and 'agent' scopes and returns a
 * combined jsonb payload.
 *
 * The RPC does the actual work: fuzzy-match orphan pulse_* rows (is_in_crm=
 * true but linked_*_id NULL) against the CRM agencies/agents table using
 * pg_trgm similarity + token Jaccard + length-normalised edit distance,
 * auto-apply when the confidence ensemble is >= threshold AND the runner-up
 * is clearly behind, stage for review otherwise.
 *
 * When an auto-apply writes `pulse_agencies.linked_agency_id` the invariant
 * trigger + substrate-invalidation trigger (migration 191) fire transparently
 * — this function doesn't have to orchestrate timeline events itself.
 *
 * Invocation
 *   - POST (service_role OR master_admin) — normal operation
 *   - GET  (admin only)                   — convenience for the ops console
 *   - Cron — `pulse-reconcile-crm-links` at 02:50 UTC (migration 192)
 *   - Mappings tab "Reconcile now" button (supabase.functions.invoke)
 *
 * The function optionally accepts a per-scope threshold in the request body:
 *   { threshold_agency?: number, threshold_agent?: number }
 * Falls back to the RPC default (0.9) when omitted.
 */

import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'pulseReconcileCrmLinks';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'GET') {
    return errorResponse('Method not allowed. Use POST or GET.', 405, req);
  }

  // ── Auth gate: service_role OR master_admin ────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (user.role !== 'master_admin') return errorResponse('Forbidden: master_admin only.', 403, req);
  }

  // Health-check bypass so edgeFunctionHealth can probe without side effects.
  let body: any = {};
  if (method === 'POST') {
    try { body = await req.clone().json().catch(() => ({})); } catch { body = {}; }
    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
    }
  }

  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const admin = getAdminClient();

  const thresholdAgency = typeof body?.threshold_agency === 'number' ? body.threshold_agency : 0.9;
  const thresholdAgent  = typeof body?.threshold_agent  === 'number' ? body.threshold_agent  : 0.9;

  // Open a sync_log row so the run appears in the Ops feed.
  const { data: syncLog } = await admin.from('pulse_sync_logs').insert({
    sync_type: 'pulse_reconcile_crm_links',
    source_id: 'pulse_reconcile_crm',
    source_label: `${GENERATOR} · ${isServiceRole ? 'cron' : 'manual'}`,
    status: 'running',
    triggered_by: isServiceRole ? 'cron' : 'manual',
    triggered_by_name: `${GENERATOR}:${isServiceRole ? 'cron' : (user?.email || 'unknown')}`,
    started_at: new Date().toISOString(),
  }).select('id').single();
  const syncLogId: string | null = syncLog?.id || null;

  const errors: string[] = [];
  let agencyResult: any = null;
  let agentResult:  any = null;

  try {
    const { data, error } = await admin.rpc('pulse_reconcile_crm_linkage', {
      p_entity_type: 'agency',
      p_auto_apply_threshold: thresholdAgency,
    });
    if (error) throw new Error(error.message);
    agencyResult = data;
  } catch (err: any) {
    errors.push(`agency: ${err?.message || String(err)}`);
  }

  try {
    const { data, error } = await admin.rpc('pulse_reconcile_crm_linkage', {
      p_entity_type: 'agent',
      p_auto_apply_threshold: thresholdAgent,
    });
    if (error) throw new Error(error.message);
    agentResult = data;
  } catch (err: any) {
    errors.push(`agent: ${err?.message || String(err)}`);
  }

  const durationMs = Date.now() - startedAt;
  const generatedAt = new Date().toISOString();

  // Combined stats for UI consumption.
  const combined = {
    run_id: runId,
    generated_at: generatedAt,
    duration_ms: durationMs,
    agency: agencyResult,
    agent:  agentResult,
    totals: {
      scanned: (agencyResult?.scanned ?? 0) + (agentResult?.scanned ?? 0),
      auto_applied: (agencyResult?.auto_applied ?? 0) + (agentResult?.auto_applied ?? 0),
      proposed_for_review: (agencyResult?.proposed_for_review ?? 0) + (agentResult?.proposed_for_review ?? 0),
      ambiguous: (agencyResult?.ambiguous ?? 0) + (agentResult?.ambiguous ?? 0),
      unmatchable: (agencyResult?.unmatchable ?? 0) + (agentResult?.unmatchable ?? 0),
    },
    errors: errors.length ? errors : undefined,
  };

  if (syncLogId) {
    try {
      await admin.from('pulse_sync_logs').update({
        status: errors.length ? 'partial' : 'completed',
        completed_at: new Date().toISOString(),
        records_fetched: combined.totals.scanned,
        records_updated: combined.totals.auto_applied,
        error_message: errors.length ? errors.join(' | ').slice(0, 1000) : null,
      }).eq('id', syncLogId);
      await admin.from('pulse_sync_log_payloads').upsert({
        sync_log_id: syncLogId,
        result_summary: combined,
      }, { onConflict: 'sync_log_id' });
    } catch (err: any) {
      console.warn(`[${GENERATOR}] sync_log finalise failed: ${err?.message || err}`);
    }
  }

  return jsonResponse({
    ok: errors.length === 0,
    sync_log_id: syncLogId,
    ...combined,
  }, 200, req);
});
