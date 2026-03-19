import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const PROCESSOR_VERSION = "v3.0";

Deno.serve(async (req) => {
  try {
    // Health check probe
    const cloned = req.clone();
    const probeText = await cloned.text().catch(() => '');
    try {
      const probe = JSON.parse(probeText);
      if (probe?._health_check) {
        return Response.json({ _version: PROCESSOR_VERSION, _fn: 'receiveTonomoWebhook', _ts: '2026-03-17' });
      }
    } catch { /* not JSON or not a health check */ }

    const rawBody = probeText || await req.text();
    const receivedAt = new Date().toISOString();

    let payload = {};
    let parseError = null;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      parseError = `Body is not valid JSON: ${e.message}`;
      payload = { _raw: rawBody };
    }

    const headers = {};
    req.headers.forEach((value, key) => { headers[key] = value; });

    const action = detectAction(payload);
    const orderId = payload.orderId || payload.order?.orderId || payload.id || null;
    const signals = extractSignals(payload);
    const summary = buildSummary(payload, action);

    const base44 = createClientFromRequest(req);

    // Step 1: Always log first — never lose a webhook
    let logId = null;
    try {
      const log = await base44.asServiceRole.entities.TonomoWebhookLog.create({
        event_type: action,
        received_at: receivedAt,
        raw_payload: JSON.stringify(payload, null, 2),
        summary: summary,
        has_photographer: signals.has_photographer,
        has_services: signals.has_services,
        has_address: signals.has_address,
        has_agent: signals.has_agent,
        has_appointment_time: signals.has_appointment_time,
        parse_error: parseError,
        request_headers: JSON.stringify(headers),
        source_ip: req.headers.get('x-forwarded-for') || 'unknown',
      });
      logId = log?.id || null;
    } catch (dbErr) {
      console.error('Failed to write TonomoWebhookLog:', dbErr.message);
    }

    // Step 2: Enqueue — skip test payloads and unparseable events
    if (logId && !parseError && action !== 'unknown' && action !== 'test') {
      try {
        await base44.asServiceRole.entities.TonomoProcessingQueue.create({
          webhook_log_id: logId,
          action: action,
          order_id: orderId,
          status: 'pending',
          retry_count: 0,
          processor_version: PROCESSOR_VERSION,
          created_at: receivedAt,
        });
      } catch (qErr) {
        console.error('Failed to enqueue:', qErr.message);
      }

      // Step 3: Processing is handled by the frontend watchdog (auto-triggers every 30s)
      // No function-to-function HTTP call needed — the queue item is already enqueued above
    }

    return Response.json({ received: true, action, log_id: logId }, { status: 200 });

  } catch (err) {
    // Always return 200 to prevent Tonomo retries on our errors
    return Response.json({ received: true, error: err.message }, { status: 200 });
  }
});

function detectAction(p) {
  if (typeof p.orderId === 'string' && p.orderId.startsWith('test_')) return 'test';
  if (p.action) return p.action;
  if (p.bookingFlow && p.user) return 'new_customer';
  if (p.orderStatus === 'complete' && p.shouldNotifyOrderCompletion === true) return 'booking_completed';
  if (p.isValidatedForWebhook || p.orderStatus) return 'booking_created_or_changed';
  return 'unknown';
}

function extractSignals(p) {
  const photographer = p.photographers?.[0] || null;
  const agent = p.order?.listingAgents?.[0] || p.listingAgents?.[0] || null;
  const address = p.address?.formatted_address || p.location || p.order?.property_address?.formatted_address || p.property_address?.formatted_address || null;
  const services = [...(p.order?.services_a_la_cart || p.services_a_la_cart || []), ...(p.order?.services || p.services || [])].filter(Boolean);
  const startTime = p.when?.start_time || null;
  return {
    has_photographer: !!photographer,
    has_services: services.length > 0,
    has_address: !!address,
    has_agent: !!agent,
    has_appointment_time: !!startTime,
  };
}

function buildSummary(p, action) {
  const orderName = p.order?.orderName || p.orderName || p.order?.order_name || p.order_name || 'Unknown order';
  const photographer = p.photographers?.[0]?.name || null;
  const invoiceAmount = p.order?.invoice_amount ?? p.invoice_amount ?? null;
  const isOrderCancelled = action === 'canceled' ||
    (action === 'changed' && p.order?.orderStatus === 'cancelled') ||
    (action === 'booking_created_or_changed' && p.orderStatus === 'cancelled');

  if (action === 'test') return `Test webhook — ${orderName}`;
  if (isOrderCancelled) return `Order cancelled — ${orderName}`;
  if (action === 'scheduled') return `New shoot scheduled — ${orderName} — ${photographer ?? 'Unassigned'}`;
  if (action === 'rescheduled') return `Shoot rescheduled — ${orderName} — ${photographer ?? 'Unassigned'}`;
  if (action === 'canceled') return `Appointment cancelled — ${orderName}`;
  if (action === 'changed') return `Changed — ${orderName} — ${photographer ?? 'Unassigned'}`;
  if (action === 'booking_completed') return `Delivered — ${orderName}${invoiceAmount ? ` — $${invoiceAmount}` : ''}`;
  if (action === 'booking_created_or_changed') return `Order updated — ${orderName}${invoiceAmount ? ` — $${invoiceAmount}` : ''}`;
  if (action === 'new_customer') return `New customer — ${p.user?.name ?? ''} — ${p.user?.email ?? ''}`;
  return `Event — ${orderName}`;
}