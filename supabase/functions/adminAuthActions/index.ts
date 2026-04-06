import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCors, getCorsHeaders } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const _cors = handleCors(req); if (_cors) return _cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify the caller is an admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check caller is admin
    const { data: callerRecord } = await admin.from('users').select('role').eq('id', caller.id).single();
    if (!callerRecord || !['master_admin', 'admin'].includes(callerRecord.role)) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { action } = body;

    // ─── INVITE USER ───
    if (action === 'invite_user') {
      const { email, role, fullName } = body;
      if (!email) return error('Email required', 400);

      const { data: authData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { role: role || 'employee', full_name: fullName || email.split('@')[0] },
      });
      if (inviteErr) return error(inviteErr.message, 400);

      const userId = authData.user?.id;
      if (userId) {
        await admin.from('users').upsert({
          id: userId,
          email: email.toLowerCase().trim(),
          full_name: fullName || email.split('@')[0],
          role: role || 'employee',
          is_active: true,
        }, { onConflict: 'email' });
      }

      // Log auth event
      await admin.from('auth_events').insert({
        user_email: email,
        event_type: 'user_invited',
        metadata: { invited_by: caller.email, role },
      });

      return json({ success: true, user_id: userId });
    }

    // ─── RESEND INVITE ───
    if (action === 'resend_invite') {
      const { email } = body;
      if (!email) return error('Email required', 400);

      const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
      if (inviteErr) return error(inviteErr.message, 400);

      await admin.from('auth_events').insert({
        user_email: email,
        event_type: 'invite_resent',
        metadata: { resent_by: caller.email },
      });

      return json({ success: true });
    }

    // ─── SEND PASSWORD RESET ───
    if (action === 'send_password_reset') {
      const { email } = body;
      if (!email) return error('Email required', 400);

      const { error: resetErr } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${req.headers.get('origin') || 'https://flexstudios.app'}/auth/reset-password` },
      });
      if (resetErr) return error(resetErr.message, 400);

      await admin.from('auth_events').insert({
        user_email: email,
        event_type: 'password_reset_sent',
        metadata: { sent_by: caller.email },
      });

      return json({ success: true });
    }

    // ─── SIGN OUT EVERYWHERE (for a specific user) ───
    if (action === 'sign_out_everywhere') {
      const { user_id } = body;
      if (!user_id) return error('user_id required', 400);

      const { error: signOutErr } = await admin.auth.admin.signOut(user_id, 'global');
      if (signOutErr) return error(signOutErr.message, 400);

      await admin.from('auth_events').insert({
        user_id,
        event_type: 'forced_sign_out_all',
        metadata: { forced_by: caller.email },
      });

      return json({ success: true });
    }

    // ─── CREATE USER (for registration with invite code) ───
    if (action === 'register_with_code') {
      const { email, password, fullName, code } = body;
      if (!email || !password || !code) return error('email, password, code required', 400);

      // Validate invite code (using atomic claim)
      const { data: codeData, error: claimErr } = await admin.rpc('claim_invite_code', { p_code: code });
      if (claimErr) return error('Invalid, expired, or fully used invite code', 400);

      // Create auth user
      const { data: authData, error: signupErr } = await admin.auth.admin.createUser({
        email: email.toLowerCase().trim(),
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: codeData.role },
      });
      if (signupErr) return error(signupErr.message, 400);

      // Create users table record
      await admin.from('users').insert({
        id: authData.user.id,
        email: email.toLowerCase().trim(),
        full_name: fullName || email.split('@')[0],
        role: codeData.role,
        is_active: true,
        auth_provider: 'email',
      });

      // Log auth event
      await admin.from('auth_events').insert({
        user_id: authData.user.id,
        user_email: email,
        event_type: 'user_registered',
        metadata: { invite_code: code, role: codeData.role },
      });

      return json({ success: true, user_id: authData.user.id, role: codeData.role });
    }

    return error(`Unknown action: ${action}`, 400);

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function json(data: any, status = 200, req?: Request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function error(msg: string, status = 400, req?: Request) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}
