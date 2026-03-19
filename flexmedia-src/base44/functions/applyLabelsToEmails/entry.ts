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
    const { threadIds, emailAccountId, labels } = body;

    // Validate required fields
    if (!threadIds || !emailAccountId || !labels) {
      return Response.json({ 
        error: 'Missing required fields: threadIds, emailAccountId, labels' 
      }, { status: 400 });
    }

    // Validate types
    if (!Array.isArray(threadIds) || !Array.isArray(labels)) {
      return Response.json({ 
        error: 'threadIds and labels must be arrays' 
      }, { status: 400 });
    }

    if (typeof emailAccountId !== 'string' || !emailAccountId.trim()) {
      return Response.json({ 
        error: 'emailAccountId must be a non-empty string' 
      }, { status: 400 });
    }

    // Validate threadIds are strings
    if (!threadIds.every(id => typeof id === 'string' && id.trim())) {
      return Response.json({ 
        error: 'All threadIds must be non-empty strings' 
      }, { status: 400 });
    }

    // Validate labels are strings
    if (!labels.every(l => typeof l === 'string' && l.trim())) {
      return Response.json({ 
        error: 'All labels must be non-empty strings' 
      }, { status: 400 });
    }

    // Deduplicate labels
    const uniqueLabels = Array.from(new Set(labels.map(l => l.trim())));

    // Fetch messages matching the thread IDs and account
    // Query each thread separately to avoid rate limiting
    const allMessages = [];
    for (const threadId of threadIds) {
      const messages = await base44.entities.EmailMessage.filter({
        email_account_id: emailAccountId.trim(),
        gmail_thread_id: threadId
      });
      allMessages.push(...messages);
    }

    if (allMessages.length === 0) {
      return Response.json({
        success: true,
        updated: 0,
        message: 'No messages found for the provided thread IDs'
      });
    }

    let updated = 0;
    const failed = [];

    // Update each message's labels with error tracking
    for (const message of allMessages) {
      try {
        const currentLabels = Array.isArray(message.labels) ? message.labels : [];
        
        // Merge and deduplicate labels
        const newLabels = Array.from(new Set([...currentLabels, ...uniqueLabels]));
        
        // Only update if labels changed
        if (JSON.stringify(currentLabels.sort()) !== JSON.stringify(newLabels.sort())) {
          await base44.entities.EmailMessage.update(message.id, {
            labels: newLabels
          });
          updated++;
        }
      } catch (error) {
        console.error(`Failed to update message ${message.id}:`, error);
        failed.push(message.id);
      }
    }

    const response = {
      success: failed.length === 0,
      updated,
      total: allMessages.length,
      failed: failed.length,
      message: `Applied labels to ${updated}/${allMessages.length} emails`
    };

    if (failed.length > 0) {
      response.failedIds = failed;
    }

    return Response.json(response);
  } catch (error) {
    console.error('Error applying labels:', error);
    return Response.json({ 
      error: 'Failed to apply labels: ' + (error?.message || 'Unknown error') 
    }, { status: 500 });
  }
});