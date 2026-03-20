import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const {
      email_message_id,
      url,
      link_text,
      clicked_by,
      clicked_by_name
    } = await req.json();

    // Validate required fields
    if (!email_message_id || !url) {
      return Response.json({
        error: 'Missing required fields: email_message_id, url'
      }, { status: 400 });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return Response.json({
        error: 'Invalid URL format'
      }, { status: 400 });
    }

    // Get request headers for user agent and IP
    const userAgent = req.headers.get('user-agent') || null;
    const ipAddress = req.headers.get('x-forwarded-for') || 
                     req.headers.get('cf-connecting-ip') ||
                     null;

    // Create link click record
    const clickRecord = await base44.entities.EmailLinkClick.create({
      email_message_id,
      url,
      link_text: link_text || null,
      clicked_by: clicked_by || null,
      clicked_by_name: clicked_by_name || null,
      user_agent: userAgent,
      ip_address: ipAddress
    });

    return Response.json({
      success: true,
      click: clickRecord
    });
  } catch (error) {
    console.error('Error tracking link click:', error);
    return Response.json({
      error: 'Failed to track click: ' + (error?.message || 'Unknown error')
    }, { status: 500 });
  }
});