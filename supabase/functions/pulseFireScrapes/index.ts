import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Pulse Fire Scrapes — Lightweight cron dispatcher (v3 DB-driven config)
 *
 * Reads source configuration from pulse_source_configs (single source of truth
 * for all Apify input parameters). For per_suburb sources, iterates active
 * suburbs in pulse_target_suburbs and fires individual pulseDataSync calls
 * fire-and-forget. For bounding_box sources, fires a single pulseDataSync call.
 *
 * Body params:
 *   source_id: string    — must exist in pulse_source_configs
 *   min_priority: number — override config.min_priority (optional)
 *   max_suburbs: number  — override config.max_suburbs (optional, safety cap)
 *
 * The actor input template (URL, maxItems, maxPages, etc.) lives in
 * pulse_source_configs.actor_input (jsonb). This function inflates {suburb}
 * and {suburb-slug} placeholders and passes the result verbatim to
 * pulseDataSync as body.actorInput.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
// IMPORTANT: SUPABASE_SERVICE_ROLE_KEY on new Supabase projects is auto-injected
// in the new sb_secret_... format, which is NOT a JWT and fails edge function
// auth (UNAUTHORIZED_INVALID_JWT_FORMAT). For edge-to-edge HTTP calls we need a
// legacy JWT service_role key. PULSE_EDGE_JWT is a user-set secret containing
// that JWT. Falls back to SUPABASE_SERVICE_ROLE_KEY only if PULSE_EDGE_JWT is
// missing (for backward compat with old projects).
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get('PULSE_EDGE_JWT') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

/**
 * Expand {suburb} / {suburb-slug} / {postcode} placeholders in every string
 * value of the actor input template. Non-string values pass through unchanged.
 */
function inflateSuburbTemplate(
  input: Record<string, any>,
  suburb: string,
  postcode: string | null,
): Record<string, any> {
  const slug = suburb.toLowerCase().replace(/\s+/g, '-');
  const postcodeStr = postcode || '';
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') {
      out[k] = v
        .replace(/\{suburb\}/g, suburb)
        .replace(/\{suburb-slug\}/g, slug)
        .replace(/\{postcode\}/g, postcodeStr);
    } else {
      out[k] = v;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const _entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v3.0', _fn: 'pulseFireScrapes', _arch: 'db-driven' });
    }

    const { source_id } = body;

    if (!source_id) {
      return errorResponse('source_id is required', 400);
    }

    // ── Load config from DB (single source of truth) ─────────────────────
    const { data: config, error: cfgErr } = await admin
      .from('pulse_source_configs')
      .select('source_id, label, actor_slug, actor_input, approach, max_results_per_suburb, max_suburbs, min_priority, is_enabled')
      .eq('source_id', source_id)
      .single();

    if (cfgErr || !config) {
      return errorResponse(`Unknown source_id: ${source_id}. Must exist in pulse_source_configs. ${cfgErr?.message || ''}`, 400);
    }

    if (!config.is_enabled) {
      return errorResponse(`Source ${source_id} is disabled in pulse_source_configs.`, 400);
    }

    const actorInput = (config.actor_input || {}) as Record<string, any>;
    const isBoundingBox = config.approach === 'bounding_box';
    const sourceLabel = config.label || source_id;

    // Body overrides > DB config > defaults
    const min_priority = body.min_priority ?? config.min_priority ?? 0;
    const max_suburbs = body.max_suburbs ?? config.max_suburbs ?? 20;

    const now = new Date().toISOString();

    // Duplicate run check — skip if already running within last 30 min
    const { data: runningSync } = await admin.from('pulse_sync_logs')
      .select('id')
      .eq('source_id', source_id)
      .eq('status', 'running')
      .gte('started_at', new Date(Date.now() - 30 * 60000).toISOString())
      .limit(1);
    if (runningSync && runningSync.length > 0) {
      return jsonResponse({ success: false, message: `Source ${source_id} already running`, existing_log: runningSync[0].id });
    }

    // ── Bounding box: single call, no suburb iteration ──────────────────
    if (isBoundingBox) {
      const params = {
        suburbs: [],
        state: 'NSW',
        source_id,
        source_label: `${sourceLabel} (cron)`,
        triggered_by_name: 'Cron',
        // Pass the actor input verbatim — pulseDataSync consumes it as-is.
        actorInput,
      };

      const p = fetch(`${SUPABASE_URL}/functions/v1/pulseDataSync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(params),
      }).catch((err) => { console.error('Fire-and-forget failed for', source_id, err.message?.substring(0, 100)); });
      await Promise.race([p, new Promise(r => setTimeout(r, 3000))]);

      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'system', event_type: 'cron_dispatched', event_category: 'system',
          title: `Cron dispatched: ${sourceLabel}`,
          description: `Bounding box scrape fired`,
          new_value: { source_id, actor_input: actorInput },
          source: 'cron',
        });
      } catch { /* non-fatal */ }

      try {
        await admin.from('pulse_source_configs').update({ last_run_at: now }).eq('source_id', source_id);
      } catch { /* non-fatal */ }

      return jsonResponse({ success: true, source_id, dispatched: 1, type: 'bounding_box' });
    }

    // ── Per-suburb: load suburbs, fire individual calls ──────────────────
    let query = admin.from('pulse_target_suburbs')
      .select('name, postcode')
      .eq('is_active', true)
      .order('priority', { ascending: false })
      .limit(max_suburbs);

    if (min_priority > 0) {
      query = query.gte('priority', min_priority);
    }

    const { data: suburbs } = await query;
    if (!suburbs || suburbs.length === 0) {
      return jsonResponse({ success: true, source_id, dispatched: 0, message: 'No active suburbs' });
    }

    // Per-suburb URLs require postcode — skip any suburb missing it. The REA
    // URL pattern (e.g. /buy/in-strathfield,+nsw+2135) silently redirects or
    // returns garbage without a postcode, so scraping without one is unsafe.
    const actorInputUsesPostcode = JSON.stringify(actorInput).includes('{postcode}');
    const skippedSuburbs: string[] = [];
    const eligibleSuburbs = suburbs.filter(s => {
      if (actorInputUsesPostcode && !s.postcode) {
        skippedSuburbs.push(s.name);
        return false;
      }
      return true;
    });

    if (skippedSuburbs.length > 0) {
      console.warn(`[${source_id}] Skipped ${skippedSuburbs.length} suburbs missing postcode: ${skippedSuburbs.slice(0, 10).join(', ')}${skippedSuburbs.length > 10 ? '...' : ''}`);
    }

    // Inject max_results_per_suburb as actorInput.maxItems (cap per run).
    const maxItems = config.max_results_per_suburb ?? actorInput.maxItems ?? 10;

    let dispatched = 0;
    for (const suburb of eligibleSuburbs) {
      // Inflate {suburb} / {suburb-slug} / {postcode} placeholders in template
      const inflated = inflateSuburbTemplate(actorInput, suburb.name, suburb.postcode || null);
      // Force maxItems from config so we never depend on hardcoded template value
      inflated.maxItems = maxItems;

      const params = {
        suburbs: [suburb.name],
        state: 'NSW',
        source_id,
        source_label: `${sourceLabel} - ${suburb.name} (cron)`,
        triggered_by_name: 'Cron',
        actorInput: inflated,
      };

      const sp = fetch(`${SUPABASE_URL}/functions/v1/pulseDataSync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(params),
      }).catch((err) => { console.error('Fire-and-forget failed for', source_id, err.message?.substring(0, 100)); });
      await Promise.race([sp, new Promise(r => setTimeout(r, 3000))]);

      dispatched++;

      // Stagger to avoid Apify rate limit
      if (dispatched < eligibleSuburbs.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    try {
      await admin.from('pulse_timeline').insert({
        entity_type: 'system', event_type: 'cron_dispatched', event_category: 'system',
        title: `Cron dispatched: ${sourceLabel}`,
        description: `Fired ${dispatched} individual suburb scrapes (${eligibleSuburbs.map(s => s.name).slice(0, 5).join(', ')}${eligibleSuburbs.length > 5 ? '...' : ''})${skippedSuburbs.length > 0 ? ` — skipped ${skippedSuburbs.length} missing postcode` : ''}`,
        new_value: { source_id, dispatched, min_priority, max_items: maxItems, suburbs: eligibleSuburbs.map(s => s.name), skipped: skippedSuburbs, actor_input: actorInput },
        source: 'cron',
      });
    } catch { /* non-fatal */ }

    try {
      await admin.from('pulse_source_configs').update({ last_run_at: now }).eq('source_id', source_id);
    } catch { /* non-fatal */ }

    return jsonResponse({ success: true, source_id, dispatched, suburbs: eligibleSuburbs.length, skipped: skippedSuburbs.length, max_items: maxItems });

  } catch (error: any) {
    console.error('pulseFireScrapes error:', error);
    return errorResponse(error.message);
  }
});
