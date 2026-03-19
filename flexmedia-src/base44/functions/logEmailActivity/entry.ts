import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    const body = await req.json();
    const {
      email_message_id,
      email_account_id,
      action_type,
      old_value,
      new_value,
      description
    } = body;

    // Validate required fields
    if (!email_message_id || !email_account_id || !action_type) {
      return Response.json({
        error: 'Missing required fields: email_message_id, email_account_id, action_type'
      }, { status: 400 });
    }

    // Validate action_type
    const validActions = [
      'opened', 'marked_read', 'marked_unread', 'visibility_changed',
      'project_linked', 'project_unlinked', 'label_added', 'label_removed',
      'archived', 'restored', 'deleted', 'reply_sent', 'starred', 'unstarred',
      'priority_changed'
    ];

    if (!validActions.includes(action_type)) {
      return Response.json({
        error: `Invalid action_type: ${action_type}`
      }, { status: 400 });
    }

    // Create activity record
    const activity = await base44.entities.EmailActivity.create({
      email_message_id,
      email_account_id,
      action_type,
      old_value: old_value || null,
      new_value: new_value || null,
      description: description || action_type,
      performed_by: user.id,
      performed_by_name: user.full_name,
      timestamp: new Date().toISOString()
    });

    return Response.json({
      success: true,
      activity
    });
  } catch (error) {
    console.error('Error logging email activity:', error);
    return Response.json({
      error: 'Failed to log activity: ' + (error?.message || 'Unknown error')
    }, { status: 500 });
  }
});