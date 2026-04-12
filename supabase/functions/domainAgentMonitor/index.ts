import { handleCors, getCorsHeaders, jsonResponse, getAdminClient } from '../_shared/supabase.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const DOMAIN_API_BASE = 'https://api.domain.com.au/v1';
const DOMAIN_AUTH_URL = 'https://auth.domain.com.au/v1/connect/token';

// Norman So's CRM agent ID (for simulation matching)
const NORMAN_AGENT_ID = 'c0ec2a9a-157e-45ab-9caf-bbf08947d82d';

// ─── Domain API Auth ────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getDomainToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const clientId = Deno.env.get('DOMAIN_CLIENT_ID');
  const clientSecret = Deno.env.get('DOMAIN_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(DOMAIN_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=api_listings_read api_agencies_read`,
    });
    if (!res.ok) return null;
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedToken;
  } catch {
    return null;
  }
}

async function domainGet(path: string): Promise<any> {
  const token = await getDomainToken();
  if (!token) throw new Error('NO_DOMAIN_TOKEN');

  const res = await fetch(`${DOMAIN_API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 403 || res.status === 401) throw new Error('DOMAIN_NOT_AUTHORIZED');
  if (!res.ok) throw new Error(`Domain API ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// ─── Address Normalization & Matching ────────────────────────────────────────

function normalizeAddress(addr: string): string {
  if (!addr) return '';
  return addr
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/,/g, '')
    .replace(/\b(nsw|vic|qld|sa|wa|nt|act|tas)\b/gi, '')
    .replace(/\b(australia)\b/gi, '')
    .replace(/\b(street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|lane|ln|crescent|cres|parade|pde|boulevard|blvd)\b/gi, (m) => {
      const abbrevs: Record<string, string> = {
        street: 'st', st: 'st', road: 'rd', rd: 'rd', avenue: 'ave', ave: 'ave',
        drive: 'dr', dr: 'dr', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl',
        lane: 'ln', ln: 'ln', crescent: 'cres', cres: 'cres', parade: 'pde', pde: 'pde',
        boulevard: 'blvd', blvd: 'blvd',
      };
      return abbrevs[m.toLowerCase()] || m.toLowerCase();
    })
    .replace(/\d{4,}/g, '') // strip postcodes
    .replace(/\s+/g, ' ')
    .trim();
}

function addressMatch(domainAddr: string, projectAddr: string): boolean {
  const a = normalizeAddress(domainAddr);
  const b = normalizeAddress(projectAddr);
  if (!a || !b) return false;
  if (a === b) return true;
  // Partial match: one contains the other (handles unit number variations)
  if (a.includes(b) || b.includes(a)) return true;
  // Extract street number + name core for fuzzy match
  const coreA = a.replace(/^(\d+\/?[a-z]?\s)/, '$1').slice(0, 30);
  const coreB = b.replace(/^(\d+\/?[a-z]?\s)/, '$1').slice(0, 30);
  if (coreA.length > 10 && coreB.length > 10 && coreA === coreB) return true;
  return false;
}

// ─── Photo Quality Scoring ──────────────────────────────────────────────────

function scorePhotoQuality(listing: any): number {
  let score = 0;
  const photoCount = listing.photo_count || 0;
  // Photo count (max 40 points)
  if (photoCount >= 25) score += 40;
  else if (photoCount >= 15) score += 30;
  else if (photoCount >= 10) score += 20;
  else if (photoCount >= 5) score += 10;
  else score += 2;
  // Floorplan (20 points)
  if (listing.has_floorplan) score += 20;
  // Video (20 points)
  if (listing.has_video) score += 20;
  // Virtual tour (10 points)
  if (listing.has_virtual_tour) score += 10;
  // High-res detection from media URLs (10 points)
  const urls = listing.media_urls || [];
  if (urls.some((u: string) => /w[3-9]\d{3}|h[2-9]\d{3}/.test(u))) score += 10;
  return Math.min(score, 100);
}

function qualityLabel(score: number): string {
  if (score >= 80) return 'Professional';
  if (score >= 50) return 'Standard';
  if (score >= 25) return 'Basic';
  return 'Amateur';
}

// ─── Simulation Data ────────────────────────────────────────────────────────

function getSimulatedListings(): any[] {
  return [
    // ── Norman's REAL properties (will match FlexMedia projects) ──
    {
      domain_listing_id: 'SIM-2017001',
      address: '501/8 Parramatta Rd, Strathfield NSW 2135',
      headline: 'Stunning Apartment in Prime Location',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$850,000 - $900,000',
      price: 875000,
      bedrooms: 2, bathrooms: 2, carspaces: 1, land_area_sqm: null,
      photo_count: 22, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim1-w4500-h3000', 'https://bucket-api.domain.com.au/v1/bucket/image/sim2-w4500-h3000'],
      date_listed: '2026-04-10T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017002',
      address: '6 Jones St, Concord NSW 2137',
      headline: 'Charming Family Home on Quiet Street',
      property_type: 'residential',
      status: 'for_sale',
      display_price: 'Auction Guide $2,200,000',
      price: 2200000,
      bedrooms: 4, bathrooms: 2, carspaces: 2, land_area_sqm: 550,
      photo_count: 28, has_floorplan: true, has_video: true, has_virtual_tour: true,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim3-w4500-h3000'],
      date_listed: '2026-04-08T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017003',
      address: '36 Keeler St, Carlingford NSW 2118',
      headline: 'Modern Living in Sought-After Suburb',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$1,450,000',
      price: 1450000,
      bedrooms: 3, bathrooms: 2, carspaces: 1, land_area_sqm: 420,
      photo_count: 18, has_floorplan: true, has_video: false, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim4-w3200-h2400'],
      date_listed: '2026-04-07T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017004',
      address: '9/94 Burwood Rd, Croydon Park NSW 2136',
      headline: 'Top Floor Unit with District Views',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$680,000',
      price: 680000,
      bedrooms: 2, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 24, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim5-w4500-h3000'],
      date_listed: '2026-03-22T00:00:00Z',
      source_portal: 'domain',
    },
    // ── FAKE gap listings (Norman listed but FlexMedia DIDN'T shoot) ──
    {
      domain_listing_id: 'SIM-2017005',
      address: '12/45 The Boulevarde, Strathfield NSW 2135',
      headline: 'Spacious Apartment Close to Station',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$720,000 - $780,000',
      price: 750000,
      bedrooms: 2, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 8, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim6-w1600-h1200'],
      date_listed: '2026-04-11T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017006',
      address: '3 Albert St, Burwood NSW 2134',
      headline: 'Opportunity Knocks in Blue-Chip Suburb',
      property_type: 'residential',
      status: 'for_sale',
      display_price: 'Contact Agent',
      price: null,
      bedrooms: 3, bathrooms: 1, carspaces: 1, land_area_sqm: 380,
      photo_count: 4, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim7-w1024-h768'],
      date_listed: '2026-04-09T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017007',
      address: '22 Patterson St, Concord NSW 2137',
      headline: 'Beautifully Renovated Character Home',
      property_type: 'residential',
      status: 'sold',
      display_price: 'Sold $2,850,000',
      price: 2850000,
      bedrooms: 5, bathrooms: 3, carspaces: 2, land_area_sqm: 650,
      photo_count: 15, has_floorplan: true, has_video: false, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim8-w3200-h2400'],
      date_listed: '2026-03-15T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017008',
      address: '7/19 Homebush Rd, Strathfield NSW 2135',
      headline: 'Low-Maintenance Living in Prime Position',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$550,000',
      price: 550000,
      bedrooms: 1, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 6, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim9-w1600-h1200'],
      date_listed: '2026-04-05T00:00:00Z',
      source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017009',
      address: '88 Liverpool Rd, Croydon Park NSW 2133',
      headline: 'Immaculate Family Home with Pool',
      property_type: 'residential',
      status: 'for_sale',
      display_price: '$1,800,000 - $1,950,000',
      price: 1875000,
      bedrooms: 4, bathrooms: 3, carspaces: 2, land_area_sqm: 580,
      photo_count: 12, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: ['https://bucket-api.domain.com.au/v1/bucket/image/sim10-w3200-h2400'],
      date_listed: '2026-04-02T00:00:00Z',
      source_portal: 'domain',
    },
  ];
}

// ─── Transform Domain API listing to our format ─────────────────────────────

function transformDomainListing(raw: any): any {
  const prop = raw.propertyDetails || {};
  const media = raw.media || [];
  const advertiser = raw.advertiser || {};
  const addr = prop.displayableAddress || prop.address || '';
  const photos = media.filter((m: any) => m.category === 'image');

  return {
    domain_listing_id: String(raw.id || raw.listingId || ''),
    address: addr,
    headline: raw.headline || '',
    property_type: raw.channel || 'residential',
    status: raw.status === 'sold' || raw.soldDetails ? 'sold' : raw.isWithdrawn ? 'withdrawn' : 'for_sale',
    display_price: raw.priceDetails?.displayPrice || raw.price || 'Contact Agent',
    price: raw.priceDetails?.price || null,
    bedrooms: prop.bedrooms || null,
    bathrooms: prop.bathrooms || null,
    carspaces: prop.carspaces || null,
    land_area_sqm: prop.landArea || null,
    photo_count: photos.length,
    has_floorplan: !!raw.hasFloorplan || media.some((m: any) => m.category === 'floorplan'),
    has_video: !!raw.hasVideo || media.some((m: any) => m.category === 'video'),
    has_virtual_tour: !!raw.virtualTourUrl,
    media_urls: photos.slice(0, 5).map((m: any) => m.url),
    date_listed: raw.dateListed || null,
    source_portal: 'domain',
  };
}

// ─── Main Handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'domainAgentMonitor' }, 200, req);
  }

  try {
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
    const { data: projects = [] } = await admin
      .from('projects')
      .select('id, property_address, title, status, shoot_date, calculated_price, price, payment_status, products, packages')
      .eq('agent_id', agentId)
      .neq('source', 'goal')
      .order('shoot_date', { ascending: false });

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

    // 4. Score photo quality
    for (const listing of domainListings) {
      listing.photo_quality_score = scorePhotoQuality(listing);
      listing.quality_label = qualityLabel(listing.photo_quality_score);
    }

    // 5. Auto-match Domain listings to FlexMedia projects
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

    // 6. Find internal projects with no Domain listing
    const matchedProjectIds = new Set(matches.map((m: any) => m.project.id));
    const unmatchedProjects = projects.filter((p: any) => !matchedProjectIds.has(p.id));

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
        avg_photo_quality: totalListings > 0
          ? Math.round(domainListings.reduce((s: number, l: any) => s + l.photo_quality_score, 0) / totalListings)
          : 0,
      },
      matches,
      gaps,
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
