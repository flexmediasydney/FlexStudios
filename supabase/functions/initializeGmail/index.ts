/**
 * @deprecated Use getGmailOAuthUrl instead. This function is kept only for
 * backward compatibility and simply returns a 410 Gone directing callers
 * to the canonical endpoint.
 */
import { handleCors, jsonResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  return jsonResponse({
    deprecated: true,
    message: 'This endpoint is deprecated. Use getGmailOAuthUrl to obtain the OAuth URL and handleGmailOAuthCallback for the redirect.',
    replacement: 'getGmailOAuthUrl',
  }, 410);
});
