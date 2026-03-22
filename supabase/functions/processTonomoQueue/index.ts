import { getAdminClient, createEntities, handleCors, jsonResponse } from '../_shared/supabase.ts';
import { PROCESSOR_VERSION, BATCH_SIZE, LOCK_TTL_SECONDS } from './types.ts';
import {
  extractOrderIdFromPayload,
  writeAudit,
  releaseLock,
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

  if (!orderId) {
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

  if (action === 'scheduled') return handleScheduled(entities, orderId, payload, 'scheduled');
  if (action === 'rescheduled') return handleRescheduled(entities, orderId, payload);
  if (action === 'canceled') return handleCancelled(entities, orderId, payload);
  if (action === 'changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'changed') return handleChanged(entities, orderId, payload);
  if (action === 'booking_created_or_changed' && isOrderCancelled) return handleCancelled(entities, orderId, payload);
  if (action === 'booking_created_or_changed') return handleOrderUpdate(entities, orderId, payload);
  if (action === 'booking_completed') return handleDelivered(entities, orderId, payload);
  if (action === 'new_customer') return handleNewCustomer(entities, payload);

  return { summary: `Skipped unknown action: ${action}`, skipped: true };
}

// Entry point
Deno.serve(async (req) => {
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

  const settings = await safeList(entities, 'TonomoIntegrationSettings', 1);
  const s = settings?.[0];

  const results: any = { processed: 0, failed: 0, skipped: 0 };

  try {
    await safeUpdate(entities, 'TonomoIntegrationSettings', { heartbeat_at: new Date().toISOString() });

    // Atomic lock — use Postgres advisory lock to prevent concurrent runs (TOCTOU-safe)
    const LOCK_KEY = 424242; // arbitrary unique integer for this processor
    let lockResult: any = null;
    try {
      const lockResp = await admin.rpc('pg_try_advisory_lock', { lock_id: LOCK_KEY });
      lockResult = lockResp?.data ?? null;
    } catch { lockResult = null; }
    // Fallback to settings-based lock if advisory lock RPC not available
    const gotAdvisoryLock = lockResult === true;
    if (!gotAdvisoryLock) {
      // Fallback: settings-based lock (original approach, kept for compatibility)
      if (s?.processing_lock_at) {
        const lockStr = s.processing_lock_at.replace(/Z$/, '') + 'Z';
        const lockAge = (Date.now() - new Date(lockStr).getTime()) / 1000;
        if (!isNaN(lockAge) && lockAge < LOCK_TTL_SECONDS) {
          return jsonResponse({ skipped: true, reason: 'lock_active', lock_age: lockAge });
        }
      }
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
        const key = `${item.action}:${item.order_id}:${item.event_id || ''}`;
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
    // Skip items with no order_id
    if (noOrder.length > 0) {
      await Promise.all(noOrder.map(item =>
        entities.TonomoProcessingQueue.update(item.id, {
          status: 'skipped',
          error_message: 'No order_id — cannot match to project',
        }).catch(() => {})
      ));
      results.skipped += noOrder.length;
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

        const payload = JSON.parse(log.raw_payload);
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
        await entities.TonomoProcessingQueue.update(item.id, {
          status: newStatus,
          retry_count: retries,
          error_message: err.message?.substring(0, 500),
          last_failed_at: new Date().toISOString(),
        });
        results.failed++;
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
    await releaseLock(entities, s);
    console.error('Processor fatal error:', err.message);
    return jsonResponse({ error: err.message }, 200);
  }
});
