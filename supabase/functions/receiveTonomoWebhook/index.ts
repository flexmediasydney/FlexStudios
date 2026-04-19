import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const PROCESSOR_VERSION = "v3.1";

// ─── HMAC signature verification ─────────────────────────────────────────────
// Tonomo does not yet sign webhooks (verified via 30-day header audit on
// tonomo_webhook_logs — no x-tonomo-signature / x-signature headers present).
// We ship the verifier now so the endpoint is ready the moment Tonomo adds
// a shared secret. Behaviour:
//   • No TONOMO_WEBHOOK_SECRET set           → log warning, allow (today)
//   • Secret set + TONOMO_WEBHOOK_VERIFY_STRICT ≠ 'true' (log-only)
//       → log pass/fail but always allow (soft rollout)
//   • Secret set + TONOMO_WEBHOOK_VERIFY_STRICT = 'true'
//       → reject 401 on missing/invalid signature
// Header probed (case-insensitive): x-tonomo-signature OR x-signature.
// Accepts hex or base64 encodings of the HMAC-SHA256 digest of the raw body.
async function verifyHmac(rawBody: string, req: Request): Promise<{ ok: boolean; reason: string }> {
  const secret = Deno.env.get('TONOMO_WEBHOOK_SECRET');
  if (!secret) {
    console.warn('TONOMO_WEBHOOK_SECRET not set — skipping verification');
    return { ok: true, reason: 'no_secret_configured' };
  }
  const sigHeader = req.headers.get('x-tonomo-signature') || req.headers.get('x-signature');
  if (!sigHeader) return { ok: false, reason: 'missing_signature_header' };
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const cleanSig = sigHeader.replace(/^sha256=/i, '').trim();
    let sigBytes: Uint8Array;
    if (/^[0-9a-f]+$/i.test(cleanSig) && cleanSig.length % 2 === 0) {
      sigBytes = Uint8Array.from(cleanSig.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    } else {
      sigBytes = Uint8Array.from(atob(cleanSig), c => c.charCodeAt(0));
    }
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(rawBody));
    return { ok, reason: ok ? 'valid' : 'signature_mismatch' };
  } catch (e: any) {
    return { ok: false, reason: `verify_error:${e.message}` };
  }
}

// ─── Dedup-aware queue insert ────────────────────────────────────────────────
// Background — 2026-04-19 investigation ("93 of 285 last-7d drops"):
//   Two schema features conspire to hide duplicate-burst drops:
//     1. Partial UNIQUE index idx_queue_event_id_action_dedup on
//        (event_id, action) WHERE event_id IS NOT NULL
//                           AND status IN ('pending','processing')
//     2. BEFORE-INSERT trigger trg_queue_insert_pending (function
//        guard_queue_insert_pending) that clamps EVERY inserted row to
//        status='pending' regardless of the value passed by the caller.
//   Tonomo fans out 3-10 webhooks per booking edit carrying the same event_id
//   and action. The first insert succeeds; every subsequent insert 23505's
//   because (a) the prior row is still 'pending', (b) the trigger forces the
//   incoming row to 'pending' too, (c) the partial index catches the collision.
//   The old code logged "CRITICAL", retried once (same trap), then silently
//   returned queued=false — leaving a webhook_log row with NO queue row.
//   That's the 93-row audit gap.
//
// Fix: detect 23505, then do a two-step dance the trigger/index cannot block:
//   Step A: INSERT with event_id=NULL (sidesteps the partial-index predicate
//           because it requires event_id IS NOT NULL). Trigger still forces
//           status='pending' — that's fine, row is off the unique index.
//   Step B: UPDATE the row to set event_id back to its real value AND flip
//           status to 'superseded'. UPDATE does NOT fire the BEFORE-INSERT
//           trigger. With status='superseded' the row stays outside the
//           partial index predicate, so no collision occurs. Audit trail is
//           preserved and the processor's in-memory dedup (processTonomoQueue
//           line 160 `seen` map) already matches this semantics.
async function enqueueWithDedupGuard(
  admin: any,
  entities: any,
  row: {
    webhook_log_id: string;
    action: string;
    order_id: string | null;
    event_id: string | null;
  },
): Promise<{ queued: boolean; superseded_duplicate: boolean; error: string | null }> {
  const now = new Date().toISOString();
  try {
    await entities.TonomoProcessingQueue.create({
      webhook_log_id: row.webhook_log_id,
      action: row.action,
      order_id: row.order_id,
      event_id: row.event_id,
      status: 'pending',
      retry_count: 0,
      processor_version: PROCESSOR_VERSION,
      created_at: now,
    });
    return { queued: true, superseded_duplicate: false, error: null };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    // Postgres 23505 = unique_violation. PostgREST surfaces either the raw code
    // or a "duplicate key value violates unique constraint" text — detect leniently.
    const isDedupConflict =
      msg.includes('idx_queue_event_id_action_dedup') ||
      msg.includes('duplicate key') ||
      msg.includes('23505');
    if (!isDedupConflict) {
      return { queued: false, superseded_duplicate: false, error: msg };
    }
    // Step A — insert with event_id=NULL to skip the partial index predicate.
    try {
      const { data: inserted, error: insErr } = await admin
        .from('tonomo_processing_queue')
        .insert({
          webhook_log_id: row.webhook_log_id,
          action: row.action,
          order_id: row.order_id,
          event_id: null, // ← predicate requires event_id IS NOT NULL, so we stay off the index
          retry_count: 0,
          processor_version: PROCESSOR_VERSION,
          created_at: now,
        })
        .select('id')
        .single();
      if (insErr || !inserted?.id) {
        const insMsg = insErr?.message || 'no row returned';
        return { queued: false, superseded_duplicate: false, error: `dedup_fallback_insert_failed:${insMsg}` };
      }
      // Step B — restore event_id and flip to 'superseded'. Trigger is BEFORE
      // INSERT only; UPDATE sails through. status='superseded' keeps the row
      // outside the partial unique index predicate → no collision.
      const { error: updErr } = await admin
        .from('tonomo_processing_queue')
        .update({
          event_id: row.event_id,
          status: 'superseded',
          result_summary: 'Superseded at ingest — duplicate of in-flight (event_id,action) pair',
          processed_at: now,
        })
        .eq('id', inserted.id);
      if (updErr) {
        // Insert landed but the status flip didn't. The row is still
        // status='pending' with event_id=null — the processor will pick it up
        // and run it as a no-op lookup (no matching orderId+event_id trail).
        // Strictly better than a total drop. Warn loudly.
        console.warn(
          `enqueueWithDedupGuard: inserted ${inserted.id} but superseded UPDATE failed: ${updErr.message}`,
        );
        return { queued: true, superseded_duplicate: false, error: `partial_success:${updErr.message}` };
      }
      return { queued: false, superseded_duplicate: true, error: null };
    } catch (supErr: any) {
      const supMsg = String(supErr?.message || supErr || '');
      console.error(
        `enqueueWithDedupGuard: primary 23505 (${msg.substring(0, 120)}); ` +
        `fallback insert/update threw (${supMsg.substring(0, 120)})`,
      );
      return { queued: false, superseded_duplicate: false, error: `dedup_fallback_threw:${supMsg}` };
    }
  }
}

serveWithAudit('receiveTonomoWebhook', async (req) => {
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

    // ─── HMAC verification (log-only by default) ─────────────────────────
    const hmacResult = await verifyHmac(rawBody, req);
    const strictMode = Deno.env.get('TONOMO_WEBHOOK_VERIFY_STRICT') === 'true';
    if (!hmacResult.ok) {
      if (strictMode) {
        console.warn(`Rejected webhook — invalid signature (${hmacResult.reason})`);
        return new Response('Unauthorized', { status: 401 });
      } else {
        console.warn(`HMAC verification failed (log-only mode): ${hmacResult.reason}`);
      }
    }

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
    // ── Note on tonomo_webhook_log_payloads (migration 096) ───────────
    // A payload side-table exists for future growth-mitigation. For now
    // we keep raw_payload on the main row because SettingsTonomoWebhooks
    // parses it per-row to display orderId / photographer / agent / etc.
    // Splitting here would silently break that page. The header table is
    // still small (~11 MB) so this isn't urgent. TTL cron (migration 096)
    // caps growth at 180 days. If the webhook UI is ever refactored to
    // pre-compute those fields, split this the same way we did for sync logs.
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

    // Step 2: Enqueue — skip test payloads and unparseable events.
    // Every non-test, parseable webhook MUST result in a queue row (either
    // status='pending' for normal processing, or status='superseded' for
    // burst duplicates) so we preserve audit completeness.
    let queued = false;
    let superseded = false;
    let enqueueError: string | null = null;
    if (logId && !parseError && action !== 'unknown' && action !== 'test') {
      const result = await enqueueWithDedupGuard(admin, entities, {
        webhook_log_id: logId,
        action: action,
        order_id: orderId,
        event_id: payload.id || null,
      });
      queued = result.queued;
      superseded = result.superseded_duplicate;
      enqueueError = result.error;
      if (enqueueError) {
        console.error(
          `Failed to enqueue webhook ${logId} (action=${action}, order=${orderId}): ${enqueueError}`,
        );
        // One more retry with brief backoff — mirrors the original behaviour
        // for transient failures (not dedup conflicts, which we already handled).
        await new Promise(r => setTimeout(r, 500));
        const retry = await enqueueWithDedupGuard(admin, entities, {
          webhook_log_id: logId,
          action: action,
          order_id: orderId,
          event_id: payload.id || null,
        });
        queued = retry.queued;
        superseded = retry.superseded_duplicate;
        if (retry.error) {
          console.error(`CRITICAL: Retry enqueue also failed for ${logId}: ${retry.error}`);
          enqueueError = retry.error;
        } else {
          enqueueError = null;
        }
      }
    }

    return jsonResponse({ received: true, action, log_id: logId, queued, superseded, enqueue_error: enqueueError }, 200);

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
