import { handleCors, jsonResponse, getAdminClient, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Recheck mapping gaps on pending_review projects.
 * Called when a mapping is confirmed/linked/updated.
 *
 * Two passes:
 * 1. Sweep projects with non-empty mapping_gaps/products_mapping_gaps — revalidate
 *    each gap against the current tonomo_mapping_tables, then replay the webhook
 *    if the project is still in pending_review so Tonomo handlers can repopulate
 *    agent_id/photographer_id/products.
 * 2. Sweep pending_review Tonomo projects that have empty gap arrays but are
 *    still missing an agent_id/photographer_id — these slipped through the
 *    gap-tracking because an earlier "changed" event overwrote state without
 *    repopulating mapping_gaps. Replay their latest webhook unconditionally so
 *    the newly-confirmed mapping gets applied.
 */
serveWithAudit('recheckMappingGaps', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();

    // 1. Load all confirmed mappings — services, agents, photographers
    const { data: allMappings = [] } = await admin
      .from('tonomo_mapping_tables')
      .select('tonomo_id, tonomo_label, flexmedia_label, flexmedia_entity_id, is_confirmed, mapping_type')
      .eq('is_confirmed', true);

    // Service mappings: match by tonomo_id or label
    const serviceMappings = allMappings.filter((m: any) => m.mapping_type === 'service');
    const confirmedTonomoIds = new Set(serviceMappings.map((m: any) => m.tonomo_id));
    const confirmedNames = new Set<string>();
    for (const m of serviceMappings) {
      if (m.flexmedia_label) confirmedNames.add(m.flexmedia_label.toLowerCase());
      if (m.tonomo_label) confirmedNames.add(m.tonomo_label.toLowerCase());
    }

    // Agent/photographer mappings: match by email or name (gap format: "agent:email" or "photographer:email")
    const staffMappings = allMappings.filter((m: any) => ['agent', 'photographer'].includes(m.mapping_type) && m.flexmedia_entity_id);
    const confirmedStaffEmails = new Set<string>();
    const confirmedStaffNames = new Set<string>();
    for (const m of staffMappings) {
      if (m.tonomo_label) confirmedStaffNames.add(m.tonomo_label.toLowerCase());
      if (m.flexmedia_label) confirmedStaffNames.add(m.flexmedia_label.toLowerCase());
    }
    // Also check agents table directly — gaps use email, agents have email field
    const { data: agents = [] } = await admin.from('agents').select('id, email, name');
    for (const a of agents) {
      if (a.email) confirmedStaffEmails.add(a.email.toLowerCase());
      if (a.name) confirmedStaffNames.add(a.name.toLowerCase());
    }
    // And users table for photographers
    const { data: users = [] } = await admin.from('users').select('id, email, full_name');
    for (const u of users) {
      if (u.email) confirmedStaffEmails.add(u.email.toLowerCase());
      if (u.full_name) confirmedStaffNames.add(u.full_name.toLowerCase());
    }

    // Helper: replay the most recent completed queue entry for a project so the
    // current processor handlers re-resolve everything with the updated mappings.
    //
    // Prefers appointment-level events (scheduled/changed/rescheduled) because
    // those actions actually re-run resolveMappingsMulti to update agent_id /
    // photographer_id. Order-level events (booking_created_or_changed, handled
    // by handleOrderUpdate) skip agent/photographer resolution entirely and
    // would leave the project stuck.
    const replayedOrderIds = new Set<string>();
    const replayLatestWebhook = async (orderId: string | null | undefined, projectId: string) => {
      if (!orderId) return false;
      if (replayedOrderIds.has(orderId)) return true; // already queued in this run
      try {
        // Clear manual overrides so Tonomo can update products/packages/agent/etc.
        await admin
          .from('projects')
          .update({ manually_overridden_fields: '[]' })
          .eq('id', projectId);

        // Priority 1: latest appointment-level event that resolves staff.
        let { data: queueEntries } = await admin
          .from('tonomo_processing_queue')
          .select('id, action')
          .eq('order_id', orderId)
          .eq('status', 'completed')
          .in('action', ['scheduled', 'changed', 'rescheduled'])
          .order('created_at', { ascending: false })
          .limit(1);

        // Priority 2: fall back to any completed entry if no appointment-level exists.
        if (!queueEntries?.[0]) {
          const { data: fallback } = await admin
            .from('tonomo_processing_queue')
            .select('id, action')
            .eq('order_id', orderId)
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(1);
          queueEntries = fallback || [];
        }

        if (queueEntries?.[0]) {
          await admin
            .from('tonomo_processing_queue')
            .update({ status: 'pending', retry_count: 0, error_message: null, result_summary: null, processed_at: null })
            .eq('id', queueEntries[0].id);
          replayedOrderIds.add(orderId);
          return true;
        }
      } catch (replayErr) {
        console.warn(`Failed to replay webhook for project ${projectId}:`, replayErr);
      }
      return false;
    };

    // ─────────────────────────────────────────────────────────────────────
    // PASS 1: Projects with tracked gaps in mapping_gaps/products_mapping_gaps
    // ─────────────────────────────────────────────────────────────────────
    const { data: projects = [] } = await admin
      .from('projects')
      .select('id, mapping_gaps, products_mapping_gaps, status, tonomo_order_id, agent_id, photographer_id')
      .or('mapping_gaps.neq.[]::jsonb,products_mapping_gaps.neq.[]::jsonb')
      .not('mapping_gaps', 'is', null);

    let cleared = 0;
    let stillGapped = 0;

    for (const project of projects) {
      let gaps: string[] = [];
      let productGaps: string[] = [];

      try {
        gaps = typeof project.mapping_gaps === 'string'
          ? JSON.parse(project.mapping_gaps)
          : (project.mapping_gaps || []);
      } catch { gaps = []; }

      try {
        productGaps = typeof project.products_mapping_gaps === 'string'
          ? JSON.parse(project.products_mapping_gaps)
          : (project.products_mapping_gaps || []);
      } catch { productGaps = []; }

      if (gaps.length === 0 && productGaps.length === 0) continue;

      // Recheck each gap: is the service/agent/photographer now mapped?
      // mapping_gaps format: ["service:tonomoId", "agent:email", "photographer:email", ...]
      const remainingGaps = gaps.filter((g: string) => {
        if (g.startsWith('service:')) {
          const tonomoId = g.replace('service:', '');
          return !confirmedTonomoIds.has(tonomoId);
        }
        if (g.startsWith('agent:') || g.startsWith('photographer:')) {
          const identifier = g.replace(/^(agent|photographer):/, '').toLowerCase();
          // Check if this email/name is now in confirmed mappings, agents, or users
          return !confirmedStaffEmails.has(identifier) && !confirmedStaffNames.has(identifier);
        }
        // Unknown gap type — keep it
        return true;
      });

      // products_mapping_gaps format: ["Service Display Name", ...]
      const remainingProductGaps = productGaps.filter((name: string) => {
        return !confirmedNames.has(name.toLowerCase());
      });

      if (remainingGaps.length < gaps.length || remainingProductGaps.length < productGaps.length) {
        // Some gaps resolved — update project
        await admin
          .from('projects')
          .update({
            mapping_gaps: remainingGaps,
            products_mapping_gaps: remainingProductGaps,
          })
          .eq('id', project.id);
        cleared++;

        // If project is pending_review and has a tonomo order, replay the latest
        // webhook so Tonomo handlers can re-resolve and update agent_id / products / etc.
        if (project.status === 'pending_review' && project.tonomo_order_id) {
          await replayLatestWebhook(project.tonomo_order_id, project.id);
        }
      }

      if (remainingGaps.length > 0 || remainingProductGaps.length > 0) {
        stillGapped++;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PASS 2: pending_review Tonomo projects with empty gap arrays but still
    // missing agent_id or photographer_id. These slipped the gap-tracking
    // because a later "changed" event only set pending_review_reason without
    // populating mapping_gaps. Replay their latest webhook so the newly
    // confirmed agent/photographer mapping gets applied.
    //
    // Only targets projects whose stale pending_review_reason explicitly
    // mentions the agent/photographer gap OR where agent_id/photographer_id
    // is actually null. This avoids replaying projects that are in
    // pending_review for unrelated reasons (e.g. service change, additional
    // appointment, urgent review) and prevents infinite replay loops when
    // mapping_confidence is legitimately "partial" due to non-mapping factors.
    // ─────────────────────────────────────────────────────────────────────
    const { data: stealthProjects = [] } = await admin
      .from('projects')
      .select('id, status, tonomo_order_id, agent_id, photographer_id, mapping_confidence, pending_review_type, pending_review_reason')
      .eq('status', 'pending_review')
      .eq('source', 'tonomo')
      .not('tonomo_order_id', 'is', null);

    let stealthReplayed = 0;
    for (const project of stealthProjects) {
      // Already handled in pass 1? Skip to avoid double-replaying.
      if (replayedOrderIds.has(project.tonomo_order_id)) continue;

      // Replay heuristics — look at what *would* benefit from re-resolving
      // against the current mapping table:
      //   (a) agent_id missing but payload has a listing agent, or
      //   (b) photographer_id missing but payload includes photographers, or
      //   (c) stale pending_review_reason still complains about unresolved
      //       staff even though agent_id/photographer_id are now set.
      // All three cases imply that a fresh mapping-table lookup could
      // complete the project.
      const reason = project.pending_review_reason || '';
      const mentionsAgentGap = reason.includes('Agent reassigned') || reason.includes('agent not found');
      const mentionsPhotographerGap = reason.includes('Photographer(s) reassigned') || reason.includes('Photographer reassigned');
      const needsAgent = !project.agent_id;
      const needsPhotographer = !project.photographer_id;

      // Only replay if there's clear evidence a remap would help.
      if (!needsAgent && !needsPhotographer && !mentionsAgentGap && !mentionsPhotographerGap) continue;

      const replayed = await replayLatestWebhook(project.tonomo_order_id, project.id);
      if (replayed) stealthReplayed++;
    }

    // Trigger the processor once at the end to pick up all replayed queue items
    if (replayedOrderIds.size > 0) {
      fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/processTonomoQueue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: '{}',
      }).catch(() => {});
    }

    return jsonResponse({
      status: 'ok',
      projects_checked: projects.length + stealthProjects.length,
      gaps_cleared: cleared,
      still_gapped: stillGapped,
      stealth_replayed: stealthReplayed,
      total_replayed: replayedOrderIds.size,
    }, 200, req);

  } catch (err: any) {
    console.error('recheckMappingGaps error:', err?.message || err);
    return jsonResponse({ error: err?.message || 'Internal error' }, 500, req);
  }
});
