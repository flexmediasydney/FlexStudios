/**
 * canonical-discovery-queue — Wave 12 / W11.6.11 admin-facing list endpoint.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reads the W12 discovery surface and presents it to the SettingsObjectRegistryDiscovery
 * admin UI. Two distinct event sources feed the queue:
 *
 *   1. `pass2_slot_suggestion` rows in shortlisting_events (W11.6.6 writer):
 *      Stage 4 suggested a slot taxonomy entry that doesn't yet exist in the
 *      canonical slotEnumeration. Payload: { proposed_slot_id, candidate_stems,
 *      reasoning, emitted_by }. These describe SLOT proposals, not OBJECT
 *      candidates — but the operator workflow is identical (review → promote
 *      to canonical / reject / defer), so the same UI handles both.
 *
 *   2. `object_registry_candidates` rows in the W12 schema:
 *      The canonical-rollup batch produced these from raw_attribute_observations.
 *      They describe OBJECT candidates (with similarity_to_existing alternates).
 *
 * This endpoint returns BOTH streams in a single payload so the UI can render
 * a unified queue keyed by `source_type` ('slot_suggestion' vs 'object_candidate').
 *
 * Behaviour:
 *
 *   POST {
 *     project_id?: string,
 *     status?: 'pending' | 'promoted' | 'rejected' | 'deferred' | 'all',
 *     source?: 'slot_suggestion' | 'object_candidate' | 'all',
 *     search?: string,
 *     page?: number = 0,
 *     limit?: number = 50
 *   }
 *
 *   →  {
 *        ok: true,
 *        rows: Array<DiscoveryRow>,
 *        counts: { pending, promoted, rejected, deferred },
 *        page,
 *        limit,
 *        has_more
 *      }
 *
 *   DiscoveryRow shape:
 *     {
 *       id: string,                              // event id (slot_suggestion) or candidate.id
 *       source_type: 'slot_suggestion' | 'object_candidate',
 *       project_id: string | null,
 *       round_id: string | null,
 *       proposed_label: string,
 *       reasoning: string | null,
 *       candidate_stems: string[],               // stems mentioned in the proposal
 *       thumbnails: Array<{ stem: string, dropbox_preview_path: string | null }>,
 *       nearest_canonicals: Array<{ id, canonical_id, display_name, similarity }>,
 *       observed_count: number,                  // how many times this proposal has surfaced
 *       status: 'pending' | 'promoted' | 'rejected' | 'deferred',
 *       resolved_at: string | null,
 *       resolved_by: string | null,
 *       created_at: string
 *     }
 *
 * Auth: master_admin / admin (same gate as object-registry-admin's list).
 *       Service-role bypass for cross-fn calls + tests.
 *
 * Coordination note (W11.6.6 hand-off):
 *   When this function runs against a database where W11.6.6 has not yet
 *   shipped the persistProposedSlots writer, no `pass2_slot_suggestion`
 *   events will exist — the slot_suggestion stream returns zero rows but
 *   the endpoint succeeds. The admin UI's empty-state copy explains this.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { embedText, formatVectorLiteral } from '../_shared/canonicalRegistry/embeddings.ts';

const FN_NAME = 'canonical-discovery-queue';
const FN_VERSION = 'v1.0';

interface QueueBody {
  project_id?: string;
  status?: 'pending' | 'promoted' | 'rejected' | 'deferred' | 'all';
  source?: 'slot_suggestion' | 'object_candidate' | 'all';
  search?: string;
  page?: number;
  limit?: number;
  /** Skip enrichment work — useful for quick health-check */
  _health_check?: boolean;
}

interface DiscoveryRow {
  id: string;
  source_type: 'slot_suggestion' | 'object_candidate';
  project_id: string | null;
  round_id: string | null;
  proposed_label: string;
  proposed_display_name?: string | null;
  reasoning: string | null;
  candidate_stems: string[];
  thumbnails: Array<{ stem: string; dropbox_preview_path: string | null }>;
  nearest_canonicals: Array<{
    id: string;
    canonical_id: string;
    display_name: string;
    similarity: number;
  }>;
  operator_history: {
    promoted_at?: string | null;
    promoted_by?: string | null;
    promoted_into_id?: string | null;
    rejected_at?: string | null;
    deferred_until?: string | null;
  };
  observed_count: number;
  status: 'pending' | 'promoted' | 'rejected' | 'deferred';
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

interface SlotSuggestionEvent {
  id: number;
  project_id: string;
  round_id: string | null;
  payload: {
    proposed_slot_id?: string | null;
    candidate_stems?: string[];
    reasoning?: string | null;
    emitted_by?: string | null;
    /** W11.6.11: when an operator resolves this event, we mutate the payload
     *  in place rather than adding columns to the events table (which is
     *  append-only). The promote endpoint sets these. */
    discovery_status?: 'pending' | 'promoted' | 'rejected' | 'deferred';
    discovery_resolved_at?: string | null;
    discovery_resolved_by?: string | null;
    discovery_promoted_into_id?: string | null;
    discovery_target_table?: 'object_registry' | 'attribute_registry';
    discovery_canonical_label?: string | null;
    discovery_reject_reason?: string | null;
    discovery_deferred_until?: string | null;
  };
  created_at: string;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  // GET-style behaviour: we accept both POST (with JSON body) and GET (with
  // query string) so dashboards can hit the endpoint without preflight.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, req);
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin' && user.role !== 'admin') {
      return errorResponse('Forbidden: master_admin or admin only', 403, req);
    }
  }

  // ─── Parse body / query ───────────────────────────────────────────────────
  let body: QueueBody = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      // Allow empty body — defaults will be used
      body = {};
    }
  } else {
    const url = new URL(req.url);
    body = {
      project_id: url.searchParams.get('project_id') || undefined,
      status: (url.searchParams.get('status') as QueueBody['status']) || undefined,
      source: (url.searchParams.get('source') as QueueBody['source']) || undefined,
      search: url.searchParams.get('search') || undefined,
      page: url.searchParams.get('page') ? Number(url.searchParams.get('page')) : undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    };
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME, ok: true }, 200, req);
  }

  const status = body.status || 'pending';
  const source = body.source || 'all';
  const page = Math.max(0, Number(body.page) || 0);
  const limit = Math.max(1, Math.min(Number(body.limit) || 50, 200));
  const offset = page * limit;

  const startMs = Date.now();
  const admin = getAdminClient();

  try {
    // ─── 1. Fetch slot_suggestion events ──────────────────────────────────
    const slotRows: DiscoveryRow[] = [];
    const objectCandidateRows: DiscoveryRow[] = [];

    if (source === 'slot_suggestion' || source === 'all') {
      let q = admin
        .from('shortlisting_events')
        .select('id, project_id, round_id, payload, created_at')
        .eq('event_type', 'pass2_slot_suggestion')
        .order('created_at', { ascending: false });

      if (body.project_id) q = q.eq('project_id', body.project_id);

      // Don't apply LIMIT here — we filter client-side by status (which lives
      // in payload JSONB) and re-paginate after merge. Cap at 1000 rows for
      // safety; the payload search filter still fits in memory at that scale.
      const { data: events, error } = await q.limit(1000);
      if (error) {
        console.warn(`[${FN_NAME}] slot_suggestion fetch failed: ${error.message}`);
      } else {
        for (const ev of (events || []) as SlotSuggestionEvent[]) {
          const payloadStatus = ev.payload?.discovery_status || 'pending';
          if (status !== 'all' && payloadStatus !== status) continue;

          const proposedLabel =
            (ev.payload?.proposed_slot_id || '').toString().trim() || '(unlabelled slot suggestion)';

          // Apply text search if requested (across proposed_label + reasoning).
          if (body.search && body.search.trim().length > 0) {
            const needle = body.search.trim().toLowerCase();
            const haystack = `${proposedLabel} ${ev.payload?.reasoning || ''}`.toLowerCase();
            if (!haystack.includes(needle)) continue;
          }

          slotRows.push({
            id: `slot:${ev.id}`,
            source_type: 'slot_suggestion',
            project_id: ev.project_id,
            round_id: ev.round_id,
            proposed_label: proposedLabel,
            proposed_display_name: proposedLabel,
            reasoning: ev.payload?.reasoning || null,
            candidate_stems: Array.isArray(ev.payload?.candidate_stems) ? ev.payload.candidate_stems : [],
            thumbnails: [], // populated below
            nearest_canonicals: [], // populated below
            operator_history: {
              promoted_at: payloadStatus === 'promoted' ? ev.payload?.discovery_resolved_at || null : null,
              promoted_by: ev.payload?.discovery_resolved_by || null,
              promoted_into_id: ev.payload?.discovery_promoted_into_id || null,
              rejected_at: payloadStatus === 'rejected' ? ev.payload?.discovery_resolved_at || null : null,
              deferred_until: payloadStatus === 'deferred' ? ev.payload?.discovery_deferred_until || null : null,
            },
            observed_count: 1,
            status: payloadStatus,
            resolved_at: ev.payload?.discovery_resolved_at || null,
            resolved_by: ev.payload?.discovery_resolved_by || null,
            created_at: ev.created_at,
          });
        }
      }
    }

    // ─── 2. Fetch object_registry_candidates ──────────────────────────────
    if (source === 'object_candidate' || source === 'all') {
      // Map UI status → DB status.
      // 'promoted' → DB 'approved'; 'pending' → DB 'pending'; 'rejected' → 'rejected';
      // 'deferred' → 'deferred'; 'all' → no filter.
      const statusMap: Record<string, string> = {
        pending: 'pending',
        promoted: 'approved',
        rejected: 'rejected',
        deferred: 'deferred',
      };

      let q = admin
        .from('object_registry_candidates')
        .select(
          'id, candidate_type, proposed_canonical_label, proposed_display_name, ' +
            'proposed_description, similarity_to_existing, observed_count, ' +
            'sample_excerpts, status, reviewed_by, reviewed_at, approved_object_id, ' +
            'first_proposed_at, last_proposed_at, review_after_at, created_at',
        )
        .eq('candidate_type', 'object')
        .order('observed_count', { ascending: false })
        .order('last_proposed_at', { ascending: false });

      if (status !== 'all') {
        q = q.eq('status', statusMap[status] || status);
      }

      const { data: candidates, error } = await q.limit(1000);
      if (error) {
        console.warn(`[${FN_NAME}] candidate fetch failed: ${error.message}`);
      } else {
        // PostgREST's `select` type inference can't see through our composite
        // string of column names — cast through `unknown` so the row shape we
        // actually receive (validated against migration 380) is what we type.
        type CandidateRow = {
          id: string;
          proposed_canonical_label: string;
          proposed_display_name: string | null;
          proposed_description: string | null;
          similarity_to_existing: Record<string, unknown> | null;
          observed_count: number;
          sample_excerpts: string[] | null;
          status: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          approved_object_id: string | null;
          first_proposed_at: string;
          last_proposed_at: string;
          review_after_at: string | null;
          created_at: string;
        };
        const candidateRows = (candidates || []) as unknown as CandidateRow[];
        for (const c of candidateRows) {
          const proposedLabel = c.proposed_display_name || c.proposed_canonical_label;

          if (body.search && body.search.trim().length > 0) {
            const needle = body.search.trim().toLowerCase();
            const haystack = `${proposedLabel} ${c.proposed_description || ''} ${(c.sample_excerpts || []).join(' ')}`.toLowerCase();
            if (!haystack.includes(needle)) continue;
          }

          // Map back to UI status
          const uiStatus = (
            c.status === 'approved' ? 'promoted'
            : c.status === 'auto_archived' ? 'deferred'
            : c.status
          ) as DiscoveryRow['status'];

          // Surface the rolled-up similarity_to_existing alternates as nearest_canonicals
          const sim = (c.similarity_to_existing || {}) as Record<string, unknown>;
          const nearestCanonicals: DiscoveryRow['nearest_canonicals'] = [];
          if (sim.top_match_id) {
            nearestCanonicals.push({
              id: String(sim.top_match_id),
              canonical_id: String(sim.top_match_canonical_id || sim.top_match_label || ''),
              display_name: String(sim.top_match_display_name || sim.top_match_label || ''),
              similarity: Number(sim.top_match_score || 0),
            });
          }
          const alts = Array.isArray(sim.alternates) ? sim.alternates : [];
          for (const a of alts.slice(0, 3) as Array<Record<string, unknown>>) {
            nearestCanonicals.push({
              id: String(a.id || ''),
              canonical_id: String(a.canonical_id || a.label || ''),
              display_name: String(a.display_name || a.label || ''),
              similarity: Number(a.score || 0),
            });
          }

          objectCandidateRows.push({
            id: `obj:${c.id}`,
            source_type: 'object_candidate',
            project_id: null,
            round_id: null,
            proposed_label: c.proposed_canonical_label,
            proposed_display_name: proposedLabel,
            reasoning: c.proposed_description || ((c.sample_excerpts || []).slice(0, 1)[0] ?? null),
            candidate_stems: [],
            thumbnails: [],
            nearest_canonicals: nearestCanonicals,
            operator_history: {
              promoted_at: c.status === 'approved' ? c.reviewed_at : null,
              promoted_by: c.reviewed_by,
              promoted_into_id: c.approved_object_id,
              rejected_at: c.status === 'rejected' ? c.reviewed_at : null,
              deferred_until: c.status === 'deferred' ? c.review_after_at : null,
            },
            observed_count: c.observed_count || 1,
            status: uiStatus,
            resolved_at: c.reviewed_at,
            resolved_by: c.reviewed_by,
            created_at: c.created_at,
          });
        }
      }
    }

    // ─── 3. Enrich slot suggestions with thumbnails ──────────────────────
    // For each slot suggestion's candidate_stems, fetch dropbox_preview_path
    // from composition_groups (joined via best_bracket_stem).
    if (slotRows.length > 0) {
      const allStems = new Set<string>();
      for (const r of slotRows) {
        for (const s of r.candidate_stems.slice(0, 4)) allStems.add(String(s));
      }
      if (allStems.size > 0) {
        const { data: groups } = await admin
          .from('composition_groups')
          .select('best_bracket_stem, dropbox_preview_path, round_id')
          .in('best_bracket_stem', Array.from(allStems));
        const stemToPath = new Map<string, string>();
        for (const g of (groups || []) as Array<{ best_bracket_stem: string | null; dropbox_preview_path: string | null }>) {
          if (g.best_bracket_stem && g.dropbox_preview_path) {
            // Last writer wins — preview paths are stable per stem in practice.
            stemToPath.set(g.best_bracket_stem, g.dropbox_preview_path);
          }
        }
        for (const r of slotRows) {
          r.thumbnails = r.candidate_stems.slice(0, 4).map((stem) => ({
            stem: String(stem),
            dropbox_preview_path: stemToPath.get(String(stem)) ?? null,
          }));
        }
      } else {
        for (const r of slotRows) r.thumbnails = [];
      }

      // Compute top-3 nearest canonicals for each slot suggestion (cosine vs
      // existing object_registry rows). Embedding cost is bounded — only
      // pending slot suggestions get embedded; cap at 30 per call to stay
      // under the timeout. Cached via a small per-call memo keyed by label.
      const labelEmbedCache = new Map<string, number[]>();
      const slotsToEmbed = slotRows.filter((r) => r.status === 'pending').slice(0, 30);

      for (const r of slotsToEmbed) {
        if (!r.proposed_label) continue;
        try {
          let vec = labelEmbedCache.get(r.proposed_label);
          if (!vec) {
            const result = await embedText(r.proposed_label).catch(() => null);
            if (Array.isArray(result)) {
              vec = result;
              labelEmbedCache.set(r.proposed_label, result);
            }
          }
          if (vec) {
            const literal = formatVectorLiteral(vec);
            const { data: matches } = await admin.rpc('canonical_nearest_neighbors', {
              p_embedding: literal,
              p_top_n: 3,
            });
            r.nearest_canonicals = (matches || []).map((m: Record<string, unknown>) => ({
              id: String(m.id),
              canonical_id: String(m.canonical_id),
              display_name: String(m.display_name),
              similarity: Number(m.similarity),
            }));
          }
        } catch (err) {
          // Non-fatal — just skip enrichment for this row.
          console.warn(`[${FN_NAME}] nearest-neighbour enrichment failed for "${r.proposed_label}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ─── 4. Merge + paginate ──────────────────────────────────────────────
    const merged = [...slotRows, ...objectCandidateRows].sort((a, b) => {
      // Pending first, then by observed_count, then by created_at desc.
      const aRank = a.status === 'pending' ? 0 : 1;
      const bRank = b.status === 'pending' ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      if ((b.observed_count || 0) !== (a.observed_count || 0)) {
        return (b.observed_count || 0) - (a.observed_count || 0);
      }
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    const totalMatched = merged.length;
    const pagedRows = merged.slice(offset, offset + limit);

    // ─── 5. Counts (across all statuses, source-aware) ───────────────────
    const counts = await fetchCounts(admin, body.project_id);

    return jsonResponse({
      ok: true,
      rows: pagedRows,
      counts,
      page,
      limit,
      total: totalMatched,
      has_more: offset + limit < totalMatched,
      elapsed_ms: Date.now() - startMs,
      filters: {
        project_id: body.project_id || null,
        status,
        source,
        search: body.search || null,
      },
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] failed: ${msg}`);
    return errorResponse(`canonical-discovery-queue failed: ${msg}`, 500, req);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchCounts(
  admin: ReturnType<typeof getAdminClient>,
  projectId?: string,
): Promise<{ pending: number; promoted: number; rejected: number; deferred: number }> {
  const counts = { pending: 0, promoted: 0, rejected: 0, deferred: 0 };

  // Slot suggestion counts (filter on payload->>discovery_status).
  // Empty/missing payload key = pending (default).
  let slotQ = admin
    .from('shortlisting_events')
    .select('id, payload')
    .eq('event_type', 'pass2_slot_suggestion');
  if (projectId) slotQ = slotQ.eq('project_id', projectId);

  const { data: slotEvents } = await slotQ.limit(2000);
  for (const ev of (slotEvents || []) as Array<{ payload: Record<string, unknown> | null }>) {
    const s = (ev.payload?.discovery_status as string) || 'pending';
    if (s in counts) {
      (counts as Record<string, number>)[s]++;
    }
  }

  // Object candidate counts.
  const { data: candCounts } = await admin
    .from('object_registry_candidates')
    .select('status', { count: 'exact', head: false })
    .eq('candidate_type', 'object');
  if (Array.isArray(candCounts)) {
    for (const c of candCounts as Array<{ status: string }>) {
      if (c.status === 'pending') counts.pending++;
      else if (c.status === 'approved') counts.promoted++;
      else if (c.status === 'rejected') counts.rejected++;
      else if (c.status === 'deferred' || c.status === 'auto_archived') counts.deferred++;
    }
  }

  return counts;
}
