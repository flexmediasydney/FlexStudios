// One-shot diagnostic: inspect websift/realestateau input schema drift.
// Modes:
//   "inspect" — fetch specific run meta + input + dataset metadata
//   "fire"    — fire a test run and measure coverage
//   "log"     — fetch the stderr/stdout log of a specific runId
//   "dataset" — fetch dataset item count + first rows for a runId
//   "full"    — inspect + fire (historical default)

import { handleCors, jsonResponse, errorResponse, serveWithAudit, getUserFromReq, getAdminClient } from '../_shared/supabase.ts';

const APIFY_TOKEN = Deno.env.get('APIFY_TOKEN') || '';
const APIFY_BASE = 'https://api.apify.com/v2';

async function apifyGet(path: string): Promise<any> {
  const resp = await fetch(`${APIFY_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { _error: `${resp.status} ${txt.substring(0, 400)}` };
  }
  return await resp.json();
}

async function fetchRunFull(runId: string): Promise<any> {
  const run = await apifyGet(`/actor-runs/${runId}`);
  if (run?._error) return { _error: run._error };
  const d = run?.data || {};

  let input: any = null;
  if (d.defaultKeyValueStoreId) {
    const r = await fetch(`${APIFY_BASE}/key-value-stores/${d.defaultKeyValueStoreId}/records/INPUT`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    if (r.ok) try { input = JSON.parse(await r.text()); } catch { input = null; }
  }

  let dsMeta: any = null;
  let dsItems: any[] = [];
  if (d.defaultDatasetId) {
    const dsM = await apifyGet(`/datasets/${d.defaultDatasetId}`);
    dsMeta = dsM?.data || dsM;
    const itemsResp = await fetch(`${APIFY_BASE}/datasets/${d.defaultDatasetId}/items?clean=1&limit=5`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    if (itemsResp.ok) dsItems = await itemsResp.json();
  }

  return {
    id: d.id,
    status: d.status,
    actId: d.actId,
    buildNumber: d.buildNumber,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    stats: d.stats,
    usageUsd: d.usageUsd,
    exitCode: d.exitCode,
    statusMessage: d.statusMessage,
    defaultDatasetId: d.defaultDatasetId,
    input,
    dsMeta,
    dsSampleCount: dsItems.length,
    dsFirstItemKeys: dsItems[0] ? Object.keys(dsItems[0]).sort() : [],
    dsSample: dsItems.slice(0, 1),
  };
}

async function fetchRunLog(runId: string): Promise<string> {
  const resp = await fetch(`${APIFY_BASE}/actor-runs/${runId}/log`, {
    headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
  });
  if (!resp.ok) return `err ${resp.status}: ${await resp.text().catch(()=>'')}`;
  return await resp.text();
}

async function fireActor(actorSlug: string, input: any, waitSecs = 150) {
  const safeId = actorSlug.replace('/', '~');
  const url = `${APIFY_BASE}/acts/${safeId}/runs?timeout=${waitSecs}&waitForFinish=${waitSecs}`;
  const startedAt = Date.now();
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
    return { input, submit_status: resp.status, error: txt.substring(0, 400) };
  }
  const runData = await resp.json();
  const d = runData?.data || {};
  const datasetId = d.defaultDatasetId;
  let items: any[] = [];
  let dsMeta: any = null;
  if (datasetId) {
    const dsM = await apifyGet(`/datasets/${datasetId}`);
    dsMeta = dsM?.data || dsM;
    const itemsResp = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=1&limit=1000`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` },
    });
    if (itemsResp.ok) items = await itemsResp.json();
  }
  return {
    input,
    runId: d.id,
    status: d.status,
    stats: d.stats,
    usageUsd: d.usageUsd,
    exitCode: d.exitCode,
    statusMessage: d.statusMessage,
    elapsed_ms: Date.now() - startedAt,
    defaultDatasetId: datasetId,
    dsMeta,
    dataset_count: items.length,
    first_3_rows: items.slice(0, 3),
    all_items: items,
  };
}

serveWithAudit('tmpTestWebsiftFixed', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Authentication required', 401);
  if (!APIFY_TOKEN) return errorResponse('APIFY_TOKEN not set', 500);

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body.mode || 'full';
    const runId = body.runId;
    const fireInput = body.input || null;

    if (mode === 'log' && runId) {
      const log = await fetchRunLog(runId);
      return jsonResponse({ runId, log_length: log.length, log });
    }
    if (mode === 'dataset' && runId) {
      const d = await fetchRunFull(runId);
      return jsonResponse(d);
    }
    if (mode === 'inspect') {
      const successRun = await fetchRunFull(body.successRunId || '1dOlRerDw54r3HL5V');
      const zeroRun = await fetchRunFull(body.zeroRunId || 'S75xEpTN1VhIwcmo5');
      return jsonResponse({ successRun, zeroRun });
    }
    if (mode === 'fire') {
      const input = fireInput || { location: 'Strathfield NSW', maxPages: 5, fullScrape: true };
      const r = await fireActor('websift/realestateau', input, 150);
      const allItems = (r as any).all_items || [];
      const t = allItems.length;
      const p = (n: number) => t > 0 ? Math.round(100 * n / t) : 0;
      const cnt = (pred: (a: any) => boolean) => allItems.filter(pred).length;
      const coverage = {
        email_pct:     p(cnt((a: any) => !!(a.email || a.emailAddress))),
        mobile_pct:    p(cnt((a: any) => !!(a.mobile || a.mobileNumber))),
        phone_pct:     p(cnt((a: any) => !!(a.phone || a.phoneNumber || a.business_phone))),
        facebook_pct:  p(cnt((a: any) => !!(a.facebook || a.facebookUrl))),
        instagram_pct: p(cnt((a: any) => !!(a.instagram || a.instagramUrl))),
        linkedin_pct:  p(cnt((a: any) => !!(a.linkedin || a.linkedInUrl))),
        photo_pct:     p(cnt((a: any) => !!(a.profileImage || a.photo || a.image))),
        sold_pct:      p(cnt((a: any) => !!(a.propertiesSold || a.sales_as_lead))),
        reaId_pct:     p(cnt((a: any) => !!(a.agentId || a.reaAgentId || a.salesperson_id || a.id))),
      };
      let matched = 0;
      const codes: string[] = [];
      for (const a of allItems) {
        const c = a?.agentId || a?.reaAgentId || a?.salesperson_id || a?.id;
        if (c) codes.push(String(c));
      }
      if (codes.length) {
        const supa = getAdminClient();
        const { data: m } = await supa.from('pulse_agents').select('rea_agent_id').in('rea_agent_id', codes);
        matched = m?.length ?? 0;
      }
      let log: string | null = null;
      if (t === 0 && r.runId) log = await fetchRunLog(r.runId);
      return jsonResponse({
        input: r.input,
        runId: r.runId,
        status: r.status,
        stats: r.stats,
        usageUsd: r.usageUsd,
        defaultDatasetId: r.defaultDatasetId,
        dsMeta_itemCount: r.dsMeta?.itemCount,
        dsMeta_cleanItemCount: r.dsMeta?.cleanItemCount,
        dsMeta_createdAt: r.dsMeta?.createdAt,
        dataset_total: t,
        coverage,
        xref: {
          codes_returned: codes.length,
          matched_in_our_db: matched,
          match_pct: codes.length ? Math.round(100 * matched / codes.length) : 0,
        },
        sample_first_3: allItems.slice(0, 3),
        all_keys: allItems[0] ? Object.keys(allItems[0]).sort() : [],
        log_tail: log ? log.substring(Math.max(0, log.length - 3000)) : null,
      });
    }
    return jsonResponse({ error: 'unknown mode' });
  } catch (err) {
    return errorResponse(`Exception: ${(err as Error).message}`, 500);
  }
});
