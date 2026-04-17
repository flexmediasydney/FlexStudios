import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('logEmailActivity', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({} as any));
    const {
      email_message_id,
      email_account_id,
      action_type,
      old_value,
      new_value,
      description,
    } = body;

    // Validate required fields
    if (!email_message_id || !email_account_id || !action_type) {
      return errorResponse('Missing required fields: email_message_id, email_account_id, action_type', 400, req);
    }

    // Validate action_type
    const validActions = [
      'opened', 'marked_read', 'marked_unread', 'visibility_changed',
      'project_linked', 'project_unlinked', 'label_added', 'label_removed',
      'archived', 'restored', 'deleted', 'reply_sent', 'starred', 'unstarred',
      'priority_changed',
    ];

    if (!validActions.includes(action_type)) {
      return errorResponse(`Invalid action_type: ${action_type}`, 400);
    }

    // Create activity record
    const activity = await entities.EmailActivity.create({
      email_message_id,
      email_account_id,
      action_type,
      old_value: old_value || null,
      new_value: new_value || null,
      description: description || action_type,
      performed_by: user.id,
      performed_by_name: user.full_name,
      timestamp: new Date().toISOString(),
    });

    return jsonResponse({ success: true, activity });

  } catch (err: any) {
    console.error('Error logging email activity:', err);
    return errorResponse('Failed to log activity: ' + (err?.message || 'Unknown error'));
  }
});
