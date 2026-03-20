import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Secure function to read emails with granular permission checks.
 * Guards against: unauthorized access, data leaks, N+1 queries
 */
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { email_account_id, limit = 20 } = await req.json();

        // Validate limit to prevent memory exhaustion
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
            return Response.json({ error: 'Invalid limit. Must be 1-500.' }, { status: 400 });
        }

        if (!email_account_id || typeof email_account_id !== 'string') {
            return Response.json({ error: 'email_account_id is required' }, { status: 400 });
        }

        // CRITICAL: Verify user owns this email account
        const accounts = await base44.entities.EmailAccount.filter({
            id: email_account_id,
            assigned_to_user_id: user.id
        });

        if (!accounts || accounts.length === 0) {
            // Return 403 (Forbidden) not 404 to avoid leaking existence of email accounts
            return Response.json({ error: 'Access denied' }, { status: 403 });
        }

        // Safe fetch with explicit user filter
        const emails = await base44.entities.EmailMessage.filter({
            email_account_id,
            is_deleted: false
        }, '-received_at', limit);

        // Sanitize response: strip sensitive fields
        const sanitized = emails.map(email => ({
            id: email.id,
            from: email.from,
            from_name: email.from_name,
            to: email.to,
            subject: email.subject,
            received_at: email.received_at,
            is_unread: email.is_unread,
            is_starred: email.is_starred,
            project_id: email.project_id,
            priority: email.priority,
            // DO NOT INCLUDE: body (potential XSS), refresh_token, access_token
        }));

        return Response.json({ success: true, emails: sanitized });
    } catch (error) {
        console.error('Error reading emails:', error);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
});