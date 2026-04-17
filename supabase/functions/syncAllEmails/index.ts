import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, serveWithAudit } from '../_shared/supabase.ts';

// Admin-only scheduled sync with comprehensive error handling and logging

serveWithAudit('syncAllEmails', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth: allow service-role (internal/cron calls) or master_admin users
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
      if (user.role !== 'master_admin') {
        return errorResponse('Forbidden: Master admin access required', 403);
      }
    }

    // Retry helper
    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: any) {
          if (err.status === 429 && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    };

    // Get all active email accounts with pagination
    const emailAccounts = await retryWithBackoff(() =>
      entities.EmailAccount.filter({
        is_active: true
      }, null, 1000)
    );

    if (emailAccounts.length === 0) {
      return jsonResponse({
        success: true,
        message: 'No email accounts to sync',
        accounts: 0,
        totalSynced: 0
      });
    }

    const results: any = {
      totalSynced: 0,
      accountsProcessed: 0,
      accountsWithErrors: 0,
      details: [] as any[],
      startTime: new Date().toISOString()
    };

    // Process each account
    for (const account of emailAccounts) {
      try {
        // Invoke with retry and backoff
        const syncResult = await retryWithBackoff(() =>
          invokeFunction('syncGmailMessagesForAccount', {
            accountId: account.id,
            userId: account.assigned_to_user_id
          })
        );

        results.totalSynced += syncResult?.synced || 0;
        results.accountsProcessed++;

        results.details.push({
          email: account.email_address,
          synced: syncResult?.synced || 0,
          status: 'success'
        });
      } catch (error: any) {
        results.accountsWithErrors++;
        results.details.push({
          email: account.email_address,
          status: 'error',
          error: error.message
        });
        console.error(`Error syncing ${account.email_address}:`, error);
      }
    }

    results.endTime = new Date().toISOString();
    results.success = results.accountsWithErrors === 0;

    return jsonResponse(results);
  } catch (error: any) {
    console.error('Sync scheduler error:', error);
    return errorResponse(error.message);
  }
});
