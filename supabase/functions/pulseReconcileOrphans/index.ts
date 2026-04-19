/**
 * pulseReconcileOrphans — daily sweep that detects + fixes orphan relationships
 * across the pulse_* entity graph.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Migrations 122 + 123 installed AFTER-INSERT bridge triggers and BEFORE-
 * INSERT denormalized-UUID sync triggers on pulse_listings/pulse_agents so
 * new rows can never leave dangling `agent_rea_id` / `agency_rea_id` refs
 * or NULL `agent_pulse_id` / `agency_pulse_id` columns. But reality creates
 * drift anyway:
 *   - a websift import with `agent_name=NULL` skips the bridge (both legs
 *     require name to be non-NULL),
 *   - a race where the denormalized-UUID trigger runs before the bridge
 *     populates the pulse_agents row (the AFTER sweep partly mitigates),
 *   - manual fixups that sidestep triggers (`UPDATE ... SET agent_rea_id=X`
 *     on a historical backfill script),
 *   - pulse_crm_mappings rows created before the mapped pulse row existed.
 *
 * So we run a daily SWEEPER that:
 *   1. finds these orphans,
 *   2. applies the same idempotent bridge-create / COALESCE-backfill logic
 *      that the triggers would have (migration 122 + 123 patterns),
 *   3. reports per-check counts,
 *   4. emits a `pulse_timeline` warning when drift exceeds a threshold.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 * service_role (via SUPABASE_SERVICE_ROLE_KEY or legacy JWT) or a logged-in
 * master_admin. POSTs with no auth are rejected. Cron trigger uses the
 * `pulse_cron_jwt` vault secret.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────
 * Every step is idempotent:
 *   - bridge INSERTs use ON CONFLICT DO UPDATE … COALESCE,
 *   - pulse_id backfills are UPDATE … WHERE col IS NULL,
 *   - the warning event_type has an idempotency_key keyed by day.
 * Second run the same day returns zeros across the board.
 *
 * ── Trigger ─────────────────────────────────────────────────────────────
 * Cron daily 03:00 UTC (migration 131) plus on-demand POST for ops.
 */

import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'pulseReconcileOrphans';
const WARNING_THRESHOLD = 50; // fire a pulse_timeline warning beyond this
const EXECUTION_BUDGET_MS = 60_000; // 60s hard cap — warn if exceeded

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'GET') {
    return errorResponse('Method not allowed. Use POST (service_role or master_admin) or GET (admin only).', 405, req);
  }

  // ── Auth gate: service_role OR master_admin ────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (user.role !== 'master_admin') return errorResponse('Forbidden: master_admin only.', 403, req);
  }

  // Health-check probe bypass (for edgeFunctionHealth auditing)
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

  // ── Open a sync_log row so this run is visible on the Ops tab ─────────
  const initialLabel = `${GENERATOR} · ${isServiceRole ? 'cron' : 'manual'}`;
  const { data: syncLog } = await admin.from('pulse_sync_logs').insert({
    sync_type: 'pulse_reconcile_orphans',
    source_id: 'pulse_reconcile',
    source_label: initialLabel,
    status: 'running',
    triggered_by: isServiceRole ? 'cron' : 'manual',
    triggered_by_name: `${GENERATOR}:${isServiceRole ? 'cron' : (user?.email || 'unknown')}`,
    started_at: new Date().toISOString(),
  }).select('id').single();
  const syncLogId: string | null = syncLog?.id || null;

  // Counters — filled as each check runs.
  const fixes = {
    bridge_created_agents: 0,
    bridge_created_agencies: 0,
    agent_pulse_id_backfilled: 0,
    agency_pulse_id_backfilled: 0,
    linked_agency_pulse_id_backfilled: 0,
    crm_mapping_pulse_entity_id_backfilled: 0,
    total_repairs: 0,
  };
  const errors: string[] = [];

  // ── Helper: safely run a check, append errors rather than bail ────────
  async function safeStep<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[${GENERATOR}] ${label} failed: ${msg}`);
      errors.push(`${label}: ${msg}`);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 1 — pulse_listings.agent_rea_id without matching pulse_agents
  // ════════════════════════════════════════════════════════════════════════
  // Same SQL shape as migration 122 Part A.1 but narrower: only process
  // listings that also have a non-null agent_name (otherwise we have nothing
  // to seed the row with; the nightly scraper will refresh when it has one).
  // Returns the inserted row count (xmax=0 ⇒ fresh insert).
  await safeStep('bridge_agents_from_listings', async () => {
    // Migration 152: pass sync_log_id so companion pulse_timeline rows
    // are linked back to this reconciler run (was emitting NULL and
    // tripping the audit RPCs — ~5,311 NULL rows/day).
    const { data, error } = await admin.rpc('pulse_reconcile_bridge_agents_from_listings', {
      p_sync_log_id: syncLogId,
    });
    if (error) throw new Error(error.message);
    fixes.bridge_created_agents = Number(data) || 0;
  });

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 2 + 3 combined — pulse_agencies bridge from listings + agents
  // ════════════════════════════════════════════════════════════════════════
  // Mirror of migration 122 Part A.2. The RPC handles both sources (listings
  // and agents) in one pass, deduping by lower(trim(name)).
  await safeStep('bridge_agencies_from_refs', async () => {
    // Migration 152: same sync_log_id plumbing as agents bridge above.
    const { data, error } = await admin.rpc('pulse_reconcile_bridge_agencies_from_refs', {
      p_sync_log_id: syncLogId,
    });
    if (error) throw new Error(error.message);
    fixes.bridge_created_agencies = Number(data) || 0;
  });

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 4 — pulse_listings.agent_pulse_id NULL but agent_rea_id resolves
  // ════════════════════════════════════════════════════════════════════════
  // The BEFORE INSERT/UPDATE trigger from migration 123 Part C already does
  // this live, but historical rows and any post-bridge race leftovers land
  // here. Batched UPDATE via FROM join — one round-trip, not row-by-row.
  await safeStep('backfill_agent_pulse_id', async () => {
    const { data, error } = await admin.rpc('pulse_reconcile_backfill_agent_pulse_id');
    if (error) throw new Error(error.message);
    fixes.agent_pulse_id_backfilled = Number(data) || 0;
  });

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 5 — pulse_listings.agency_pulse_id NULL but agency_rea_id resolves
  // ════════════════════════════════════════════════════════════════════════
  await safeStep('backfill_agency_pulse_id', async () => {
    const { data, error } = await admin.rpc('pulse_reconcile_backfill_agency_pulse_id');
    if (error) throw new Error(error.message);
    fixes.agency_pulse_id_backfilled = Number(data) || 0;
  });

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 6 — pulse_agents.linked_agency_pulse_id NULL but agency_rea_id resolves
  // ════════════════════════════════════════════════════════════════════════
  await safeStep('backfill_linked_agency_pulse_id', async () => {
    const { data, error } = await admin.rpc('pulse_reconcile_backfill_linked_agency_pulse_id');
    if (error) throw new Error(error.message);
    fixes.linked_agency_pulse_id_backfilled = Number(data) || 0;
  });

  // ════════════════════════════════════════════════════════════════════════
  // CHECK 7 — pulse_crm_mappings.pulse_entity_id NULL but rea_id resolves
  // ════════════════════════════════════════════════════════════════════════
  // Two shapes: agent mappings resolve via pulse_agents.rea_agent_id,
  // agency mappings resolve via pulse_agencies.rea_agency_id. The RPC runs
  // both in one transaction and returns the combined rowcount.
  await safeStep('backfill_crm_mapping_pulse_entity_id', async () => {
    const { data, error } = await admin.rpc('pulse_reconcile_backfill_crm_mapping_pulse_entity_id');
    if (error) throw new Error(error.message);
    fixes.crm_mapping_pulse_entity_id_backfilled = Number(data) || 0;
  });

  fixes.total_repairs =
    fixes.bridge_created_agents +
    fixes.bridge_created_agencies +
    fixes.agent_pulse_id_backfilled +
    fixes.agency_pulse_id_backfilled +
    fixes.linked_agency_pulse_id_backfilled +
    fixes.crm_mapping_pulse_entity_id_backfilled;

  // ════════════════════════════════════════════════════════════════════════
  // Residual orphan counts — what's left AFTER the repair pass
  // ════════════════════════════════════════════════════════════════════════
  // These counts let ops see whether we're still shedding orphans or the
  // fleet is healthy. A non-zero value here after a successful run points
  // to structurally unresolvable rows (missing agent_name on both listings
  // for a rea_agent_id, for example).
  const stillOrphan = {
    listings_agent: 0,
    listings_agency: 0,
    agents_agency: 0,
  };

  await safeStep('still_orphan_listings_agent', async () => {
    const { count: c } = await admin.from('pulse_listings')
      .select('*', { count: 'exact', head: true })
      .not('agent_rea_id', 'is', null)
      .is('agent_pulse_id', null);
    stillOrphan.listings_agent = c ?? 0;
  });
  await safeStep('still_orphan_listings_agency', async () => {
    const { count: c } = await admin.from('pulse_listings')
      .select('*', { count: 'exact', head: true })
      .not('agency_rea_id', 'is', null)
      .is('agency_pulse_id', null);
    stillOrphan.listings_agency = c ?? 0;
  });
  await safeStep('still_orphan_agents_agency', async () => {
    const { count: c } = await admin.from('pulse_agents')
      .select('*', { count: 'exact', head: true })
      .not('agency_rea_id', 'is', null)
      .is('linked_agency_pulse_id', null);
    stillOrphan.agents_agency = c ?? 0;
  });

  const durationMs = Date.now() - startedAt;
  const generatedAt = new Date().toISOString();

  // ════════════════════════════════════════════════════════════════════════
  // Drift warning — when we had to make more than WARNING_THRESHOLD repairs
  // in a single run, something upstream is producing orphans faster than the
  // triggers can bridge them. Emit a pulse_timeline row so it surfaces on
  // the Ops event stream + uptime dashboards.
  // Idempotency: keyed on the UTC day so re-runs consolidate into one row.
  // ════════════════════════════════════════════════════════════════════════
  if (fixes.total_repairs > WARNING_THRESHOLD) {
    try {
      const day = generatedAt.slice(0, 10);
      await admin.from('pulse_timeline').insert({
        entity_type: 'system',
        event_type: 'integrity_drift_warning',
        event_category: 'system',
        title: `Pulse drift: ${fixes.total_repairs} orphan repairs in one sweep`,
        description:
          `Reconciler repaired ${fixes.total_repairs} orphan refs ` +
          `(threshold ${WARNING_THRESHOLD}). Investigate upstream writers / recent scrape batches.`,
        new_value: { fixes, still_orphan: stillOrphan, duration_ms: durationMs, run_id: runId },
        source: GENERATOR,
        idempotency_key: `${GENERATOR}:drift:${day}`,
      });
    } catch (err: any) {
      console.warn(`[${GENERATOR}] drift warning insert failed: ${err?.message || err}`);
      // Non-fatal — still return a 200 so the cron doesn't retry.
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Close the sync_log row
  // ════════════════════════════════════════════════════════════════════════
  const resultSummary = {
    fixes,
    still_orphan: stillOrphan,
    errors,
    run_id: runId,
  };
  if (syncLogId) {
    try {
      await admin.from('pulse_sync_logs').update({
        status: errors.length ? 'partial' : 'completed',
        completed_at: new Date().toISOString(),
        records_fetched: fixes.total_repairs,
        records_updated: fixes.total_repairs,
        error_message: errors.length ? errors.join(' | ').slice(0, 1000) : null,
      }).eq('id', syncLogId);
      await admin.from('pulse_sync_log_payloads').upsert({
        sync_log_id: syncLogId,
        result_summary: resultSummary,
      }, { onConflict: 'sync_log_id' });
    } catch (err: any) {
      console.warn(`[${GENERATOR}] sync_log finalise failed: ${err?.message || err}`);
    }
  }

  if (durationMs > EXECUTION_BUDGET_MS) {
    console.warn(`[${GENERATOR}] exceeded budget: ${durationMs}ms`);
  }

  return jsonResponse({
    ok: errors.length === 0,
    generated_at: generatedAt,
    duration_ms: durationMs,
    run_id: runId,
    sync_log_id: syncLogId,
    fixes,
    still_orphan: stillOrphan,
    ...(errors.length ? { errors } : {}),
  }, 200, req);
});
