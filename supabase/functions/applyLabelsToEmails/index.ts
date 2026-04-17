import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('applyLabelsToEmails', async (req) => {
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
    const { threadIds, emailAccountId, labels } = body;

    // Validate required fields
    if (!threadIds || !emailAccountId || !labels) {
      return errorResponse('Missing required fields: threadIds, emailAccountId, labels', 400, req);
    }

    // Validate types
    if (!Array.isArray(threadIds) || !Array.isArray(labels)) {
      return errorResponse('threadIds and labels must be arrays', 400, req);
    }

    if (typeof emailAccountId !== 'string' || !emailAccountId.trim()) {
      return errorResponse('emailAccountId must be a non-empty string', 400, req);
    }

    // Validate threadIds are strings
    if (!threadIds.every((id: any) => typeof id === 'string' && id.trim())) {
      return errorResponse('All threadIds must be non-empty strings', 400, req);
    }

    // Validate labels are strings
    if (!labels.every((l: any) => typeof l === 'string' && l.trim())) {
      return errorResponse('All labels must be non-empty strings', 400);
    }

    // Deduplicate labels
    const uniqueLabels = Array.from(new Set(labels.map((l: string) => l.trim())));

    // Verify the email account belongs to the authenticated user
    const accountCheck = await entities.EmailAccount.filter({
      id: emailAccountId.trim(),
      assigned_to_user_id: user.id
    });
    if (accountCheck.length === 0) {
      return errorResponse('Forbidden: you do not own this email account', 403);
    }

    // Fetch messages matching the thread IDs and account
    const allMessages: any[] = [];
    for (const threadId of threadIds) {
      const messages = await entities.EmailMessage.filter({
        email_account_id: emailAccountId.trim(),
        gmail_thread_id: threadId,
      }, null, 500);
      allMessages.push(...messages);
    }

    if (allMessages.length === 0) {
      return jsonResponse({
        success: true,
        updated: 0,
        message: 'No messages found for the provided thread IDs',
      });
    }

    let updated = 0;
    const failed: string[] = [];

    // Update each message's labels with error tracking
    for (const message of allMessages) {
      try {
        const currentLabels = Array.isArray(message.labels) ? message.labels : [];

        // Merge and deduplicate labels
        const newLabels = Array.from(new Set([...currentLabels, ...uniqueLabels]));

        // Only update if labels changed
        if (JSON.stringify([...currentLabels].sort()) !== JSON.stringify([...newLabels].sort())) {
          await entities.EmailMessage.update(message.id, {
            labels: newLabels,
          });
          updated++;
        }
      } catch (error: any) {
        console.error(`Failed to update message ${message.id}:`, error);
        failed.push(message.id);
      }
    }

    const response: any = {
      success: failed.length === 0,
      updated,
      total: allMessages.length,
      failed: failed.length,
      message: `Applied labels to ${updated}/${allMessages.length} emails`,
    };

    if (failed.length > 0) {
      response.failedIds = failed;
    }

    return jsonResponse(response);

  } catch (err: any) {
    console.error('Error applying labels:', err);
    return errorResponse('Failed to apply labels: ' + (err?.message || 'Unknown error'));
  }
});
