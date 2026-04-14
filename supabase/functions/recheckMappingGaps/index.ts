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

    // 1. Load all confirmed service mappings (tonomo_id + both label variants)
    const { data: mappings = [] } = await admin
      .from('tonomo_mapping_tables')
      .select('tonomo_id, tonomo_label, flexmedia_label, is_confirmed')
      .eq('is_confirmed', true)
      .eq('mapping_type', 'service');

    const confirmedTonomoIds = new Set(mappings.map((m: any) => m.tonomo_id));
    // Match by BOTH the Tonomo original name AND the FlexMedia label (case-insensitive)
    const confirmedNames = new Set<string>();
    for (const m of mappings) {
      if (m.flexmedia_label) confirmedNames.add(m.flexmedia_label.toLowerCase());
      if (m.tonomo_label) confirmedNames.add(m.tonomo_label.toLowerCase());
    }

    // 2. Find all projects with non-empty mapping gaps
    const { data: projects = [] } = await admin
      .from('projects')
      .select('id, mapping_gaps, products_mapping_gaps')
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

      // Recheck each gap: is the service now mapped?
      // mapping_gaps format: ["service:tonomoId", ...]
      const remainingGaps = gaps.filter((g: string) => {
        const tonomoId = g.replace('service:', '');
        return !confirmedTonomoIds.has(tonomoId);
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
