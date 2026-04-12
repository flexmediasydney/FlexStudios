import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const PROCESSOR_VERSION = "v3.0";

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // Health check probe
    const cloned = req.clone();
    const probeText = await cloned.text().catch(() => '');
    try {
      const probe = JSON.parse(probeText);
      if (probe?._health_check || probe?._isHealthCheck || probe?.action === 'health_check') {
        return jsonResponse({ _version: PROCESSOR_VERSION, _fn: 'receiveTonomoWebhook', healthy: true, _ts: new Date().toISOString() });
      }
    } catch { /* not JSON or not a health check */ }

    const rawBody = probeText || await req.text();
    const receivedAt = new Date().toISOString();

    let payload: any = {};
    let parseError: string | null = null;
    try {
      payload = JSON.parse(rawBody);
    } catch (e: any) {
      parseError = `Body is not valid JSON: ${e.message}`;
      payload = { _raw: rawBody };
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });

    const action = detectAction(payload);
    // CRITICAL: Never fall back to payload.id — that's the appointment/event ID, not the order ID.
    // Using it would cause every appointment-level event (time change, people change) to create a duplicate project.
    const orderId = payload.orderId || payload.order?.orderId || null;
    const signals = extractSignals(payload);
    const summary = buildSummary(payload, action);

    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Step 1: Always log first — never lose a webhook
    let logId: string | null = null;
    try {
      const log = await entities.TonomoWebhookLog.create({
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
    } catch (dbErr: any) {
      console.error('Failed to write TonomoWebhookLog:', dbErr.message);
    }

    // Step 2: Enqueue — skip test payloads and unparseable events
    let queued = false;
    if (logId && !parseError && action !== 'unknown' && action !== 'test') {
      try {
        await entities.TonomoProcessingQueue.create({
          webhook_log_id: logId,
          action: action,
          order_id: orderId,
          event_id: payload.id || null,
          status: 'pending',
          retry_count: 0,
          processor_version: PROCESSOR_VERSION,
          created_at: receivedAt,
        });
        queued = true;
      } catch (qErr: any) {
        console.error(`CRITICAL: Failed to enqueue webhook ${logId} (action=${action}, order=${orderId}):`, qErr.message);
        // Attempt retry once after brief delay
        try {
          await new Promise(r => setTimeout(r, 500));
          await entities.TonomoProcessingQueue.create({
            webhook_log_id: logId, action, order_id: orderId,
            event_id: payload.id || null, status: 'pending',
            retry_count: 0, processor_version: PROCESSOR_VERSION, created_at: receivedAt,
          });
          queued = true;
        } catch (retryErr: any) {
          console.error(`CRITICAL: Retry enqueue also failed for ${logId}:`, retryErr.message);
        }
      }
    }

    return jsonResponse({ received: true, action, log_id: logId, queued }, 200);

  } catch (err: any) {
    // Always return 200 to prevent Tonomo retries on our errors
    return jsonResponse({ received: true, error: err.message }, 200);
  }
});

function detectAction(p: any): string {
  if (typeof p.orderId === 'string' && p.orderId.startsWith('test_')) return 'test';
  if (p.action) return p.action;
  if (p.bookingFlow && p.user) return 'new_customer';
  if (p.orderStatus === 'complete' && p.shouldNotifyOrderCompletion === true) return 'booking_completed';

  // ── Payment-only update detection ────────────────────────────────────────
  // If the payload has paymentStatus but NO scheduling signals (no address,
  // no services, no appointment time, no booking flow), this is a pure
  // payment/invoice status update — NOT a new booking. Route it to a
  // dedicated handler that ONLY updates existing projects (never creates).
  if (p.paymentStatus && !p.action) {
    const hasSchedulingSignals = !!(
      p.address || p.services || p.services_a_la_cart ||
      p.order?.services || p.order?.services_a_la_cart ||
      p.when?.start_time || p.bookingFlow || p.isValidatedForWebhook
    );
    if (!hasSchedulingSignals) return 'payment_updated';
  }

  // Require isValidatedForWebhook explicitly, or orderStatus with additional booking signals
  // to avoid misclassifying metadata pings that happen to have orderStatus
  if (p.isValidatedForWebhook) return 'booking_created_or_changed';
  if (p.orderStatus && (p.orderId || p.order?.orderId || p.orderName || p.order?.orderName || p.address || p.services)) return 'booking_created_or_changed';
  return 'unknown';
}

function extractSignals(p: any) {
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

function buildSummary(p: any, action: string): string {
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
