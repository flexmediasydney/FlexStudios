// One-shot diagnostic: call abotapi/realestate-au-lightning for a list of
// REA search URLs, return the dataset + stats side-by-side. Meant to evaluate
// whether this actor returns fields azzouzana doesn't (soldDate, dateListed,
// daysOnMarket, etc.). Delete after use — not a production code path.

import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR_SLUG = 'abotapi/realestate-au-lightning';

async function runActor(input: any, label: string) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN not set');
  const safeId = ACTOR_SLUG.replace('/', '~');
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=180&waitForFinish=180`;
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
    throw new Error(`Apify ${label} submit ${resp.status}: ${txt.substring(0, 300)}`);
  }
  const runData = await resp.json();
  let runId = runData?.data?.id;
  let status = runData?.data?.status;
  let datasetId = runData?.data?.defaultDatasetId;
  let stats = runData?.data?.stats;

  // Poll if still running (timeout param + waitForFinish usually returns done)
  let polls = 0;
  while ((status === 'RUNNING' || status === 'READY') && polls < 30) {
    await new Promise(r => setTimeout(r, 3000));
    const pollResp = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    const pd = await pollResp.json();
    status = pd?.data?.status;
    datasetId = pd?.data?.defaultDatasetId || datasetId;
    stats = pd?.data?.stats || stats;
    polls++;
  }

  if (status !== 'SUCCEEDED') {
    return { label, status, runId, stats, items: [], error: `status=${status}` };
  }

  const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=50`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  const items = itemsResp.ok ? await itemsResp.json() : [];
  return { label, status, runId, stats, items: Array.isArray(items) ? items : [], datasetId };
}

serveWithAudit('tmpTestReaLightning', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const admin = getAdminClient();
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401);

  try {
    const body = await req.json().catch(() => ({}));
    const suburb: string = body.suburb || 'Yagoona';
    const state: string = body.state || 'NSW';
    const postcode: string = body.postcode || '2199';

    const suburbSlug = suburb.toLowerCase().replace(/\s+/g, '-');
    const stateLower = state.toLowerCase();

    const urls = [
      { channel: 'buy',  url: `https://www.realestate.com.au/buy/in-${suburbSlug},+${stateLower}+${postcode}/list-1` },
      { channel: 'sold', url: `https://www.realestate.com.au/sold/in-${suburbSlug},+${stateLower}+${postcode}/list-1` },
      { channel: 'rent', url: `https://www.realestate.com.au/rent/in-${suburbSlug},+${stateLower}+${postcode}/list-1` },
    ];

    const results: any[] = [];
    for (const { channel, url } of urls) {
      const input = {
        startUrls: [url],
        maxItems: 20,
        flattenOutput: true,
        maxConcurrency: 10,
        proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      };
      const result = await runActor(input, `${suburb}-${channel}`);
      // Grab a field-shape summary: keys of first item + sample 1 item
      const firstItem = result.items[0] || null;
      const keysOfFirst = firstItem ? Object.keys(firstItem).sort() : [];
      results.push({
        channel,
        url,
        apify_run_id: result.runId,
        status: result.status,
        runtime_secs: result.stats?.runTimeSecs,
        items_returned: result.items.length,
        dataset_id: result.datasetId,
        error: result.error || null,
        first_item_keys: keysOfFirst,
        first_item_sample: firstItem,
        items_preview: result.items.slice(0, 3).map((it: any) => ({
          address: it.address || it.displayAddress || it.fullAddress,
          suburb: it.suburb,
          postcode: it.postcode,
          price: it.price || it.priceText || it.priceDisplay,
          soldPrice: it.soldPrice,
          soldDate: it.soldDate,
          dateListed: it.dateListed,
          daysOnMarket: it.daysOnMarket,
          listingType: it.listingType || it.channel,
          status: it.status,
          bond: it.bond,
          availableDate: it.availableDate,
          listingId: it.listingId || it.id,
        })),
      });
    }

    // Fetch azzouzana comparison data from our existing pulse_listings
    const { data: azzouzanaListings } = await admin
      .from('pulse_listings')
      .select('listing_type, address, asking_price, sold_price, listed_date, sold_date, days_on_market, source_listing_id, price_text, first_seen_at, last_synced_at')
      .ilike('suburb', suburb)
      .order('last_synced_at', { ascending: false })
      .limit(15);

    const azzouzanaSample = (azzouzanaListings || []).slice(0, 5);
    const azzouzanaFieldCoverage = {
      total_captured_for_suburb: azzouzanaListings?.length || 0,
      with_listed_date: (azzouzanaListings || []).filter((l: any) => l.listed_date).length,
      with_sold_date: (azzouzanaListings || []).filter((l: any) => l.sold_date).length,
      with_sold_price: (azzouzanaListings || []).filter((l: any) => l.sold_price).length,
      with_days_on_market: (azzouzanaListings || []).filter((l: any) => l.days_on_market).length,
    };

    return jsonResponse({
      actor: ACTOR_SLUG,
      suburb, state, postcode,
      lightning_results: results,
      azzouzana_comparison: {
        field_coverage: azzouzanaFieldCoverage,
        sample: azzouzanaSample,
      },
      total_apify_cost_estimate_usd: (
        results.length * 0.06867 +                               // per actor start
        results.reduce((s, r) => s + r.items_returned, 0) * 0.001 // per result
      ).toFixed(4),
    });
  } catch (err: any) {
    console.error('tmpTestReaLightning error:', err);
    return errorResponse(err?.message || 'test failed');
  }
});
