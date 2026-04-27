import { getAdminClient, createEntities, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { tryAcquireMutex, releaseMutex } from '../_shared/dispatcherMutex.ts';
import { PROCESSOR_VERSION, BATCH_SIZE } from './types.ts';
import {
  extractOrderIdFromPayload,
  writeAudit,
  releaseLock,
  fireAdminNotif,
  safeList,
  safeUpdate,
  recoverFailedItems,
} from './utils.ts';
import { handleScheduled } from './handlers/handleScheduled.ts';
import { handleRescheduled } from './handlers/handleRescheduled.ts';
import { handleChanged } from './handlers/handleChanged.ts';
import { handleCancelled } from './handlers/handleCancelled.ts';
import { handleDelivered } from './handlers/handleDelivered.ts';
import { handleOrderUpdate } from './handlers/handleOrderUpdate.ts';
import { handleNewCustomer } from './handlers/handleNewCustomer.ts';

// Main router
async function processItem(entities: any, item: any, payload: any) {
  const action = item.action;
  const orderId = item.order_id || extractOrderIdFromPayload(payload);

  // new_customer doesn't need an orderId
  if (!orderId && action !== 'new_customer') {
    await writeAudit(entities, {
      action: item.action, entity_type: 'System', entity_id: null,
      operation: 'skipped', tonomo_order_id: null,
      notes: 'Skipped — no orderId in queue item or payload. Cannot match to project.',
    });
    return { summary: 'Skipped — no orderId', skipped: true };
  }

  const effectiveOrderStatus = payload.orderStatus || payload.order?.orderStatus;
  const isOrderCancelled =
    action === 'canceled' ||
    (action === 'changed' && effectiveOrderStatus === 'cancelled') ||
    (action === 'booking_created_or_changed' && effectiveOrderStatus === 'cancelled');

  // Context threaded to handlers so they can stash a pending delta with
  // full traceability back to the queue item + webhook log.
  const ctx = {
    queueRowId: item.id || null,
    webhookLogId: item.webhook_log_id || null,
    eventType: action,
  };

  if (action === 'scheduled') return handleScheduled(entities, orderId, payload, 'scheduled', ctx);
  if (action === 'rescheduled') return handleRescheduled(entities, orderId, payload, ctx);
  if (action === 'canceled') return handleCancelled(entities, orderId, payload);
  if (action === 'changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'changed') return handleChanged(entities, orderId, payload, ctx);
  if (action === 'booking_created_or_changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'booking_created_or_changed') return handleOrderUpdate(entities, orderId, payload, false, ctx);
  if (action === 'payment_updated') return handleOrderUpdate(entities, orderId, payload, true, ctx); // paymentOnly flag
  if (action === 'booking_completed') return handleDelivered(entities, orderId, payload);
  if (action === 'new_customer') return handleNewCustomer(entities, payload);

  return { summary: `Skipped unknown action: ${action}`, skipped: true };
}

// Entry point
serveWithAudit('processTonomoQueue', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const admin = getAdminClient();
  const entities = createEntities(admin);

  // Health check probe
  try {
    const probeBody = await req.clone().json().catch(() => null);
    if (probeBody?._health_check) {
      return jsonResponse({ _version: PROCESSOR_VERSION, _fn: 'processTonomoQueue', _ts: '2026-03-17' });
    }
  } catch { /* not a health check */ }

  // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
  // Accepts user JWT or service-role (cross-fn from triggerTonomoProcessing/cron).
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401, req);

  const settings = await safeList(entities, 'TonomoIntegrationSettings', 1);
  const s = settings?.[0];

  const results: any = { processed: 0, failed: 0, skipped: 0 };

  // ── Wave 7 P1-11 follow-up: row-based dispatcher mutex (replaces broken
  // pg_try_advisory_lock pattern). Advisory locks are session-scoped and
  // PostgREST routes the unlock RPC to a different connection than the
  // acquire RPC — silent unlock failures and stale-lock accumulation. The
  // dispatcher_locks table (mig 336) is connection-pool agnostic. See
  // _shared/dispatcherMutex.ts and the W7.5 design spec.
  const DISPATCHER_LOCK_NAME = 'process-tonomo-queue';
  const tickId = crypto.randomUUID();
  let lockAcquired = false;

  try {
    await safeUpdate(entities, 'TonomoIntegrationSettings', { heartbeat_at: new Date().toISOString() });

    lockAcquired = await tryAcquireMutex(admin, DISPATCHER_LOCK_NAME, tickId);
    if (!lockAcquired) {
      return jsonResponse({ skipped: true, reason: 'concurrent_dispatch' });
    }

    if (s?.id) {
      await entities.TonomoIntegrationSettings.update(s.id, {
        processing_lock_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        processor_version: PROCESSOR_VERSION,
      });
    }

    await recoverFailedItems(entities);

    const pendingItems = await entities.TonomoProcessingQueue.filter(
      { status: 'pending' },
      'created_at',
      BATCH_SIZE
    ) || [];

    if (!pendingItems.length) {
      await releaseLock(entities, s);
      return jsonResponse({ processed: 0, message: 'queue_empty' });
    }

    const byOrder: Record<string, any[]> = {};
    const noOrder: any[] = [];
    for (const item of pendingItems) {
      if (item.order_id) {
        if (!byOrder[item.order_id]) byOrder[item.order_id] = [];
        byOrder[item.order_id].push(item);
      } else {
        noOrder.push(item);
      }
    }

    // ── FIFO processing order ──────────────────────────────────────────
    // Process events strictly in chronological order (created_at).
    // Safety comes from handler-level guards, NOT from reordering:
    //   • handleOrderUpdate does NOT write shoot_date/shoot_time
    //   • handleChanged / handleRescheduled backfill appointment IDs
    //   • handleScheduled creates projects; rescheduled/changed update them
    // Appointment-first sorting was removed because it promotes rescheduled
    // BEFORE the project-creating BCC event, causing orphan skips.
    const toProcess: any[] = [];
    for (const [, items] of Object.entries(byOrder)) {
      const sorted = items.sort((a: any, b: any) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const seen = new Map();
      const toSupersede: string[] = [];
      for (const item of sorted) {
        // Each action type gets its own dedup key — don't collapse 'scheduled' and
        // 'booking_created_or_changed' since they carry different data (appointment vs order level).
        // Include event_id only when present to avoid collapsing unrelated order-level events.
        const key = item.event_id
          ? `${item.action}:${item.order_id}:${item.event_id}`
          : `${item.action}:${item.id}`; // Use queue item ID as fallback for uniqueness
        if (seen.has(key)) toSupersede.push(seen.get(key).id);
        seen.set(key, item);
      }
      if (toSupersede.length) {
        await Promise.all(toSupersede.map(id =>
          entities.TonomoProcessingQueue.update(id, { status: 'superseded' })
        ));
      }
      toProcess.push(...Array.from(seen.values()));
    }
    // Skip items with no order_id (except new_customer which doesn't need one)
    if (noOrder.length > 0) {
      const noOrderToSkip = noOrder.filter(item => item.action !== 'new_customer');
      const noOrderToProcess = noOrder.filter(item => item.action === 'new_customer');
      await Promise.all(noOrderToSkip.map(item =>
        entities.TonomoProcessingQueue.update(item.id, {
          status: 'skipped',
          error_message: 'No order_id — cannot match to project',
        }).catch(() => {})
      ));
      results.skipped += noOrderToSkip.length;
      toProcess.push(...noOrderToProcess);
    }

    for (const item of toProcess) {
      await entities.TonomoProcessingQueue.update(item.id, { status: 'processing' });

      try {
        const log = await entities.TonomoWebhookLog.get(item.webhook_log_id);
        if (!log?.raw_payload) {
          await entities.TonomoProcessingQueue.update(item.id, {
            status: 'failed',
            error_message: 'No raw_payload in log',
            last_failed_at: new Date().toISOString(),
          });
          results.failed++;
          continue;
        }

        let payload: any;
        try {
          payload = JSON.parse(log.raw_payload);
        } catch (parseErr: any) {
          await entities.TonomoProcessingQueue.update(item.id, {
            status: 'dead_letter',
            error_message: `Corrupt raw_payload JSON: ${parseErr.message?.substring(0, 200)}`,
            last_failed_at: new Date().toISOString(),
          });
          results.failed++;
          continue;
        }
        const result = await processItem(entities, item, payload);

        await entities.TonomoProcessingQueue.update(item.id, {
          status: 'completed',
          result_summary: result.summary,
          processed_at: new Date().toISOString(),
        });

        if (result.skipped) results.skipped++;
        else results.processed++;

      } catch (err: any) {
        const retries = (item.retry_count || 0) + 1;
        const newStatus = retries >= 3 ? 'dead_letter' : 'failed';
        try {
          await entities.TonomoProcessingQueue.update(item.id, {
            status: newStatus,
            retry_count: retries,
            error_message: err.message?.substring(0, 500),
            last_failed_at: new Date().toISOString(),
          });
        } catch (updateErr: any) {
          console.error(`Failed to update queue item ${item.id} status to ${newStatus}:`, updateErr.message);
        }
        results.failed++;
        if (newStatus === 'dead_letter') {
          fireAdminNotif(entities, {
            type: 'queue_dead_letter',
            category: 'tonomo',
            severity: 'critical',
            title: `Dead letter — ${item.action} for order ${item.order_id || 'unknown'}`,
            message: `Queue item failed 3 times and moved to dead letter. Error: ${err.message?.substring(0, 200)}. Manual intervention required.`,
            source: 'processTonomoQueue',
            idempotencyKeySuffix: `dead_letter:${item.id}`,
          }).catch(() => {});
        }
        await writeAudit(entities, {
          queue_item_id: item.id,
          action: item.action,
          entity_type: 'System',
          entity_id: null,
          operation: 'failed',
          tonomo_order_id: item.order_id,
          notes: `${newStatus === 'dead_letter' ? 'DEAD LETTER after 3 retries' : 'Failed attempt ' + retries}: ${err.message?.substring(0, 300)}`,
        });
      }
    }

    await releaseLock(entities, s);
    return jsonResponse({ ...results, batch_size: toProcess.length });

  } catch (err: any) {
    await releaseLock(entities, s).catch(() => {});
    console.error('Processor fatal error:', err.message);
    // Return 200 to prevent cron/scheduler retries on internal errors (queue has its own retry logic)
    return jsonResponse({ error: err.message }, 200);
  } finally {
    if (lockAcquired) {
      // Stale-lock pre-clear on the next tick covers the case where this
      // release fails silently — log and keep moving so a release error
      // can never wedge subsequent ticks.
      await releaseMutex(admin, DISPATCHER_LOCK_NAME, tickId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[processTonomoQueue] mutex release failed (will be cleaned up by stale-lock sweep): ${msg}`,
        );
      });
    }
  }
});
