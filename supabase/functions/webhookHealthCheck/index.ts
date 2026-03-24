import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCors, getCorsHeaders } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const webhookUrl = `${supabaseUrl}/functions/v1/receiveTonomoWebhook`;
    const checks = { reachable: false, statusOk: false, responseValid: false, latencyMs: 0, error: null as string | null };

    // Send a health check ping
    const start = performance.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'health_check',
          orderId: 'health_' + Date.now(),
          orderName: 'Automated Health Check',
          _isHealthCheck: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      checks.reachable = true;
      checks.latencyMs = Math.round(performance.now() - start);
      checks.statusOk = res.status >= 200 && res.status < 300;

      if (!checks.statusOk) {
        const body = await res.text().catch(() => '');
        checks.error = `HTTP ${res.status}: ${body.substring(0, 200)}`;
      } else {
        try {
          await res.json();
          checks.responseValid = true;
        } catch {
          checks.error = 'Invalid JSON response';
        }
      }
    } catch (err: any) {
      checks.error = err.name === 'AbortError'
        ? 'Timeout (>15s) — webhook unresponsive'
        : (err.message || 'Network error');
    }

    const isHealthy = checks.reachable && checks.statusOk && checks.responseValid;

    // Log the health check result
    await admin.from('tonomo_audit_logs').insert({
      action: 'health_check',
      entity_type: 'webhook',
      operation: isHealthy ? 'healthy' : 'unhealthy',
      notes: JSON.stringify(checks),
      processed_at: new Date().toISOString(),
    }).catch(() => {});

    // If unhealthy, notify ALL master_admin users
    if (!isHealthy) {
      const { data: admins } = await admin
        .from('users')
        .select('id, email, full_name')
        .eq('role', 'master_admin')
        .eq('is_active', true);

      if (admins?.length) {
        const notifications = admins.map(a => ({
          user_id: a.id,
          type: 'webhook_health_alert',
          title: 'Webhook Health Alert',
          message: `The Tonomo webhook is ${checks.reachable ? 'responding with errors' : 'UNREACHABLE'}. ${checks.error || 'Check the Tonomo integration settings.'}`,
          category: 'system',
          priority: 'high',
          is_read: false,
        }));

        await admin.from('notifications').insert(notifications).catch(() => {});

        console.error('WEBHOOK UNHEALTHY:', JSON.stringify(checks));
      }
    }

    return new Response(JSON.stringify({
      healthy: isHealthy,
      checks,
      timestamp: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: isHealthy ? 200 : 503,
    });
  } catch (err: any) {
    console.error('Health check error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
