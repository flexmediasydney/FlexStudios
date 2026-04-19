/**
 * pulseSignalGenerator — daily rollup from pulse_timeline + pulse_crm_mappings
 * into user-facing pulse_signals rows.
 *
 * The Signals tab in IndustryPulse was showing 0 rows because nothing was
 * writing to pulse_signals except the hand-capture QuickAdd dialog. This
 * function turns the noisy pulse_timeline firehose into ~dozens of curated
 * signal cards per day, driven by four classes:
 *
 *   1. Agent movement       — agency_change events (level=person)
 *   2. Agency growth        — ≥2 new agents at one agency in 24h (level=organisation)
 *   3. Price drops          — price_change events where price dropped (level=organisation)
 *   4. CRM suggestions      — new pulse_crm_mappings with confidence='suggested' (level=person)
 *
 * Idempotency: every insert sets idempotency_key=<generator>:<class>:<key> and
 * the partial unique index in migration 126 makes retries harmless. Re-running
 * the function same-day produces zero new rows.
 *
 * Schema note: pulse_signals.category has a CHECK constraint that only allows
 * event/movement/milestone/market/custom. We map the class to the nearest
 * allowed value and record the finer-grained class in source_data.kind.
 */

import {
  getAdminClient,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { startRun, endRun, recordError } from '../_shared/observability.ts';

const GENERATOR = 'pulseSignalGenerator';
const SOURCE_ID = 'pulse_signal_generator';
const DEFAULT_LOOKBACK_HOURS = 24;
const AGENCY_GROWTH_THRESHOLD = 2;  // agents gained in lookback to trigger a growth signal

type SignalInsert = {
  level: 'industry' | 'organisation' | 'person';
  category: 'event' | 'movement' | 'milestone' | 'market' | 'custom';
  title: string;
  description?: string | null;
  status: 'new';
  is_actionable: boolean;
  suggested_action?: string | null;
  linked_agent_ids?: string[];
  linked_agency_ids?: string[];
  source_data: Record<string, unknown>;
  source_generator: string;
  source_run_id: string;
  idempotency_key: string;
};

// ── Pagination helper ────────────────────────────────────────────────────

/**
 * PostgREST `.select()` silently caps at 1000 rows by default. These signal
 * generators scan pulse_timeline which has 7k+ rows in a 7-day window, so
 * each `.gte('created_at', since)` query was producing heavily truncated
 * candidate sets. We paginate with explicit `.range()` windows up to a
 * 50k hard-stop safety cap.
 *
 * `label` is for the console breadcrumb; `buildQuery(offset, limit)` must
 * return a PostgREST query promise that resolves to `{ data, error }`.
 */
const PAGE_SIZE = 1000;
const MAX_PAGINATED_ROWS = 50_000;

async function paginateTimeline<T = any>(
  label: string,
  buildQuery: (offset: number, limit: number) => PromiseLike<{ data: any; error: any }>,
): Promise<T[]> {
  const allRows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await buildQuery(offset, PAGE_SIZE);
    if (error) {
      console.error(`[${label}] page error at offset=${offset}:`, error.message);
      break;
    }
    const rows: T[] = (data || []) as T[];
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (allRows.length >= MAX_PAGINATED_ROWS) {
      console.warn(`[${label}] truncating at ${MAX_PAGINATED_ROWS} rows (safety cap)`);
      break;
    }
  }
  console.log(`[${label}] scanned ${allRows.length} rows`);
  return allRows;
}

// ── Generator classes ────────────────────────────────────────────────────

/**
 * Class 1 — agent movement. One signal per pulse_timeline row with
 * event_type='agency_change' in the lookback window.
 */
async function generateAgentMovement(
  admin: ReturnType<typeof getAdminClient>,
  since: string,
  runId: string,
): Promise<SignalInsert[]> {
  const data = await paginateTimeline<any>('agent_movement', (offset, limit) =>
    admin
      .from('pulse_timeline')
      .select('id, entity_type, pulse_entity_id, rea_id, title, description, new_value, previous_value, metadata, created_at')
      .eq('event_type', 'agency_change')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1),
  );
  if (!data.length) return [];

  return data.map((row: any) => {
    // pulse_timeline.title is already human-readable ("Jane Doe moved to Ray White")
    // so we reuse it. Fall back to a synthesised title if needed.
    const title = row.title || `Agent moved agencies`;
    const description = row.description || null;
    return {
      level: 'person',
      category: 'movement',
      title,
      description,
      status: 'new' as const,
      is_actionable: true,
      suggested_action: 'Congratulate and reconnect with this agent at their new agency',
      linked_agent_ids: [],
      linked_agency_ids: [],
      source_data: {
        kind: 'agent_movement',
        timeline_id: row.id,
        pulse_entity_id: row.pulse_entity_id,
        rea_id: row.rea_id,
        previous_value: row.previous_value,
        new_value: row.new_value,
      },
      source_generator: GENERATOR,
      source_run_id: runId,
      idempotency_key: `${GENERATOR}:agent_movement:${row.id}`,
    };
  });
}

/**
 * Class 2 — agency growth. Group first_seen events for agents in the lookback
 * by their agency_rea_id. Emit a single signal for each agency that gained
 * ≥AGENCY_GROWTH_THRESHOLD agents.
 *
 * We use pulse_agents (not pulse_timeline.new_value) to resolve agency name,
 * because the first_seen timeline row rarely has the join pre-materialised.
 */
async function generateAgencyGrowth(
  admin: ReturnType<typeof getAdminClient>,
  since: string,
  runId: string,
): Promise<SignalInsert[]> {
  const events = await paginateTimeline<any>('agency_growth', (offset, limit) =>
    admin
      .from('pulse_timeline')
      .select('id, pulse_entity_id, rea_id, created_at, metadata, new_value')
      .eq('event_type', 'first_seen')
      .eq('entity_type', 'agent')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1),
  );
  if (!events.length) return [];

  // Resolve each pulse_entity_id → pulse_agents row to find current agency_rea_id.
  // Prefer pulse_entity_id (uuid fk), fall back to rea_id if missing.
  const pulseIds = Array.from(new Set(events.map((e: any) => e.pulse_entity_id).filter(Boolean)));
  const reaIds   = Array.from(new Set(events.map((e: any) => e.rea_id).filter(Boolean)));
  if (!pulseIds.length && !reaIds.length) return [];

  let agents: any[] = [];
  if (pulseIds.length) {
    const { data } = await admin
      .from('pulse_agents')
      .select('id, name, rea_agent_id, agency_rea_id, agency_name')
      .in('id', pulseIds);
    if (data) agents = agents.concat(data);
  }
  if (reaIds.length) {
    const { data } = await admin
      .from('pulse_agents')
      .select('id, name, rea_agent_id, agency_rea_id, agency_name')
      .in('rea_agent_id', reaIds);
    if (data) agents = agents.concat(data.filter((a) => !agents.some((x) => x.id === a.id)));
  }
  if (!agents.length) return [];

  // Group by agency_rea_id (skip agents with no agency).
  const byAgency = new Map<string, { name: string; agents: any[] }>();
  for (const a of agents) {
    if (!a.agency_rea_id) continue;
    const slot = byAgency.get(a.agency_rea_id) || { name: a.agency_name || 'Unknown agency', agents: [] };
    slot.agents.push(a);
    byAgency.set(a.agency_rea_id, slot);
  }

  const signals: SignalInsert[] = [];
  // Bucket by day so a burst the next day doesn't re-fire the prior day's idempotency key.
  const dayKey = new Date().toISOString().slice(0, 10);

  for (const [agencyReaId, { name, agents: list }] of byAgency.entries()) {
    if (list.length < AGENCY_GROWTH_THRESHOLD) continue;
    const n = list.length;
    signals.push({
      level: 'organisation',
      category: 'market',
      title: `Agency ${name} grew by ${n} agents`,
      description: `In the last ${DEFAULT_LOOKBACK_HOURS}h: ${list.slice(0, 5).map((a: any) => a.name).join(', ')}${list.length > 5 ? `, +${list.length - 5} more` : ''}.`,
      status: 'new',
      is_actionable: true,
      suggested_action: 'Review the agency profile and re-engage if they were a dormant prospect',
      linked_agent_ids: list.map((a: any) => a.id),
      linked_agency_ids: [],
      source_data: {
        kind: 'agency_growth',
        agency_rea_id: agencyReaId,
        agency_name: name,
        new_agent_count: n,
        agent_pulse_ids: list.map((a: any) => a.id),
      },
      source_generator: GENERATOR,
      source_run_id: runId,
      idempotency_key: `${GENERATOR}:agency_growth:${agencyReaId}:${dayKey}`,
    });
  }
  return signals;
}

/**
 * Class 3 — price drops. Mirror pulse_timeline event_type='price_change' where
 * the price went down. Up-moves aren't interesting to a photography CRM.
 * Timeline event row exposes new_value.count + new_value.sample[].old/new.
 */
async function generatePriceDrops(
  admin: ReturnType<typeof getAdminClient>,
  since: string,
  runId: string,
): Promise<SignalInsert[]> {
  const data = await paginateTimeline<any>('price_drop', (offset, limit) =>
    admin
      .from('pulse_timeline')
      .select('id, title, description, new_value, created_at')
      .eq('event_type', 'price_change')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1),
  );
  if (!data.length) return [];

  const signals: SignalInsert[] = [];
  for (const row of data) {
    // new_value.sample is an array of { address, old, new }; filter to drops only.
    const sample: Array<{ address?: string; old?: number; new?: number }> =
      (row.new_value as any)?.sample || [];
    const drops = sample.filter((s) => (s.new ?? 0) > 0 && (s.old ?? 0) > (s.new ?? 0));
    if (!drops.length) continue;

    const top = drops[0];
    const title = drops.length === 1
      ? `Price drop: ${top.address || 'listing'} now ${fmtShort(top.new)} (was ${fmtShort(top.old)})`
      : `${drops.length} listing price drops detected`;

    signals.push({
      level: 'organisation',
      category: 'market',
      title,
      description: drops.slice(0, 3).map((d) => `${d.address || '?'}: ${fmtShort(d.old)} → ${fmtShort(d.new)}`).join('; '),
      status: 'new',
      is_actionable: true,
      suggested_action: 'Reach out — motivated vendor may now need re-marketing',
      linked_agent_ids: [],
      linked_agency_ids: [],
      source_data: {
        kind: 'price_drop',
        timeline_id: row.id,
        drop_count: drops.length,
        drops: drops.slice(0, 10),
      },
      source_generator: GENERATOR,
      source_run_id: runId,
      idempotency_key: `${GENERATOR}:price_drop:${row.id}`,
    });
  }
  return signals;
}

/**
 * Class 4 — new CRM mapping suggestions. Each row in pulse_crm_mappings with
 * confidence='suggested' and created_at in the lookback window gets one signal
 * so the user sees a nudge on the Signals tab that there's work to do on the
 * Mappings tab.
 */
async function generateCrmSuggestions(
  admin: ReturnType<typeof getAdminClient>,
  since: string,
  runId: string,
): Promise<SignalInsert[]> {
  const { data, error } = await admin
    .from('pulse_crm_mappings')
    .select('id, entity_type, pulse_entity_id, crm_entity_id, confidence, match_type, created_at')
    .eq('confidence', 'suggested')
    .gte('created_at', since);
  if (error) throw new Error(`crm_suggestion query failed: ${error.message}`);
  if (!data?.length) return [];

  // Resolve names on each side so the title isn't "matched id → id".
  const agentPulseIds = data.filter((d: any) => d.entity_type === 'agent').map((d: any) => d.pulse_entity_id).filter(Boolean);
  const agencyPulseIds = data.filter((d: any) => d.entity_type === 'agency').map((d: any) => d.pulse_entity_id).filter(Boolean);
  const agentCrmIds = data.filter((d: any) => d.entity_type === 'agent').map((d: any) => d.crm_entity_id).filter(Boolean);
  const agencyCrmIds = data.filter((d: any) => d.entity_type === 'agency').map((d: any) => d.crm_entity_id).filter(Boolean);

  const [pa, pag, ca, cag] = await Promise.all([
    agentPulseIds.length  ? admin.from('pulse_agents').select('id, name').in('id', agentPulseIds)    : Promise.resolve({ data: [] }),
    agencyPulseIds.length ? admin.from('pulse_agencies').select('id, name').in('id', agencyPulseIds) : Promise.resolve({ data: [] }),
    agentCrmIds.length    ? admin.from('agents').select('id, name').in('id', agentCrmIds)            : Promise.resolve({ data: [] }),
    agencyCrmIds.length   ? admin.from('agencies').select('id, name').in('id', agencyCrmIds)         : Promise.resolve({ data: [] }),
  ]);
  const pulseAgentName  = new Map((pa.data  || []).map((r: any) => [r.id, r.name]));
  const pulseAgencyName = new Map((pag.data || []).map((r: any) => [r.id, r.name]));
  const crmAgentName    = new Map((ca.data  || []).map((r: any) => [r.id, r.name]));
  const crmAgencyName   = new Map((cag.data || []).map((r: any) => [r.id, r.name]));

  return data.map((row: any) => {
    const isAgent = row.entity_type === 'agent';
    const pulseName = (isAgent ? pulseAgentName : pulseAgencyName).get(row.pulse_entity_id) || '(pulse entity)';
    const crmName   = (isAgent ? crmAgentName   : crmAgencyName  ).get(row.crm_entity_id)   || '(crm entity)';
    return {
      level: isAgent ? 'person' : 'organisation',
      category: 'custom',
      title: `Suggested CRM match: ${pulseName} → ${crmName}`,
      description: `Match type: ${row.match_type || 'unknown'}. Confirm or reject on the Mappings tab.`,
      status: 'new' as const,
      is_actionable: true,
      suggested_action: 'Open the Mappings tab and confirm or reject',
      linked_agent_ids: isAgent && row.crm_entity_id ? [row.crm_entity_id] : [],
      linked_agency_ids: !isAgent && row.crm_entity_id ? [row.crm_entity_id] : [],
      source_data: {
        kind: 'crm_suggestion',
        mapping_id: row.id,
        entity_type: row.entity_type,
        pulse_entity_id: row.pulse_entity_id,
        crm_entity_id: row.crm_entity_id,
        match_type: row.match_type,
      },
      source_generator: GENERATOR,
      source_run_id: runId,
      idempotency_key: `${GENERATOR}:crm_suggestion:${row.id}`,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtShort(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000)     return `$${Math.round(v / 1_000)}k`;
  return `$${v}`;
}

// ── HTTP handler ─────────────────────────────────────────────────────────

serveWithAudit('pulseSignalGenerator', async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  let lookbackHours = DEFAULT_LOOKBACK_HOURS;
  try {
    const body = await req.clone().json().catch(() => ({}));
    if (typeof body?.lookback_hours === 'number' && body.lookback_hours > 0) {
      lookbackHours = Math.min(body.lookback_hours, 168); // cap at 7 days
    }
  } catch { /* no body — use default */ }

  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const admin = getAdminClient();

  // ── Open observability run ─────────────────────────────────────────────
  // Uses the shared module so every pulseSignalGenerator invocation shows up
  // in the Run History UI the same way pulseDataSync / pulseDetailEnrich do.
  // The legacy pulse_timeline 'data_sync' row below is kept for backward
  // compatibility with the Signals tab's existing event-type filter.
  const ctx = await startRun({
    admin,
    sourceId: SOURCE_ID,
    syncType: 'pulse_signal_generate',
    triggeredBy: 'manual',
    triggeredByName: `pulseSignalGenerator:${runId.slice(0, 8)}`,
    inputConfig: { lookback_hours: lookbackHours, since, run_id: runId },
  });

  const results: Record<string, { candidates: number; inserted: number; error?: string }> = {
    agent_movement:  { candidates: 0, inserted: 0 },
    agency_growth:   { candidates: 0, inserted: 0 },
    price_drop:      { candidates: 0, inserted: 0 },
    crm_suggestion:  { candidates: 0, inserted: 0 },
  };

  const classes: Array<[string, (a: any, s: string, r: string) => Promise<SignalInsert[]>]> = [
    ['agent_movement',  generateAgentMovement],
    ['agency_growth',   generateAgencyGrowth],
    ['price_drop',      generatePriceDrops],
    ['crm_suggestion',  generateCrmSuggestions],
  ];

  // Collected signal rows (with returned ids) so we can mirror them into pulse_timeline.
  const allInsertedSignals: Array<{ id: string; row: SignalInsert }> = [];

  for (const [name, fn] of classes) {
    try {
      const rows = await fn(admin, since, runId);
      results[name].candidates = rows.length;
      if (!rows.length) continue;

      // Pre-filter against the partial unique index. We can't use Postgres
      // `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL` via
      // PostgREST upsert (it doesn't surface the predicate), so we do a
      // SELECT-then-INSERT dance. Race-safe enough for a once-daily cron.
      const keys = rows.map((r) => r.idempotency_key);
      const { data: existing } = await admin
        .from('pulse_signals')
        .select('idempotency_key')
        .in('idempotency_key', keys);
      const seen = new Set((existing || []).map((r: any) => r.idempotency_key));
      const fresh = rows.filter((r) => !seen.has(r.idempotency_key));
      if (!fresh.length) continue;

      const { error, data } = await admin
        .from('pulse_signals')
        .insert(fresh)
        .select('id, idempotency_key');
      if (error) throw new Error(error.message);
      results[name].inserted = data?.length || 0;

      // Map returned ids back to their source rows by idempotency_key so we can
      // mirror each signal into pulse_timeline for every linked entity.
      const byKey = new Map(fresh.map((r) => [r.idempotency_key, r]));
      for (const inserted of (data || [])) {
        const row = byKey.get(inserted.idempotency_key);
        if (row) allInsertedSignals.push({ id: inserted.id, row });
      }
    } catch (err: any) {
      recordError(ctx, err, 'error');
      results[name].error = err?.message || String(err);
    }
  }

  // ── Mirror signals into pulse_timeline ───────────────────────────────────
  // For each freshly inserted signal, emit one pulse_timeline row per linked
  // entity (agent + agency + any pulse_entity_id from source_data). This
  // surfaces the signal on the entity's dossier timeline so operators see
  // "Signal: Price drop" when reading the agency's intel page, not just on
  // the Signals tab.
  //
  // Idempotency: signal_mirror:<signal_id>:<entity_type>:<entity_id>
  let mirrorInserted = 0;
  try {
    const mirrorRows: Array<Record<string, unknown>> = [];
    for (const { id: signalId, row } of allInsertedSignals) {
      const kind = String((row.source_data as any)?.kind || 'signal');

      // Collect (entity_type, entity_id) pairs to mirror.
      const targets: Array<{ entity_type: string; entity_id: string }> = [];
      for (const agentId of row.linked_agent_ids || []) {
        targets.push({ entity_type: 'agent', entity_id: agentId });
      }
      for (const agencyId of row.linked_agency_ids || []) {
        targets.push({ entity_type: 'agency', entity_id: agencyId });
      }
      // Pulse-native agent / agency ids in source_data (agency_growth stores them).
      const sd: any = row.source_data || {};
      for (const pid of (sd.agent_pulse_ids || [])) {
        targets.push({ entity_type: 'agent', entity_id: pid });
      }
      for (const pid of (sd.agency_pulse_ids || [])) {
        targets.push({ entity_type: 'agency', entity_id: pid });
      }
      // Pulse entity id (crm_suggestion stores it directly, may be null).
      if (sd.pulse_entity_id) {
        const et = sd.entity_type === 'agency' ? 'agency' : 'agent';
        targets.push({ entity_type: et, entity_id: sd.pulse_entity_id });
      }

      // Dedupe — a single signal might list the same agent twice.
      const seen = new Set<string>();
      for (const t of targets) {
        const k = `${t.entity_type}:${t.entity_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        mirrorRows.push({
          entity_type: t.entity_type,
          pulse_entity_id: t.entity_id,
          event_type: 'signal_emitted',
          event_category: 'signal',
          title: row.title,
          description: row.description,
          new_value: {
            signal_id: signalId,
            kind,
            level: row.level,
            category: row.category,
            suggested_action: row.suggested_action,
          },
          metadata: { signal_id: signalId, kind, level: row.level },
          source: GENERATOR,
          idempotency_key: `signal_mirror:${signalId}:${t.entity_type}:${t.entity_id}`,
          sync_log_id: ctx.syncLogId,
        });
      }
    }

    if (mirrorRows.length) {
      // Chunk insert; idempotency_key collisions are silently ignored by the
      // partial unique index (migration 126). Same row-by-row fallback pattern
      // as pulseRelistDetector for duplicate safety.
      for (let i = 0; i < mirrorRows.length; i += 100) {
        const chunk = mirrorRows.slice(i, i + 100);
        const { data, error } = await admin.from('pulse_timeline').insert(chunk).select('id');
        if (error) {
          for (const r of chunk) {
            const { error: e2, data: d2 } = await admin.from('pulse_timeline').insert(r).select('id');
            if (!e2) mirrorInserted += d2?.length || 1;
          }
        } else {
          mirrorInserted += data?.length || 0;
        }
      }
    }
  } catch (err: any) {
    recordError(ctx, err, 'warn');
  }

  const totalInserted = Object.values(results).reduce((a, r) => a + r.inserted, 0);
  const totalCandidates = Object.values(results).reduce((a, r) => a + r.candidates, 0);
  const anyError = Object.values(results).some(r => r.error);

  // Emit a timeline "data_sync" row so the run shows up in PulseTimeline UI.
  // Kept for backward compatibility — the Signals tab filters on this event.
  try {
    await admin.from('pulse_timeline').insert({
      entity_type: 'system',
      event_type: 'data_sync',
      event_category: 'system',
      title: `Signal generator produced ${totalInserted} signal${totalInserted === 1 ? '' : 's'}`,
      description: Object.entries(results)
        .map(([k, v]) => `${k}=${v.inserted}/${v.candidates}${v.error ? ` (err: ${v.error})` : ''}`)
        .join(', '),
      new_value: { ...results, sync_log_id: ctx.syncLogId },
      source: GENERATOR,
      idempotency_key: `${GENERATOR}:run:${runId}`,
      sync_log_id: ctx.syncLogId,
    });
  } catch { /* non-fatal */ }

  // ── Close observability run ────────────────────────────────────────────
  await endRun(ctx, {
    status: anyError ? 'failed' : 'completed',
    recordsFetched: totalCandidates,
    recordsUpdated: totalInserted,
    recordsDetail: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, { candidates: v.candidates, inserted: v.inserted }]),
    ),
    sourceLabel: `${SOURCE_ID} · ${totalInserted} new · ${lookbackHours}h`,
    suburb: 'signals',
    customSummary: {
      lookback_hours: lookbackHours,
      since,
      results,
      total_candidates: totalCandidates,
      total_inserted: totalInserted,
      run_id: runId,
    },
  });

  return jsonResponse({
    ok: true,
    run_id: runId,
    sync_log_id: ctx.syncLogId,
    lookback_hours: lookbackHours,
    duration_ms: Date.now() - startedAt,
    results,
    total_inserted: totalInserted,
    timeline_mirror_inserted: mirrorInserted,
  }, 200, req);
});
