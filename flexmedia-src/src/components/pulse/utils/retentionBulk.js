/*
 * retentionBulk.js — shared react-query helpers for the Pulse Agents / Agencies
 * tabs' bulk retention lookups (mig 174).
 *
 * Why: both tabs render tables + grids of ~50 rows at a time. Each row wants a
 * "Missed opp 12m" / "Retention %" chip keyed off the retention RPC. Calling
 * pulse_get_agent_retention / pulse_get_agency_retention once per row is an
 * N+1 — see migration 174 for the batched equivalents.
 *
 * We batch per-page: when the paginated list of ids changes, fire ONE RPC
 * with the full array, store a Map keyed by rea_id in react-query cache, and
 * return the headline for a given id via a tiny accessor hook.
 *
 * React-query keys intentionally partition by `window` (from/to) so a user
 * switching the global Market Share window (not wired here yet but coming)
 * invalidates cleanly.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

export const DEFAULT_RETENTION_WINDOW_MONTHS = 12;

/* Build a [from, to] ISO pair for the given months-back window. Exposed so
 * callers can show the chip tooltip "over last N months" consistently. */
export function retentionWindow(monthsBack = DEFAULT_RETENTION_WINDOW_MONTHS) {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - monthsBack);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/* Retention band → color. Matches the swatch used across the Market Share
 * dashboard. at-risk = red, mid = amber, healthy = green. */
export function retentionBand(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "unknown";
  if (n >= 75) return "healthy";
  if (n >= 25) return "mid";
  return "at_risk";
}

export function retentionBandClass(band) {
  switch (band) {
    case "healthy":
      return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800";
    case "mid":
      return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800";
    case "at_risk":
      return "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

/* Compact $ formatter — prints $1.2k, $3.4M; matches the amber missed-$ chip
 * styling used in the Market Share dashboard so everything reads the same. */
export function fmtMissedDollars(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/* useAgentsRetentionBulk — fetches retention headline for a page of agents.
 * ids is the list of rea_agent_id strings on the current page. We filter out
 * nulls / duplicates + keep the sorted key stable so react-query dedupes. */
export function useAgentsRetentionBulk(ids, opts = {}) {
  const { enabled = true, monthsBack = DEFAULT_RETENTION_WINDOW_MONTHS } = opts;
  const cleanIds = useMemo(() => {
    const set = new Set();
    for (const raw of ids || []) {
      if (raw != null && raw !== "") set.add(String(raw));
    }
    return Array.from(set).sort();
  }, [ids]);

  const { fromIso, toIso } = useMemo(() => retentionWindow(monthsBack), [monthsBack]);

  const query = useQuery({
    queryKey: ["pulse_agents_retention_bulk", { ids: cleanIds, fromIso, toIso }],
    queryFn: async () => {
      if (cleanIds.length === 0) return new Map();
      const { data, error } = await api._supabase.rpc(
        "pulse_get_agents_retention_bulk",
        { p_rea_agent_ids: cleanIds, p_from: fromIso, p_to: toIso },
      );
      if (error) throw error;
      const out = new Map();
      for (const row of data || []) out.set(String(row.rea_agent_id), row);
      return out;
    },
    enabled: enabled && cleanIds.length > 0,
    staleTime: 2 * 60_000, // 2 min — retention data changes slowly
    keepPreviousData: true,
  });

  return query;
}

/* useAgenciesRetentionBulk — same shape keyed by agency uuid (pulse id). */
export function useAgenciesRetentionBulk(ids, opts = {}) {
  const { enabled = true, monthsBack = DEFAULT_RETENTION_WINDOW_MONTHS } = opts;
  const cleanIds = useMemo(() => {
    const set = new Set();
    for (const raw of ids || []) {
      if (raw != null && raw !== "") set.add(String(raw));
    }
    return Array.from(set).sort();
  }, [ids]);

  const { fromIso, toIso } = useMemo(() => retentionWindow(monthsBack), [monthsBack]);

  const query = useQuery({
    queryKey: ["pulse_agencies_retention_bulk", { ids: cleanIds, fromIso, toIso }],
    queryFn: async () => {
      if (cleanIds.length === 0) return new Map();
      const { data, error } = await api._supabase.rpc(
        "pulse_get_agencies_retention_bulk",
        { p_agency_pulse_ids: cleanIds, p_from: fromIso, p_to: toIso },
      );
      if (error) throw error;
      const out = new Map();
      for (const row of data || []) out.set(String(row.agency_pulse_id), row);
      return out;
    },
    enabled: enabled && cleanIds.length > 0,
    staleTime: 2 * 60_000,
    keepPreviousData: true,
  });

  return query;
}

/* Watchlist — localStorage-backed per-entity-type set of ids. Simple +
 * reliable; no need to persist server-side yet. */
const WATCH_KEYS = {
  agent: "pulse_watchlist_agents",
  agency: "pulse_watchlist_agencies",
};

export function readWatchlist(type) {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(WATCH_KEYS[type] || "");
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeWatchlist(type, set) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      WATCH_KEYS[type] || "",
      JSON.stringify(Array.from(set)),
    );
  } catch {
    /* quota / SSR */
  }
}

export function toggleWatchlistId(type, id) {
  const s = readWatchlist(type);
  const k = String(id);
  if (s.has(k)) s.delete(k);
  else s.add(k);
  writeWatchlist(type, s);
  return s;
}

/* Saved filter views — localStorage per tab. A view stores the whole
 * filter object as opaque JSON so each tab can evolve its schema without
 * migration. Max 20 views per tab kept (LRU-by-insert-order). */
const VIEW_KEYS = {
  agents: "pulse_agents_saved_views_v1",
  agencies: "pulse_agencies_saved_views_v1",
};
const VIEW_CAP = 20;

export function readSavedViews(tab) {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(VIEW_KEYS[tab] || "");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function writeSavedViews(tab, list) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_KEYS[tab] || "", JSON.stringify((list || []).slice(0, VIEW_CAP)));
  } catch {
    /* quota / SSR */
  }
}

export function addSavedView(tab, name, payload) {
  const existing = readSavedViews(tab);
  const now = new Date().toISOString();
  const view = { id: `${now}_${Math.random().toString(36).slice(2, 8)}`, name: String(name || "Untitled").slice(0, 60), savedAt: now, payload };
  const next = [view, ...existing.filter((v) => v.name !== view.name)].slice(0, VIEW_CAP);
  writeSavedViews(tab, next);
  return next;
}

export function deleteSavedView(tab, id) {
  const next = readSavedViews(tab).filter((v) => v.id !== id);
  writeSavedViews(tab, next);
  return next;
}
