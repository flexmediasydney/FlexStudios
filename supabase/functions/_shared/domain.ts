/**
 * Shared Domain.com.au API helpers for Edge Functions.
 * Used by domainAgentMonitor and retentionSweep.
 */

const DOMAIN_API_BASE = 'https://api.domain.com.au/v1';
const DOMAIN_AUTH_URL = 'https://auth.domain.com.au/v1/connect/token';

// ─── Domain API Auth ────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getDomainToken(): Promise<string | null> {
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

export async function domainGet(path: string): Promise<any> {
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

export function normalizeAddress(addr: string): string {
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
    .replace(/\d{4,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function addressMatch(domainAddr: string, projectAddr: string): boolean {
  const a = normalizeAddress(domainAddr);
  const b = normalizeAddress(projectAddr);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const coreA = a.replace(/^(\d+\/?[a-z]?\s)/, '$1').slice(0, 30);
  const coreB = b.replace(/^(\d+\/?[a-z]?\s)/, '$1').slice(0, 30);
  if (coreA.length > 10 && coreB.length > 10 && coreA === coreB) return true;
  return false;
}

// ─── Transform Domain API listing to our format ─────────────────────────────

export function transformDomainListing(raw: any): any {
  const prop = raw.propertyDetails || {};
  const media = raw.media || [];
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

// ─── Simulation Data ────────────────────────────────────────────────────────

export function getSimulatedListings(): any[] {
  return [
    {
      domain_listing_id: 'SIM-2017001',
      address: '501/8 Parramatta Rd, Strathfield NSW 2135',
      headline: 'Stunning Apartment in Prime Location',
      property_type: 'residential', status: 'for_sale',
      display_price: '$850,000 - $900,000', price: 875000,
      bedrooms: 2, bathrooms: 2, carspaces: 1, land_area_sqm: null,
      photo_count: 22, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-10T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017002',
      address: '6 Jones St, Concord NSW 2137',
      headline: 'Charming Family Home on Quiet Street',
      property_type: 'residential', status: 'for_sale',
      display_price: 'Auction Guide $2,200,000', price: 2200000,
      bedrooms: 4, bathrooms: 2, carspaces: 2, land_area_sqm: 550,
      photo_count: 28, has_floorplan: true, has_video: true, has_virtual_tour: true,
      media_urls: [], date_listed: '2026-04-08T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017003',
      address: '36 Keeler St, Carlingford NSW 2118',
      headline: 'Modern Living in Sought-After Suburb',
      property_type: 'residential', status: 'for_sale',
      display_price: '$1,450,000', price: 1450000,
      bedrooms: 3, bathrooms: 2, carspaces: 1, land_area_sqm: 420,
      photo_count: 18, has_floorplan: true, has_video: false, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-07T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017004',
      address: '9/94 Burwood Rd, Croydon Park NSW 2136',
      headline: 'Top Floor Unit with District Views',
      property_type: 'residential', status: 'for_sale',
      display_price: '$680,000', price: 680000,
      bedrooms: 2, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 24, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-03-22T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017005',
      address: '12/45 The Boulevarde, Strathfield NSW 2135',
      headline: 'Spacious Apartment Close to Station',
      property_type: 'residential', status: 'for_sale',
      display_price: '$720,000 - $780,000', price: 750000,
      bedrooms: 2, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 8, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-11T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017006',
      address: '3 Albert St, Burwood NSW 2134',
      headline: 'Opportunity Knocks in Blue-Chip Suburb',
      property_type: 'residential', status: 'for_sale',
      display_price: 'Contact Agent', price: null,
      bedrooms: 3, bathrooms: 1, carspaces: 1, land_area_sqm: 380,
      photo_count: 4, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-09T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017007',
      address: '22 Patterson St, Concord NSW 2137',
      headline: 'Beautifully Renovated Character Home',
      property_type: 'residential', status: 'sold',
      display_price: 'Sold $2,850,000', price: 2850000,
      bedrooms: 5, bathrooms: 3, carspaces: 2, land_area_sqm: 650,
      photo_count: 15, has_floorplan: true, has_video: false, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-03-15T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017008',
      address: '7/19 Homebush Rd, Strathfield NSW 2135',
      headline: 'Low-Maintenance Living in Prime Position',
      property_type: 'residential', status: 'for_sale',
      display_price: '$550,000', price: 550000,
      bedrooms: 1, bathrooms: 1, carspaces: 1, land_area_sqm: null,
      photo_count: 6, has_floorplan: false, has_video: false, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-05T00:00:00Z', source_portal: 'domain',
    },
    {
      domain_listing_id: 'SIM-2017009',
      address: '88 Liverpool Rd, Croydon Park NSW 2133',
      headline: 'Immaculate Family Home with Pool',
      property_type: 'residential', status: 'for_sale',
      display_price: '$1,800,000 - $1,950,000', price: 1875000,
      bedrooms: 4, bathrooms: 3, carspaces: 2, land_area_sqm: 580,
      photo_count: 12, has_floorplan: true, has_video: true, has_virtual_tour: false,
      media_urls: [], date_listed: '2026-04-02T00:00:00Z', source_portal: 'domain',
    },
  ];
}

// ─── Risk Level Computation ─────────────────────────────────────────────────

export function computeRiskLevel(engagementType: string | null, timesSeen: number): string {
  if (engagementType === 'exclusive') return 'critical';
  if (engagementType === 'non_exclusive' && timesSeen >= 3) return 'high';
  if (engagementType === 'non_exclusive') return 'medium';
  return 'medium';
}
