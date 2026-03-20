import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Invoked from the frontend "Process Queue Now" button via base44.functions.invoke().
// Passes the request through so the processor inherits the caller's auth context.

Deno.serve(async (req) => {
  try {
    // Forward the incoming auth headers to the processor
    const authHeader = req.headers.get('authorization') || '';
    const cookieHeader = req.headers.get('cookie') || '';

    const response = await fetch('https://flexstudios.app/api/functions/processTonomoQueue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { 'Authorization': authHeader } : {}),
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
      body: '{"triggered_by":"manual"}',
    });

    const data = await response.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 200 });
  }
});