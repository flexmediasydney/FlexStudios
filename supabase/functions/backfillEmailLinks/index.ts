/**
 * backfillEmailLinks
 *
 * One-shot / scheduled backfill that re-resolves agent_id, agency_id, agent_name,
 * agency_name for ALL email_messages rows using the shared emailLinking rules:
 *   - match From: or To: or Cc: against agents.email (case-insensitive)
 *   - fall back to domain → agency via any agent in that agency
 *
 * Safe to run repeatedly. Only updates rows whose currently-stored link
 * differs from the computed one (or where link is currently missing).
 *
 * Also propagates project_id/project_title across every message that shares a
 * gmail_thread_id with an already-linked message — so once one message in a
 * thread is linked to a project, every sibling follows.
 *
 * Auth: master_admin users or service-role calls (cron).
 *
 * Invocation: POST with optional body { dryRun?: bool, limit?: number, emailAccountId?: string }
 */

import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';
import { AgentLookup } from '../_shared/emailLinking.ts';

const BATCH_SIZE = 500; // rows fetched per page
const UPDATE_BATCH = 50; // rows updated per round-trip

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();

    // Auth: master_admin user or service-role
    const user = await getUserFromReq(req).catch(() => null);
    if (!user) {
      const authHeader = req.headers.get('authorization') || '';
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (!serviceKey || !authHeader.includes(serviceKey)) {
        return errorResponse('Authentication required', 401);
      }
    } else if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: Master admin access required', 403);
    }

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const dryRun = body.dryRun === true;
    const overrideExisting = body.overrideExisting === true; // if true, recompute even for already-linked rows
    const limit = Number.isFinite(body.limit) ? body.limit : null;
    const emailAccountId: string | null = typeof body.emailAccountId === 'string' ? body.emailAccountId : null;

    const startTime = Date.now();
    const WALL_BUDGET_MS = 55_000; // leave 5s headroom under 60s

    // Build lookup with our own addresses excluded
    const { data: allAccounts } = await admin.from('email_accounts').select('email_address');
    const ownAddresses = new Set<string>(
      (allAccounts || [])
        .map((a: any) => (a.email_address || '').toLowerCase())
        .filter(Boolean)
    );
    const lookup = new AgentLookup(admin, ownAddresses);
    await lookup.preloadAgents();
    await lookup.preloadDomains();

    // Stats
    let scanned = 0;
    let linkedFresh = 0;     // gained a link that wasn't there
    let linkChanged = 0;     // agent_id changed
    let unchanged = 0;
    const matchedVia = { from: 0, to: 0, cc: 0, domain: 0 } as Record<string, number>;
    const updates: Array<{ id: string; patch: Record<string, any> }> = [];

    // Page through all messages
    let offset = 0;
    let done = false;
    while (!done) {
      if (Date.now() - startTime > WALL_BUDGET_MS) break;
      let q = admin
        .from('email_messages')
        .select('id, "from", "to", cc, agent_id, agent_name, agency_id, agency_name, gmail_thread_id, email_account_id, project_id, project_title')
        .order('received_at', { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1);
      if (emailAccountId) q = q.eq('email_account_id', emailAccountId);
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        if (Date.now() - startTime > WALL_BUDGET_MS) { done = true; break; }
        scanned++;
        const result = await lookup.resolve({ from: row.from, to: row.to, cc: row.cc });

        // Skip if nothing to link
        if (!result.agent_id && !result.agency_id) {
          unchanged++;
          continue;
        }

        // Skip if already correctly linked (unless override)
        const sameAgent = row.agent_id === result.agent_id;
        const sameAgency = row.agency_id === result.agency_id;
        if (sameAgent && sameAgency && !overrideExisting) {
          unchanged++;
          continue;
        }

        // Don't blow away a manually-set agent_id if we can't find it anymore (override flag only)
        if (row.agent_id && !result.agent_id && !overrideExisting) {
          unchanged++;
          continue;
        }

        const patch: Record<string, any> = {
          agent_id: result.agent_id,
          agent_name: result.agent_name,
          agency_id: result.agency_id,
          agency_name: result.agency_name,
        };
        if (row.agent_id == null && row.agency_id == null) linkedFresh++;
        else linkChanged++;
        if (result.matched_via) matchedVia[result.matched_via] = (matchedVia[result.matched_via] || 0) + 1;
        updates.push({ id: row.id, patch });

        if (limit && scanned >= limit) { done = true; break; }
      }

      if (rows.length < BATCH_SIZE) done = true;
      offset += BATCH_SIZE;
    }

    // Apply updates in batches
    let applied = 0;
    if (!dryRun && updates.length > 0) {
      for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
        const chunk = updates.slice(i, i + UPDATE_BATCH);
        // Run each update individually — they differ in patch
        await Promise.all(
          chunk.map((u) =>
            admin.from('email_messages').update(u.patch).eq('id', u.id)
              .then(({ error }) => {
                if (error) console.error('backfill update failed', u.id, error.message);
                else applied++;
              })
          ),
        );
      }
    }

    // Second pass: propagate project_id/project_title across thread siblings
    // Only touch rows with NO project_id whose thread has at least one linked sibling
    let threadPropagated = 0;
    if (!dryRun && Date.now() - startTime < WALL_BUDGET_MS) {
      const { data: linkedThreads } = await admin
        .from('email_messages')
        .select('email_account_id, gmail_thread_id, project_id, project_title')
        .not('project_id', 'is', null)
        .limit(2000);
      const threadMap = new Map<string, { project_id: string; project_title: string | null }>();
      for (const r of linkedThreads || []) {
        const key = `${r.email_account_id}|${r.gmail_thread_id}`;
        if (!threadMap.has(key) && r.project_id) {
          threadMap.set(key, { project_id: r.project_id, project_title: r.project_title });
        }
      }
      for (const [key, info] of threadMap) {
        if (Date.now() - startTime > WALL_BUDGET_MS) break;
        const [accountId, threadId] = key.split('|');
        const { data: siblings } = await admin
          .from('email_messages')
          .select('id')
          .eq('email_account_id', accountId)
          .eq('gmail_thread_id', threadId)
          .is('project_id', null);
        if (siblings && siblings.length > 0) {
          const ids = siblings.map((s: any) => s.id);
          const { error } = await admin
            .from('email_messages')
            .update({ project_id: info.project_id, project_title: info.project_title })
            .in('id', ids);
          if (!error) threadPropagated += ids.length;
        }
      }
    }

    return jsonResponse({
      success: true,
      dryRun,
      overrideExisting,
      scanned,
      eligible: updates.length,
      applied,
      linkedFresh,
      linkChanged,
      unchanged,
      matchedVia,
      threadPropagated,
      durationMs: Date.now() - startTime,
      timeBudgetExhausted: Date.now() - startTime > WALL_BUDGET_MS,
    });
  } catch (err: any) {
    console.error('backfillEmailLinks error:', err);
    return errorResponse(err?.message || 'Backfill failed', 500);
  }
});
