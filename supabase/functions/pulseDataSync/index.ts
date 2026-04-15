import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Pulse Data Sync — 3-Actor Apify Merge Engine
 *
 * Runs 3 Apify scrapers for a set of target suburbs, merges agent data from
 * REA (websift) + Domain (shahidirfan), extracts agencies from listings
 * (azzouzana), cross-validates, and stores in pulse_agents + pulse_agencies.
 *
 * Body params:
 *   suburbs: string[]           — e.g. ["Strathfield", "Burwood", "Homebush"]
 *   state: string               — default "NSW"
 *   maxAgentsPerSuburb: number  — default 50
 *   maxListingsPerSuburb: number — default 30
 *   skipDomain: boolean         — skip Domain scrape (save credits)
 *   skipListings: boolean       — skip listings scrape
 *   dryRun: boolean             — return results without saving
 */

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';

// ── Apify actor runner ──────────────────────────────────────────────────────

async function runApifyActor(actorSlug: string, input: any, label: string, timeoutSecs = 180): Promise<any[]> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set in environment');

  const safeId = actorSlug.replace('/', '~');
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=${timeoutSecs}&waitForFinish=${timeoutSecs}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Apify ${label} failed: ${resp.status} — ${body.substring(0, 200)}`);
    return [];
  }

  const runData = await resp.json();
  let runId = runData?.data?.id;
  let status = runData?.data?.status;
  let datasetId = runData?.data?.defaultDatasetId;

  // Poll if still running
  if (status === 'RUNNING' || status === 'READY') {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
      });
      const pollData = await pollResp.json();
      status = pollData?.data?.status;
      datasetId = pollData?.data?.defaultDatasetId || datasetId;
      if (status !== 'RUNNING' && status !== 'READY') break;
    }
  }

  if (status !== 'SUCCEEDED') {
    console.error(`Apify ${label}: status=${status}`);
    return [];
  }

  // Fetch results
  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?limit=5000`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = await itemsResp.json();
  console.log(`Apify ${label}: ${items.length} results`);
  return items;
}

// ── Normalize helpers ───────────────────────────────────────────────────────

function normalizeMobile(raw: string | null): string {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').replace(/^61/, '0').replace(/^0+/, '0');
}

function normalizeAgencyName(raw: string | null): string {
  if (!raw) return '';
  return raw.replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  // First+Last match (handles middle names)
  const pa = na.split(/\s+/);
  const pb = nb.split(/\s+/);
  if (pa.length >= 2 && pb.length >= 2) {
    return pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
  }
  return false;
}

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'pulseDataSync', hasToken: !!APIFY_TOKEN });
    }

    if (!APIFY_TOKEN) {
      return errorResponse('APIFY_TOKEN not configured. Set it in Supabase Edge Function secrets.', 400);
    }

    const {
      suburbs = ['Strathfield'],
      state = 'NSW',
      maxAgentsPerSuburb = 50,
      maxListingsPerSuburb = 30,
      skipDomain = false,
      skipListings = false,
      dryRun = false,
    } = body;

    const now = new Date().toISOString();

    // Log sync start
    let syncLogId: string | null = null;
    if (!dryRun) {
      const log = await entities.PulseSyncLog.create({
        sync_type: 'full_sweep',
        status: 'running',
        started_at: now,
      });
      syncLogId = log.id;
    }

    const allReaAgents: any[] = [];
    const allDomainAgents: any[] = [];
    const allListings: any[] = [];

    // ── Step 1: Run Apify actors per suburb ─────────────────────────────

    for (const suburb of suburbs) {
      const suburbSlug = suburb.toLowerCase().replace(/\s+/g, '-');
      const postcodeGuess = ''; // Apify handles suburb name matching

      // 1A: websift REA agent collector
      console.log(`[${suburb}] Running websift REA agents...`);
      const reaAgents = await runApifyActor('websift/realestateau', {
        location: `${suburb} ${state}`,
        maxResults: maxAgentsPerSuburb,
        sortBy: 'SUBURB_SALES_PERFORMANCE',
        contactFilter: 'any',
      }, `websift-${suburb}`, 180);
      reaAgents.forEach(a => { a._suburb = suburb; a._source = 'rea'; });
      allReaAgents.push(...reaAgents);

      // 1B: shahidirfan Domain agent scraper
      if (!skipDomain) {
        console.log(`[${suburb}] Running shahidirfan Domain agents...`);
        const domainAgents = await runApifyActor('shahidirfan/domain-com-au-real-estate-agents-scraper', {
          startUrls: [{ url: `https://www.domain.com.au/real-estate-agents/${suburbSlug}-${state.toLowerCase()}/` }],
          maxItems: maxAgentsPerSuburb,
        }, `domain-${suburb}`, 120);
        domainAgents.forEach(a => { a._suburb = suburb; a._source = 'domain'; });
        allDomainAgents.push(...domainAgents);
      }

      // 1C: azzouzana REA listings
      if (!skipListings) {
        console.log(`[${suburb}] Running azzouzana REA listings...`);
        const listings = await runApifyActor('azzouzana/real-estate-au-scraper-pro', {
          startUrl: `https://www.realestate.com.au/buy/in-${suburbSlug},+${state.toLowerCase()}/list-1`,
          maxItems: maxListingsPerSuburb,
        }, `listings-${suburb}`, 120);
        listings.forEach(l => { l._suburb = suburb; });
        allListings.push(...listings);
      }
    }

    console.log(`Raw data: ${allReaAgents.length} REA agents, ${allDomainAgents.length} Domain agents, ${allListings.length} listings`);

    // ── Step 2: Merge agents (REA primary, Domain secondary) ────────────

    const mergedAgents: any[] = [];
    const usedDomainIds = new Set<string>();

    for (const rea of allReaAgents) {
      const reaName = rea.name || '';
      const reaMobile = normalizeMobile(rea.mobile || '');

      // Try to find matching Domain agent
      let domainMatch: any = null;
      for (const dom of allDomainAgents) {
        if (usedDomainIds.has(dom.id?.toString())) continue;
        if (fuzzyNameMatch(reaName, dom.name || '')) {
          domainMatch = dom;
          usedDomainIds.add(dom.id?.toString());
          break;
        }
      }

      // Compute data integrity
      let integrityScore = 50; // Base: single source
      const sources: string[] = ['rea'];
      let mobileValidated = false;
      let agencyValidated = false;

      if (domainMatch) {
        sources.push('domain');
        integrityScore = 70; // Dual source base

        const domMobile = normalizeMobile(domainMatch.mobile || '');
        if (reaMobile && domMobile && reaMobile === domMobile) {
          mobileValidated = true;
          integrityScore += 15;
        }

        const reaAgency = normalizeAgencyName(rea.agency?.name || '');
        const domAgency = normalizeAgencyName(domainMatch.agency || '');
        if (reaAgency && domAgency && (reaAgency.includes(domAgency) || domAgency.includes(reaAgency))) {
          agencyValidated = true;
          integrityScore += 15;
        }
      }

      const searchStats = rea.search_stats || {};
      const profileStats = rea.profile_stats || {};
      const reviews = rea.reviews || {};

      mergedAgents.push({
        full_name: reaName,
        email: null, // Neither source provides actual emails
        mobile: rea.mobile ? String(rea.mobile) : (domainMatch?.mobile || null),
        business_phone: rea.businessPhone ? String(rea.businessPhone) : (domainMatch?.phone || null),
        phone: rea.businessPhone ? String(rea.businessPhone) : (domainMatch?.phone || null),
        agency_name: rea.agency?.name || domainMatch?.agency || null,
        agency_rea_id: rea.agency?.id || null,
        agency_suburb: rea._suburb,
        job_title: rea.job_title || domainMatch?.title || null,
        years_experience: rea.years_experience || null,
        sales_as_lead: rea.sales_as_lead || null,
        total_listings_active: domainMatch?.propertiesForSale || null,
        total_sold_12m: domainMatch?.propertiesSold || (searchStats.sumSoldProperties || null),
        rea_median_sold_price: searchStats.medianSoldPrice || profileStats.medianSoldPrice || null,
        domain_avg_sold_price: domainMatch?.averageSoldPrice || null,
        avg_sold_price: searchStats.medianSoldPrice || domainMatch?.averageSoldPrice || null,
        rea_median_dom: searchStats.medianSoldDaysOnSite || profileStats.medianSoldDaysOnSite || null,
        domain_avg_dom: domainMatch?.averageSoldDaysOnMarket || null,
        avg_days_on_market: searchStats.medianSoldDaysOnSite || domainMatch?.averageSoldDaysOnMarket || null,
        rea_rating: reviews.avg_rating || null,
        domain_rating: domainMatch?.rating || null,
        overall_rating: reviews.avg_rating || domainMatch?.rating || null,
        rea_review_count: reviews.total_reviews || null,
        domain_review_count: domainMatch?.reviewCount || null,
        reviews_count: reviews.total_reviews || domainMatch?.reviewCount || 0,
        reviews_avg: reviews.avg_rating || domainMatch?.rating || null,
        awards: rea.awards || null,
        speciality_suburbs: rea.specialities || null,
        social_facebook: rea.social?.facebook || null,
        social_instagram: rea.social?.instagram || null,
        social_linkedin: rea.social?.linkedin || null,
        community_involvement: rea.community_involvement || null,
        recent_listing_ids: JSON.stringify((rea.recent_listings || []).slice(0, 10).map((l: any) => l.listing_id)),
        sales_breakdown: rea.profile_sales_breakdown ? JSON.stringify(rea.profile_sales_breakdown) : null,
        rea_agent_id: rea.salesperson_id ? String(rea.salesperson_id) : null,
        domain_agent_id: domainMatch?.id ? String(domainMatch.id) : null,
        rea_profile_url: rea.profile_url || null,
        domain_profile_url: domainMatch?.url || null,
        profile_image: domainMatch?.profileImage || null,
        source: domainMatch ? 'rea+domain' : 'rea',
        data_sources: JSON.stringify(sources),
        data_integrity_score: integrityScore,
        mobile_validated: mobileValidated,
        agency_validated: agencyValidated,
        suburbs_active: JSON.stringify([rea._suburb]),
        last_synced_at: now,
        is_in_crm: false,
        is_prospect: false,
      });
    }

    // Add remaining Domain-only agents
    for (const dom of allDomainAgents) {
      if (usedDomainIds.has(dom.id?.toString())) continue;
      mergedAgents.push({
        full_name: dom.name || '',
        mobile: dom.mobile || null,
        business_phone: dom.phone || null,
        phone: dom.phone || null,
        agency_name: dom.agency || null,
        agency_suburb: dom._suburb,
        total_listings_active: dom.propertiesForSale || null,
        total_sold_12m: dom.propertiesSold || null,
        domain_avg_sold_price: dom.averageSoldPrice || null,
        avg_sold_price: dom.averageSoldPrice || null,
        domain_avg_dom: dom.averageSoldDaysOnMarket || null,
        avg_days_on_market: dom.averageSoldDaysOnMarket || null,
        domain_rating: dom.rating || null,
        overall_rating: dom.rating || null,
        domain_review_count: dom.reviewCount || null,
        reviews_count: dom.reviewCount || 0,
        reviews_avg: dom.rating || null,
        domain_agent_id: dom.id ? String(dom.id) : null,
        domain_profile_url: dom.url || null,
        profile_image: dom.profileImage || null,
        source: 'domain',
        data_sources: JSON.stringify(['domain']),
        data_integrity_score: 40,
        mobile_validated: false,
        agency_validated: false,
        suburbs_active: JSON.stringify([dom._suburb]),
        last_synced_at: now,
        is_in_crm: false,
        is_prospect: false,
      });
    }

    // ── Step 3: Extract agencies from listings ──────────────────────────

    const agencyMap = new Map<string, any>();
    for (const listing of allListings) {
      const agencyName = listing.agencyName;
      if (!agencyName) continue;
      const key = normalizeAgencyName(agencyName);
      if (!agencyMap.has(key)) {
        agencyMap.set(key, {
          name: agencyName,
          phone: listing.agencyPhone || null,
          email: listing.agencyEmail || null,
          website: listing.agencyWebsite || null,
          address: listing.agencyAddress || null,
          suburb: listing.agencyAddress_suburb || null,
          state: listing.agencyAddress_state || null,
          postcode: listing.agencyAddress_postcode || null,
          logo_url: listing.agencyLogo || null,
          rea_profile_url: listing.agencyProfileUrl || null,
          agent_count: 0,
          active_listings: 0,
          listing_prices: [],
          suburbs: new Set<string>(),
          source: 'rea_listings',
          data_sources: JSON.stringify(['rea_listings']),
          last_synced_at: now,
          is_in_crm: false,
        });
      }
      const agency = agencyMap.get(key)!;
      agency.active_listings++;
      if (listing.suburb) agency.suburbs.add(listing.suburb);
      const price = parseFloat(String(listing.price || '').replace(/[^0-9.]/g, ''));
      if (price > 0) agency.listing_prices.push(price);

      // Extract agent names for this agency
      if (listing.agents && Array.isArray(listing.agents)) {
        for (const agent of listing.agents) {
          if (agent.name) agency.agent_count++;
        }
      }
    }

    // Count unique agents per agency from merged agents
    for (const [key, agency] of agencyMap.entries()) {
      const agentCount = mergedAgents.filter(a =>
        normalizeAgencyName(a.agency_name || '') === key
      ).length;
      if (agentCount > agency.agent_count) agency.agent_count = agentCount;
    }

    const mergedAgencies: any[] = [];
    for (const [, agency] of agencyMap.entries()) {
      const prices = agency.listing_prices;
      mergedAgencies.push({
        name: agency.name,
        phone: agency.phone,
        email: agency.email,
        website: agency.website,
        address: agency.address,
        suburb: agency.suburb,
        state: agency.state,
        postcode: agency.postcode,
        logo_url: agency.logo_url,
        rea_profile_url: agency.rea_profile_url,
        agent_count: agency.agent_count,
        active_listings: agency.active_listings,
        avg_listing_price: prices.length > 0 ? Math.round(prices.reduce((s: number, p: number) => s + p, 0) / prices.length) : null,
        suburbs_active: JSON.stringify([...agency.suburbs]),
        source: agency.source,
        data_sources: agency.data_sources,
        last_synced_at: agency.last_synced_at,
        is_in_crm: false,
      });
    }

    // ── Step 4: Cross-reference with CRM ────────────────────────────────

    const crmAgents = await entities.Agent.filter({}, null, 1000).catch(() => []);
    const crmNames = new Set(crmAgents.map((a: any) => (a.name || '').toLowerCase().trim()));
    const crmAgencies = await entities.Agency.filter({}, null, 500).catch(() => []);
    const crmAgencyNames = new Set(crmAgencies.map((a: any) => normalizeAgencyName(a.name)));

    for (const agent of mergedAgents) {
      const name = (agent.full_name || '').toLowerCase().trim();
      if (crmNames.has(name)) {
        agent.is_in_crm = true;
      } else {
        // Fuzzy match
        for (const cn of crmNames) {
          if (fuzzyNameMatch(name, cn)) {
            agent.is_in_crm = true;
            break;
          }
        }
      }
    }

    for (const agency of mergedAgencies) {
      if (crmAgencyNames.has(normalizeAgencyName(agency.name))) {
        agency.is_in_crm = true;
      }
    }

    console.log(`Merged: ${mergedAgents.length} agents, ${mergedAgencies.length} agencies`);
    console.log(`In CRM: ${mergedAgents.filter(a => a.is_in_crm).length} agents, ${mergedAgencies.filter(a => a.is_in_crm).length} agencies`);

    if (dryRun) {
      return jsonResponse({
        success: true,
        dry_run: true,
        agents: mergedAgents.length,
        agencies: mergedAgencies.length,
        listings: allListings.length,
        in_crm_agents: mergedAgents.filter(a => a.is_in_crm).length,
        in_crm_agencies: mergedAgencies.filter(a => a.is_in_crm).length,
        sample_agent: mergedAgents[0] || null,
        sample_agency: mergedAgencies[0] || null,
      });
    }

    // ── Step 5: Upsert to database ──────────────────────────────────────

    // Clear existing Fair Trading junk data first
    await admin.from('pulse_agents').delete().eq('source', 'fair_trading').then(() => {});

    // Batch insert agents — use raw admin client with explicit JSONB handling
    let agentsInserted = 0;
    let agentErrors = 0;
    const _agentErrorMsgs: string[] = [];
    const BATCH = 50;

    // Deduplicate merged agents by REA ID (same agent appears in multiple suburb searches)
    const deduped = new Map<string, any>();
    for (const agent of mergedAgents) {
      const key = agent.rea_agent_id || `name:${(agent.full_name || '').toLowerCase()}`;
      if (!deduped.has(key)) {
        deduped.set(key, agent);
      } else {
        // Merge suburbs_active from duplicate
        const existing = deduped.get(key);
        try {
          const existingSuburbs = typeof existing.suburbs_active === 'string' ? JSON.parse(existing.suburbs_active) : (existing.suburbs_active || []);
          const newSuburbs = typeof agent.suburbs_active === 'string' ? JSON.parse(agent.suburbs_active) : (agent.suburbs_active || []);
          existing.suburbs_active = JSON.stringify([...new Set([...existingSuburbs, ...newSuburbs])]);
        } catch { /* keep existing */ }
      }
    }
    const uniqueAgents = [...deduped.values()];
    console.log(`Deduped: ${mergedAgents.length} → ${uniqueAgents.length} unique agents`);

    // Upsert agents by rea_agent_id (update if exists, insert if new)
    for (let i = 0; i < uniqueAgents.length; i += BATCH) {
      const batch = uniqueAgents.slice(i, i + BATCH).map(a => ({
        ...a,
        data_sources: typeof a.data_sources === 'string' ? JSON.parse(a.data_sources) : (a.data_sources || []),
        suburbs_active: typeof a.suburbs_active === 'string' ? JSON.parse(a.suburbs_active) : (a.suburbs_active || []),
        recent_listing_ids: typeof a.recent_listing_ids === 'string' ? JSON.parse(a.recent_listing_ids) : (a.recent_listing_ids || []),
        sales_breakdown: typeof a.sales_breakdown === 'string' ? JSON.parse(a.sales_breakdown) : (a.sales_breakdown || null),
      }));
      const { error } = await admin.from('pulse_agents').upsert(batch, {
        onConflict: 'rea_agent_id',
        ignoreDuplicates: false,  // update existing records
      });
      if (error) {
        agentErrors++;
        _agentErrorMsgs.push(error.message?.substring(0, 300) || 'unknown');
      } else {
        agentsInserted += batch.length;
      }
      if ((i / BATCH) % 3 === 0) console.log(`  Agents: ${agentsInserted}/${uniqueAgents.length}...`);
    }

    // Insert agencies
    let agenciesInserted = 0;
    for (const agency of mergedAgencies) {
      const cleaned = {
        ...agency,
        suburbs_active: typeof agency.suburbs_active === 'string' ? JSON.parse(agency.suburbs_active) : (agency.suburbs_active || []),
        data_sources: typeof agency.data_sources === 'string' ? JSON.parse(agency.data_sources) : (agency.data_sources || []),
      };
      const { error } = await admin.from('pulse_agencies').insert(cleaned);
      if (error) {
        if (agenciesInserted < 2) console.error(`Agency insert error:`, error.message?.substring(0, 200));
      } else {
        agenciesInserted++;
      }
    }

    // Insert listings
    let listingsInserted = 0;
    const listingRecords = allListings.map(l => ({
      address: l.address || null,
      suburb: l.suburb || l._suburb || null,
      postcode: l.postcode || null,
      property_type: l.propertyType || null,
      bedrooms: l.bedrooms || null,
      bathrooms: l.bathrooms || null,
      listing_type: l.isSold ? 'sold' : l.isBuy ? 'for_sale' : 'other',
      asking_price: parseFloat(String(l.price || '').replace(/[^0-9.]/g, '')) || null,
      agent_name: (l.agents && l.agents[0]) ? l.agents[0].name : null,
      agent_phone: (l.agents && l.agents[0]) ? l.agents[0].phoneNumber : null,
      agency_name: l.agencyName || null,
      source: 'rea',
      source_url: l.url || null,
      source_listing_id: l.listingId ? String(l.listingId) : null,
      last_synced_at: now,
    }));

    for (let i = 0; i < listingRecords.length; i += BATCH) {
      const batch = listingRecords.slice(i, i + BATCH);
      const { error } = await admin.from('pulse_listings').insert(batch);
      if (error) {
        if (listingsInserted < 2) console.error(`Listing insert error:`, error.message?.substring(0, 200));
      } else {
        listingsInserted += batch.length;
      }
    }

    // ── Step 6: Movement Detection + Timeline Logging ──────────────────

    let movementsDetected = 0;
    let timelineEntries = 0;
    let mappingsCreated = 0;

    // Load existing pulse_agents to compare for movements
    const { data: existingPulseAgents = [] } = await admin.from('pulse_agents')
      .select('id, rea_agent_id, agency_name, agency_rea_id, full_name')
      .not('rea_agent_id', 'is', null);

    const existingByReaId = new Map(existingPulseAgents.map((a: any) => [a.rea_agent_id, a]));

    for (const agent of mergedAgents) {
      const reaId = agent.rea_agent_id;
      if (!reaId) continue;

      const existing = existingByReaId.get(reaId);

      if (!existing) {
        // New agent — first seen
        await admin.from('pulse_timeline').insert({
          entity_type: 'agent',
          rea_id: reaId,
          event_type: 'first_seen',
          event_category: 'system',
          title: `${agent.full_name} first detected`,
          description: `Agent first seen in ${agent.agency_name || 'unknown agency'}, ${agent.agency_suburb || ''}`,
          new_value: { agency_name: agent.agency_name, agency_rea_id: agent.agency_rea_id, suburb: agent.agency_suburb },
          source: 'rea_sync',
        }).then(() => { timelineEntries++; }).catch(() => {});
      } else if (existing.agency_rea_id && agent.agency_rea_id && existing.agency_rea_id !== agent.agency_rea_id) {
        // Agency change detected!
        movementsDetected++;
        await admin.from('pulse_timeline').insert({
          entity_type: 'agent',
          pulse_entity_id: existing.id,
          rea_id: reaId,
          event_type: 'agency_change',
          event_category: 'movement',
          title: `${agent.full_name} moved from ${existing.agency_name} → ${agent.agency_name}`,
          description: `Agency change detected during sync. Previous: ${existing.agency_name} (REA ${existing.agency_rea_id}). New: ${agent.agency_name} (REA ${agent.agency_rea_id}).`,
          previous_value: { agency_name: existing.agency_name, agency_rea_id: existing.agency_rea_id },
          new_value: { agency_name: agent.agency_name, agency_rea_id: agent.agency_rea_id },
          source: 'rea_sync',
        }).then(() => { timelineEntries++; }).catch(() => {});

        // Update the existing record with movement data
        await admin.from('pulse_agents').update({
          previous_agency_name: existing.agency_name,
          agency_changed_at: now,
        }).eq('id', existing.id).then(() => {}).catch(() => {});
      }
    }

    // ── Step 7: Auto-Mapping via Platform IDs + Phone ───────────────────

    const crmAgentsList = await entities.Agent.filter({}, null, 1000).catch(() => []);
    const crmAgenciesList = await entities.Agency.filter({}, null, 500).catch(() => []);

    // Load existing mappings to skip already-mapped
    const { data: existingMappings = [] } = await admin.from('pulse_crm_mappings').select('rea_id, entity_type, confidence');
    const mappedReaIds = new Set(existingMappings.filter((m: any) => m.confidence === 'confirmed').map((m: any) => `${m.entity_type}:${m.rea_id}`));

    for (const agent of mergedAgents) {
      const reaId = agent.rea_agent_id;
      if (!reaId || mappedReaIds.has(`agent:${reaId}`)) continue;

      // Try phone match first (strongest signal)
      const agentMobile = normalizeMobile(agent.mobile);
      let matchedCrm: any = null;
      let matchType = '';
      let hasNameOverlap = false;

      if (agentMobile) {
        matchedCrm = crmAgentsList.find((c: any) => normalizeMobile(c.phone) === agentMobile);
        if (matchedCrm) {
          matchType = 'phone';
          // Check if name also overlaps — agencies recycle mobile numbers,
          // so phone match alone is NOT definitive. Phone + name = confirmed.
          // Phone without name = suggested (flagged for human review).
          hasNameOverlap = fuzzyNameMatch(matchedCrm.name || '', agent.full_name || '');
        }
      }

      // Try exact name match (no phone match found)
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => (c.name || '').toLowerCase().trim() === (agent.full_name || '').toLowerCase().trim());
        if (matchedCrm) { matchType = 'name_exact'; hasNameOverlap = true; }
      }

      // Try fuzzy name match
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => fuzzyNameMatch(c.name || '', agent.full_name || ''));
        if (matchedCrm) { matchType = 'name_fuzzy'; hasNameOverlap = true; }
      }

      if (matchedCrm) {
        // Check if mapping already exists for this REA ID
        const { data: existMap } = await admin.from('pulse_crm_mappings')
          .select('id')
          .eq('rea_id', reaId)
          .eq('entity_type', 'agent')
          .limit(1);

        if (!existMap || existMap.length === 0) {
          // Confidence logic:
          //   phone + name overlap  → "confirmed" (definitive: same phone AND same person)
          //   phone only (no name)  → "suggested" (could be recycled number — flag for review)
          //   name only             → "suggested" (names can collide)
          const confidence = (matchType === 'phone' && hasNameOverlap) ? 'confirmed' : 'suggested';

          await admin.from('pulse_crm_mappings').insert({
            entity_type: 'agent',
            rea_id: reaId,
            domain_id: agent.domain_agent_id || null,
            crm_entity_id: matchedCrm.id,
            match_type: hasNameOverlap ? `${matchType}+name` : matchType,
            confidence,
          }).then(() => { mappingsCreated++; }).catch(() => {});

          // Only auto-set is_in_crm for confirmed (phone+name) matches
          if (confidence === 'confirmed') {
            const { data: freshAgent } = await admin.from('pulse_agents')
              .select('id')
              .eq('rea_agent_id', reaId)
              .limit(1);
            if (freshAgent?.[0]) {
              await admin.from('pulse_agents').update({ is_in_crm: true, linked_agent_id: matchedCrm.id }).eq('id', freshAgent[0].id);
            }
          }
        }
      }
    }

    console.log(`Post-sync: ${movementsDetected} movements, ${timelineEntries} timeline entries, ${mappingsCreated} mappings`);

    // Update sync log
    if (syncLogId) {
      await entities.PulseSyncLog.update(syncLogId, {
        status: 'completed',
        records_fetched: allReaAgents.length + allDomainAgents.length + allListings.length,
        records_new: agentsInserted + agenciesInserted + listingsInserted,
        completed_at: new Date().toISOString(),
      });
    }

    return jsonResponse({
      success: true,
      suburbs,
      _debug: {
        rea_raw: allReaAgents.length,
        domain_raw: allDomainAgents.length,
        merged_count: mergedAgents.length,
        agent_errors: agentErrors,
        first_agent_name: mergedAgents[0]?.full_name || 'none',
        agent_error_msgs: (_agentErrorMsgs || []).slice(0, 3),
      },
      agents_merged: agentsInserted,
      agencies_extracted: agenciesInserted,
      listings_stored: listingsInserted,
      movements_detected: movementsDetected,
      timeline_entries: timelineEntries,
      mappings_created: mappingsCreated,
      dual_source_agents: mergedAgents.filter(a => (a.data_sources || '').includes('domain')).length,
      in_crm_agents: mergedAgents.filter(a => a.is_in_crm).length,
      in_crm_agencies: mergedAgencies.filter(a => a.is_in_crm).length,
    });

  } catch (error: any) {
    console.error('pulseDataSync error:', error);
    return errorResponse(error.message);
  }
});
