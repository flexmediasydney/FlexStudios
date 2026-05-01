/**
 * visionFanout.test.ts — W15b.6 unit tests for the post-enrich fan-out.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/pulseDetailEnrich/visionFanout.test.ts
 *
 * Coverage (per W15b.6 spec):
 *   1. Daily cap exceeded         → no extract calls fired (skipped_reason='daily_cap_reached')
 *   2. Queue paused                → no extract calls fired (skipped_reason='queue_paused')
 *   3. Fresh extract (<14 days)    → no extract calls fired (skipped_reason='fresh_extract_exists')
 *   4. Stale extract (>14 days)    → both photo + video extract fired
 *   5. No video URL                → only photo extract fired
 *   6. Modal URL not configured    → photo fires; video skipped with warning
 *
 * Plus:
 *   7. Concurrency cap (slices of 4)  → in-flight invocations never exceed 4
 *
 * Strategy:
 *   We exercise the helper directly with a fake Supabase client (records
 *   queries and replies with caller-configured fixtures) and a fake fetch
 *   (records HTTP calls). The actual edge-fn invoke shape is `fetch
 *   ${SUPABASE_URL}/functions/v1/${name}` with a JSON body — that's the
 *   contract we assert.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  fireVisionExtractsBatch,
  fireVisionExtractsForListing,
  resolveEffectiveCap,
  VISION_FANOUT_CONCURRENCY,
  type ListingForFanout,
  type PulseVisionSettings,
} from '../_shared/pulseVisionFanout.ts';

// ─── Test plumbing ─────────────────────────────────────────────────────────

interface QueryRecord {
  table: string;
  op: string; // 'select' | 'insert' | 'eq' | 'gte' | etc.
  args?: unknown;
}

interface FakeQueryBuilder {
  select(_cols: string): FakeQueryBuilder;
  eq(_col: string, _val: unknown): FakeQueryBuilder;
  gte(_col: string, _val: unknown): FakeQueryBuilder;
  limit(_n: number): FakeQueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then(resolve: (v: { data: unknown; error: null }) => unknown): Promise<unknown>;
}

interface FakeRow {
  total_cost_usd?: number;
  id?: string;
  value?: PulseVisionSettings;
}

/**
 * Build a chained fake query builder. Each step accumulates state in the
 * `pending` object; the final await/then resolves to whatever the caller
 * pre-registered for the (table, intent) tuple.
 */
function makeFakeAdmin(opts: {
  visionSettings: PulseVisionSettings;
  todaysSpendUsd: number;
  freshExtractListingIds?: Set<string>;  // listings that have a fresh succeeded extract
  log?: QueryRecord[];
}) {
  const log = opts.log || [];
  const freshIds = opts.freshExtractListingIds || new Set<string>();

  return {
    from(table: string) {
      log.push({ table, op: 'from' });
      const state: { table: string; eqs: Record<string, unknown>; gtes: Record<string, unknown>; limit?: number } = {
        table, eqs: {}, gtes: {},
      };

      const builder: any = {
        select(_cols: string) {
          log.push({ table, op: 'select', args: _cols });
          return builder;
        },
        eq(col: string, val: unknown) {
          state.eqs[col] = val;
          return builder;
        },
        gte(col: string, val: unknown) {
          state.gtes[col] = val;
          return builder;
        },
        limit(n: number) {
          state.limit = n;
          return builder;
        },
        async maybeSingle() {
          if (table === 'engine_settings' && state.eqs.key === 'pulse_vision') {
            return { data: { value: opts.visionSettings }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: any) {
          // Resolves the built query when the caller awaits the chain.
          if (table === 'pulse_listing_vision_extracts') {
            // Two query shapes:
            //   1. .select('total_cost_usd').gte('created_at', ...)   → rows for spend tally
            //   2. .select('id').eq('listing_id',x).eq('status',y).gte('created_at',z).limit(1) → freshness check
            const isSpendTally = state.gtes['created_at'] !== undefined && state.eqs['listing_id'] === undefined;
            if (isSpendTally) {
              const rows: FakeRow[] = [{ total_cost_usd: opts.todaysSpendUsd }];
              return Promise.resolve(resolve({ data: rows, error: null }));
            }
            const isFreshnessCheck = state.eqs['status'] === 'succeeded' && typeof state.eqs['listing_id'] === 'string';
            if (isFreshnessCheck) {
              const lid = state.eqs['listing_id'] as string;
              const rows: FakeRow[] = freshIds.has(lid) ? [{ id: 'fresh-row' }] : [];
              return Promise.resolve(resolve({ data: rows, error: null }));
            }
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return builder;
    },
  };
}

interface CapturedFetch {
  url: string;
  method: string;
  body: any;
}

function makeFakeFetch(captured: CapturedFetch[], opts: { failUrls?: string[] } = {}) {
  return async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    captured.push({ url: u, method: init?.method || 'GET', body });
    if (opts.failUrls?.some(f => u.includes(f))) {
      return new Response(JSON.stringify({ error: 'forced fail' }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

const ENV = {
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-role-key',
  // Modal URL set/unset per test
  MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL: 'https://modal.example/extract',
};

const NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01 12:00 UTC
const NOW_FN = () => NOW_MS;

// ─── Tests ─────────────────────────────────────────────────────────────────

Deno.test('W15b.6 — daily cap exceeded → no extract calls fired', async () => {
  const queryLog: QueryRecord[] = [];
  const fetched: CapturedFetch[] = [];
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 35.0, // exceeds cap
    log: queryLog,
  });
  const listings: ListingForFanout[] = [
    { id: 'L1', photo_urls: ['https://img.example/1.jpg'], video_url: null },
    { id: 'L2', photo_urls: ['https://img.example/2.jpg'], video_url: null },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions.length, 2);
  for (const d of decisions) {
    assertEquals(d.fired, false);
    assertEquals(d.skipped_reason, 'daily_cap_reached');
  }
  // No HTTP calls should have been made
  assertEquals(fetched.length, 0);
});

Deno.test('W15b.6 — queue_paused → no extract calls fired', async () => {
  const fetched: CapturedFetch[] = [];
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: true, daily_cap_usd: 30 },
    todaysSpendUsd: 0,
  });
  const listings: ListingForFanout[] = [
    { id: 'L1', photo_urls: ['https://img.example/1.jpg'], video_url: null },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].fired, false);
  assertEquals(decisions[0].skipped_reason, 'queue_paused');
  assertEquals(fetched.length, 0);
});

Deno.test('W15b.6 — fresh extract (<14 days) → no extract calls fired', async () => {
  const fetched: CapturedFetch[] = [];
  const fresh = new Set<string>(['L_FRESH']);
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 5.0,
    freshExtractListingIds: fresh,
  });
  const listings: ListingForFanout[] = [
    { id: 'L_FRESH', photo_urls: ['https://img.example/1.jpg'], video_url: null },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions[0].fired, false);
  assertEquals(decisions[0].skipped_reason, 'fresh_extract_exists');
  assertEquals(fetched.length, 0);
});

Deno.test('W15b.6 — stale extract (>14 days) → both photo + video extract fired', async () => {
  const fetched: CapturedFetch[] = [];
  // No fresh ids: every freshness check returns empty rows → "stale"
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 5.0,
  });
  const listings: ListingForFanout[] = [
    {
      id: 'L_STALE',
      photo_urls: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
      video_url: 'https://video.example/clip.mp4',
    },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions.length, 1);
  assertEquals(decisions[0].fired, true);
  assertEquals(decisions[0].skipped_reason, null);
  // Both photo + video extractor invoked
  const fnNames = fetched.map(f => f.url.split('/functions/v1/')[1]);
  assert(fnNames.includes('pulse-listing-vision-extract'));
  assert(fnNames.includes('pulse-video-frame-extractor'));
  // Photo extract body carries listing_id + triggered_by
  const photoCall = fetched.find(f => f.url.endsWith('pulse-listing-vision-extract'))!;
  assertEquals(photoCall.body.listing_id, 'L_STALE');
  assertEquals(photoCall.body.triggered_by, 'pulse_detail_enrich');
  // Video extract carries video_url
  const videoCall = fetched.find(f => f.url.endsWith('pulse-video-frame-extractor'))!;
  assertEquals(videoCall.body.video_url, 'https://video.example/clip.mp4');
});

Deno.test('W15b.6 — no video URL → only photo extract fired', async () => {
  const fetched: CapturedFetch[] = [];
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 5.0,
  });
  const listings: ListingForFanout[] = [
    { id: 'L_PHOTO_ONLY', photo_urls: ['https://img.example/1.jpg'], video_url: null },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions[0].fired, true);
  // Exactly one HTTP invocation, to the photo extractor
  assertEquals(fetched.length, 1);
  assert(fetched[0].url.endsWith('pulse-listing-vision-extract'));
});

Deno.test('W15b.6 — Modal URL not configured → photo fires, video skipped with warn', async () => {
  const fetched: CapturedFetch[] = [];
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 5.0,
  });
  // ENV without MODAL URL
  const envNoModal = { ...ENV, MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL: '' };
  const listings: ListingForFanout[] = [
    {
      id: 'L_VIDEO_NO_MODAL',
      photo_urls: ['https://img.example/1.jpg'],
      video_url: 'https://video.example/clip.mp4',
    },
  ];
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: makeFakeFetch(fetched),
    now: NOW_FN,
    env: envNoModal,
  });
  // Photo extract fired ok
  assertEquals(decisions[0].fired, true);
  assertEquals(fetched.length, 1);
  assertEquals(fetched[0].url.endsWith('pulse-listing-vision-extract'), true);
  // The decision should also surface the video skip in invocations
  const videoEntry = decisions[0].invocations.find(i => i.fn === 'pulse-video-frame-extractor');
  assert(videoEntry, 'video invocation entry should be present');
  assertEquals(videoEntry!.ok, false);
  assert(String(videoEntry!.error).includes('not configured'));
});

Deno.test('W15b.6 — concurrency cap: in-flight HTTP never exceeds VISION_FANOUT_CONCURRENCY', async () => {
  const fetched: CapturedFetch[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const slowFetch = async (url: string | URL, init?: RequestInit) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    fetched.push({ url: String(url), method: init?.method || 'POST', body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 0.0,
  });
  // 12 listings — each fires 1 HTTP (no video). With concurrency=4 we expect
  // ≤4 in-flight at any time.
  const listings: ListingForFanout[] = Array.from({ length: 12 }, (_, i) => ({
    id: `L${i}`,
    photo_urls: [`https://img.example/${i}.jpg`],
    video_url: null,
  }));
  const decisions = await fireVisionExtractsBatch(admin as any, listings, {
    fetchFn: slowFetch as any,
    now: NOW_FN,
    env: ENV,
  });
  assertEquals(decisions.length, 12);
  assertEquals(fetched.length, 12);
  assert(maxInFlight <= VISION_FANOUT_CONCURRENCY, `maxInFlight=${maxInFlight} expected ≤ ${VISION_FANOUT_CONCURRENCY}`);
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

Deno.test('W15b.6 — resolveEffectiveCap: override wins on matching date', () => {
  const today = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
  const todayKey = today.toISOString().slice(0, 10);
  const settings: PulseVisionSettings = {
    daily_cap_usd: 30,
    daily_cap_override_usd: 100,
    daily_cap_override_date: todayKey,
  };
  assertEquals(resolveEffectiveCap(settings, today), 100);
});

Deno.test('W15b.6 — resolveEffectiveCap: stale override falls back to standing cap', () => {
  const today = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
  const settings: PulseVisionSettings = {
    daily_cap_usd: 30,
    daily_cap_override_usd: 100,
    daily_cap_override_date: '2025-01-01', // not today
  };
  assertEquals(resolveEffectiveCap(settings, today), 30);
});

Deno.test('W15b.6 — resolveEffectiveCap: no override → standing cap', () => {
  const today = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
  const settings: PulseVisionSettings = { daily_cap_usd: 30 };
  assertEquals(resolveEffectiveCap(settings, today), 30);
});

Deno.test('W15b.6 — fireVisionExtractsForListing: empty photos → skipped_reason=no_photos', async () => {
  const fetched: CapturedFetch[] = [];
  const admin = makeFakeAdmin({
    visionSettings: { queue_paused: false, daily_cap_usd: 30 },
    todaysSpendUsd: 0.0,
  });
  const decision = await fireVisionExtractsForListing(
    admin as any,
    { id: 'L_NOPHOTOS', photo_urls: [], video_url: null },
    {
      settings: { queue_paused: false, daily_cap_usd: 30 },
      todays_spend_usd: 0,
      effective_cap_usd: 30,
      now: new Date(NOW_MS),
    },
    { fetchFn: makeFakeFetch(fetched), env: ENV, now: NOW_FN },
  );
  assertEquals(decision.fired, false);
  assertEquals(decision.skipped_reason, 'no_photos');
  assertEquals(fetched.length, 0);
});
