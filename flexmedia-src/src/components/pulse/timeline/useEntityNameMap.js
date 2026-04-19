/**
 * useEntityNameMap — resolves pulse_entity_id → display name for the entity
 * pills on timeline rows. Hides raw UUIDs by populating a {`${type}:${id}`:
 * name} map keyed off the unique entity refs found across the supplied rows.
 *
 * Called by timeline consumers (PulseTimeline, PulseTimelineTab) once per
 * batch of rows; each call issues at most three small tab-local lookups
 * (agents, agencies, listings) with an `in.(...)` filter. Cheap — the
 * dashboard never displays more than a few hundred distinct entities at once.
 *
 * Returns the map directly (not { data, loading }) so the caller can pass it
 * straight into <PulseTimeline entityNameMap={...} /> without conditional
 * plumbing — an empty map is fine (the pill falls back to "<Type> <short>").
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/supabaseClient";

export default function useEntityNameMap(entries) {
  const ids = useMemo(() => {
    const byType = { agent: new Set(), agency: new Set(), listing: new Set() };
    for (const e of entries || []) {
      if (!e?.entity_type || !e?.pulse_entity_id) continue;
      if (byType[e.entity_type]) byType[e.entity_type].add(e.pulse_entity_id);
    }
    return {
      agents:    Array.from(byType.agent),
      agencies:  Array.from(byType.agency),
      listings:  Array.from(byType.listing),
    };
  }, [entries]);

  const [map, setMap] = useState({});

  useEffect(() => {
    let cancelled = false;
    const { agents, agencies, listings } = ids;
    if (agents.length === 0 && agencies.length === 0 && listings.length === 0) {
      setMap({});
      return;
    }

    (async () => {
      const next = {};
      try {
        const tasks = [];
        if (agents.length > 0) {
          tasks.push(api._supabase
            .from("pulse_agents")
            .select("id, full_name")
            .in("id", agents)
            .then(({ data }) => {
              for (const r of data || []) {
                if (r?.id) next[`agent:${r.id}`] = r.full_name || null;
              }
            })
            .catch(() => {}));
        }
        if (agencies.length > 0) {
          tasks.push(api._supabase
            .from("pulse_agencies")
            .select("id, name")
            .in("id", agencies)
            .then(({ data }) => {
              for (const r of data || []) {
                if (r?.id) next[`agency:${r.id}`] = r.name || null;
              }
            })
            .catch(() => {}));
        }
        if (listings.length > 0) {
          tasks.push(api._supabase
            .from("pulse_listings")
            .select("id, address, suburb")
            .in("id", listings)
            .then(({ data }) => {
              for (const r of data || []) {
                if (!r?.id) continue;
                const label = r.address
                  ? (r.suburb ? `${r.address}, ${r.suburb}` : r.address)
                  : (r.suburb || null);
                next[`listing:${r.id}`] = label;
              }
            })
            .catch(() => {}));
        }
        await Promise.all(tasks);
      } catch { /* best-effort */ }
      if (!cancelled) setMap(next);
    })();

    return () => { cancelled = true; };
    // Re-run only when the set of IDs changes (stringified to avoid arr-ref churn).
  }, [ids.agents.join(","), ids.agencies.join(","), ids.listings.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return map;
}
