import { handleCors, jsonResponse, errorResponse, invokeFunction, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

// Invoked from the frontend "Process Queue Now" button.
// Delegates to processTonomoQueue via cross-function call.

serveWithAudit('triggerTonomoProcessing', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const data = await invokeFunction('processTonomoQueue', { triggered_by: 'manual' });
    return jsonResponse(data);
  } catch (err: any) {
    console.error('triggerTonomoProcessing error:', err.message);
    return errorResponse(err.message || 'Internal error', 500);
  }
});
