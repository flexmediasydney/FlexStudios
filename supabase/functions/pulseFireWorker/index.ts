import { getAdminClient, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * pulseFireWorker — Queue-draining executor (new in migration 093)
 *
 * pg_cron fires this every minute. Each invocation:
 *   1. Reconcile: re-queue any items stuck in 'running' > 5 min (failed handoffs,
 *      dead pulseDataSync invocations, etc.).
 *   2. Drain: loop claiming eligible items respecting per-source stagger +
 *      circuit-breaker state. Dispatches via pg_net (fire-and-forget with DB-
 *      owned HTTP lifecycle — survives worker exit).
 *   3. Reconcile batches: mark any pulse_fire_batches row 'completed' when all
 *      its queue items are terminal.
 *
 * ── Key design decisions ───────────────────────────────────────────────────
 * - Dispatch via pg_net, not direct fetch. pg_net's background worker owns the
 *   HTTP lifecycle so our edge function can exit without aborting in-flight
 *   requests. The worker also doesn't need to wait 60-120s for pulseDataSync
 *   to finish; it fires and moves on.
 *
 * - Outcome is recorded by pulseDataSync itself (via the fire_queue_id it
 *   receives), not polled by the worker. This keeps the worker fast and the
 *   state machine crisp.
 *
 * - Reconciler is the safety net: if pulseDataSync dies before calling
 *   pulse_fire_queue_record_outcome, the queue row stays 'running'. After 5
 *   min the reconciler re-queues it (or dead-letters if attempts >= 3).
 *
 * - Per-source stagger is enforced in-memory per worker tick. An RPC-based
 *   approach was considered but kept simple: worker tracks last-dispatched-ms
 *   per source in a Map, checks before each claim, sleeps to respect windows.
 *
 * - Circuit breakers are pre-loaded at tick start (small table, few sources).
 *   Sources with state='open' and reopen_at in the future are skipped.
 */

const WORKER_WALL_MS = 110_000;     // leave 20s grace under edge runtime 150s cap
const MAX_ITEMS_PER_TICK = 60;      // upper bound per invocation to avoid runaway
const IDLE_EXIT_MS = 8_000;         // exit early if no work for this long
const DEFAULT_STAGGER_MS = 2_000;   // fallback when config.stagger_seconds is NULL
const STUCK_RECONCILE_MIN = 5;      // items 'running' older than this → re-queue
const IDLE_POLL_MS = 1_500;         // how long to sleep when all sources cooling

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

serveWithAudit('pulseFireWorker', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const admin = getAdminClient();
  const workerStart = Date.now();
  let lastActivityAt = workerStart;
  const stats = {
    reconciled_stuck: 0,
    dispatched: 0,
    batches_completed: 0,
    sources_skipped_circuit: [] as string[],
    wall_ms: 0,
  };

  try {
    const body = await req.json().catch(() => ({}));
    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'pulseFireWorker', _arch: 'queue-drain' });
    }

    // ── Phase 1: Reconcile stuck 'running' items ──────────────────────────
    {
      const { data } = await admin.rpc('pulse_fire_queue_reconcile_stuck', { p_stuck_minutes: STUCK_RECONCILE_MIN });
      stats.reconciled_stuck = Number(data) || 0;
      if (stats.reconciled_stuck > 0) {
        console.log(`[worker] reconciled ${stats.reconciled_stuck} stuck items`);
      }
    }

    // ── Preload per-source config (stagger, circuit breakers) ─────────────
    const staggerMs = new Map<string, number>();
    const openBreakers = new Map<string, string>();  // source_id -> reopen_at iso

    const { data: sourceCfgs } = await admin.from('pulse_source_configs')
      .select('source_id, stagger_seconds, is_enabled')
      .eq('is_enabled', true);
    for (const sc of sourceCfgs || []) {
      staggerMs.set(sc.source_id, ((sc as any).stagger_seconds || 2) * 1000);
    }

    const { data: breakers } = await admin.from('pulse_source_circuit_breakers')
      .select('source_id, state, reopen_at');
    const nowIso = new Date().toISOString();
    for (const b of breakers || []) {
      if ((b as any).state === 'open' && (b as any).reopen_at && (b as any).reopen_at > nowIso) {
        openBreakers.set((b as any).source_id, (b as any).reopen_at);
      }
    }

    if (openBreakers.size > 0) {
      stats.sources_skipped_circuit = Array.from(openBreakers.keys());
      console.log(`[worker] circuit open for: ${stats.sources_skipped_circuit.join(', ')}`);
    }

    // ── Phase 2: Drain loop ────────────────────────────────────────────────
    const lastDispatched = new Map<string, number>();  // source_id -> unix ms

    while (Date.now() - workerStart < WORKER_WALL_MS && stats.dispatched < MAX_ITEMS_PER_TICK) {
      // Check which sources currently have pending work (past next_attempt_at)
      const { data: pendingSources } = await admin.from('pulse_fire_queue')
        .select('source_id')
        .eq('status', 'pending')
        .lte('next_attempt_at', new Date().toISOString())
        .limit(500);

      // Dedupe source_ids
      const pendingSet = new Set<string>();
      for (const row of pendingSources || []) pendingSet.add((row as any).source_id);

      if (pendingSet.size === 0) {
        // No pending work right now
        if (Date.now() - lastActivityAt > IDLE_EXIT_MS) {
          console.log('[worker] idle — exiting');
          break;
        }
        await sleep(IDLE_POLL_MS);
        continue;
      }

      // Filter to sources eligible RIGHT NOW (not on breaker + past stagger window)
      const now = Date.now();
      const eligibleSources: string[] = [];
      for (const sid of pendingSet) {
        if (openBreakers.has(sid)) continue;
        const last = lastDispatched.get(sid) || 0;
        const stagger = staggerMs.get(sid) || DEFAULT_STAGGER_MS;
        if (now - last >= stagger) eligibleSources.push(sid);
      }

      if (eligibleSources.length === 0) {
        // All sources on stagger cooldown. Sleep until soonest is eligible.
        const waitMs = Math.min(
          ...Array.from(pendingSet).map(sid => {
            if (openBreakers.has(sid)) return IDLE_POLL_MS;
            const last = lastDispatched.get(sid) || 0;
            const stagger = staggerMs.get(sid) || DEFAULT_STAGGER_MS;
            return Math.max(100, (last + stagger) - Date.now());
          })
        );
        await sleep(Math.min(waitMs, 3_000));
        continue;
      }

      // ── Claim 1 item per eligible source in parallel ────────────────────
      // SKIP LOCKED means concurrent workers (shouldn't exist but belt+braces)
      // won't double-claim. RPC also increments attempts atomically.
      const claimPromises = eligibleSources.map(async (sid) => {
        const { data, error } = await admin.rpc('pulse_fire_queue_claim_next', {
          p_source_id: sid, p_limit: 1,
        });
        if (error) {
          console.error(`[worker] claim rpc error for ${sid}: ${error.message}`);
          return null;
        }
        return (data && data[0]) || null;
      });
      const claimed = (await Promise.all(claimPromises)).filter(Boolean) as any[];

      if (claimed.length === 0) {
        // Race: another worker got the items. Retry shortly.
        await sleep(500);
        continue;
      }

      lastActivityAt = Date.now();

      // ── Dispatch claimed items via pg_net (fire-and-forget) ─────────────
      // The RPC calls net.http_post(pulseDataSync) with fire_queue_id in the
      // payload. pulseDataSync will call pulse_fire_queue_record_outcome on
      // completion. If pulseDataSync dies before that, the reconciler on next
      // tick catches the stuck 'running' row and re-queues it.
      const dispatchPromises = claimed.map(async (item: any) => {
        lastDispatched.set(item.source_id, Date.now());
        try {
          const { error } = await admin.rpc('pulse_fire_queue_dispatch_via_net', { p_queue_id: item.id });
          if (error) {
            console.error(`[worker] dispatch rpc failed for ${item.id}: ${error.message}`);
            // Immediately mark failed so the reconciler doesn't wait 5min
            await admin.rpc('pulse_fire_queue_record_outcome', {
              p_id: item.id,
              p_success: false,
              p_error: `Dispatch RPC: ${error.message}`,
              p_category: 'transient',
            });
            return;
          }
          stats.dispatched++;
        } catch (err: any) {
          console.error(`[worker] dispatch exception for ${item.id}: ${err?.message}`);
          await admin.rpc('pulse_fire_queue_record_outcome', {
            p_id: item.id,
            p_success: false,
            p_error: `Dispatch exception: ${err?.message || 'unknown'}`,
            p_category: 'transient',
          }).catch(() => {});
        }
      });

      await Promise.allSettled(dispatchPromises);
    }

    // ── Phase 3: Mark batches complete ────────────────────────────────────
    {
      const { data } = await admin.rpc('pulse_fire_batches_reconcile');
      stats.batches_completed = Number(data) || 0;
    }

    stats.wall_ms = Date.now() - workerStart;
    return jsonResponse({ success: true, ...stats });

  } catch (error: any) {
    console.error('pulseFireWorker error:', error);
    stats.wall_ms = Date.now() - workerStart;
    return errorResponse(`pulseFireWorker failed: ${error.message || error}`, 500);
  }
});
