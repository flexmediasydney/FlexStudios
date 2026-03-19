import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const steps: any[] = [];

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    steps.push({ step: 1, name: 'createClient', ok: true });

    // Step 2: Can we read settings?
    let settings: any = null;
    try {
      const list = await entities.TonomoIntegrationSettings.list('-created_date', 1);
      settings = list?.[0] || null;
      steps.push({ step: 2, name: 'readSettings', ok: true, hasSettings: !!settings, lockAt: settings?.processing_lock_at || null });
    } catch (e: any) {
      steps.push({ step: 2, name: 'readSettings', ok: false, error: e.message });
    }

    // Step 2b: Clear the lock if stuck
    if (settings?.id && settings?.processing_lock_at) {
      try {
        await entities.TonomoIntegrationSettings.update(settings.id, { processing_lock_at: null });
        steps.push({ step: '2b', name: 'clearLock', ok: true });
      } catch (e: any) {
        steps.push({ step: '2b', name: 'clearLock', ok: false, error: e.message });
      }
    }

    // Step 3: Can we read the queue?
    let pending: any[] = [];
    let failed: any[] = [];
    let deadLetter: any[] = [];
    try {
      const queue = await entities.TonomoProcessingQueue.list('-created_date', 100);
      pending = queue.filter((q: any) => q.status === 'pending');
      failed = queue.filter((q: any) => q.status === 'failed');
      deadLetter = queue.filter((q: any) => q.status === 'dead_letter');
      steps.push({
        step: 3, name: 'readQueue', ok: true,
        pending: pending.length,
        failed: failed.length,
        deadLetter: deadLetter.length,
        failedErrors: failed.slice(0, 3).map((q: any) => ({ id: q.id, action: q.action, order_id: q.order_id, error: q.error_message, retries: q.retry_count })),
        deadLetterErrors: deadLetter.slice(0, 3).map((q: any) => ({ id: q.id, action: q.action, order_id: q.order_id, error: q.error_message, retries: q.retry_count })),
      });
    } catch (e: any) {
      steps.push({ step: 3, name: 'readQueue', ok: false, error: e.message });
    }

    // Step 4: Can we read a webhook log?
    const testItem = pending[0] || failed[0] || deadLetter[0];
    if (testItem?.webhook_log_id) {
      try {
        const log = await entities.TonomoWebhookLog.get(testItem.webhook_log_id);
        const hasPayload = !!log?.raw_payload;
        let payloadPreview = null;
        if (hasPayload) {
          try {
            const p = JSON.parse(log.raw_payload);
            payloadPreview = { action: p.action, orderId: p.orderId, orderName: p.orderName || p.order?.orderName };
          } catch {}
        }
        steps.push({ step: 4, name: 'readWebhookLog', ok: true, hasPayload, payloadPreview });
      } catch (e: any) {
        steps.push({ step: 4, name: 'readWebhookLog', ok: false, error: e.message });
      }
    } else {
      steps.push({ step: 4, name: 'readWebhookLog', ok: null, reason: 'no queue items to test' });
    }

    // Step 5: Can we read Projects?
    try {
      const projects = await entities.Project.list('-created_date', 1);
      steps.push({ step: 5, name: 'readProjects', ok: true, count: projects?.length || 0 });
    } catch (e: any) {
      steps.push({ step: 5, name: 'readProjects', ok: false, error: e.message });
    }

    // Step 6: Can we read mapping table?
    try {
      const maps = await entities.TonomoMappingTable.list('-created_date', 5);
      steps.push({ step: 6, name: 'readMappings', ok: true, count: maps?.length || 0 });
    } catch (e: any) {
      steps.push({ step: 6, name: 'readMappings', ok: false, error: e.message });
    }

    // Step 7: Reset first failed/dead_letter item to pending and try processing it
    const retryTarget = failed[0] || deadLetter[0];
    if (retryTarget) {
      try {
        await entities.TonomoProcessingQueue.update(retryTarget.id, {
          status: 'pending',
          retry_count: 0,
          error_message: null,
        });
        steps.push({ step: 7, name: 'resetOneItem', ok: true, id: retryTarget.id, action: retryTarget.action });
      } catch (e: any) {
        steps.push({ step: 7, name: 'resetOneItem', ok: false, error: e.message });
      }
    }

    return jsonResponse({ diagnosis: 'complete', steps }, 200);

  } catch (e: any) {
    steps.push({ step: 'fatal', error: e.message, stack: e.stack?.substring(0, 500) });
    return jsonResponse({ diagnosis: 'fatal_error', steps }, 200);
  }
});
