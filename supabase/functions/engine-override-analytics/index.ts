/**
 * engine-override-analytics — W11.6.10 master_admin analytics endpoint.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md (Sections A-I)
 *
 * One endpoint that aggregates the 9 dashboard sections into a single payload
 * so the frontend can render all charts off a single network round-trip.
 *
 * Behaviour:
 *
 *   GET / POST {
 *     date_range_days?: number      // default 30; max 365
 *     package_filter?: string       // 'Gold Package' | 'Silver Package' | …
 *     tier_filter?: string          // 'premium' | 'standard' | 'approachable'
 *     room_type_filter?: string
 *     drill_round_id?: string       // narrow to a single round (for drill-through)
 *   }
 *
 *   →  AnalyticsResponse (see below) — every section returns either real
 *      aggregated data or a `{ insufficient: true, days_until_ready }`
 *      placeholder. Sections degrade gracefully when their dependency
 *      table is empty (e.g. composition_classification_overrides for
 *      Section E — pre-W11.6.9 ship).
 *
 * Auth: master_admin / admin only. Service-role bypass for cross-fn calls
 *       and tests. RLS bypass via service-role admin client.
 *
 * Cost note (W11.6 spec): heavy aggregation, but no per-image LLM calls.
 * Each section's SQL is bounded by the date window. v1 ships with on-demand
 * aggregation; if the dashboard is slow at 90+ days, v2 can promote to
 * a `mv_override_analytics` materialised view refreshed nightly.
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import {
  buildCohortGrid,
  buildOverrideTimeline,
  buildTierConfigEvents,
  buildProblemRounds,
  buildReclassPatterns,
  buildStage4Patterns,
  buildStage4Trend,
  buildVoiceTierDistribution,
  buildRegistryCounts,
  buildTopUnresolvedLabels,
  buildCostStacked,
  buildCostSummary,
  buildKpiSummary,
  hasInsufficientHistory,
} from './aggregate.ts';

const FN_NAME = 'engine-override-analytics';
const FN_VERSION = 'v1.0.0';

interface AnalyticsRequest {
  date_range_days?: number;
  package_filter?: string;
  tier_filter?: string;
  room_type_filter?: string;
  drill_round_id?: string;
  _health_check?: boolean;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, req);
  }

  // ─── Auth ────────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin' && user.role !== 'admin') {
      return errorResponse('Forbidden: master_admin or admin only', 403, req);
    }
  }

  // ─── Parse body / query ───────────────────────────────────────────────────
  let body: AnalyticsRequest = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  } else {
    const url = new URL(req.url);
    body = {
      date_range_days: url.searchParams.get('date_range_days')
        ? Number(url.searchParams.get('date_range_days'))
        : undefined,
      package_filter: url.searchParams.get('package_filter') || undefined,
      tier_filter: url.searchParams.get('tier_filter') || undefined,
      room_type_filter: url.searchParams.get('room_type_filter') || undefined,
      drill_round_id: url.searchParams.get('drill_round_id') || undefined,
    };
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME, ok: true }, 200, req);
  }

  const daysBack = Math.max(1, Math.min(Number(body.date_range_days) || 30, 365));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
  const cutoffIso = cutoff.toISOString();

  const startMs = Date.now();
  const admin = getAdminClient();

  try {
    // ─── 1. Fetch the canonical row sets (in parallel where possible) ──────
    const [
      roundsRes,
      classificationsRes,
      overridesRes,
      stage4OverridesRes,
      reclassOverridesRes,
      tierConfigsRes,
      masterListingsRes,
      auditRes,
      candidatesRes,
      registryCountRes,
      observationsCountRes,
      observationsResolvedRes,
      groupsRes,
      projectsRes,
    ] = await Promise.all([
      admin
        .from('shortlisting_rounds')
        .select('id, project_id, package_type, property_tier, engine_mode, started_at, completed_at')
        .gte('started_at', cutoffIso)
        .limit(2000),
      admin
        .from('composition_classifications')
        .select('round_id, group_id, room_type, classified_at')
        .gte('classified_at', cutoffIso)
        .limit(20000),
      admin
        .from('shortlisting_overrides')
        .select(
          'round_id, ai_proposed_group_id, human_action, primary_signal_overridden, review_duration_seconds, created_at',
        )
        .gte('created_at', cutoffIso)
        .limit(20000),
      admin
        .from('shortlisting_stage4_overrides')
        .select('round_id, field, stage_1_value, stage_4_value, review_status, created_at')
        .gte('created_at', cutoffIso)
        .limit(20000),
      // Section E — graceful degrade if table empty / W11.6.9 not yet shipped.
      admin
        .from('composition_classification_overrides')
        .select('round_id, override_source, ai_room_type, human_room_type, created_at')
        .gte('created_at', cutoffIso)
        .limit(20000),
      admin
        // mig 443 rename: shortlisting_tier_configs → shortlisting_grade_configs;
        // tier_id column → grade_id. PostgREST alias preserves the API field
        // name `tier_id` so the aggregator + dashboard don't need to rename.
        .from('shortlisting_grade_configs')
        .select('tier_id:grade_id, version, activated_at, notes, is_active')
        .order('activated_at', { ascending: false })
        .limit(200),
      admin
        .from('shortlisting_master_listings')
        .select('property_tier, voice_anchor_used, created_at')
        .is('deleted_at', null)
        .gte('created_at', cutoffIso)
        .limit(2000),
      admin
        .from('engine_run_audit')
        .select('round_id, engine_mode, stage1_total_cost_usd, stage4_total_cost_usd, total_cost_usd, created_at')
        .gte('created_at', cutoffIso)
        .limit(2000),
      // Section H — top unresolved candidates
      admin
        .from('object_registry_candidates')
        .select('proposed_canonical_label, proposed_display_name, observed_count, status')
        .eq('candidate_type', 'object')
        .order('observed_count', { ascending: false })
        .limit(500),
      admin.from('object_registry').select('id', { count: 'exact', head: true }).eq('is_active', true),
      admin.from('raw_attribute_observations').select('id', { count: 'exact', head: true }),
      admin
        .from('raw_attribute_observations')
        .select('id', { count: 'exact', head: true })
        .not('normalised_to_object_id', 'is', null),
      admin.from('composition_groups').select('id, round_id').gte('created_at', cutoffIso).limit(20000),
      admin
        .from('projects')
        .select('id, title, property_address')
        .limit(2000),
    ]);

    // Surface fetch errors but allow individual sections to render
    const fetchErrors: Record<string, string> = {};
    if (roundsRes.error) fetchErrors.rounds = roundsRes.error.message;
    if (classificationsRes.error) fetchErrors.classifications = classificationsRes.error.message;
    if (overridesRes.error) fetchErrors.overrides = overridesRes.error.message;
    if (stage4OverridesRes.error) fetchErrors.stage4 = stage4OverridesRes.error.message;
    if (reclassOverridesRes.error) fetchErrors.reclass = reclassOverridesRes.error.message;
    if (auditRes.error) fetchErrors.audit = auditRes.error.message;

    const rounds = (roundsRes.data || []) as Array<{
      id: string;
      project_id: string;
      package_type: string | null;
      property_tier: string | null;
      engine_mode: string | null;
      started_at: string;
    }>;
    const classifications = (classificationsRes.data || []) as Array<{
      round_id: string;
      group_id: string;
      room_type: string | null;
      classified_at: string | null;
    }>;
    const overrides = (overridesRes.data || []) as Array<{
      round_id: string;
      ai_proposed_group_id: string | null;
      human_action: string | null;
      primary_signal_overridden: string | null;
      review_duration_seconds: number | null;
      created_at: string;
    }>;
    const stage4Overrides = (stage4OverridesRes.data || []) as Array<{
      round_id: string;
      field: string | null;
      stage_1_value: string | null;
      stage_4_value: string | null;
      review_status: string | null;
      created_at: string;
    }>;
    const reclassRows = (reclassOverridesRes.data || []) as Array<{
      round_id: string;
      override_source: string | null;
      ai_room_type: string | null;
      human_room_type: string | null;
      created_at: string;
    }>;
    const tierConfigs = (tierConfigsRes.data || []) as Array<{
      tier_id: string;
      version: number;
      activated_at: string | null;
      notes: string | null;
      is_active: boolean;
    }>;
    const masterListings = (masterListingsRes.data || []) as Array<{
      property_tier: string | null;
      voice_anchor_used: string | null;
      created_at: string;
    }>;
    const auditRows = (auditRes.data || []) as Array<{
      round_id: string;
      engine_mode: string | null;
      stage1_total_cost_usd: number | string | null;
      stage4_total_cost_usd: number | string | null;
      total_cost_usd: number | string | null;
      created_at: string;
    }>;
    const candidates = (candidatesRes.data || []) as Array<{
      proposed_canonical_label: string;
      proposed_display_name: string | null;
      observed_count: number;
      status: string;
    }>;
    const projects = (projectsRes.data || []) as Array<{
      id: string;
      title: string | null;
      property_address: string | null;
    }>;

    const projectById = new Map(projects.map((p) => [p.id, p]));

    // Apply optional filters
    let filteredRounds = rounds;
    if (body.package_filter) {
      filteredRounds = filteredRounds.filter((r) => r.package_type === body.package_filter);
    }
    if (body.tier_filter) {
      filteredRounds = filteredRounds.filter((r) => r.property_tier === body.tier_filter);
    }
    if (body.drill_round_id) {
      filteredRounds = filteredRounds.filter((r) => r.id === body.drill_round_id);
    }

    const filteredRoundIds = new Set(filteredRounds.map((r) => r.id));
    const filteredClassifications = classifications.filter((c) => filteredRoundIds.has(c.round_id));
    const filteredOverrides = overrides.filter((o) => filteredRoundIds.has(o.round_id));
    const filteredStage4 = stage4Overrides.filter((s) => filteredRoundIds.has(s.round_id));
    const filteredReclass = reclassRows.filter((r) => filteredRoundIds.has(r.round_id));

    // ─── 2. Section A — cohort grid ────────────────────────────────────────
    const cohortGrid = buildCohortGrid(
      filteredRounds.map((r) => ({
        round_id: r.id,
        property_tier: r.property_tier,
        engine_mode: r.engine_mode,
      })),
      filteredClassifications,
      filteredOverrides.map((o) => ({
        round_id: o.round_id,
        ai_proposed_group_id: o.ai_proposed_group_id,
        human_action: o.human_action,
      })),
    );

    // ─── 3. Section B — override-rate timeline ─────────────────────────────
    const timeline = buildOverrideTimeline(
      filteredOverrides.map((o) => ({
        round_id: o.round_id,
        created_at: o.created_at,
        human_action: o.human_action,
      })),
      filteredStage4.map((s) => ({ round_id: s.round_id, created_at: s.created_at })),
      filteredClassifications,
      daysBack,
    );

    // ─── 4. Section C — tier-config events ─────────────────────────────────
    const tierConfigEvents = buildTierConfigEvents(
      tierConfigs.map((tc) => ({
        activated_at: tc.activated_at,
        tier_id: tc.tier_id,
        version: tc.version,
        notes: tc.notes,
        is_active: tc.is_active,
      })),
      daysBack,
    );

    // ─── 5. Section D — top problem rounds ─────────────────────────────────
    const problemRounds = buildProblemRounds(
      filteredRounds.map((r) => {
        const proj = projectById.get(r.project_id);
        return {
          round_id: r.id,
          project_id: r.project_id,
          property_tier: r.property_tier,
          package_type: r.package_type,
          project_title: proj?.title || null,
          property_address: proj?.property_address || null,
        };
      }),
      filteredOverrides.map((o) => ({
        round_id: o.round_id,
        human_action: o.human_action,
        primary_signal_overridden: o.primary_signal_overridden,
      })),
      filteredClassifications,
      filteredStage4.map((s) => ({ round_id: s.round_id })),
    );

    // ─── 6. Section E — reclassification patterns (degrades gracefully) ───
    const reclassPatterns = buildReclassPatterns(filteredReclass);
    const reclassDegraded = reclassOverridesRes.error != null;

    // ─── 7. Section F — Stage 4 self-corrections ──────────────────────────
    const stage4Patterns = buildStage4Patterns(filteredStage4);
    const stage4TrendData = buildStage4Trend(filteredStage4);

    // ─── 8. Section G — voice tier distribution ────────────────────────────
    const voiceTierDist = buildVoiceTierDistribution(masterListings);

    // ─── 9. Section H — canonical registry coverage ───────────────────────
    const totalCanonical = registryCountRes.count ?? 0;
    const totalObservations = observationsCountRes.count ?? 0;
    const resolvedObservations = observationsResolvedRes.count ?? 0;
    const registryCounts = buildRegistryCounts(
      candidates.map((c) => ({ status: c.status })),
      totalCanonical,
      totalObservations,
      resolvedObservations,
    );
    const topUnresolved = buildTopUnresolvedLabels(candidates, 10);
    const registryDegraded = candidatesRes.error != null;

    // ─── 10. Section I — cost-per-stage attribution ───────────────────────
    const costStacked = buildCostStacked(auditRows);
    const costSummary = buildCostSummary(auditRows);
    const costSufficient = hasInsufficientHistory(
      auditRows.length > 0 ? auditRows[auditRows.length - 1].created_at : null,
      14, // 2 weeks of cost data feels like the minimum
    );

    // ─── Header KPIs ────────────────────────────────────────────────────────
    const kpiSummary = buildKpiSummary({
      total_overrides: filteredOverrides.filter((o) => o.human_action !== 'confirm').length,
      total_proposals: filteredClassifications.length,
      review_durations_seconds: filteredOverrides.map((o) => Number(o.review_duration_seconds || 0)),
    });

    // ─── 11. Insufficient-data probes for time-series sections ────────────
    const oldestOverride =
      filteredOverrides.length > 0
        ? filteredOverrides[filteredOverrides.length - 1].created_at
        : filteredStage4.length > 0
          ? filteredStage4[filteredStage4.length - 1].created_at
          : null;
    const timelineSufficient = hasInsufficientHistory(oldestOverride, 7);
    const tierConfigSufficient = hasInsufficientHistory(
      tierConfigs.length > 0 ? tierConfigs[tierConfigs.length - 1].activated_at : null,
      14,
    );

    // ─── 12. Final response ────────────────────────────────────────────────
    return jsonResponse(
      {
        ok: true,
        date_range_days: daysBack,
        as_of: new Date().toISOString(),
        elapsed_ms: Date.now() - startMs,
        filters: {
          package_filter: body.package_filter || null,
          tier_filter: body.tier_filter || null,
          room_type_filter: body.room_type_filter || null,
          drill_round_id: body.drill_round_id || null,
        },
        kpis: kpiSummary,
        sections: {
          A_cohort_grid: { cells: cohortGrid },
          B_timeline: {
            points: timeline,
            insufficient: timelineSufficient.insufficient,
            days_until_ready: timelineSufficient.days_until_ready,
          },
          C_tier_config_events: {
            events: tierConfigEvents,
            insufficient: tierConfigSufficient.insufficient,
            days_until_ready: tierConfigSufficient.days_until_ready,
          },
          D_problem_rounds: { rows: problemRounds },
          E_reclassification_patterns: {
            patterns: reclassPatterns,
            degraded: reclassDegraded,
            note: reclassDegraded
              ? 'composition_classification_overrides table not readable — W11.6.9 may not be shipped'
              : null,
          },
          F_stage4_self_corrections: {
            patterns: stage4Patterns,
            trend: stage4TrendData,
          },
          G_voice_tier_distribution: voiceTierDist,
          H_canonical_registry_coverage: {
            counts: registryCounts,
            top_unresolved: topUnresolved,
            degraded: registryDegraded,
          },
          I_cost_per_stage: {
            summary: costSummary,
            stacked: costStacked,
            insufficient: costSufficient.insufficient,
            days_until_ready: costSufficient.days_until_ready,
          },
        },
        fetch_errors: Object.keys(fetchErrors).length > 0 ? fetchErrors : null,
        meta: {
          total_rounds_in_window: filteredRounds.length,
          total_classifications_in_window: filteredClassifications.length,
          total_overrides_in_window: filteredOverrides.length,
        },
      },
      200,
      req,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] failed: ${msg}`);
    return errorResponse(`engine-override-analytics failed: ${msg}`, 500, req);
  }
});
