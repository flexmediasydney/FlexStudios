import { handleCors, jsonResponse, getAdminClient, getUserFromReq, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const VALID_STATUSES = ['identified', 'investigating', 'passed', 'checked', 'red_flag'];
const RESOLVED_STATUSES = ['passed', 'checked', 'red_flag'];

serveWithAudit('updateRetentionAlert', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const body = await req.json().catch(() => null);
    if (!body || !body.action) {
      return jsonResponse({ error: 'Missing action field' }, 400, req);
    }

    const admin = getAdminClient();

    // ─── update_status ─────────────────────────────────────────────────
    if (body.action === 'update_status') {
      const { alert_id, status, user_id, user_name, user_email } = body;

      if (!alert_id || !status) {
        return jsonResponse({ error: 'alert_id and status are required' }, 400, req);
      }
      if (!VALID_STATUSES.includes(status)) {
        return jsonResponse({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400, req);
      }

      // Fetch current alert
      const { data: alert, error: fetchErr } = await admin
        .from('retention_alerts')
        .select('*')
        .eq('id', alert_id)
        .single();

      if (fetchErr || !alert) {
        return jsonResponse({ error: 'Retention alert not found' }, 404, req);
      }

      const oldStatus = alert.investigation_status || 'identified';
      const now = new Date().toISOString();

      const updatePayload: Record<string, any> = {
        investigation_status: status,
        updated_at: now,
      };

      // Set investigated_by fields when transitioning to 'investigating'
      if (status === 'investigating') {
        updatePayload.investigated_by = user_id || null;
        updatePayload.investigated_by_name = user_name || null;
        updatePayload.investigated_at = now;
      }

      // Set resolved_at when transitioning to a resolved status
      if (RESOLVED_STATUSES.includes(status)) {
        updatePayload.resolved_at = now;
      }

      const { error: updateErr } = await admin
        .from('retention_alerts')
        .update(updatePayload)
        .eq('id', alert_id);

      if (updateErr) {
        console.error('Failed to update retention alert:', updateErr);
        return jsonResponse({ error: updateErr.message }, 500, req);
      }

      // Write audit log
      await admin
        .from('audit_logs')
        .insert({
          entity_type: 'retention_alert',
          entity_id: alert_id,
          entity_name: alert.address || '',
          action: 'update',
          changed_fields: [{ field: 'investigation_status', old_value: oldStatus, new_value: status }],
          user_name: user_name || '',
          user_email: user_email || '',
        })
        .then(() => {})
        .catch((err: any) => console.warn('Audit log insert failed:', err?.message));

      // Notify admins when an alert is flagged as red_flag
      if (status === 'red_flag' && oldStatus !== 'red_flag') {
        const { data: admins = [] } = await admin
          .from('users')
          .select('id')
          .in('role', ['master_admin', 'admin']);

        for (const adm of admins) {
          await admin
            .from('notifications')
            .insert({
              user_id: adm.id,
              type: 'retention_red_flag',
              category: 'system',
              severity: 'critical',
              title: `Red flag: ${alert.address}`,
              message: `${user_name || 'A team member'} flagged a retention alert for investigation at ${alert.address}.`,
              cta_label: 'View Alert',
              cta_url: '/client-monitor',
              is_read: false,
              is_dismissed: false,
              source: 'user',
              idempotency_key: `retention_red_flag:${alert_id}:${new Date().toISOString().slice(0, 10)}`,
            })
            .catch(() => {}); // Idempotency handles duplicates
        }
      }

      return jsonResponse({ success: true, alert_id, old_status: oldStatus, new_status: status }, 200, req);
    }

    // ─── update_notes ──────────────────────────────────────────────────
    if (body.action === 'update_notes') {
      const { alert_id, notes, user_name, user_email } = body;

      if (!alert_id) {
        return jsonResponse({ error: 'alert_id is required' }, 400, req);
      }

      const now = new Date().toISOString();

      const { error: updateErr } = await admin
        .from('retention_alerts')
        .update({
          notes: notes || '',
          notes_updated_at: now,
          notes_updated_by: user_name || '',
          updated_at: now,
        })
        .eq('id', alert_id);

      if (updateErr) {
        console.error('Failed to update retention alert notes:', updateErr);
        return jsonResponse({ error: updateErr.message }, 500, req);
      }

      return jsonResponse({ success: true, alert_id }, 200, req);
    }

    // ─── bulk_update ───────────────────────────────────────────────────
    if (body.action === 'bulk_update') {
      const { alert_ids, status, user_id, user_name, user_email } = body;

      if (!Array.isArray(alert_ids) || alert_ids.length === 0 || !status) {
        return jsonResponse({ error: 'alert_ids (array) and status are required' }, 400, req);
      }
      if (!VALID_STATUSES.includes(status)) {
        return jsonResponse({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400, req);
      }

      const now = new Date().toISOString();
      const results: Array<{ alert_id: string; success: boolean; error?: string }> = [];

      for (const alert_id of alert_ids) {
        try {
          // Fetch current alert
          const { data: alert, error: fetchErr } = await admin
            .from('retention_alerts')
            .select('*')
            .eq('id', alert_id)
            .single();

          if (fetchErr || !alert) {
            results.push({ alert_id, success: false, error: 'Not found' });
            continue;
          }

          const oldStatus = alert.investigation_status || 'identified';

          const updatePayload: Record<string, any> = {
            investigation_status: status,
            updated_at: now,
          };

          if (status === 'investigating') {
            updatePayload.investigated_by = user_id || null;
            updatePayload.investigated_by_name = user_name || null;
            updatePayload.investigated_at = now;
          }

          if (RESOLVED_STATUSES.includes(status)) {
            updatePayload.resolved_at = now;
          }

          const { error: updateErr } = await admin
            .from('retention_alerts')
            .update(updatePayload)
            .eq('id', alert_id);

          if (updateErr) {
            results.push({ alert_id, success: false, error: updateErr.message });
            continue;
          }

          // Write audit log
          await admin
            .from('audit_logs')
            .insert({
              entity_type: 'retention_alert',
              entity_id: alert_id,
              entity_name: alert.address || '',
              action: 'update',
              changed_fields: [{ field: 'investigation_status', old_value: oldStatus, new_value: status }],
              user_name: user_name || '',
              user_email: user_email || '',
            })
            .then(() => {})
            .catch((err: any) => console.warn('Audit log insert failed:', err?.message));

          results.push({ alert_id, success: true });
        } catch (err: any) {
          results.push({ alert_id, success: false, error: err?.message || 'Unknown error' });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return jsonResponse({ success: true, updated: successCount, total: alert_ids.length, results }, 200, req);
    }

    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400, req);
  } catch (err: any) {
    console.error('updateRetentionAlert error:', err);
    return jsonResponse({ error: err?.message || 'Internal error' }, 500, req);
  }
});
