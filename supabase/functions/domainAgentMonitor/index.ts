import { handleCors, jsonResponse, getAdminClient, getUserFromReq, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { domainGet, transformDomainListing, addressMatch, getSimulatedListings } from '../_shared/domain.ts';

// ─── Main Handler ───────────────────────────────────────────────────────────

serveWithAudit('domainAgentMonitor', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'domainAgentMonitor' }, 200, req);
  }

  try {
    // Auth gate — required since verify_jwt=false on deploy (ES256 runtime incompat).
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Authentication required', 401, req);

    const body = await req.json().catch(() => ({}));
    const agentId = body.agent_id;
    if (!agentId) {
      return jsonResponse({ error: 'agent_id required' }, 400, req);
    }

    const admin = getAdminClient();

    // 1. Load agent from CRM
    const { data: agent, error: agentErr } = await admin
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .maybeSingle();

    if (agentErr || !agent) {
      return jsonResponse({ error: 'Agent not found' }, 404, req);
    }

    // 2. Load agent's FlexMedia projects
    const __projects_raw = await admin
      .from('projects')
      .select('id, property_address, title, status, shoot_date, calculated_price, price, payment_status, products, packages')
      .eq('agent_id', agentId)
      .neq('source', 'goal')
      .order('shoot_date', { ascending: false });
const projects = __projects_raw.data ?? [];

    // 3. Fetch Domain listings (real API or simulation)
    let domainListings: any[] = [];
    let dataSource = 'simulation';

    if (agent.domain_agent_id) {
      try {
        const raw = await domainGet(`/agents/${agent.domain_agent_id}/listings?includedArchivedListings=true&pageSize=50`);
        if (Array.isArray(raw) && raw.length > 0) {
          domainListings = raw.map(transformDomainListing);
          dataSource = 'domain_api';
        }
      } catch (err: any) {
        console.warn(`Domain API failed for agent ${agent.domain_agent_id}: ${err.message}. Falling back to simulation.`);
      }
    }

    // Fallback to simulation
    if (domainListings.length === 0) {
      domainListings = getSimulatedListings();
      dataSource = 'simulation';
    }

    // 4. Auto-match Domain listings to FlexMedia projects
    const matches: any[] = [];
    const gaps: any[] = [];

    for (const listing of domainListings) {
      const matchedProject = projects.find((p: any) =>
        addressMatch(listing.address, p.property_address || '')
      );

      if (matchedProject) {
        matches.push({
          listing,
          project: {
            id: matchedProject.id,
            property_address: matchedProject.property_address,
            title: matchedProject.title,
            status: matchedProject.status,
            shoot_date: matchedProject.shoot_date,
            price: matchedProject.calculated_price || matchedProject.price,
            payment_status: matchedProject.payment_status,
          },
        });
      } else {
        gaps.push({ listing });
      }
    }

    // 5. Find internal projects with no Domain listing
    const matchedProjectIds = new Set(matches.map((m: any) => m.project.id));
    const unmatchedProjects = projects.filter((p: any) => !matchedProjectIds.has(p.id));

    // 6. Load retention alerts for this agent
    const __alerts_raw = await admin
      .from('retention_alerts')
      .select('*')
      .eq('agent_id', agentId)
      .order('first_detected_at', { ascending: false });
const alerts = __alerts_raw.data ?? [];

    // 7. Build response
    const totalListings = domainListings.length;
    const coveragePct = totalListings > 0 ? Math.round((matches.length / totalListings) * 100) : 0;

    const response = {
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        phone: agent.phone,
        agency: agent.current_agency_name,
        engagement_type: agent.engagement_type,
        domain_agent_id: agent.domain_agent_id,
        domain_url: agent.domain_url,
        rea_url: agent.rea_url,
      },
      data_source: dataSource,
      stats: {
        domain_listings: totalListings,
        flexmedia_projects: projects.length,
        matched: matches.length,
        gaps: gaps.length,
        coverage_pct: coveragePct,
        unmatched_projects: unmatchedProjects.length,
        active_alerts: alerts.filter((a: any) => a.is_active).length,
      },
      matches,
      gaps,
      alerts,
      unmatched_projects: unmatchedProjects.map((p: any) => ({
        id: p.id,
        property_address: p.property_address,
        title: p.title,
        status: p.status,
        shoot_date: p.shoot_date,
      })),
      all_listings: domainListings,
    };

    return jsonResponse(response, 200, req);

  } catch (err: any) {
    console.error('domainAgentMonitor error:', err?.message || err);
    return jsonResponse({ error: err?.message || 'Internal error' }, 500, req);
  }
});
