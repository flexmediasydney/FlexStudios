import { handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

// Invoked from the frontend "Process Queue Now" button.
// Delegates to processTonomoQueue via cross-function call.

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const data = await invokeFunction('processTonomoQueue', { triggered_by: 'manual' });
    return jsonResponse(data);
  } catch (err: any) {
    console.error('triggerTonomoProcessing error:', err.message);
    return errorResponse(err.message || 'Internal error', 500);
  }
});
