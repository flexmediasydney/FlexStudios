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

interface ApifyRunResult {
  items: any[];
  runId: string | null;
  datasetId: string | null;
}

async function runApifyActor(actorSlug: string, input: any, label: string, timeoutSecs = 180): Promise<ApifyRunResult> {
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
    return { items: [], runId: null, datasetId: null };
  }

  const runData = await resp.json();
  let runId = runData?.data?.id || null;
  let status = runData?.data?.status;
  let datasetId = runData?.data?.defaultDatasetId || null;

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
    return { items: [], runId, datasetId };
  }

  // Fetch results
  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?limit=5000`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = await itemsResp.json();
  console.log(`Apify ${label}: ${items.length} results`);
  return { items, runId, datasetId };
}

// ── Normalize helpers ───────────────────────────────────────────────────────

function normalizeMobile(raw: string | null): string {
  if (!raw) return '';
  // Strip all non-digits, normalize +61/61 prefix → 04 format
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('614')) digits = '0' + digits.slice(2); // 61412... → 0412...
  else if (digits.startsWith('61')) digits = '0' + digits.slice(2);
  if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
}

function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/,/g, '');
  // "contact agent", "price on request" etc
  if (s.includes('contact') || s.includes('request') || s.includes('enquire') || s.includes('auction')) return null;
  // "$1.08m" or "$1.08M"
  const mMatch = s.match(/\$?([\d.]+)\s*m/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);
  // "$850k" or "$850K"
  const kMatch = s.match(/\$?([\d.]+)\s*k/i);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  // "$850,000" or ranges "$850,000 - $900,000" (take lower bound)
  const numMatch = s.match(/\$?([\d]+(?:\.[\d]+)?)/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    // If value < 10000, likely already in K or M shorthand that wasn't caught
    return val > 10000 ? Math.round(val) : null;
  }
  return null;
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
      maxAgenciesPerSuburb = 50,
      skipDomain = false,
      skipDomainAgencies = false,
      skipListings = false,
      dryRun = false,
      source_id = null,
      source_label = null,
      triggered_by = null,
      triggered_by_name = null,
      // Bounding box mode: single URL covers entire region (no per-suburb loop)
      listingsStartUrl = null,
      maxListingsTotal = 0,
      // Domain listings mode (fatihtahta actor — provides listing dates + media)
      domainListingsLocation = null,
      domainListingsSaleType = null, // buy, rent, sold
      maxDomainListings = 0,
    } = body;

    const now = new Date().toISOString();
    const apifyRunIds: Record<string, string | null> = {};

    // Log sync start
    let syncLogId: string | null = null;
    if (!dryRun) {
      const log = await entities.PulseSyncLog.create({
        sync_type: source_id || 'full_sweep',
        source_id: source_id || null,
        source_label: source_label || null,
        status: 'running',
        started_at: now,
        input_config: { suburbs, state, maxAgentsPerSuburb, maxListingsPerSuburb, skipDomain, skipListings },
        triggered_by: triggered_by || null,
        triggered_by_name: triggered_by_name || null,
      });
      syncLogId = log.id;
    }

    const allReaAgents: any[] = [];
    const allDomainAgents: any[] = [];
    const allListings: any[] = [];
    const allDomainAgencies: any[] = [];

    // ── Step 0: Bounding box listings (single-URL mode, no per-suburb loop) ──
    if (listingsStartUrl && maxListingsTotal > 0) {
      console.log(`[bounding-box] Running azzouzana with custom URL, max ${maxListingsTotal}...`);
      const bbResult = await runApifyActor('azzouzana/real-estate-au-scraper-pro', {
        startUrl: listingsStartUrl,
        maxItems: maxListingsTotal,
      }, 'listings-boundingbox', 300);
      bbResult.items.forEach(l => { l._suburb = l.suburb || 'Greater Sydney'; l._source = 'rea_boundingbox'; });
      allListings.push(...bbResult.items);
      if (bbResult.runId) apifyRunIds['listings-boundingbox'] = bbResult.runId;
      console.log(`[bounding-box] ${bbResult.items.length} listings from bounding box`);
    }

    // ── Step 0b: Domain listings via fatihtahta (provides createdDate + media galleries) ──
    const allDomainListings: any[] = [];
    if (domainListingsLocation && maxDomainListings > 0) {
      console.log(`[domain-listings] Running fatihtahta for ${domainListingsLocation} (${domainListingsSaleType || 'buy'}), max ${maxDomainListings}...`);
      const dlResult = await runApifyActor('fatihtahta/domain-com-au-scraper', {
        location: domainListingsLocation,
        saleType: domainListingsSaleType || 'buy',
        limit: maxDomainListings,
      }, 'domain-listings', 300);
      dlResult.items.forEach(l => { l._source = 'domain_listings'; });
      allDomainListings.push(...dlResult.items);
      if (dlResult.runId) apifyRunIds['domain-listings'] = dlResult.runId;
      console.log(`[domain-listings] ${dlResult.items.length} listings from Domain`);

      // Convert fatihtahta Domain listing format to our unified format
      // Actual structure: { listing_id, listing: { listed_at, headline, ... }, property: { address, image_urls, ... },
      //   contacts: { agents: [{ name, photo, mobile }], agency_id, agency_logo, agency_name },
      //   location: { latitude, longitude, suburb, street, postcode, state },
      //   media: { gallery: [...] }, inspection: { inspections: [...] }, search_result, source }
      for (const dl of allDomainListings) {
        const listing = dl.listing || {};
        const prop = dl.property || {};
        const contacts = dl.contacts || {};
        const loc = dl.location || {};
        const insp = dl.inspection || {};
        const media = dl.media || {};
        const searchResult = dl.search_result || {};
        const contactAgents = contacts.agents || [];
        const imageUrls = prop.image_urls || [];
        const gallery = media.gallery || [];
        const inspList = insp.inspections || [];

        const objective = (listing.objective || domainListingsSaleType || 'SALE').toUpperCase();

        allListings.push({
          address: prop.address || (loc.street ? `${loc.streetNumber || ''} ${loc.street}, ${loc.suburb}`.trim() : null),
          suburb: loc.suburb || null,
          postcode: loc.postcode || null,
          state: loc.state || null,
          propertyType: prop.property_type || prop.primary_property_type || null,
          bedrooms: prop.bedroom_count || null,
          bathrooms: prop.bathroom_count || null,
          carSpaces: prop.parking_count || null,
          landSize: prop.land_size || null,
          price: prop.price_text || null,
          isBuy: objective === 'SALE' || objective === 'BUY',
          isRent: objective === 'RENT',
          isSold: objective === 'SOLD',
          url: prop.canonical_url || null,
          listingId: dl.listing_id ? String(dl.listing_id) : null,
          agencyName: contacts.agency_name || null,
          agents: contactAgents.map((a: any) => ({
            name: a.name || null,
            phoneNumber: a.mobile || a.phone || null,
            image: a.photo || null,
            emails: a.email ? [a.email] : [],
          })),
          images: imageUrls,
          mainImage: imageUrls[0] || (gallery[0]?.images?.original?.url) || null,
          description: listing.headline || listing.description?.substring(0, 500) || null,
          inspections: inspList.map((i: any) => ({ startTime: i.isoDate || i.closingDateTime?.isoDate || null })).filter((i: any) => i.startTime),
          status: searchResult.listing_type || listing.channel || null,
          agencyLogo: contacts.agency_logo || null,
          agencyPhone: contacts.agency_phone || null,
          agencyEmail: null,
          hasVideo: !!(media.gallery || []).some((m: any) => m.mediaType === 'video'),
          latitude: loc.latitude || null,
          longitude: loc.longitude || null,
          promoLevel: null,
          agentPhoto: contactAgents[0]?.photo || null,
          brandColour: null,
          // KEY FIELD: actual listing date from Domain
          listedDate: listing.listed_at || listing.created_at || null,
          auctionDate: null,
          _suburb: loc.suburb || 'Greater Sydney',
          _source: 'domain_listings',
        });
      }
    }

    // ── Step 1: Run Apify actors per suburb ─────────────────────────────

    for (const suburb of suburbs) {
      const suburbSlug = suburb.toLowerCase().replace(/\s+/g, '-');
      const postcodeGuess = ''; // Apify handles suburb name matching

      // 1A: websift REA agent collector
      if (maxAgentsPerSuburb > 0) {
        console.log(`[${suburb}] Running websift REA agents...`);
        const reaResult = await runApifyActor('websift/realestateau', {
          location: `${suburb} ${state}`,
          maxResults: maxAgentsPerSuburb,
          sortBy: 'SUBURB_SALES_PERFORMANCE',
          contactFilter: 'any',
        }, `websift-${suburb}`, 180);
        reaResult.items.forEach(a => { a._suburb = suburb; a._source = 'rea'; });
        allReaAgents.push(...reaResult.items);
        if (reaResult.runId) apifyRunIds[`websift-${suburb}`] = reaResult.runId;
      }

      // 1B: ScrapStorm Domain agent scraper (replaces shahidirfan — richer fields + agencyId)
      if (!skipDomain && maxAgentsPerSuburb > 0) {
        console.log(`[${suburb}] Running scrapestorm Domain agents...`);
        const domResult = await runApifyActor('scrapestorm/domain-com-au-real-estate-agents-scraper---cheap', {
          domain_url: `https://www.domain.com.au/real-estate-agents/${suburbSlug}-${state.toLowerCase()}/`,
          max_items: maxAgentsPerSuburb,
        }, `domain-agents-${suburb}`, 120);
        domResult.items.forEach(a => { a._suburb = suburb; a._source = 'domain'; });
        allDomainAgents.push(...domResult.items);
        if (domResult.runId) apifyRunIds[`domain-agents-${suburb}`] = domResult.runId;
      }

      // 1D: ScrapStorm Domain agency scraper (dedicated agency-level data)
      if (!skipDomainAgencies && maxAgenciesPerSuburb > 0) {
        console.log(`[${suburb}] Running scrapestorm Domain agencies...`);
        const agencyResult = await runApifyActor('scrapestorm/domain-com-au-real-estate-agencies-scraper---cheap', {
          domain_url: `https://www.domain.com.au/real-estate-agencies/${suburbSlug}-${state.toLowerCase()}/`,
          max_items: maxAgenciesPerSuburb,
        }, `domain-agencies-${suburb}`, 120);
        agencyResult.items.forEach(a => { a._suburb = suburb; a._source = 'domain_agencies'; });
        allDomainAgencies.push(...agencyResult.items);
        if (agencyResult.runId) apifyRunIds[`domain-agencies-${suburb}`] = agencyResult.runId;
      }

      // 1C: azzouzana REA listings
      if (!skipListings && maxListingsPerSuburb > 0) {
        console.log(`[${suburb}] Running azzouzana REA listings...`);
        const listResult = await runApifyActor('azzouzana/real-estate-au-scraper-pro', {
          startUrl: `https://www.realestate.com.au/buy/in-${suburbSlug},+${state.toLowerCase()}/list-1`,
          maxItems: maxListingsPerSuburb,
        }, `listings-${suburb}`, 120);
        listResult.items.forEach(l => { l._suburb = suburb; });
        allListings.push(...listResult.items);
        if (listResult.runId) apifyRunIds[`listings-${suburb}`] = listResult.runId;
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
        const domAgency = normalizeAgencyName(domainMatch.agencyName || domainMatch.agency || '');
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
        business_phone: rea.businessPhone ? String(rea.businessPhone) : (domainMatch?.telephone || domainMatch?.phone || null),
        phone: rea.businessPhone ? String(rea.businessPhone) : (domainMatch?.telephone || domainMatch?.phone || null),
        agency_name: rea.agency?.name || domainMatch?.agencyName || domainMatch?.agency || null,
        agency_rea_id: rea.agency?.id || null,
        agency_domain_id: domainMatch?.agencyId ? String(domainMatch.agencyId) : null,
        agency_suburb: rea._suburb,
        job_title: rea.job_title || domainMatch?.jobTitle || domainMatch?.title || null,
        years_experience: rea.years_experience || null,
        sales_as_lead: rea.sales_as_lead || null,
        total_listings_active: domainMatch?.totalForSale || domainMatch?.propertiesForSale || null,
        total_sold_12m: domainMatch?.totalSoldAndAuctioned || domainMatch?.propertiesSold || (searchStats.sumSoldProperties || null),
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
        domain_agent_id: domainMatch?.agentIdV2 ? String(domainMatch.agentIdV2) : (domainMatch?.id ? String(domainMatch.id) : null),
        rea_profile_url: rea.profile_url || null,
        domain_profile_url: domainMatch?.profileUrl ? (domainMatch.profileUrl.startsWith('http') ? domainMatch.profileUrl : `https://www.domain.com.au${domainMatch.profileUrl}`) : (domainMatch?.url || null),
        profile_image: domainMatch?.profilePhoto || domainMatch?.profileImage || null,
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
        business_phone: dom.telephone || dom.phone || null,
        phone: dom.telephone || dom.phone || null,
        agency_name: dom.agencyName || dom.agency || null,
        agency_domain_id: dom.agencyId ? String(dom.agencyId) : null,
        agency_suburb: dom._suburb,
        job_title: dom.jobTitle || dom.title || null,
        total_listings_active: dom.totalForSale || dom.propertiesForSale || null,
        total_sold_12m: dom.totalSoldAndAuctioned || dom.propertiesSold || null,
        domain_avg_sold_price: dom.averageSoldPrice || null,
        avg_sold_price: dom.averageSoldPrice || null,
        domain_avg_dom: dom.averageSoldDaysOnMarket || null,
        avg_days_on_market: dom.averageSoldDaysOnMarket || null,
        domain_rating: dom.rating || null,
        overall_rating: dom.rating || null,
        domain_review_count: dom.reviewCount || null,
        reviews_count: dom.reviewCount || 0,
        reviews_avg: dom.rating || null,
        domain_agent_id: dom.agentIdV2 ? String(dom.agentIdV2) : (dom.id ? String(dom.id) : null),
        domain_profile_url: dom.profileUrl ? (dom.profileUrl.startsWith('http') ? dom.profileUrl : `https://www.domain.com.au${dom.profileUrl}`) : (dom.url || null),
        profile_image: dom.profilePhoto || dom.profileImage || null,
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

    // ── Step 3: Build agencies from listings + agent data ─────────────

    // 3a: Seed agencies from listings data (address, phone, logo, listings count)
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
          active_listings: 0,
          listing_prices: [],
          suburbs: new Set<string>(),
          sources: new Set<string>(['rea_listings']),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.active_listings++;
      if (listing.suburb) agency.suburbs.add(listing.suburb);
      const price = parseFloat(String(listing.price || '').replace(/[^0-9.]/g, ''));
      if (price > 0) agency.listing_prices.push(price);
    }

    // 3b: Enrich agencies from merged agent data (REA IDs, sales, ratings, agent count)
    // Also discover agencies that appear in agent data but had no listings
    for (const agent of mergedAgents) {
      const agencyName = agent.agency_name;
      if (!agencyName) continue;
      const key = normalizeAgencyName(agencyName);
      if (!agencyMap.has(key)) {
        agencyMap.set(key, {
          name: agencyName,
          phone: null, email: null, website: null, address: null,
          suburb: agent.agency_suburb || null, state: null, postcode: null,
          logo_url: null, rea_profile_url: null,
          active_listings: 0, listing_prices: [],
          suburbs: new Set<string>(),
          sources: new Set<string>(),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.sources.add(agent.source || 'rea');
      if (agent.agency_rea_id) agency.rea_agency_ids.add(agent.agency_rea_id);
      if (agent.agency_suburb) agency.suburbs.add(agent.agency_suburb);
    }

    // 3b.5: Enrich agencies from ScrapStorm Domain agency data (dedicated agency-level fields)
    for (const domAgency of allDomainAgencies) {
      const agencyName = domAgency.name;
      if (!agencyName) continue;
      const key = normalizeAgencyName(agencyName);
      if (!agencyMap.has(key)) {
        agencyMap.set(key, {
          name: agencyName,
          phone: null, email: null, website: null, address: null,
          suburb: domAgency._suburb || null, state: null, postcode: null,
          logo_url: null, rea_profile_url: null,
          active_listings: 0, listing_prices: [],
          suburbs: new Set<string>(),
          sources: new Set<string>(),
          rea_agency_ids: new Set<string>(),
        });
      }
      const agency = agencyMap.get(key)!;
      agency.sources.add('domain_agencies');
      // Domain agency data is authoritative for these fields — overwrite if present
      if (domAgency.displayAddress) {
        agency.address = domAgency.displayAddress;
        // Extract suburb from display address (e.g. "Level 5, 66 Berry Street, North Sydney NSW 2060")
        const addrParts = domAgency.displayAddress.split(',');
        if (addrParts.length >= 2) {
          const lastPart = addrParts[addrParts.length - 1].trim();
          const suburbMatch = lastPart.match(/^(.+?)\s+(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}$/);
          if (suburbMatch) agency.suburb = suburbMatch[1].trim();
        }
      }
      if (domAgency.telephone) agency.phone = agency.phone || domAgency.telephone;
      if (domAgency.mobile) agency.phone = agency.phone || domAgency.mobile;
      if (domAgency.email) agency.email = domAgency.email;
      if (domAgency.logoSmall) agency.logo_url = agency.logo_url || domAgency.logoSmall;
      // Domain-specific fields stored on the map for later
      agency.domain_agency_id = domAgency.id ? String(domAgency.id) : null;
      agency.domain_profile_url = domAgency.profileUrl ? (domAgency.profileUrl.startsWith('http') ? domAgency.profileUrl : `https://www.domain.com.au${domAgency.profileUrl}`) : null;
      agency.profile_tier = domAgency.profileTier || null;
      agency.brand_colour = domAgency.brandColour || null;
      agency.domain_total_for_sale = domAgency.totalForSale || 0;
      agency.domain_total_sold = domAgency.totalSoldAndAuctioned || 0;
      agency.domain_total_for_rent = domAgency.totalForRent || 0;
      agency.domain_agents = domAgency.agents || [];
      if (domAgency._suburb) agency.suburbs.add(domAgency._suburb);
    }

    // 3c: Aggregate per-agency stats from agents
    const mergedAgencies: any[] = [];
    for (const [key, agency] of agencyMap.entries()) {
      const agencyAgents = mergedAgents.filter(a => normalizeAgencyName(a.agency_name || '') === key);
      const agentCount = agencyAgents.length;
      const totalSold = agencyAgents.reduce((s, a) => s + (a.sales_as_lead || 0), 0);
      const avgRating = (() => {
        const rated = agencyAgents.filter(a => a.reviews_avg > 0 || a.rea_rating > 0);
        if (rated.length === 0) return null;
        return Math.round(rated.reduce((s, a) => s + (a.reviews_avg || a.rea_rating || 0), 0) / rated.length * 10) / 10;
      })();
      const totalReviews = agencyAgents.reduce((s, a) => s + (a.reviews_count || 0), 0);
      const avgSoldPrice = (() => {
        const withPrice = agencyAgents.filter(a => a.avg_sold_price > 0);
        if (withPrice.length === 0) return null;
        return Math.round(withPrice.reduce((s, a) => s + a.avg_sold_price, 0) / withPrice.length);
      })();
      const avgDom = (() => {
        const withDom = agencyAgents.filter(a => a.avg_days_on_market > 0);
        if (withDom.length === 0) return null;
        return Math.round(withDom.reduce((s, a) => s + a.avg_days_on_market, 0) / withDom.length);
      })();
      const prices = agency.listing_prices;
      const reaIds = [...agency.rea_agency_ids];

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
        rea_agency_id: reaIds[0] || null,
        domain_agency_id: agency.domain_agency_id || null,
        domain_profile_url: agency.domain_profile_url || null,
        profile_tier: agency.profile_tier || null,
        brand_colour: agency.brand_colour || null,
        agent_count: agentCount || (agency.domain_agents || []).length || 0,
        active_listings: agency.active_listings || agency.domain_total_for_sale || 0,
        total_sold_and_auctioned: agency.domain_total_sold || null,
        total_for_rent: agency.domain_total_for_rent || null,
        avg_listing_price: prices.length > 0 ? Math.round(prices.reduce((s: number, p: number) => s + p, 0) / prices.length) : null,
        total_sold_12m: totalSold || agency.domain_total_sold || null,
        avg_sold_price: avgSoldPrice,
        avg_days_on_market: avgDom,
        avg_agent_rating: avgRating,
        total_reviews: totalReviews || null,
        suburbs_active: JSON.stringify([...agency.suburbs]),
        source: [...agency.sources].join('+') || 'rea_listings',
        data_sources: JSON.stringify([...agency.sources]),
        last_synced_at: now,
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
    await admin.from('pulse_agents').delete().eq('source', 'fair_trading');

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

    // Upsert agencies (dedup by normalized name via unique index)
    let agenciesInserted = 0;
    for (const agency of mergedAgencies) {
      const cleaned = {
        ...agency,
        suburbs_active: typeof agency.suburbs_active === 'string' ? JSON.parse(agency.suburbs_active) : (agency.suburbs_active || []),
        data_sources: typeof agency.data_sources === 'string' ? JSON.parse(agency.data_sources) : (agency.data_sources || []),
      };
      const { error } = await admin.from('pulse_agencies').upsert(cleaned, {
        onConflict: 'lower(trim(name))',
        ignoreDuplicates: false,
      });
      if (error) {
        // Fallback: if functional index conflict doesn't work, try name-match update
        const { error: updateErr } = await admin.from('pulse_agencies')
          .update(cleaned)
          .ilike('name', agency.name.trim())
          .limit(1);
        if (!updateErr) { agenciesInserted++; }
        else if (agenciesInserted < 2) console.error(`Agency upsert error:`, error.message?.substring(0, 200));
      } else {
        agenciesInserted++;
      }
    }

    // Upsert listings + detect new listings
    let listingsInserted = 0;
    let newListingsDetected = 0;

    // Load existing listing IDs for new-listing detection
    const existingListingIds = new Set<string>();
    if (allListings.length > 0) {
      const { data: existingListings = [] } = await admin.from('pulse_listings')
        .select('source_listing_id')
        .not('source_listing_id', 'is', null);
      existingListings.forEach((l: any) => { if (l.source_listing_id) existingListingIds.add(l.source_listing_id); });
    }

    const listingRecords = allListings.map(l => {
      const listingId = l.listingId ? String(l.listingId) : null;
      const isNew = listingId && !existingListingIds.has(listingId);
      // Extract first future inspection
      const inspections = Array.isArray(l.inspections) ? l.inspections : [];
      const nextInspection = inspections[0]?.startTime || null;
      // Extract agent details from listing (emails, photos, REA IDs)
      const listingAgents = Array.isArray(l.agents) ? l.agents : [];
      const primaryAgent = listingAgents[0] || {};
      return {
        address: l.address || null,
        suburb: l.suburb || l._suburb || null,
        postcode: l.postcode || null,
        property_type: l.propertyType || null,
        bedrooms: l.bedrooms || null,
        bathrooms: l.bathrooms || null,
        parking: (l.parking || l.carSpaces) ? String(l.parking || l.carSpaces) : null,
        land_size: l.landSize ? String(l.landSize) : null,
        listing_type: l.isSold ? 'sold' : l.isBuy ? 'for_sale' : l.isRent ? 'for_rent' : 'other',
        asking_price: parsePrice(l.price),
        sold_price: parsePrice(l.soldPrice),
        listed_date: l.listedDate || l.dateAvailable || null,
        created_date: l.listedDate || null, // Actual platform listing date (Domain provides this)
        sold_date: l.soldDate || null,
        auction_date: l.auctionDate || null,
        days_on_market: l.daysOnMarket || null,
        status: l.status || null,
        next_inspection: nextInspection,
        agent_name: primaryAgent.name || null,
        agent_phone: primaryAgent.phoneNumber || null,
        agent_photo: primaryAgent.image || l.agentPhoto || null,
        agency_name: l.agencyName || null,
        agency_logo: l.agencyLogo || null,
        agency_brand_colour: l.brandColour || null,
        description: l.description ? String(l.description).substring(0, 500) : null,
        image_url: l.mainImage || (Array.isArray(l.images) && l.images[0]) || null,
        hero_image: l.mainImage || (Array.isArray(l.images) && l.images[0]) || null,
        images: Array.isArray(l.images) ? l.images.slice(0, 20) : null,
        has_video: l.hasVideo || false,
        latitude: l.latitude || null,
        longitude: l.longitude || null,
        features: l.propertyFeatures ? l.propertyFeatures : null,
        promo_level: l.promoLevel || l.productDepth || null,
        domain_listing_url: l._source === 'domain_listings' ? (l.url || null) : null,
        domain_listing_id: l._source === 'domain_listings' ? listingId : null,
        source: l._source || 'rea',
        source_url: l.url || null,
        source_listing_id: l._source === 'domain_listings' ? null : listingId,
        last_synced_at: now,
        _isNew: isNew,
        // Cross-enrichment data (stripped before DB insert, used for agent enrichment)
        _agentEmail: (primaryAgent.emails && primaryAgent.emails[0]) || null,
        _agentPhoto: primaryAgent.image || null,
        _agentReaId: primaryAgent.agentId ? String(primaryAgent.agentId) : null,
        _agentJobTitle: primaryAgent.jobTitle || null,
        _allAgents: listingAgents.map((a: any) => ({
          name: a.name, email: (a.emails && a.emails[0]) || null,
          phone: a.phoneNumber || null, photo: a.image || null,
          reaId: a.agentId ? String(a.agentId) : null, jobTitle: a.jobTitle || null,
        })),
      };
    });

    for (let i = 0; i < listingRecords.length; i += BATCH) {
      const batch = listingRecords.slice(i, i + BATCH);
      const cleanBatch = batch.map(({ _isNew, _agentEmail, _agentPhoto, _agentReaId, _agentJobTitle, _allAgents, ...rest }) => rest);
      const { error } = await admin.from('pulse_listings').upsert(cleanBatch, {
        onConflict: 'source_listing_id',
        ignoreDuplicates: false,
      });
      if (error) {
        console.error(`Listing upsert error (batch ${i / BATCH}):`, error.message?.substring(0, 300));
        // Fallback: insert one by one, skipping failures
        for (const rec of cleanBatch) {
          const { error: singleErr } = await admin.from('pulse_listings').insert(rec);
          if (!singleErr) listingsInserted++;
          else if (listingsInserted < 3) console.error(`Single listing insert error:`, singleErr.message?.substring(0, 200), 'listing_id:', rec.source_listing_id);
        }
      } else {
        listingsInserted += cleanBatch.length;
      }
      // Count new listings in this batch
      newListingsDetected += batch.filter(l => l._isNew).length;
    }

    // Log new listings to timeline
    if (newListingsDetected > 0) {
      const sampleNew = listingRecords.filter(l => l._isNew).slice(0, 5);
      try {
        await admin.from('pulse_timeline').insert({
          entity_type: 'listing',
          event_type: 'new_listings_detected',
          event_category: 'market',
          title: `${newListingsDetected} new listing${newListingsDetected !== 1 ? 's' : ''} detected`,
          description: sampleNew.map(l => `${l.address || l.suburb || '?'} — ${l.agency_name || '?'}`).join('; '),
          new_value: { count: newListingsDetected, sample: sampleNew.map(l => ({ address: l.address, suburb: l.suburb, price: l.asking_price, agency: l.agency_name, agent: l.agent_name })) },
          source: source_id || 'rea_sync',
        });
      } catch { /* non-fatal */ }
    }

    // Load CRM data once — used by cross-enrichment notifications + auto-mapping
    const crmAgentsList = await entities.Agent.filter({}, null, 1000).catch(() => []);
    const crmAgenciesList = await entities.Agency.filter({}, null, 500).catch(() => []);

    // ── Step 5.5: Cross-enrich agents from listing data ──────────────
    // Listings contain agent emails, photos, and REA IDs that the agent
    // scraper doesn't provide. Merge these into existing pulse_agents.
    {
      // Build a map of agent enrichment data from all listings
      const agentEnrichMap = new Map<string, { email?: string; photo?: string; reaId?: string; jobTitle?: string; listingCount: number; latestListing?: string }>();

      for (const lr of listingRecords) {
        const agents = lr._allAgents || [];
        for (const la of agents) {
          if (!la.name) continue;
          const key = la.name.toLowerCase().trim();
          const existing = agentEnrichMap.get(key) || { listingCount: 0 };
          if (la.email && !existing.email) existing.email = la.email;
          if (la.photo && !existing.photo) existing.photo = la.photo;
          if (la.reaId && !existing.reaId) existing.reaId = la.reaId;
          if (la.jobTitle && !existing.jobTitle) existing.jobTitle = la.jobTitle;
          existing.listingCount++;
          if (lr.source_url) existing.latestListing = lr.address || lr.suburb || lr.source_url;
          agentEnrichMap.set(key, existing);
        }
      }

      if (agentEnrichMap.size > 0) {
        // Load existing pulse_agents to enrich
        const { data: existingAgentsForEnrich = [] } = await admin.from('pulse_agents')
          .select('id, full_name, email, profile_image, rea_agent_id, job_title, total_listings_active');

        let enriched = 0;
        for (const pa of existingAgentsForEnrich) {
          const key = (pa.full_name || '').toLowerCase().trim();
          const enrichData = agentEnrichMap.get(key);
          if (!enrichData) continue;

          const updates: Record<string, any> = {};
          if (enrichData.email && !pa.email) updates.email = enrichData.email;
          if (enrichData.photo && !pa.profile_image) updates.profile_image = enrichData.photo;
          if (enrichData.reaId && !pa.rea_agent_id) updates.rea_agent_id = enrichData.reaId;
          if (enrichData.jobTitle && !pa.job_title) updates.job_title = enrichData.jobTitle;
          if (enrichData.listingCount > 0) updates.total_listings_active = enrichData.listingCount;

          if (Object.keys(updates).length > 0) {
            await admin.from('pulse_agents').update(updates).eq('id', pa.id);
            enriched++;
          }
        }
        console.log(`Cross-enriched ${enriched} agents from listing data (${agentEnrichMap.size} unique agents in listings)`);
      }
    }

    // ── Step 5.6: CRM client listing notifications ─────────────────────
    // When a new listing comes from an agent who IS in the CRM, notify admins.
    if (newListingsDetected > 0) {
      const newListingsFromCrmAgents = listingRecords.filter(l => {
        if (!l._isNew || !l.agent_name) return false;
        const agentName = l.agent_name.toLowerCase().trim();
        return crmAgentsList.some((c: any) => (c.name || '').toLowerCase().trim() === agentName);
      });

      if (newListingsFromCrmAgents.length > 0) {
        const users = await entities.User.list('-created_date', 200).catch(() => []);
        const admins = (users as any[]).filter((u: any) => u.role === 'master_admin' || u.role === 'admin');
        for (const listing of newListingsFromCrmAgents.slice(0, 5)) {
          const addr = listing.address || listing.suburb || 'New property';
          for (const u of admins) {
            try {
              await entities.Notification.create({
                user_id: u.id, type: 'pulse_client_listing', category: 'pulse', severity: 'info',
                title: `Client listing: ${listing.agent_name}`,
                message: `Your client ${listing.agent_name} just listed ${addr}${listing.asking_price ? ` (${listing.asking_price > 1000000 ? '$' + (listing.asking_price / 1000000).toFixed(1) + 'M' : '$' + Math.round(listing.asking_price / 1000) + 'K'})` : ''}`,
                is_read: false, is_dismissed: false, source: 'pulse',
                idempotency_key: `client_listing:${listing.source_listing_id}:${u.id}`,
                created_date: now,
              });
            } catch { /* dedup key handles repeats */ }
          }
        }
        // Timeline entry
        try {
          await admin.from('pulse_timeline').insert({
            entity_type: 'listing',
            event_type: 'client_new_listing',
            event_category: 'market',
            title: `${newListingsFromCrmAgents.length} new listing${newListingsFromCrmAgents.length !== 1 ? 's' : ''} from CRM clients`,
            description: newListingsFromCrmAgents.slice(0, 3).map(l => `${l.agent_name}: ${l.address || l.suburb}`).join('; '),
            source: source_id || 'rea_sync',
          });
        } catch { /* non-fatal */ }
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
        });
        timelineEntries++;
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
        });
        timelineEntries++;

        // Update the existing record with movement data
        await admin.from('pulse_agents').update({
          previous_agency_name: existing.agency_name,
          agency_changed_at: now,
        }).eq('id', existing.id);
      }
    }

    // ── Step 7: Auto-Mapping via Platform IDs + Phone (Agents + Agencies) ──
    // crmAgentsList + crmAgenciesList already loaded before Step 5.5

    // Load existing mappings to skip already-mapped
    const { data: existingMappings = [] } = await admin.from('pulse_crm_mappings').select('rea_id, domain_id, entity_type, confidence');
    const mappedKeys = new Set(existingMappings.filter((m: any) => m.confidence === 'confirmed').map((m: any) =>
      `${m.entity_type}:${m.rea_id || ''}:${m.domain_id || ''}`
    ));

    // 7a: Agent mapping — ID-first, then phone, then name
    for (const agent of mergedAgents) {
      const reaId = agent.rea_agent_id;
      const domainId = agent.domain_agent_id;
      if (!reaId && !domainId) continue;
      if (mappedKeys.has(`agent:${reaId || ''}:${domainId || ''}`)) continue;

      let matchedCrm: any = null;
      let matchType = '';
      let hasNameOverlap = false;

      // Priority 1: REA agent ID match (strongest — unique platform ID)
      if (reaId) {
        matchedCrm = crmAgentsList.find((c: any) => c.rea_agent_id === reaId);
        if (matchedCrm) { matchType = 'rea_id'; hasNameOverlap = true; }
      }

      // Priority 2: Domain agent ID match
      if (!matchedCrm && domainId) {
        matchedCrm = crmAgentsList.find((c: any) => c.domain_agent_id === domainId);
        if (matchedCrm) { matchType = 'domain_id'; hasNameOverlap = true; }
      }

      // Priority 3: Phone match
      if (!matchedCrm) {
        const agentMobile = normalizeMobile(agent.mobile);
        if (agentMobile) {
          matchedCrm = crmAgentsList.find((c: any) => normalizeMobile(c.phone) === agentMobile);
          if (matchedCrm) {
            matchType = 'phone';
            hasNameOverlap = fuzzyNameMatch(matchedCrm.name || '', agent.full_name || '');
          }
        }
      }

      // Priority 4: Exact name match
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => (c.name || '').toLowerCase().trim() === (agent.full_name || '').toLowerCase().trim());
        if (matchedCrm) { matchType = 'name_exact'; hasNameOverlap = true; }
      }

      // Priority 5: Fuzzy name match
      if (!matchedCrm) {
        matchedCrm = crmAgentsList.find((c: any) => fuzzyNameMatch(c.name || '', agent.full_name || ''));
        if (matchedCrm) { matchType = 'name_fuzzy'; hasNameOverlap = true; }
      }

      if (matchedCrm) {
        const { data: existMap } = await admin.from('pulse_crm_mappings')
          .select('id').eq('entity_type', 'agent')
          .or(`rea_id.eq.${reaId || 'NONE'},domain_id.eq.${domainId || 'NONE'}`)
          .limit(1);

        if (!existMap || existMap.length === 0) {
          // ID matches are always confirmed; phone+name = confirmed; phone-only or name-only = suggested
          const confidence = (matchType === 'rea_id' || matchType === 'domain_id' || (matchType === 'phone' && hasNameOverlap)) ? 'confirmed' : 'suggested';

          await admin.from('pulse_crm_mappings').insert({
            entity_type: 'agent',
            rea_id: reaId || null,
            domain_id: domainId || null,
            crm_entity_id: matchedCrm.id,
            match_type: hasNameOverlap ? `${matchType}+name` : matchType,
            confidence,
          });
          mappingsCreated++;

          if (confidence === 'confirmed') {
            // Write platform IDs back to the CRM record for future matching
            const crmUpdates: Record<string, any> = { };
            if (reaId && !matchedCrm.rea_agent_id) crmUpdates.rea_agent_id = reaId;
            if (domainId && !matchedCrm.domain_agent_id) crmUpdates.domain_agent_id = domainId;
            if (Object.keys(crmUpdates).length > 0) {
              admin.from('agents').update(crmUpdates).eq('id', matchedCrm.id);
            }

            const { data: freshAgent } = await admin.from('pulse_agents')
              .select('id').eq('rea_agent_id', reaId || 'NONE').limit(1);
            if (freshAgent?.[0]) {
              await admin.from('pulse_agents').update({ is_in_crm: true, linked_agent_id: matchedCrm.id }).eq('id', freshAgent[0].id);
            }
          }
        }
      }
    }

    // 7b: Agency mapping — Domain ID, REA ID, then name
    for (const agency of mergedAgencies) {
      const reaAgencyId = agency.rea_agency_id;
      const domainAgencyId = agency.domain_agency_id;
      if (!reaAgencyId && !domainAgencyId) continue;

      let matchedCrmAgency: any = null;
      let agencyMatchType = '';

      // Priority 1: Domain agency ID
      if (domainAgencyId) {
        matchedCrmAgency = crmAgenciesList.find((c: any) => c.domain_agency_id === domainAgencyId);
        if (matchedCrmAgency) agencyMatchType = 'domain_id';
      }

      // Priority 2: REA agency ID
      if (!matchedCrmAgency && reaAgencyId) {
        matchedCrmAgency = crmAgenciesList.find((c: any) => c.rea_agency_id === reaAgencyId);
        if (matchedCrmAgency) agencyMatchType = 'rea_id';
      }

      // Priority 3: Normalized name match
      if (!matchedCrmAgency) {
        const normName = normalizeAgencyName(agency.name);
        matchedCrmAgency = crmAgenciesList.find((c: any) => normalizeAgencyName(c.name) === normName);
        if (matchedCrmAgency) agencyMatchType = 'name';
      }

      if (matchedCrmAgency) {
        const { data: existAgencyMap } = await admin.from('pulse_crm_mappings')
          .select('id').eq('entity_type', 'agency')
          .eq('crm_entity_id', matchedCrmAgency.id)
          .limit(1);

        if (!existAgencyMap || existAgencyMap.length === 0) {
          const agencyConfidence = (agencyMatchType === 'domain_id' || agencyMatchType === 'rea_id') ? 'confirmed' : 'suggested';

          await admin.from('pulse_crm_mappings').insert({
            entity_type: 'agency',
            rea_id: reaAgencyId || null,
            domain_id: domainAgencyId || null,
            crm_entity_id: matchedCrmAgency.id,
            match_type: agencyMatchType,
            confidence: agencyConfidence,
          });
          mappingsCreated++;

          // Write platform IDs back to CRM agency
          if (agencyConfidence === 'confirmed') {
            const agencyUpdates: Record<string, any> = {};
            if (reaAgencyId && !matchedCrmAgency.rea_agency_id) agencyUpdates.rea_agency_id = reaAgencyId;
            if (domainAgencyId && !matchedCrmAgency.domain_agency_id) agencyUpdates.domain_agency_id = domainAgencyId;
            if (agency.rea_profile_url && !matchedCrmAgency.rea_profile_url) agencyUpdates.rea_profile_url = agency.rea_profile_url;
            if (agency.domain_profile_url && !matchedCrmAgency.domain_profile_url) agencyUpdates.domain_profile_url = agency.domain_profile_url;
            if (Object.keys(agencyUpdates).length > 0) {
              admin.from('agencies').update(agencyUpdates).eq('id', matchedCrmAgency.id);
            }
          }
        }
      }

      // Set is_in_crm on pulse_agency
      if (matchedCrmAgency) {
        const normName = normalizeAgencyName(agency.name);
        admin.from('pulse_agencies').update({ is_in_crm: true })
          .ilike('name', agency.name.trim());
      }
    }

    console.log(`Post-sync: ${movementsDetected} movements, ${timelineEntries} timeline entries, ${mappingsCreated} mappings`);

    // Update sync log with full results + raw payload
    if (syncLogId) {
      await entities.PulseSyncLog.update(syncLogId, {
        status: 'completed',
        records_fetched: allReaAgents.length + allDomainAgents.length + allListings.length + allDomainAgencies.length + allDomainListings.length,
        records_new: agentsInserted + agenciesInserted + listingsInserted,
        completed_at: new Date().toISOString(),
        apify_run_id: Object.values(apifyRunIds).filter(Boolean).join(',') || null,
        raw_payload: {
          rea_agents: allReaAgents,
          domain_agents: allDomainAgents,
          domain_agencies: allDomainAgencies,
          domain_listings: allDomainListings,
          listings: allListings,
        },
        result_summary: {
          agents_merged: agentsInserted,
          agencies_extracted: agenciesInserted,
          listings_stored: listingsInserted,
          movements_detected: movementsDetected,
          timeline_entries: timelineEntries,
          mappings_created: mappingsCreated,
          dual_source: mergedAgents.filter(a => (a.data_sources || '').includes('domain')).length,
          in_crm_agents: mergedAgents.filter(a => a.is_in_crm).length,
          agent_errors: agentErrors,
        },
        records_detail: {
          rea_agents: { fetched: allReaAgents.length, inserted: agentsInserted, errors: agentErrors },
          domain_agents: { fetched: allDomainAgents.length },
          listings: { fetched: allListings.length, inserted: listingsInserted },
          agencies: { extracted: agenciesInserted },
        },
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
      sync_log_id: syncLogId,
      apify_run_ids: apifyRunIds,
    });

  } catch (error: any) {
    console.error('pulseDataSync error:', error);
    return errorResponse(error.message);
  }
});
