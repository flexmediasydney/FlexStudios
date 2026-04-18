/**
 * pulseTimelineAnchor — on-demand backfill that re-links unanchored
 * pulse_timeline rows to entities.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Audit finding DB02 (migration 123 Part D): 2,138 pulse_timeline rows with
 * pulse_entity_id IS NULL AND rea_id IS NULL. Migration 123 handled the
 * easy cases (agent rows with matching rea_agent_id, single-item listing
 * rollups parseable from description). The rest are listing events where:
 *   - metadata contains source_listing_id/agent_rea_id but the column is
 *     empty (older emitters didn't populate pulse_entity_id),
 *   - the description has a usable "<address> <suburb>" token but the
 *     address-prefix SQL in 123 only handled "<address>: ..." format,
 *   - or a rea_id is hiding in metadata.rea_id/metadata.agency_rea_id.
 *
 * This function is a one-shot tool (no cron — invoked run-as-needed) that
 * attempts inference against each remaining orphan and re-links where a
 * confident match is found.
 *
 * ── Algorithm ───────────────────────────────────────────────────────────
 * For each orphan (batch_size limit):
 *   1. If entity_type='listing' AND metadata.source_listing_id is present,
 *      look up pulse_listings by source_listing_id.
 *   2. If entity_type='agent' AND metadata.agent_rea_id (or metadata.rea_id)
 *      is present, look up pulse_agents by rea_agent_id.
 *   3. If entity_type='agency' AND metadata.agency_rea_id (or metadata.rea_id)
 *      is present, look up pulse_agencies by rea_agency_id.
 *   4. If entity_type='listing' AND description matches a single pulse_listings
 *      row via "<address> <suburb>" ILIKE join, anchor (low-confidence flag).
 *
 * Dry-run mode reports what WOULD be anchored without writing. Live mode
 * bulk-updates pulse_entity_id + rea_id on matched rows.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 * master_admin OR service_role (so curl with CRON_JWT works).
 *
 * ── Invocation ──────────────────────────────────────────────────────────
 *   POST body: {
 *     dry_run?: boolean,          // default false
 *     batch_size?: int,           // default 500, hard cap 5000
 *     entity_types?: string[]     // optional filter, e.g. ['listing']
 *   }
 */

import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'pulseTimelineAnchor';
const WALL_BUDGET_MS = 90_000; // give plenty of room for ILIKE join
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

type OrphanRow = {
  id: string;
  entity_type: string | null;
  event_type: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  title: string | null;
};

/** Event types that are structurally aggregate rollups — one row summarises
 *  N listings/agents, so there's no single pulse entity to anchor to. We
 *  skip address-ILIKE inference for these. Channels A/B/C (metadata ID
 *  lookups) still run, since those would be populated only for single-entity
 *  events in the first place. */
const AGGREGATE_EVENT_TYPES = new Set<string>([
  'new_listings_detected',
  'client_new_listing',
  'price_change',          // same shape as status_change: multi-item per row
  'coverage_report',
  'cron_dispatched',
  'cron_dispatch_started',
  'cron_dispatch_batch',
  'cron_dispatch_completed',
  'data_sync',
  'data_cleanup',
  'circuit_reset',
  'integrity_drift_warning',
]);

type Anchor = {
  pulse_entity_id?: string;
  rea_id?: string | null;
  via: 'source_listing_id' | 'agent_rea_id' | 'agency_rea_id' | 'metadata_rea_id' | 'address_match';
};

function pickMetaKey(meta: Record<string, unknown> | null, keys: string[]): string | null {
  if (!meta || typeof meta !== 'object') return null;
  for (const k of keys) {
    const v = (meta as any)[k];
    if (v !== undefined && v !== null && v !== '') {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
}

/** Returns [address, suburb] extracted from the trailing "<address> <suburb>"
 *  section of a description, if parseable. We look for a token that starts
 *  with a digit (street number) and contains at least one space. */
function extractAddressAndSuburb(description: string | null): { address: string; suburb: string } | null {
  if (!description) return null;
  // Strip HTML-ish chars, trim.
  const cleaned = description.replace(/\s+/g, ' ').trim();
  // Look for the first "<digit>...<word> <word>" substring, greedy to the end
  // of a line/phrase. We're looking for something like "12 Smith St Alexandria".
  const m = cleaned.match(/(\d{1,4}[^:;,\|]*?)\s+([A-Z][a-zA-Z\-' ]{2,40})(?=[:\|;]|$)/);
  if (!m) return null;
  const address = m[1].trim();
  const suburb = m[2].trim();
  if (address.length < 4 || suburb.length < 3) return null;
  return { address, suburb };
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed. Use POST.', 405, req);
  }

  // ── Auth gate ────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') return errorResponse('Forbidden: master_admin only', 403, req);
  }

  let body: any = {};
  try { body = await req.clone().json().catch(() => ({})); } catch { body = {}; }
  if (body?._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const dry_run = body?.dry_run === true;
  const rawBatch = Number(body?.batch_size);
  const batch_size = Number.isFinite(rawBatch) && rawBatch > 0
    ? Math.min(MAX_BATCH_SIZE, Math.floor(rawBatch))
    : DEFAULT_BATCH_SIZE;
  const entity_types: string[] | null = Array.isArray(body?.entity_types) && body.entity_types.length > 0
    ? body.entity_types.map((s: any) => String(s)).filter(Boolean)
    : null;

  const startedAt = Date.now();
  const admin = getAdminClient();

  // ── Fetch orphan batch ───────────────────────────────────────────────
  let query = admin.from('pulse_timeline')
    .select('id, entity_type, event_type, description, metadata, title')
    .is('pulse_entity_id', null)
    .is('rea_id', null)
    .order('created_at', { ascending: false })
    .limit(batch_size);
  if (entity_types) query = query.in('entity_type', entity_types);

  const { data: orphansRaw, error: selErr } = await query;
  if (selErr) {
    return errorResponse(`Failed to fetch orphans: ${selErr.message}`, 500, req);
  }
  const orphans: OrphanRow[] = (orphansRaw || []) as OrphanRow[];
  const scanned = orphans.length;

  if (scanned === 0) {
    // Nothing to do. Return a quick success shape identical to the main
    // path so callers can always rely on the same fields.
    const { count: stillC } = await admin.from('pulse_timeline')
      .select('*', { count: 'exact', head: true })
      .is('pulse_entity_id', null)
      .is('rea_id', null);
    return jsonResponse({
      ok: true,
      dry_run,
      scanned: 0,
      anchored: 0,
      still_unanchored: stillC ?? 0,
      breakdown: { by_source_listing_id: 0, by_agent_rea_id: 0, by_agency_rea_id: 0, by_metadata_rea_id: 0, by_address_match: 0 },
      sample_anchored: [],
      duration_ms: Date.now() - startedAt,
    }, 200, req);
  }

  // ── Inference pass ───────────────────────────────────────────────────
  //
  // We group orphans by inference channel and resolve each channel via ONE
  // bulk lookup to avoid N queries per channel. Channels (in priority order):
  //   A. source_listing_id (metadata) → pulse_listings.id
  //   B. agent_rea_id / rea_id (metadata) for entity_type=agent → pulse_agents.id
  //   C. agency_rea_id / rea_id (metadata) for entity_type=agency → pulse_agencies.id
  //   D. address ILIKE join — last-resort, only when exactly one listing matches
  //
  // Each orphan is assigned to at most one channel (A wins over B/C/D, etc).

  const breakdown = {
    by_source_listing_id: 0,
    by_agent_rea_id: 0,
    by_agency_rea_id: 0,
    by_metadata_rea_id: 0,  // generic metadata.rea_id when entity_type is ambiguous
    by_address_match: 0,
  };

  const decisions = new Map<string, Anchor>(); // orphan.id → anchor decision
  const sourceListingKeys = new Map<string, string[]>(); // source_listing_id → [orphanIds]
  const agentReaKeys = new Map<string, string[]>();      // rea_agent_id   → [orphanIds]
  const agencyReaKeys = new Map<string, string[]>();     // rea_agency_id  → [orphanIds]
  const genericReaKeys = new Map<string, string[]>();    // rea_id (unknown entity type) → [orphanIds]
  const addressCandidates: Array<{ id: string; address: string; suburb: string }> = [];

  for (const row of orphans) {
    const meta = row.metadata || null;
    const etype = (row.entity_type || '').toLowerCase();

    // Channel A — listing + source_listing_id
    if (etype === 'listing') {
      const sli = pickMetaKey(meta, ['source_listing_id', 'sourceListingId', 'listing_id']);
      if (sli) {
        const arr = sourceListingKeys.get(sli) || [];
        arr.push(row.id);
        sourceListingKeys.set(sli, arr);
        continue;
      }
    }

    // Channel B — agent + rea id
    if (etype === 'agent') {
      const reaId = pickMetaKey(meta, ['agent_rea_id', 'rea_agent_id', 'rea_id']);
      if (reaId) {
        const arr = agentReaKeys.get(reaId) || [];
        arr.push(row.id);
        agentReaKeys.set(reaId, arr);
        continue;
      }
    }

    // Channel C — agency + rea id
    if (etype === 'agency') {
      const reaId = pickMetaKey(meta, ['agency_rea_id', 'rea_agency_id', 'rea_id']);
      if (reaId) {
        const arr = agencyReaKeys.get(reaId) || [];
        arr.push(row.id);
        agencyReaKeys.set(reaId, arr);
        continue;
      }
    }

    // Channel (generic) — bare metadata.rea_id without a known entity_type
    {
      const reaId = pickMetaKey(meta, ['rea_id']);
      if (reaId) {
        const arr = genericReaKeys.get(reaId) || [];
        arr.push(row.id);
        genericReaKeys.set(reaId, arr);
        continue;
      }
    }

    // Channel D — listing address/suburb ILIKE
    // Skip known aggregate rollup event types: their descriptions pack
    // multiple listings into one row (separated by "; ") so any single-
    // address extract is meaningless.
    if (etype === 'listing' && !AGGREGATE_EVENT_TYPES.has(row.event_type || '')) {
      const parsed = extractAddressAndSuburb(row.description);
      if (parsed) {
        addressCandidates.push({ id: row.id, address: parsed.address, suburb: parsed.suburb });
        continue;
      }
    }
  }

  // ── Bulk resolve channel A: source_listing_id ────────────────────────
  if (sourceListingKeys.size > 0) {
    const keys = Array.from(sourceListingKeys.keys());
    // Chunk to avoid .in() exploding; 500 is comfortable.
    for (let i = 0; i < keys.length && Date.now() - startedAt < WALL_BUDGET_MS; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const { data, error } = await admin.from('pulse_listings')
        .select('id, source_listing_id')
        .in('source_listing_id', chunk);
      if (error) continue; // non-fatal, we carry on
      for (const row of (data || [])) {
        const sli = String(row.source_listing_id);
        const orphanIds = sourceListingKeys.get(sli) || [];
        for (const oid of orphanIds) {
          if (!decisions.has(oid)) {
            decisions.set(oid, { pulse_entity_id: row.id, via: 'source_listing_id' });
            breakdown.by_source_listing_id++;
          }
        }
      }
    }
  }

  // ── Bulk resolve channel B: pulse_agents.rea_agent_id ────────────────
  if (agentReaKeys.size > 0) {
    const keys = Array.from(agentReaKeys.keys());
    for (let i = 0; i < keys.length && Date.now() - startedAt < WALL_BUDGET_MS; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const { data, error } = await admin.from('pulse_agents')
        .select('id, rea_agent_id')
        .in('rea_agent_id', chunk);
      if (error) continue;
      for (const row of (data || [])) {
        const reaId = String(row.rea_agent_id);
        const orphanIds = agentReaKeys.get(reaId) || [];
        for (const oid of orphanIds) {
          if (!decisions.has(oid)) {
            decisions.set(oid, { pulse_entity_id: row.id, rea_id: reaId, via: 'agent_rea_id' });
            breakdown.by_agent_rea_id++;
          }
        }
      }
    }
  }

  // ── Bulk resolve channel C: pulse_agencies.rea_agency_id ─────────────
  if (agencyReaKeys.size > 0) {
    const keys = Array.from(agencyReaKeys.keys());
    for (let i = 0; i < keys.length && Date.now() - startedAt < WALL_BUDGET_MS; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const { data, error } = await admin.from('pulse_agencies')
        .select('id, rea_agency_id')
        .in('rea_agency_id', chunk);
      if (error) continue;
      for (const row of (data || [])) {
        const reaId = String(row.rea_agency_id);
        const orphanIds = agencyReaKeys.get(reaId) || [];
        for (const oid of orphanIds) {
          if (!decisions.has(oid)) {
            decisions.set(oid, { pulse_entity_id: row.id, rea_id: reaId, via: 'agency_rea_id' });
            breakdown.by_agency_rea_id++;
          }
        }
      }
    }
  }

  // ── Bulk resolve channel "generic": try both agents then agencies ────
  if (genericReaKeys.size > 0) {
    const keys = Array.from(genericReaKeys.keys());
    // Try pulse_agents first (most common case for orphan rows).
    for (let i = 0; i < keys.length && Date.now() - startedAt < WALL_BUDGET_MS; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const { data, error } = await admin.from('pulse_agents')
        .select('id, rea_agent_id')
        .in('rea_agent_id', chunk);
      if (error) continue;
      for (const row of (data || [])) {
        const reaId = String(row.rea_agent_id);
        const orphanIds = genericReaKeys.get(reaId) || [];
        for (const oid of orphanIds) {
          if (!decisions.has(oid)) {
            decisions.set(oid, { pulse_entity_id: row.id, rea_id: reaId, via: 'metadata_rea_id' });
            breakdown.by_metadata_rea_id++;
          }
        }
      }
    }
    // Then pulse_agencies for any residual generic keys still unmatched.
    const unresolvedKeys: string[] = [];
    for (const [reaId, orphanIds] of genericReaKeys) {
      if (orphanIds.some(oid => !decisions.has(oid))) unresolvedKeys.push(reaId);
    }
    for (let i = 0; i < unresolvedKeys.length && Date.now() - startedAt < WALL_BUDGET_MS; i += 500) {
      const chunk = unresolvedKeys.slice(i, i + 500);
      const { data, error } = await admin.from('pulse_agencies')
        .select('id, rea_agency_id')
        .in('rea_agency_id', chunk);
      if (error) continue;
      for (const row of (data || [])) {
        const reaId = String(row.rea_agency_id);
        const orphanIds = genericReaKeys.get(reaId) || [];
        for (const oid of orphanIds) {
          if (!decisions.has(oid)) {
            decisions.set(oid, { pulse_entity_id: row.id, rea_id: reaId, via: 'metadata_rea_id' });
            breakdown.by_metadata_rea_id++;
          }
        }
      }
    }
  }

  // ── Channel D: address/suburb ILIKE (lossy, one-by-one, capped) ──────
  // Only run if we still have wall-clock budget. Cap to the first 200 address
  // candidates so a pathological run can't eat the whole budget here.
  const addressCap = Math.min(addressCandidates.length, 200);
  for (let i = 0; i < addressCap; i++) {
    if (Date.now() - startedAt > WALL_BUDGET_MS) break;
    const { id: orphanId, address, suburb } = addressCandidates[i];
    if (decisions.has(orphanId)) continue;
    // Escape ILIKE wildcards in user data.
    const safeAddr = address.replace(/[%_]/g, (m) => `\\${m}`);
    const safeSub = suburb.replace(/[%_]/g, (m) => `\\${m}`);
    const { data, error } = await admin.from('pulse_listings')
      .select('id')
      .ilike('address', `${safeAddr}%`)
      .ilike('suburb', `${safeSub}%`)
      .limit(2);
    if (error) continue;
    const rows = data || [];
    // Anchor only on unambiguous matches (exactly 1). This is intentionally
    // conservative — migration 123 left listing events unanchored precisely
    // because multi-match attribution is incorrect attribution.
    if (rows.length === 1) {
      decisions.set(orphanId, { pulse_entity_id: rows[0].id, via: 'address_match' });
      breakdown.by_address_match++;
    }
  }

  const anchored = decisions.size;

  // ── Orphan shape breakdown (helps operators understand why things didn't
  // anchor — for the remaining DB02 residue, most orphans are aggregate
  // rollups with no single entity to point at, not data errors). ────────
  const orphanShape: Record<string, number> = {};
  for (const row of orphans) {
    const key = `${row.entity_type || 'null'}:${row.title?.split(' ').slice(1, 4).join(' ') || ''}`.substring(0, 80);
    // Use a coarser shape signal: entity_type + event_type pattern from title.
    // Simpler: group by entity_type only — callers can drill into pulse_timeline
    // directly if they want finer groupings.
    const simpleKey = row.entity_type || 'null';
    orphanShape[simpleKey] = (orphanShape[simpleKey] || 0) + 1;
    void key;
  }

  // Count how many orphans had no inference signal at all (couldn't even
  // reach a lookup) — flags unanchorable rollups clearly.
  let no_inference_signal = 0;
  let aggregate_rollups = 0;
  for (const row of orphans) {
    if (decisions.has(row.id)) continue;
    const meta = row.metadata || null;
    const etype = (row.entity_type || '').toLowerCase();
    const isAggregate = AGGREGATE_EVENT_TYPES.has(row.event_type || '');
    if (isAggregate) aggregate_rollups++;
    const hadMetaKey =
      pickMetaKey(meta, ['source_listing_id', 'sourceListingId', 'listing_id', 'agent_rea_id', 'rea_agent_id', 'agency_rea_id', 'rea_agency_id', 'rea_id']) !== null;
    const hadAddress = !isAggregate && etype === 'listing' && extractAddressAndSuburb(row.description) !== null;
    if (!hadMetaKey && !hadAddress) no_inference_signal++;
  }

  // ── Build sample for response (regardless of dry_run) ────────────────
  const sample_anchored: any[] = [];
  for (const row of orphans) {
    const d = decisions.get(row.id);
    if (!d) continue;
    sample_anchored.push({
      timeline_id: row.id,
      entity_type: row.entity_type,
      title: row.title,
      via: d.via,
      pulse_entity_id: d.pulse_entity_id,
      rea_id: d.rea_id ?? null,
    });
    if (sample_anchored.length >= 20) break;
  }

  // ── Apply updates (skipped if dry_run) ───────────────────────────────
  // PostgREST can't bulk UPDATE with different values per row in one call,
  // so we batch by grouping orphan ids with identical (pulse_entity_id, rea_id)
  // target tuples and issue one UPDATE per group. For our dataset (~2k
  // orphans across a handful of target entities) this is typically <50
  // round-trips — fast.
  const updateErrors: string[] = [];
  if (!dry_run && anchored > 0) {
    // Group decisions by target tuple.
    type TargetKey = string;
    const byTarget = new Map<TargetKey, { pulse_entity_id: string; rea_id: string | null; ids: string[] }>();
    for (const [orphanId, dec] of decisions) {
      if (!dec.pulse_entity_id) continue;
      const key = `${dec.pulse_entity_id}|${dec.rea_id ?? ''}`;
      const existing = byTarget.get(key);
      if (existing) {
        existing.ids.push(orphanId);
      } else {
        byTarget.set(key, {
          pulse_entity_id: dec.pulse_entity_id,
          rea_id: dec.rea_id ?? null,
          ids: [orphanId],
        });
      }
    }

    for (const [, group] of byTarget) {
      if (Date.now() - startedAt > WALL_BUDGET_MS) {
        updateErrors.push('wall_budget_exceeded_before_all_updates_applied');
        break;
      }
      const patch: Record<string, any> = { pulse_entity_id: group.pulse_entity_id };
      if (group.rea_id) patch.rea_id = group.rea_id;
      // IN clause cap — chunk if necessary.
      for (let i = 0; i < group.ids.length; i += 500) {
        const chunk = group.ids.slice(i, i + 500);
        const { error } = await admin.from('pulse_timeline')
          .update(patch)
          .in('id', chunk);
        if (error) {
          updateErrors.push(`update group ${group.pulse_entity_id.slice(0, 8)}: ${error.message.substring(0, 150)}`);
        }
      }
    }
  }

  // ── Compute still_unanchored (fresh count) ───────────────────────────
  let still_unanchored: number | null = null;
  try {
    const { count: c } = await admin.from('pulse_timeline')
      .select('*', { count: 'exact', head: true })
      .is('pulse_entity_id', null)
      .is('rea_id', null);
    still_unanchored = c ?? null;
  } catch {
    still_unanchored = null;
  }

  return jsonResponse({
    ok: updateErrors.length === 0,
    dry_run,
    batch_size,
    entity_types: entity_types,
    scanned,
    anchored,
    still_unanchored,
    no_inference_signal,
    aggregate_rollups,
    orphan_shape: orphanShape,
    breakdown,
    sample_anchored,
    duration_ms: Date.now() - startedAt,
    ...(updateErrors.length ? { errors: updateErrors } : {}),
  }, 200, req);
});
