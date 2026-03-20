import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  const steps = [];
  
  try {
    // Step 1: Can we create a client?
    const base44 = createClientFromRequest(req);
    steps.push({ step: 1, name: 'createClient', ok: true });

    // Step 2: Can we read settings?
    let settings = null;
    try {
      const list = await base44.asServiceRole.entities.TonomoIntegrationSettings.list('-created_date', 1);
      settings = list?.[0] || null;
      steps.push({ step: 2, name: 'readSettings', ok: true, hasSettings: !!settings, lockAt: settings?.processing_lock_at || null });
    } catch (e) {
      steps.push({ step: 2, name: 'readSettings', ok: false, error: e.message });
    }

    // Step 2b: Clear the lock if stuck
    if (settings?.id && settings?.processing_lock_at) {
      try {
        await base44.asServiceRole.entities.TonomoIntegrationSettings.update(settings.id, { processing_lock_at: null });
        steps.push({ step: '2b', name: 'clearLock', ok: true });
      } catch (e) {
        steps.push({ step: '2b', name: 'clearLock', ok: false, error: e.message });
      }
    }

    // Step 3: Can we read the queue?
    let pending = [];
    let failed = [];
    let deadLetter = [];
    try {
      const queue = await base44.asServiceRole.entities.TonomoProcessingQueue.list('-created_date', 100);
      pending = queue.filter(q => q.status === 'pending');
      failed = queue.filter(q => q.status === 'failed');
      deadLetter = queue.filter(q => q.status === 'dead_letter');
      steps.push({ 
        step: 3, name: 'readQueue', ok: true, 
        pending: pending.length, 
        failed: failed.length, 
        deadLetter: deadLetter.length,
        failedErrors: failed.slice(0, 3).map(q => ({ id: q.id, action: q.action, order_id: q.order_id, error: q.error_message, retries: q.retry_count })),
        deadLetterErrors: deadLetter.slice(0, 3).map(q => ({ id: q.id, action: q.action, order_id: q.order_id, error: q.error_message, retries: q.retry_count })),
      });
    } catch (e) {
      steps.push({ step: 3, name: 'readQueue', ok: false, error: e.message });
    }

    // Step 4: Can we read a webhook log?
    const testItem = pending[0] || failed[0] || deadLetter[0];
    if (testItem?.webhook_log_id) {
      try {
        const log = await base44.asServiceRole.entities.TonomoWebhookLog.get(testItem.webhook_log_id);
        const hasPayload = !!log?.raw_payload;
        let payloadPreview = null;
        if (hasPayload) {
          try {
            const p = JSON.parse(log.raw_payload);
            payloadPreview = { action: p.action, orderId: p.orderId, orderName: p.orderName || p.order?.orderName };
          } catch {}
        }
        steps.push({ step: 4, name: 'readWebhookLog', ok: true, hasPayload, payloadPreview });
      } catch (e) {
        steps.push({ step: 4, name: 'readWebhookLog', ok: false, error: e.message });
      }
    } else {
      steps.push({ step: 4, name: 'readWebhookLog', ok: null, reason: 'no queue items to test' });
    }

    // Step 5: Can we read Projects?
    try {
      const projects = await base44.asServiceRole.entities.Project.list('-created_date', 1);
      steps.push({ step: 5, name: 'readProjects', ok: true, count: projects?.length || 0 });
    } catch (e) {
      steps.push({ step: 5, name: 'readProjects', ok: false, error: e.message });
    }

    // Step 6: Can we read mapping table?
    try {
      const maps = await base44.asServiceRole.entities.TonomoMappingTable.list('-created_date', 5);
      steps.push({ step: 6, name: 'readMappings', ok: true, count: maps?.length || 0 });
    } catch (e) {
      steps.push({ step: 6, name: 'readMappings', ok: false, error: e.message });
    }

    // Step 7: Reset first failed/dead_letter item to pending and try processing it
    const retryTarget = failed[0] || deadLetter[0];
    if (retryTarget) {
      try {
        await base44.asServiceRole.entities.TonomoProcessingQueue.update(retryTarget.id, {
          status: 'pending',
          retry_count: 0,
          error_message: null,
        });
        steps.push({ step: 7, name: 'resetOneItem', ok: true, id: retryTarget.id, action: retryTarget.action });
      } catch (e) {
        steps.push({ step: 7, name: 'resetOneItem', ok: false, error: e.message });
      }
    }

    return Response.json({ diagnosis: 'complete', steps }, { status: 200 });

  } catch (e) {
    steps.push({ step: 'fatal', error: e.message, stack: e.stack?.substring(0, 500) });
    return Response.json({ diagnosis: 'fatal_error', steps }, { status: 200 });
  }
});