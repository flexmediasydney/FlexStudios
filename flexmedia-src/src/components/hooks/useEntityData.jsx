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
import { base44 } from '@/api/base44Client';
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
const LIST_LIMIT = 1000;           // always fetch up to 1000; limit applied client-side

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
    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      if (!event) return;
      pendingEvents.push(event);
      if (!debounceTimer) debounceTimer = setTimeout(flush, 30);
    });

    subscriptions.set(entityName, unsubscribe);
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

  const promise = globalThrottler
    .execute(() => base44.entities[entityName].list(null, LIST_LIMIT))
    .then(items => {
      inFlight.delete(entityName);
      const raw = items || [];

      // Dev-mode RLS warning: if we expected data but got nothing, it may be an
      // RLS policy misconfiguration (Supabase returns [] instead of an error).
      if (raw.length === 0 && import.meta.env.DEV) {
        console.debug(
          `[useEntityData] ${entityName}.list() returned 0 rows. ` +
          `If this is unexpected, check RLS policies for the corresponding table.`
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
    .execute(() => base44.entities[entityName].get(entityId))
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
  const optsRef    = useRef({ sortBy, limit, filter });
  const mountedRef = useRef(true);

  useEffect(() => { optsRef.current = { sortBy, limit, filter }; });

  useEffect(() => {
    if (!entityName) {
      setData([]);
      setLoading(false);
      return;
    }

    mountedRef.current = true;
    let retryCount = 0;

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
          setTimeout(load, 1000 * retryCount);
        } else {
          setError(err);
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mountedRef.current = false;
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
          setTimeout(load, 1000 * retryCount);
        } else {
          setError(err);
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mountedRef.current = false;
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
  const optsRef    = useRef(entityConfigs);
  useEffect(() => { optsRef.current = entityConfigs; });

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