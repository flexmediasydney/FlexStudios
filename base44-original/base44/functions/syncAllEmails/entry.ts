import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Admin-only scheduled sync with comprehensive error handling and logging

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Verify master admin
    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Master admin access required' }, { status: 403 });
    }

    // Retry helper
     const retryWithBackoff = async (fn, maxRetries = 2) => {
         for (let attempt = 0; attempt <= maxRetries; attempt++) {
             try {
                 return await fn();
             } catch (err) {
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
       base44.asServiceRole.entities.EmailAccount.filter({
         is_active: true
       }, null, 1000)
     );

    if (emailAccounts.length === 0) {
      return Response.json({
        success: true,
        message: 'No email accounts to sync',
        accounts: 0,
        totalSynced: 0
      });
    }

    const results = {
      totalSynced: 0,
      accountsProcessed: 0,
      accountsWithErrors: 0,
      details: [],
      startTime: new Date().toISOString()
    };

    // Process each account
    for (const account of emailAccounts) {
      try {
        // Invoke with retry and backoff
        const syncResult = await retryWithBackoff(() =>
          base44.asServiceRole.functions.invoke('syncGmailMessagesForAccount', {
            accountId: account.id,
            userId: account.assigned_to_user_id
          })
        );

        results.totalSynced += syncResult.data?.synced || 0;
        results.accountsProcessed++;

        results.details.push({
          email: account.email_address,
          synced: syncResult.data?.synced || 0,
          status: 'success'
        });
      } catch (error) {
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

    return Response.json(results);
  } catch (error) {
    console.error('Sync scheduler error:', error);
    return Response.json({
      success: false,
      error: error.message,
      totalSynced: 0,
      accountsProcessed: 0
    }, { status: 500 });
  }
});