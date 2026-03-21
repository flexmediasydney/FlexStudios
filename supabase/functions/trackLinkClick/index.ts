import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const {
      email_message_id,
      url,
      link_text,
      clicked_by,
      clicked_by_name,
    } = await req.json();

    // Validate required fields
    if (!email_message_id || !url) {
      return errorResponse('Missing required fields: email_message_id, url', 400);
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return errorResponse('Invalid URL format', 400);
    }

    // Get request headers for user agent and IP
    const userAgent = req.headers.get('user-agent') || null;
    const ipAddress = req.headers.get('x-forwarded-for') ||
                     req.headers.get('cf-connecting-ip') ||
                     null;

    // Create link click record
    const clickRecord = await entities.EmailLinkClick.create({
      email_message_id,
      url,
      link_text: link_text || null,
      clicked_by: clicked_by || null,
      clicked_by_name: clicked_by_name || null,
      user_agent: userAgent,
      ip_address: ipAddress,
    });

    return jsonResponse({
      success: true,
      click: clickRecord,
    });
  } catch (error: any) {
    console.error('Error tracking link click:', error);
    return errorResponse('Failed to track click: ' + (error?.message || 'Unknown error'));
  }
});
