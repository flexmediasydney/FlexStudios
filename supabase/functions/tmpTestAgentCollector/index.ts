// One-shot diagnostic: evaluate `websift/australian-realestate-agent-collector`
// as a replacement/supplement for `websift/realestateau`.
// Fires a single run against Strathfield (postcode 2135), summarises coverage
// of the fields we care about (email, mobile, social media, REA ID), and
// cross-references rmaAgentCode against our existing pulse_agents.
//
// Delete after evaluation — not a production code path.

import { handleCors, jsonResponse, errorResponse, serveWithAudit, getUserFromReq, getAdminClient } from '../_shared/supabase.ts';

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';

serveWithAudit('tmpTestAgentCollector', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401);

  if (!APIFY_TOKEN) return errorResponse('APIFY_TOKEN not set', 500);

  try {
    const { location = '2135', maxResults = 50, allowSurrounding = false } =
      await req.json().catch(() => ({}));

    const actorSlug = 'websift~australian-realestate-agent-collector';
    const input = {
      location,
      allowSurrounding,
      maxResults,
      requireEmailPhone: false,
      sortBy: 'sold',
    };

    // Fire + wait (120s cap — actor says fast, 1 page of results).
    const startedAt = Date.now();
    const url = `${APIFY_BASE}/acts/${actorSlug}/runs?timeout=120&waitForFinish=120`;
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
      return jsonResponse({
        ok: false,
        submit_status: resp.status,
        error: txt.substring(0, 800),
      });
    }

    const runData = await resp.json();
    const runId = runData?.data?.id;
    const runStatus = runData?.data?.status;
    const datasetId = runData?.data?.defaultDatasetId;
    const runStats = runData?.data?.stats ?? null;
    const usageUsd = runData?.data?.usageUsd ?? null;

    if (runStatus !== 'SUCCEEDED') {
      return jsonResponse({
        ok: false,
        runId,
        runStatus,
        runStats,
        usageUsd,
        error: `Apify run status=${runStatus}`,
      });
    }

    // Pull the dataset.
    const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=1000`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    const items: any[] = itemsResp.ok ? await itemsResp.json() : [];

    const total = items.length;
    const pct = (n: number) => total > 0 ? Math.round(100 * n / total) : 0;
    const count = (pred: (a: any) => boolean) => items.filter(pred).length;

    const coverage = {
      email_pct:       pct(count(a => !!a.email)),
      mobile_pct:      pct(count(a => !!a.mobileNumber)),
      phone_pct:       pct(count(a => !!a.phoneNumber)),
      facebook_pct:    pct(count(a => !!a.facebookUrl)),
      linkedin_pct:    pct(count(a => !!a.linkedInUrl)),
      twitter_pct:     pct(count(a => !!a.twitterUrl)),
      rma_code_pct:    pct(count(a => !!a.rmaAgentCode)),
      agency_id_pct:   pct(count(a => !!a.agency?.agencyId)),
      photo_pct:       pct(count(a => !!a.profileImage || !!a.photo || !!a.imageUrl)),
    };

    // Cross-reference rmaAgentCode against our pulse_agents.rea_agent_id.
    const rmaCodes = items.map(a => a.rmaAgentCode).filter(Boolean);
    const supa = getAdminClient();
    const { data: matched } = await supa
      .from('pulse_agents')
      .select('rea_agent_id, name, email, mobile, agency_name')
      .in('rea_agent_id', rmaCodes);
    const matchedCount = matched?.length ?? 0;

    // Samples so we can eyeball the schema.
    const samples = items.slice(0, 3).map((a: any) => ({
      fullName:                a.fullName,
      email:                   a.email,
      phoneNumber:             a.phoneNumber,
      mobileNumber:            a.mobileNumber,
      facebookUrl:             a.facebookUrl,
      linkedInUrl:             a.linkedInUrl,
      twitterUrl:              a.twitterUrl,
      rmaAgentCode:            a.rmaAgentCode,
      currentSaleListingCount: a.currentSaleListingCount,
      agency:                  a.agency,
      raw_keys:                Object.keys(a).sort(),
    }));

    return jsonResponse({
      ok: true,
      duration_ms: Date.now() - startedAt,
      runId,
      runStatus,
      usageUsd,
      runStats,
      input,
      total_rows: total,
      coverage,
      xref_pulse_agents: {
        rma_codes_returned: rmaCodes.length,
        matched_in_our_db: matchedCount,
        match_pct_of_returned: rmaCodes.length ? Math.round(100 * matchedCount / rmaCodes.length) : 0,
      },
      samples,
      all_keys_on_first_row: items[0] ? Object.keys(items[0]).sort() : [],
    });
  } catch (err) {
    return errorResponse(`Exception: ${(err as Error).message}`, 500);
  }
});
