import { handleCors, jsonResponse, getAdminClient } from '../_shared/supabase.ts';

/**
 * Recheck mapping gaps on pending_review projects.
 * Called when a mapping is confirmed/linked/updated.
 * Sweeps all projects with non-empty mapping_gaps and revalidates
 * each gap against the current tonomo_mapping_tables.
 */
Deno.serve(async (req) => {
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

    // 2. Find all projects with non-empty mapping gaps
    const { data: projects = [] } = await admin
      .from('projects')
      .select('id, mapping_gaps, products_mapping_gaps, status, tonomo_order_id')
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

        // If project is pending_review and has a tonomo order, clear manual overrides
        // and replay the latest webhook to re-resolve products with updated mappings
        if (project.status === 'pending_review' && project.tonomo_order_id) {
          try {
            // Clear manual overrides so Tonomo can update products/packages
            await admin
              .from('projects')
              .update({ manually_overridden_fields: '[]' })
              .eq('id', project.id);
            const { data: queueEntries } = await admin
              .from('tonomo_processing_queue')
              .select('id')
              .eq('order_id', project.tonomo_order_id)
              .eq('status', 'completed')
              .order('created_at', { ascending: false })
              .limit(1);

            if (queueEntries?.[0]) {
              await admin
                .from('tonomo_processing_queue')
                .update({ status: 'pending', retry_count: 0, error_message: null, result_summary: null, processed_at: null })
                .eq('id', queueEntries[0].id);

              // Trigger queue processor to pick up the replayed entry
              fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/processTonomoQueue`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                },
                body: '{}',
              }).catch(() => {});
            }
          } catch (replayErr) {
            console.warn(`Failed to replay webhook for project ${project.id}:`, replayErr);
          }
        }
      }

      if (remainingGaps.length > 0 || remainingProductGaps.length > 0) {
        stillGapped++;
      }
    }

    return jsonResponse({
      status: 'ok',
      projects_checked: projects.length,
      gaps_cleared: cleared,
      still_gapped: stillGapped,
    }, 200, req);

  } catch (err: any) {
    console.error('recheckMappingGaps error:', err?.message || err);
    return jsonResponse({ error: err?.message || 'Internal error' }, 500, req);
  }
});
