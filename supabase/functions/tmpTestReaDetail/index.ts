// One-shot diagnostic: run memo23/realestate-au-listings against 3 REA detail
// URLs (for_sale, sold, for_rent) to evaluate whether it returns the dates +
// rich fields we currently lack from azzouzana. Delete after use — not a
// production code path.

import { handleCors, jsonResponse, errorResponse, serveWithAudit, getUserFromReq } from '../_shared/supabase.ts';

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';

async function runActor(actorSlug: string, input: any, label: string, waitSecs = 110) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  const safeId = actorSlug.replace('/', '~');
  // Tighter waitForFinish so the edge function doesn't hit its 150s wall-clock cap.
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=${waitSecs}&waitForFinish=${waitSecs}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${APIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { label, error: `Apify ${label} submit ${resp.status}: ${txt.substring(0, 400)}`, items: [] };
  }
  const runData = await resp.json();
  const runId = runData?.data?.id;
  const status = runData?.data?.status;
  const datasetId = runData?.data?.defaultDatasetId;
  const stats = runData?.data?.stats;

  if (status !== 'SUCCEEDED') {
    return { label, status, runId, stats, items: [], error: `status=${status}`, datasetId };
  }

  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=20`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = itemsResp.ok ? await itemsResp.json() : [];
  return { label, status, runId, stats, items: Array.isArray(items) ? items : [], datasetId };
}

serveWithAudit('tmpTestReaDetail', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401);

  try {
    const testUrls = [
      { label: 'for_sale_auction', url: 'https://www.realestate.com.au/property-townhouse-nsw-alexandria-150821604' },
      { label: 'sold',             url: 'https://www.realestate.com.au/sold/property-apartment-nsw-neutral+bay-150553356' },
      { label: 'for_rent',         url: 'https://www.realestate.com.au/property-townhouse-nsw-st+marys-438806844' },
    ];

    // memo23 input — it accepts either list URLs or direct property URLs in `urls` array.
    // Some actors name the field `startUrls` instead; try both shapes.
    const memoInput = {
      startUrls: testUrls.map(t => t.url), // array of STRINGS, not objects
      maxItems: 10,
      flattenOutput: true,
    };

    const memoRes = await runActor('memo23/realestate-au-listings', memoInput, 'memo23', 95);

    // Also test abotapi — possibly richer sold-date data
    const abotapiInput = {
      urls: testUrls.map(t => t.url), // some actors accept `urls`
      startUrls: testUrls.map(t => ({ url: t.url })),
      maxItems: 10,
      useBuiltInFullUrls: true,
    };
    const abotapiRes = await runActor('abotapi/realestate-au-scraper', abotapiInput, 'abotapi', 30);

    // Recursively find every key/path that looks like a date/time field.
    function findDateFields(obj: any, path = '', out: Record<string, any> = {}, depth = 0): Record<string, any> {
      if (depth > 6 || obj == null) return out;
      if (Array.isArray(obj)) {
        obj.slice(0, 3).forEach((item, i) => findDateFields(item, `${path}[${i}]`, out, depth + 1));
        return out;
      }
      if (typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          const full = path ? `${path}.${k}` : k;
          if (/^(date|time|sold|listed|auction|available|modified|created|inspect|scraped|lastSeen|updated|published|agencyListingContract|withdrawn|offMarket)/i.test(k)
              || /Date$|Time$|At$/.test(k)) {
            if (typeof v === 'string' || typeof v === 'number' || v == null) {
              out[full] = v;
            } else {
              findDateFields(v, full, out, depth + 1);
            }
          } else if (typeof v === 'object') {
            findDateFields(v, full, out, depth + 1);
          }
        }
      }
      return out;
    }

    // Summarise each actor's output
    function summarise(res: any) {
      const items = res.items || [];
      const fieldUnion = new Set<string>();
      items.forEach((it: any) => Object.keys(it || {}).forEach(k => fieldUnion.add(k)));
      return {
        label: res.label,
        status: res.status,
        runId: res.runId,
        runtime_secs: res.stats?.runTimeSecs,
        compute_units: res.stats?.computeUnits,
        items_returned: items.length,
        error: res.error || null,
        field_union_sorted: Array.from(fieldUnion).sort(),
        // Per-item date scan — recursive, catches nested like listing.auctionTime, listing.inspectionsAndAuctions[].dateTime
        per_item_dates: items.map((it: any) => ({
          url: it.url || it.listingUrl,
          listingId: it.listingId,
          channel: it.channel,
          isSold: it.isSold, isBuy: it.isBuy, isRent: it.isRent,
          status: it.status, statusCode: it.statusCode,
          price: it.price,
          dates_found: findDateFields(it),
        })),
        // ALL items' listing subtrees (so we can see sold + rent, not just buy)
        all_items_listing: items.map((it: any) => ({
          channel: it.channel, listingId: it.listingId, status: it.status,
          listing_keys: it.listing ? Object.keys(it.listing).sort() : null,
          listing: it.listing || null,
          withIdsResponse: it.withIdsResponse || null,
        })),
      };
    }

    return jsonResponse({
      memo23: summarise(memoRes),
      abotapi: summarise(abotapiRes),
      test_urls: testUrls,
    });
  } catch (err: any) {
    console.error('tmpTestReaDetail error:', err);
    return errorResponse(err?.message || 'test failed');
  }
});
