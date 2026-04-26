/**
 * drone-dispatcher-watchdog
 * ─────────────────────────
 * Wave 11 S3 (Cluster E) — Cron-driven health monitor for drone-job-dispatcher.
 *
 * Trigger: pg_cron 'drone-dispatcher-watchdog' (every 5 min) — see mig 314.
 *
 * Per invocation:
 *   1. Calls check_drone_dispatcher_health() RPC. The RPC inspects
 *      cron.job_run_details for the dispatcher's last successful tick.
 *      If >5 min ago it inserts a row into drone_dispatcher_health_alerts
 *      (deduped: at most one row per unhealthy stretch / per hour).
 *   2. Drains up to 10 unprocessed rows from drone_dispatcher_health_alerts.
 *   3. For each, fans out a 'drone_dispatcher_unhealthy' notification via
 *      fireNotif (master_admin recipients per notification_routing_rules).
 *      On success, marks the row processed=true so we don't re-notify.
 *      On failure (network blip, etc.) we leave processed=false so the next
 *      tick retries — this is why the dedup window in the RPC is 1 hour
 *      rather than "any unprocessed row exists" (we want the watchdog to be
 *      resilient to transient notify failures without spamming).
 *
 * Auth: __service_role__ (cron). Manually invocable by master_admin.
 * Deployed verify_jwt=false; auth via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getAdminClient,
  getUserFromReq,
  serveWithAudit,
  fireNotif,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-dispatcher-watchdog';
const MAX_DRAIN = 10;

type HealthAlert = {
  id: string;
  health_state: string;
  secs_since_last_tick: number | null;
  last_tick_at: string | null;
  last_tick_status: string | null;
  last_tick_msg: string | null;
};

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth: cron service role OR master_admin manual trigger.
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') return errorResponse('Forbidden', 403, req);
  }

  // Health-check probe (used by the platform health check).
  let body: { _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const admin = getAdminClient();

  // ── 1. Run the RPC (inserts an outbox row if unhealthy + deduped). ──────
  const { data: healthData, error: healthErr } = await admin.rpc(
    'check_drone_dispatcher_health',
  );
  if (healthErr) {
    console.error(`[${GENERATOR}] health check RPC failed:`, healthErr);
    return errorResponse(`health check failed: ${healthErr.message}`, 500, req);
  }

  // ── 2. Drain unprocessed outbox rows (oldest first). ────────────────────
  const { data: alertsRaw, error: alertsErr } = await admin
    .from('drone_dispatcher_health_alerts')
    .select('id, health_state, secs_since_last_tick, last_tick_at, last_tick_status, last_tick_msg')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(MAX_DRAIN);

  if (alertsErr) {
    console.error(`[${GENERATOR}] outbox read failed:`, alertsErr);
    return errorResponse(`outbox read failed: ${alertsErr.message}`, 500, req);
  }

  const alerts: HealthAlert[] = (alertsRaw || []) as HealthAlert[];

  // ── 3. Fan out notifications + mark processed. ──────────────────────────
  let notifiedCount = 0;
  const failedAlertIds: string[] = [];

  for (const alert of alerts) {
    try {
      const minutesSince =
        alert.secs_since_last_tick != null
          ? Math.round(alert.secs_since_last_tick / 60)
          : null;

      const title = `Drone dispatcher ${alert.health_state}`;
      const message =
        minutesSince != null
          ? `Last successful tick ${minutesSince} min ago. Drone pipeline halted — investigate cron + Edge Fn logs.`
          : `Dispatcher has never recorded a successful tick — investigate cron + Edge Fn logs.`;

      const ok = await fireNotif({
        type: 'drone_dispatcher_unhealthy',
        category: 'system',
        severity: 'critical',
        title,
        message,
        ctaLabel: 'View Diagnostics',
        source: GENERATOR,
        // One notification per alert row; alert.id is unique → safe key.
        idempotencyKey: `drone-dispatcher-watchdog-${alert.id}`,
      });

      if (!ok) {
        failedAlertIds.push(alert.id);
        continue;
      }

      const { error: updateErr } = await admin
        .from('drone_dispatcher_health_alerts')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('id', alert.id);

      if (updateErr) {
        console.error(
          `[${GENERATOR}] failed to mark alert ${alert.id} processed:`,
          updateErr,
        );
        // Notification did go out — don't add to failedAlertIds; next tick
        // will re-notify which is preferable to silently losing the mark.
        failedAlertIds.push(alert.id);
        continue;
      }

      notifiedCount++;
    } catch (notifErr) {
      console.error(
        `[${GENERATOR}] notify failed for alert ${alert.id}:`,
        notifErr,
      );
      failedAlertIds.push(alert.id);
      // Leave processed=false so next 5-min tick retries.
    }
  }

  return jsonResponse(
    {
      success: true,
      health: healthData,
      alerts_seen: alerts.length,
      alerts_processed: notifiedCount,
      alerts_remaining: alerts.length - notifiedCount,
      failed_alert_ids: failedAlertIds,
    },
    200,
    req,
  );
});
