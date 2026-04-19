/**
 * useTimelineSourceRun — react-query hook that resolves a timeline row's
 * `source` + `created_at` → the sync_log that likely emitted it, its source
 * config, and the first ~5KB of its raw payload for preview.
 *
 * Match logic (lifted verbatim from the design brief):
 *   SELECT ... FROM pulse_sync_logs
 *    WHERE source_id = <timeline.source>
 *      AND started_at <= <timeline.created_at>
 *      AND (completed_at IS NULL OR completed_at >= <timeline.created_at> - interval '5 minutes')
 *    ORDER BY started_at DESC
 *    LIMIT 1
 *
 * Returns { syncLog, sourceConfig, payload, payloadTruncated } — all nullable.
 *
 * Hook is intentionally *slim*: we don't fetch the full payload until the
 * drawer is opened, and even then we cap at ~5KB to keep the UI snappy.
 * Callers requiring the full payload for download should refetch directly.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

const PAYLOAD_PREVIEW_BYTES = 5 * 1024;
const MATCH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** @internal — callable outside the hook for "Download full" button. */
export async function fetchFullPayload(syncLogId) {
  if (!syncLogId) return null;
  const { data, error } = await api._supabase
    .from("pulse_sync_log_payloads")
    .select("raw_payload, result_summary, input_config, records_detail")
    .eq("sync_log_id", syncLogId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchSyncLogFor({ source, createdAt }) {
  if (!source || !createdAt) return { syncLog: null, sourceConfig: null, payload: null, payloadTruncated: false };

  const ts = new Date(createdAt);
  if (isNaN(ts.getTime())) return { syncLog: null, sourceConfig: null, payload: null, payloadTruncated: false };
  const windowStart = new Date(ts.getTime() - MATCH_WINDOW_MS).toISOString();

  // Sync-log match — widest plausible match. We filter client-side for the
  // (completed_at IS NULL OR completed_at >= windowStart) leg since the REST
  // builder can't express OR across nullable columns succinctly.
  const { data: logs, error: logErr } = await api._supabase
    .from("pulse_sync_logs")
    .select(
      "id, source_id, source_label, status, started_at, completed_at, " +
      "records_fetched, records_new, records_updated, apify_run_id, error_message, " +
      "triggered_by, triggered_by_name"
    )
    .eq("source_id", source)
    .lte("started_at", ts.toISOString())
    .order("started_at", { ascending: false })
    .limit(10);
  if (logErr) throw logErr;

  const syncLog = (logs || []).find(l =>
    l.completed_at == null || new Date(l.completed_at).getTime() >= new Date(windowStart).getTime()
  ) || (logs || [])[0] || null;

  // Source config — independent fetch. Fine to run in parallel but we keep
  // it sequential for simplicity; this is a one-off drawer open.
  const { data: cfg } = await api._supabase
    .from("pulse_source_configs")
    .select("source_id, label, actor_slug, apify_store_url, description, schedule_cron, is_enabled")
    .eq("source_id", source)
    .maybeSingle();

  // Payload preview — optional, keyed by sync_log.id.
  let payload = null;
  let payloadTruncated = false;
  if (syncLog?.id) {
    const { data: pl } = await api._supabase
      .from("pulse_sync_log_payloads")
      .select("raw_payload, result_summary")
      .eq("sync_log_id", syncLog.id)
      .maybeSingle();
    if (pl) {
      let pretty = "";
      try {
        pretty = JSON.stringify(pl.raw_payload ?? pl.result_summary ?? {}, null, 2);
      } catch {
        pretty = String(pl.raw_payload || pl.result_summary || "");
      }
      if (pretty.length > PAYLOAD_PREVIEW_BYTES) {
        payload = pretty.slice(0, PAYLOAD_PREVIEW_BYTES);
        payloadTruncated = true;
      } else {
        payload = pretty;
      }
    }
  }

  return { syncLog, sourceConfig: cfg || null, payload, payloadTruncated };
}

export function useTimelineSourceRun(source, createdAt, { enabled = true } = {}) {
  return useQuery({
    queryKey: ["pulse-timeline-source-run", source, createdAt],
    queryFn: () => fetchSyncLogFor({ source, createdAt }),
    enabled: !!source && !!createdAt && enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
