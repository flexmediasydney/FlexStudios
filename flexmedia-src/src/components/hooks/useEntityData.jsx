/**
 * useEntityData.jsx — v5.0 (Supabase-compatible)
 *
 * Architecture: shared cache + subscription fan-out
 *
 * Module-level (shared across ALL component instances):
 *   entityCache      Map<entityName, rawItem[]>        raw API data, never decorated
 *   singleCache      Map<"Entity:id", rawItem>         raw single-entity data
 *   cacheTimestamps  Map<string, number>               for TTL checks
 *   inFlight         Map<string, Promise>              dedup concurrent fetches
 *   listListeners    Map<entityName, Set<refreshFn>>   fan-out on list change
 *   singleListeners  Map<"Entity:id", Set<refreshFn>>  fan-out on single change
 *   subscriptions    Map<entityName, unsubscribeFn>    one Supabase Realtime sub per entity
 *
 * Per-component:
 *   local state, registers a refresh listener, cleans up on unmount
 *
 * Result:
 *   - N components loading same entity → 1 HTTP request total
 *   - navigate away and back → instant cache hit, no HTTP request
 *   - real-time event → all mounted components update simultaneously
 *   - component unmount → cleanly removed from listener set, nothing breaks
 *
 * Supabase notes:
 *   - RLS denial returns empty array (not an error); we log a dev warning
 *   - The shim's mapRow already aliases created_at → created_date etc.
 *   - Retry logic lives in the throttler; hook only retries on transient failures
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/api/supabaseClient';
import { globalThrottler } from '@/components/utils/requestThrottler';
import { decorateEntity, decorateEntities } from '@/components/utils/entityTransformer';

// ─── Shared module-level state ────────────────────────────────────────────────

const entityCache     = new Map(); // entityName → rawItem[]
const singleCache     = new Map(); // "Entity:id" → rawItem | null
const cacheTimestamps = new Map(); // key → timestamp (ms)
const inFlight        = new Map(); // key → Promise<void>
const listListeners   = new Map(); // entityName → Set<fn>
const singleListeners = new Map(); // "Entity:id" → Set<fn>
const subscriptions   = new Map(); // entityName → unsubscribeFn

const CACHE_TTL  = 5 * 60 * 1000; // 5 minutes
// Default list cap bumped 1000 → 10000 (2026-04-19). The old 1000 default was
// silently capping consumers like `useEntityList("Agency")` that pass no
// explicit limit. 10000 is generous enough to cover every medium table we have
// today (agencies/agents/users/teams/sources etc.) without blowing memory.
// Large tables that regularly exceed 10k get explicit ENTITY_LIST_LIMITS
// entries below. Consumers should still pass an explicit limit when they know
// the shape — the dev-mode warn-on-exact-cap below flags any hook that hits
// the default exactly (strong truncation signal).
const LIST_LIMIT = 10000;
// Large tables need higher fetch limits so per-page client-side slices don't silently drop rows.
//
// Pulse intelligence data can grow into the tens of thousands once the cron
// starts covering all of NSW/VIC/QLD. The tabs that display these
// (PulseListings, PulseAgentIntel, PulseAgencyIntel) use server-side pagination
// (range + count:exact) so the TABLE itself doesn't rely on this cap. The cap
// here only governs the shared cache that the parent Pulse page + cross-tab
// slideouts + stat cards consume. PulseTimeline bumped 10k → 50k (2026-04-19)
// because prod already has ~19k rows and the lower cap was silently dropping
// ~9k events from every stat card / cross-tab slideout that reads this cache.
// Memory still reasonable: 50k × ~1KB per timeline row = ~50MB worst case.
// Once we cross ~100k and stat cards become the bottleneck, the parent page
// should migrate to `count:exact, head:true` aggregate queries instead of
// pulling the full list into memory.
const ENTITY_LIST_LIMITS = {
  PulseListing: 25000,
  PulseAgent: 25000,
  PulseAgency: 10000,
  PulseTimeline: 50000,
  // ProjectTask can grow fast: ~17 tasks per project × hundreds of projects + revisions
  ProjectTask: 5000,
  // TaskTimeLog grows ~1 row per Timer start/stop, plus auto-onsite logs from
  // logOnsiteEffortOnUpload. Bumped 5000 → 15000 (2026-05-05) because busy
  // accounts crossed 5k and were silently truncating older logs out of the
  // shared cache, which made the kanban "actual / estimated" effort badge
  // show "0m / 5h" on projects that had real Timer history.
  TaskTimeLog: 15000,
  // EmailMessage rows include full HTML bodies (often 10-50KB each). The 10000
  // default was paginating through the whole table on every page load via
  // Layout.jsx + GlobalSearch.jsx and tipped Postgres into statement_timeout
  // (root-cause of the 2026-04-28 outage). Both consumers slice to 500
  // client-side anyway.
  EmailMessage: 500,
};
const CACHE_PRUNE_INTERVAL = 10 * 60 * 1000; // prune every 10 minutes
const MAX_SINGLE_CACHE_SIZE = 2000; // BUG FIX: cap singleCache to prevent unbounded memory growth

// BUG FIX: Periodically prune expired entries from singleCache and cacheTimestamps
// to prevent memory leaks from entities that are fetched once and never accessed again.
let _pruneTimer = null;
function ensurePruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(() => {
    const now = Date.now();
    let pruned = 0;
    for (const [key, ts] of cacheTimestamps) {
      // Only prune single-entity entries (contain ':'), not list caches
      if (key.includes(':') && (now - ts) > CACHE_TTL * 2) {
        singleCache.delete(key);
        cacheTimestamps.delete(key);
        singleListeners.delete(key);
        pruned++;
      }
    }
    // Hard cap: if singleCache is still too large, evict oldest entries
    if (singleCache.size > MAX_SINGLE_CACHE_SIZE) {
      const entries = [...cacheTimestamps.entries()]
        .filter(([k]) => k.includes(':'))
        .sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, singleCache.size - MAX_SINGLE_CACHE_SIZE);
      for (const [key] of toRemove) {
        singleCache.delete(key);
        cacheTimestamps.delete(key);
        singleListeners.delete(key);
        pruned++;
      }
    }
    // pruned count intentionally not logged
  }, CACHE_PRUNE_INTERVAL);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isCacheFresh(key) {
  const ts = cacheTimestamps.get(key);
  return ts != null && (Date.now() - ts) < CACHE_TTL;
}

/**
 * Identify transient errors worth retrying at the hook level.
 * Rate-limit errors are NOT included because the globalThrottler already
 * retries those internally.
 */
function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||    // browser offline / DNS failure
    msg.includes('network')         ||    // generic network error
    msg.includes('timeout')         ||    // request timeout
    msg.includes('load failed')     ||    // Safari-specific fetch failure
    msg.includes('aborted')               // AbortController
  );
}

function notifyListListeners(entityName) {
  listListeners.get(entityName)?.forEach(fn => {
    try { fn(); } catch (_) { /* don't let one bad listener break others */ }
  });
}

function notifySingleListeners(entityName, entityId) {
  singleListeners.get(`${entityName}:${entityId}`)?.forEach(fn => {
    try { fn(); } catch (_) { /* same */ }
  });
}

function registerListListener(entityName, fn) {
  if (!listListeners.has(entityName)) listListeners.set(entityName, new Set());
  listListeners.get(entityName).add(fn);
}

function removeListListener(entityName, fn) {
  listListeners.get(entityName)?.delete(fn);
}

function registerSingleListener(entityName, entityId, fn) {
  const key = `${entityName}:${entityId}`;
  if (!singleListeners.has(key)) singleListeners.set(key, new Set());
  singleListeners.get(key).add(fn);
}

function removeSingleListener(entityName, entityId, fn) {
  singleListeners.get(`${entityName}:${entityId}`)?.delete(fn);
}

/**
 * Ensure exactly one Supabase Realtime subscription per entity type.
 * All events → update shared caches → fan-out to all listener sets.
 *
 * The shim's subscribe() already normalises Supabase Realtime payloads to
 * { id, type: 'create'|'update'|'delete', data } so the hook is format-agnostic.
 */
function ensureSubscription(entityName) {
  if (subscriptions.has(entityName)) return;
  ensurePruneTimer(); // BUG FIX: start cache pruning when first subscription is created

  let debounceTimer = null;
  const pendingEvents = [];

  const flush = () => {
    debounceTimer = null;
    const events = pendingEvents.splice(0);
    if (events.length === 0) return;

    let listDirty = false;
    const singlesDirty = new Set();

    for (const event of events) {
      if (!event || event.id == null) continue;

      const { id, type, data } = event;
      const singleKey = `${entityName}:${id}`;

      // ── Update single cache ──
      if (type === 'delete') {
        singleCache.set(singleKey, null);  // null = "known to not exist"
        cacheTimestamps.set(singleKey, Date.now());
      } else if (data) {
        singleCache.set(singleKey, data);
        cacheTimestamps.set(singleKey, Date.now());
      }
      singlesDirty.add(id);

      // ── Update list cache (only if we already have one) ──
      const list = entityCache.get(entityName);
      if (list != null) {
        listDirty = true;
        if (type === 'create') {
          if (!list.some(item => item.id === id) && data) {
            entityCache.set(entityName, [...list, data]);
          }
        } else if (type === 'update' && data) {
          const idx = list.findIndex(item => item.id === id);
          if (idx !== -1) {
            const next = list.slice();
            next[idx] = data;
            entityCache.set(entityName, next);
          } else {
            // Not in list yet — add it (filter may now match)
            entityCache.set(entityName, [...list, data]);
          }
        } else if (type === 'delete') {
          entityCache.set(entityName, list.filter(item => item.id !== id));
        }
        // Extend TTL — subscription-driven updates keep cache fresh
        cacheTimestamps.set(entityName, Date.now());
      }
    }

    // Notify AFTER all events applied (single batch setState per component)
    if (listDirty) notifyListListeners(entityName);
    singlesDirty.forEach(id => notifySingleListeners(entityName, id));
  };

  try {
    const unsubscribe = api.entities[entityName].subscribe((event) => {
      if (!event) return;
      pendingEvents.push(event);
      if (!debounceTimer) debounceTimer = setTimeout(flush, 30);
    });

    // BUG FIX: wrap unsubscribe to also clear pending debounce timer.
    // Without this, clearEntityCache() unsubscribes the channel but the
    // pending setTimeout still fires, writing stale data into a cleared cache.
    subscriptions.set(entityName, () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      pendingEvents.length = 0;
      unsubscribe();
    });
  } catch (err) {
    // Supabase Realtime may fail to connect (network issues, missing table, etc.)
    // This is non-fatal: the hook still works via polling/manual refetch.
    console.warn(`[useEntityData] Realtime subscription failed for ${entityName}:`, err?.message);
  }
}

/**
 * Tear down and re-create a subscription (e.g. after a reconnect).
 */
function resubscribe(entityName) {
  const unsub = subscriptions.get(entityName);
  if (unsub) {
    try { unsub(); } catch (_) { /* ignore */ }
    subscriptions.delete(entityName);
  }
  ensureSubscription(entityName);
}

/**
 * Fetch entity list with in-flight dedup.
 * Returns a Promise<void> that resolves when the cache is populated.
 * All concurrent callers for the same entity share the same Promise.
 *
 * Supabase notes:
 *   - RLS denial returns an empty array, not an error. We log a dev-mode
 *     warning so misconfigured policies surface during development.
 *   - The globalThrottler already handles rate-limit retries, so we do NOT
 *     add retry logic here (avoids compounding retries).
 */
function fetchEntityList(entityName) {
  // Fresh cache → no fetch needed
  if (entityCache.has(entityName) && isCacheFresh(entityName)) {
    return Promise.resolve();
  }

  // In-flight dedup
  if (inFlight.has(entityName)) {
    return inFlight.get(entityName);
  }

  const appliedLimit = ENTITY_LIST_LIMITS[entityName] || LIST_LIMIT;
  const promise = globalThrottler
    .execute(() => api.entities[entityName].list(null, appliedLimit))
    .then(items => {
      inFlight.delete(entityName);
      const raw = items || [];

      // Dev-mode RLS warning: if we expected data but got nothing, it may be an
      // RLS policy misconfiguration (Supabase returns [] instead of an error).
      // Dev note: if raw.length === 0 unexpectedly, check RLS policies

      // Dev-mode truncation signal: when the list returned exactly equals the
      // applied limit, we're very likely silently dropping rows. Surfacing
      // this in the console lets us audit for under-provisioned caps across
      // the app without waiting for a user report.
      if (
        raw.length === appliedLimit &&
        typeof import.meta !== 'undefined' &&
        import.meta?.env?.DEV
      ) {
        console.warn(
          `[useEntityData] ${entityName} returned exactly ${appliedLimit} rows — ` +
          `cache likely truncated. Bump ENTITY_LIST_LIMITS.${entityName} or use server-side pagination.`
        );
      }

      entityCache.set(entityName, raw);
      const now = Date.now();
      cacheTimestamps.set(entityName, now);
      // Bonus: populate single caches (useEntityData gets free hits)
      raw.forEach(item => {
        if (item.id) {
          singleCache.set(`${entityName}:${item.id}`, item);
          cacheTimestamps.set(`${entityName}:${item.id}`, now);
          // Notify single-entity listeners so detail pages see the update
          notifySingleListeners(entityName, item.id);
        }
      });
      notifyListListeners(entityName);
    })
    .catch(err => {
      inFlight.delete(entityName);
      throw err;
    });

  inFlight.set(entityName, promise);
  return promise;
}

/**
 * Fetch a single entity by ID with in-flight dedup.
 * Checks list cache first before making a network call.
 */
function fetchSingleEntity(entityName, entityId) {
  const singleKey = `${entityName}:${entityId}`;

  // Single cache hit
  if (singleCache.has(singleKey) && isCacheFresh(singleKey)) {
    return Promise.resolve();
  }

  // Extract from list cache if available
  if (entityCache.has(entityName) && isCacheFresh(entityName)) {
    const found = (entityCache.get(entityName) || []).find(i => i.id === entityId);
    if (found) {
      singleCache.set(singleKey, found);
      cacheTimestamps.set(singleKey, Date.now());
      return Promise.resolve();
    }
  }

  // In-flight dedup for single fetches
  if (inFlight.has(singleKey)) {
    return inFlight.get(singleKey);
  }

  const promise = globalThrottler
    .execute(() => api.entities[entityName].get(entityId))
    .then(item => {
      inFlight.delete(singleKey);
      singleCache.set(singleKey, item ?? null);
      cacheTimestamps.set(singleKey, Date.now());
      notifySingleListeners(entityName, entityId);
    })
    .catch(err => {
      inFlight.delete(singleKey);
      throw err;
    });

  inFlight.set(singleKey, promise);
  return promise;
}

// ─── Client-side data transformations ────────────────────────────────────────

function applyFilter(items, filter) {
  if (!filter) return items;
  if (typeof filter === 'function') return items.filter(filter);
  if (typeof filter === 'object') {
    const entries = Object.entries(filter);
    if (entries.length === 0) return items;
    return items.filter(item =>
      entries.every(([key, value]) =>
        Array.isArray(value) ? value.includes(item[key]) : item[key] === value
      )
    );
  }
  return items;
}

function applySort(items, sortBy) {
  if (!sortBy || items.length === 0) return items;
  if (typeof sortBy !== 'string') return items;
  const isDesc = sortBy.startsWith('-');
  const field  = isDesc ? sortBy.slice(1) : sortBy;
  return [...items].sort((a, b) => {
    const av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return isDesc ? -cmp : cmp;
  });
}

function applyLimit(items, limit) {
  return (limit && items.length > limit) ? items.slice(0, limit) : items;
}

// ─── Public cache management ──────────────────────────────────────────────────

/**
 * Tear down and re-create the Realtime subscription for an entity.
 * Call this after auth state changes (login/logout) or connection drops.
 */
export { resubscribe as resubscribeEntity };

/**
 * Pre-warm the entity list cache. Useful for route prefetching —
 * if the cache is already fresh, this is a no-op.
 */
export { fetchEntityList as prefetchEntityList };

/**
 * Pre-warm the single-entity cache. Useful for route prefetching —
 * resolves from list cache when possible, otherwise fetches from API.
 */
export { fetchSingleEntity as prefetchSingleEntity };

/** Force-expire the list cache for an entity (triggers refetch on next access). */
export function invalidateEntityCache(entityName) {
  entityCache.delete(entityName);
  cacheTimestamps.delete(entityName);
  inFlight.delete(entityName);
}

/**
 * Force-invalidate and refetch an entity list from the API.
 * Unlike invalidateEntityCache (which only deletes the cache),
 * this function also triggers a fresh fetch and notifies all
 * listening components when the data arrives.
 */
export async function refetchEntityList(entityName) {
  invalidateEntityCache(entityName);
  try {
    await fetchEntityList(entityName);
  } catch (err) {
    console.warn(`refetchEntityList(${entityName}) failed:`, err?.message);
  }
}

/**
 * Optimistically update a single entity in BOTH the single-entity cache
 * AND the list cache, then notify all listeners. Use this after an API
 * update call to make the UI react instantly without waiting for a
 * full list refetch or Realtime event.
 *
 * @param {string} entityName - e.g. 'Agent', 'Team', 'Agency'
 * @param {string} entityId - UUID of the entity
 * @param {object} updates - partial field updates to merge
 */
export function updateEntityInCache(entityName, entityId, updates) {
  if (!entityName || !entityId || !updates) return;

  // Update single-entity cache
  const singleKey = `${entityName}:${entityId}`;
  const existing = singleCache.get(singleKey);
  if (existing) {
    const merged = { ...existing, ...updates };
    singleCache.set(singleKey, merged);
    cacheTimestamps.set(singleKey, Date.now());
    notifySingleListeners(entityName, entityId);
  }

  // Update list cache entry
  const listData = entityCache.get(entityName);
  if (Array.isArray(listData)) {
    const idx = listData.findIndex(item => item.id === entityId);
    if (idx !== -1) {
      listData[idx] = { ...listData[idx], ...updates };
      entityCache.set(entityName, [...listData]); // new array ref to trigger re-renders
      notifyListListeners(entityName);
    }
  }
}

/**
 * Clear ALL caches and subscriptions. Must be called on logout.
 * Also resets the request throttler to clear any backoff state.
 */
export function clearEntityCache() {
  entityCache.clear();
  singleCache.clear();
  cacheTimestamps.clear();
  inFlight.clear();
  listListeners.clear();
  singleListeners.clear();
  subscriptions.forEach(unsub => {
    try { unsub(); } catch (_) { /* ignore */ }
  });
  subscriptions.clear();
  // BUG FIX: clear cache prune timer on logout
  if (_pruneTimer) { clearInterval(_pruneTimer); _pruneTimer = null; }
  // Reset throttler backoff state so the next session starts clean
  globalThrottler.reset();
}

// ─── useEntityList ─────────────────────────────────────────────────────────────

/**
 * Load a list of entities with shared caching, request dedup, and real-time updates.
 *
 * @param {string}          entityName  Base44 entity name
 * @param {string}          [sortBy]    Field name; prefix '-' for descending
 * @param {number}          [limit]     Max items returned (client-side slice of 1000-item cache)
 * @param {object|function} [filter]    Object for equality match; function for predicate
 * @returns {{ data: any[], loading: boolean, error: any, refetch: () => Promise<void> }}
 */
export function useEntityList(entityName, sortBy = null, limit = null, filter = null) {
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(!!entityName);
  const [error,   setError]   = useState(null);

  const filterKey = typeof filter === 'function'
    ? filter.toString()
    : JSON.stringify(filter);

  // Keep current options accessible inside refresh without stale closure
  // BUG FIX: assign directly during render instead of using a bare useEffect.
  // A no-deps useEffect schedules an unnecessary commit phase on every render
  // and runs twice in StrictMode, adding overhead with no benefit for ref syncing.
  const optsRef    = useRef({ sortBy, limit, filter });
  optsRef.current = { sortBy, limit, filter };
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!entityName) {
      setData([]);
      setLoading(false);
      return;
    }

    mountedRef.current = true;
    let retryCount = 0;
    let retryTimer = null; // BUG FIX: track retry setTimeout so we can clear on unmount

    // refresh: reads current cache, applies this component's transformations
    const refresh = () => {
      if (!mountedRef.current) return;
      const raw    = entityCache.get(entityName) || [];
      const { sortBy: sb, limit: lim, filter: f } = optsRef.current;
      const result = applyLimit(applySort(applyFilter(raw, f), sb), lim);
      setData(decorateEntities(entityName, result));
      setLoading(false);
      setError(null);
    };

    registerListListener(entityName, refresh);
    ensureSubscription(entityName);

    const load = async () => {
      // Instant render from valid cache
      if (entityCache.has(entityName) && isCacheFresh(entityName)) {
        refresh();
        return;
      }

      setLoading(true);

      try {
        await fetchEntityList(entityName);
        // fetchEntityList already called notifyListListeners → refresh may have fired,
        // but we call it again to guarantee our component updates (handles case where
        // we were not yet registered when the notification fired).
        refresh();
      } catch (err) {
        if (!mountedRef.current) return;
        // Rate-limit retries are handled inside globalThrottler.
        // We only retry here for transient network errors (offline → online).
        if (retryCount < 2 && isTransientError(err)) {
          retryCount++;
          retryTimer = setTimeout(load, 1000 * retryCount);
        } else {
          setError(err);
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mountedRef.current = false;
      if (retryTimer) clearTimeout(retryTimer); // BUG FIX: clear pending retry on unmount
      removeListListener(entityName, refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityName, sortBy, filterKey]);

  const refetch = useCallback(async () => {
    if (!entityName) return;
    invalidateEntityCache(entityName);
    if (mountedRef.current) setLoading(true);
    try {
      await fetchEntityList(entityName);
    } catch (err) {
      if (mountedRef.current) {
        setError(err);
        setLoading(false);
      }
    }
  }, [entityName]);

  return { data, loading, error, refetch };
}

// ─── useEntityData (single entity by ID) ─────────────────────────────────────

/**
 * Load a single entity by ID with shared caching and real-time updates.
 *
 * @param {string} entityName
 * @param {string} entityId
 * @returns {{ data: object|null, loading: boolean, error: any }}
 */
export function useEntityData(entityName, entityId) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(!!(entityName && entityId));
  const [error,   setError]   = useState(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    if (!entityName || !entityId) {
      setData(null);
      setLoading(false);
      return;
    }

    mountedRef.current = true;
    let retryCount = 0;
    let retryTimer = null; // BUG FIX: track retry setTimeout so we can clear on unmount
    const singleKey = `${entityName}:${entityId}`;

    const refresh = () => {
      if (!mountedRef.current) return;
      const raw = singleCache.get(singleKey); // null means "not found", undefined means "not cached"
      setData(raw != null ? decorateEntity(entityName, raw) : null);
      setLoading(false);
      setError(null);
    };

    registerSingleListener(entityName, entityId, refresh);
    ensureSubscription(entityName);

    const load = async () => {
      if (singleCache.has(singleKey) && isCacheFresh(singleKey)) {
        refresh();
        return;
      }

      setLoading(true);

      try {
        await fetchSingleEntity(entityName, entityId);
        refresh();
      } catch (err) {
        if (!mountedRef.current) return;
        // Rate-limit retries are handled inside globalThrottler.
        // Retry here only for transient network errors.
        if (retryCount < 2 && isTransientError(err)) {
          retryCount++;
          retryTimer = setTimeout(load, 1000 * retryCount);
        } else {
          setError(err);
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mountedRef.current = false;
      if (retryTimer) clearTimeout(retryTimer); // BUG FIX: clear pending retry on unmount
      removeSingleListener(entityName, entityId, refresh);
    };
  }, [entityName, entityId]);

  return { data, loading, error };
}

// ─── useEntitiesData (multi-entity convenience wrapper) ───────────────────────

/**
 * Load multiple entity types simultaneously.
 * All fetches run in parallel (deduped with other concurrent callers).
 *
 * @param {Array<{ entityName, sortBy?, limit?, filter? }>} entityConfigs
 * @returns {{ data: { [entityName]: any[] }, loading: boolean }}
 */
export function useEntitiesData(entityConfigs) {
  const configKey = JSON.stringify(
    entityConfigs.map(c => ({ n: c.entityName, s: c.sortBy, l: c.limit }))
  );

  const [data, setData] = useState(
    () => Object.fromEntries(entityConfigs.map(cfg => [cfg.entityName, []]))
  );
  const [loading, setLoading] = useState(entityConfigs.length > 0);
  const mountedRef = useRef(true);
  // BUG FIX: direct assignment instead of bare useEffect (same fix as useEntityList)
  const optsRef    = useRef(entityConfigs);
  optsRef.current = entityConfigs;

  useEffect(() => {
    if (entityConfigs.length === 0) {
      setLoading(false);
      return;
    }

    mountedRef.current = true;
    let pending = entityConfigs.length;

    const rebuildAll = () => {
      if (!mountedRef.current) return;
      const next = {};
      for (const cfg of optsRef.current) {
        const raw    = entityCache.get(cfg.entityName) || [];
        const result = applyLimit(
          applySort(applyFilter(raw, cfg.filter ?? null), cfg.sortBy ?? null),
          cfg.limit ?? null
        );
        next[cfg.entityName] = decorateEntities(cfg.entityName, result);
      }
      setData(next);
    };

    const cleanup = [];

    entityConfigs.forEach(cfg => {
      const { entityName } = cfg;
      let resolved = false;

      ensureSubscription(entityName);

      const onCacheChange = () => {
        rebuildAll();
        if (!resolved) {
          resolved = true;
          pending--;
          if (pending === 0 && mountedRef.current) setLoading(false);
        }
      };

      registerListListener(entityName, onCacheChange);
      cleanup.push(() => removeListListener(entityName, onCacheChange));

      if (entityCache.has(entityName) && isCacheFresh(entityName)) {
        // Microtask so all registrations complete before any setState
        Promise.resolve().then(onCacheChange);
      } else {
        fetchEntityList(entityName)
          .then(onCacheChange)
          .catch(() => {
            if (!resolved) {
              resolved = true;
              pending--;
              if (pending === 0 && mountedRef.current) setLoading(false);
            }
          });
      }
    });

    return () => {
      mountedRef.current = false;
      cleanup.forEach(fn => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  return { data, loading };
}