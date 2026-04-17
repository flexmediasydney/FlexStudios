import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleCors, getCorsHeaders, getUserFromReq, errorResponse as sharedErrorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('adminAuthActions', async (req) => {
  const _cors = handleCors(req); if (_cors) return _cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Parse body first so we can check if it's a registration (no auth needed)
    const body = await req.json().catch(() => ({} as any));
    const { action } = body;

    // ── Auth: require master_admin for all actions EXCEPT register_with_code ──
    // Registration is done by unauthenticated users with a valid invite code.
    // The invite code itself serves as the authorization mechanism.
    const user = await getUserFromReq(req).catch(() => null);
    if (action !== 'register_with_code') {
      if (!user || user.role !== 'master_admin') {
        return new Response(JSON.stringify({ error: 'Only the account owner can perform admin auth actions' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    const caller = user;

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

      const normalizedEmail = email.toLowerCase().trim();

      // Validate invite code (using atomic claim)
      const { data: codeData, error: claimErr } = await admin.rpc('claim_invite_code', { p_code: code });
      if (claimErr) return error('Invalid, expired, or fully used invite code', 400);

      let userId: string;

      // Check if auth user already exists (e.g., from Google SSO or previous attempt)
      let existing: any = null;
      try {
        const { data: { users: found } } = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
        existing = (found || []).find((u: any) => u.email === normalizedEmail) || null;
      } catch { /* no existing user */ }

      if (existing) {
        // Auth user exists (Google SSO or previous partial attempt)
        // Update their password and metadata instead of creating new
        userId = existing.id;
        const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
          password,
          email_confirm: true,
          user_metadata: {
            ...existing.user_metadata,
            full_name: fullName || existing.user_metadata?.full_name,
            role: codeData.role,
          },
        });
        if (updateErr) {
          // Rollback: unclaim the invite code
          await admin.from('invite_codes').update({ use_count: admin.rpc ? 0 : 0 }).eq('code', code);
          return error(updateErr.message, 400);
        }
      } else {
        // Create new auth user
        const { data: authData, error: signupErr } = await admin.auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName, role: codeData.role },
        });
        if (signupErr) {
          // Rollback: unclaim the invite code
          await admin.rpc('unclaim_invite_code', { p_code: code }).catch(() => {
            // If unclaim RPC doesn't exist, manually decrement
            admin.from('invite_codes')
              .update({ use_count: 0 })
              .eq('code', code)
              .catch(() => {});
          });
          return error(signupErr.message, 400);
        }
        userId = authData.user.id;
      }

      // Create/update users table record (upsert handles partial previous attempts)
      await admin.from('users').upsert({
        id: userId,
        email: normalizedEmail,
        full_name: fullName || normalizedEmail.split('@')[0],
        role: codeData.role,
        is_active: true,
      }, { onConflict: 'id' });

      // Log auth event
      await admin.from('auth_events').insert({
        user_id: userId,
        user_email: normalizedEmail,
        event_type: 'user_registered',
        metadata: { invite_code: code, role: codeData.role, had_existing_auth: !!existing },
      }).catch(() => {}); // non-fatal

      return json({ success: true, user_id: userId, role: codeData.role });
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
