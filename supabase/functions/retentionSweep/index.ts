import { handleCors, jsonResponse, getAdminClient, getUserFromReq, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { domainGet, transformDomainListing, addressMatch, getSimulatedListings, computeRiskLevel } from '../_shared/domain.ts';

serveWithAudit('retentionSweep', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    // Accepts user JWT or service-role (cron).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const body = await req.json().catch(() => ({}));
    const singleAgentId = body.agent_id || null;
    const admin = getAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    // 1. Load agents to sweep
    let agentQuery = admin
      .from('agents')
      .select('id, name, email, domain_agent_id, current_agency_id, current_agency_name, engagement_type')
      .not('domain_agent_id', 'is', null);

    if (singleAgentId) {
      agentQuery = agentQuery.eq('id', singleAgentId);
    }

    const __agents_raw = await agentQuery;
const agents = __agents_raw.data ?? [];

    let totalNewAlerts = 0;
    let totalResolved = 0;
    let totalCritical = 0;
    const agentsSummary: any[] = [];

    for (const agent of agents) {
      try {
        // 2. Fetch Domain listings
        let domainListings: any[] = [];
        let dataSource = 'simulation';

        try {
          const raw = await domainGet(`/agents/${agent.domain_agent_id}/listings?includedArchivedListings=true&pageSize=50`);
          if (Array.isArray(raw) && raw.length > 0) {
            domainListings = raw.map(transformDomainListing);
            dataSource = 'domain_api';
          }
        } catch (err: any) {
          console.warn(`Domain API failed for ${agent.name} (${agent.domain_agent_id}): ${err.message}`);
        }

        if (domainListings.length === 0) {
          domainListings = getSimulatedListings();
          dataSource = 'simulation';
        }

        // 3. Load FlexMedia projects for this agent
        const __projects_raw = await admin
          .from('projects')
          .select('id, property_address, title')
          .eq('agent_id', agent.id)
          .neq('source', 'goal');
const projects = __projects_raw.data ?? [];

        // 4. Find gaps (Domain listings with no matching project)
        const gapListingIds = new Set<string>();
        for (const listing of domainListings) {
          const matched = projects.some((p: any) => addressMatch(listing.address, p.property_address || ''));
          if (!matched) {
            gapListingIds.add(listing.domain_listing_id);

            // Upsert retention alert
            const riskLevel = computeRiskLevel(agent.engagement_type, 1); // Will be recalculated below
            const { data: existing } = await admin
              .from('retention_alerts')
              .select('id, times_seen')
              .eq('agent_id', agent.id)
              .eq('domain_listing_id', listing.domain_listing_id)
              .maybeSingle();

            if (existing) {
              const newTimesSeen = (existing.times_seen || 0) + 1;
              await admin
                .from('retention_alerts')
                .update({
                  last_seen_at: new Date().toISOString(),
                  times_seen: newTimesSeen,
                  risk_level: computeRiskLevel(agent.engagement_type, newTimesSeen),
                  is_active: true,
                  sweep_date: today,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id);
            } else {
              const newRisk = computeRiskLevel(agent.engagement_type, 1);
              await admin
                .from('retention_alerts')
                .insert({
                  agent_id: agent.id,
                  agency_id: agent.current_agency_id || null,
                  domain_listing_id: listing.domain_listing_id,
                  address: listing.address,
                  headline: listing.headline || null,
                  display_price: listing.display_price || null,
                  listing_status: listing.status || null,
                  date_listed: listing.date_listed || null,
                  engagement_type: agent.engagement_type || null,
                  risk_level: newRisk,
                  sweep_date: today,
                });
              totalNewAlerts++;
              if (newRisk === 'critical') totalCritical++;
            }
          }
        }

        // 5. Auto-resolve: alerts for this agent whose listing is no longer a gap
        const __activeAlerts_raw = await admin
          .from('retention_alerts')
          .select('id, domain_listing_id, investigation_status')
          .eq('agent_id', agent.id)
          .eq('is_active', true);
const activeAlerts = __activeAlerts_raw.data ?? [];

        for (const alert of activeAlerts) {
          if (!gapListingIds.has(alert.domain_listing_id)) {
            // Gap resolved — auto-pass if not already concluded
            const concluded = ['passed', 'checked', 'red_flag'].includes(alert.investigation_status);
            const resolvePayload: Record<string, any> = {
              is_active: false,
              investigation_status: concluded ? alert.investigation_status : 'passed',
              updated_at: new Date().toISOString(),
            };
            if (!concluded) resolvePayload.resolved_at = new Date().toISOString();
            await admin
              .from('retention_alerts')
              .update(resolvePayload)
              .eq('id', alert.id);
            totalResolved++;
          }
        }

        agentsSummary.push({
          agent_id: agent.id,
          name: agent.name,
          data_source: dataSource,
          domain_listings: domainListings.length,
          gaps: gapListingIds.size,
        });

      } catch (agentErr: any) {
        console.error(`Sweep error for agent ${agent.name}: ${agentErr.message}`);
        agentsSummary.push({ agent_id: agent.id, name: agent.name, error: agentErr.message });
      }
    }

    // 6. Send notifications for new critical alerts
    if (totalCritical > 0) {
      const __admins_raw = await admin
        .from('users')
        .select('id, full_name')
        .in('role', ['master_admin', 'admin']);
const admins = __admins_raw.data ?? [];

      for (const adm of admins) {
        await admin
          .from('notifications')
          .insert({
            user_id: adm.id,
            type: 'retention_red_flag',
            category: 'system',
            severity: 'critical',
            title: `${totalCritical} new critical retention alert${totalCritical > 1 ? 's' : ''}`,
            message: `Exclusive agent coverage gaps detected during daily retention sweep.`,
            cta_label: 'View Retention Alerts',
            cta_url: '/client-monitor',
            is_read: false,
            is_dismissed: false,
            source: 'automation',
            idempotency_key: `retention_sweep:${today}:${adm.id}`,
          })
          .then(() => {})
          .catch(() => {}); // Idempotency key handles duplicates
      }
    }

    return jsonResponse({
      status: 'ok',
      sweep_date: today,
      agents_scanned: agents.length,
      new_alerts: totalNewAlerts,
      resolved: totalResolved,
      critical_alerts: totalCritical,
      agents: agentsSummary,
    }, 200, req);

  } catch (err: any) {
    console.error('retentionSweep error:', err?.message || err);
    return jsonResponse({ error: err?.message || 'Internal error' }, 500, req);
  }
});
