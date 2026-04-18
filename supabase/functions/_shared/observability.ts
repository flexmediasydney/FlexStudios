/**
 * Shared observability helpers for Industry-Pulse edge functions.
 *
 * Consolidates the recurring patterns scattered through pulseDataSync,
 * pulseDetailEnrich, pulseFireWorker, pulseRelistDetector, etc:
 *
 *   1. `startRun`  → insert a pulse_sync_logs row in status='running' and
 *                    return a RunContext you thread through the handler.
 *   2. `recordError` → accumulate structured errors (non-fatal). Groups repeat
 *                    messages by 80-char prefix so schema-mismatch avalanches
 *                    collapse into a single entry with a count.
 *   3. `endRun`   → finalise the sync_log row (status + header columns) AND
 *                    write the heavy side-table payload into
 *                    pulse_sync_log_payloads per migration 095. Header-column
 *                    vocab matches the real schema (completed/failed/timed_out,
 *                    records_fetched, records_updated, records_detail,
 *                    apify_run_id scalar, error_message).
 *   4. breakerCheckOpen / breakerRecordSuccess / breakerRecordFailure — the
 *      canonical reads/writes to pulse_source_circuit_breakers. Mirrors the
 *      logic from pulseDetailEnrich so every function uses identical
 *      threshold/cooldown semantics.
 *
 * Every operation emits a structured `[invocationId]` console.log prefix for
 * Supabase Logs Explorer.
 *
 * Backward compatible — existing functions continue to work unchanged; callers
 * opt in file-by-file.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Types ────────────────────────────────────────────────────────────────

export interface RunContext {
  /** Uuid unique to this invocation — appears as the prefix on every log line. */
  invocationId: string;
  /** pulse_sync_logs.id for this run. */
  syncLogId: string;
  /** Date.now() captured at startRun time — used for duration_ms calculation. */
  startedAt: number;
  /** Source identifier (e.g. 'rea_detail_enrich', 'rea_list'). */
  sourceId: string;
  /** Admin Supabase client (bypasses RLS). */
  admin: SupabaseClient;
  /** Mutable error list — updated by recordError, drained by endRun. */
  errors: Array<{ msg: string; severity: 'warn' | 'error' | 'fatal'; count: number }>;
}

/** Circuit breaker status readout. `open=true` means the caller must short-circuit. */
export interface BreakerStatus {
  open: boolean;
  reopenAt: string | null;
  consecutiveFailures?: number;
  state?: string;
}

// ── Run lifecycle ─────────────────────────────────────────────────────────

/**
 * Open a pulse_sync_logs row and return a RunContext. Mirrors the existing
 * pulseDetailEnrich / pulseDataSync pattern.
 *
 * Throws if the sync_log insert fails — the caller should let this bubble up
 * and return a 500 (we cannot record the run at all if this fails).
 */
export async function startRun(params: {
  admin: SupabaseClient;
  sourceId: string;
  syncType: string;
  triggeredBy: string;
  triggeredByName: string;
  inputConfig?: Record<string, any>;
}): Promise<RunContext> {
  const { admin, sourceId, syncType, triggeredBy, triggeredByName, inputConfig } = params;
  const invocationId = crypto.randomUUID();
  const startedAt = Date.now();
  const initialLabel = `${sourceId} · ${triggeredBy}`;

  console.log(`[${invocationId}] startRun source=${sourceId} sync_type=${syncType} triggered_by=${triggeredBy}`);

  const { data, error } = await admin.from('pulse_sync_logs').insert({
    sync_type: syncType,
    source_id: sourceId,
    source_label: initialLabel,
    status: 'running',
    triggered_by: triggeredBy,
    triggered_by_name: triggeredByName,
    started_at: new Date(startedAt).toISOString(),
  }).select('id').single();

  if (error || !data) {
    console.error(`[${invocationId}] startRun failed to create sync_log:`, error?.message);
    throw new Error(`Failed to create sync_log: ${error?.message || 'unknown'}`);
  }

  const syncLogId = data.id as string;

  // Seed input_config eagerly — matches migration 095 side-table pattern so
  // the UI run-detail drill-through shows configuration immediately (rather
  // than only after the run finishes).
  if (inputConfig) {
    try {
      await admin.from('pulse_sync_log_payloads').upsert({
        sync_log_id: syncLogId,
        input_config: inputConfig,
      }, { onConflict: 'sync_log_id' });
    } catch (err: any) {
      console.warn(`[${invocationId}] startRun input_config seed failed (non-fatal): ${err?.message}`);
    }
  }

  return {
    invocationId,
    syncLogId,
    startedAt,
    sourceId,
    admin,
    errors: [],
  };
}

/**
 * Record a structured error. Non-fatal, does not throw.
 * Groups repeat messages by 80-char prefix so a single root cause that trips
 * 40+ rows collapses to one entry with a count.
 */
export function recordError(
  ctx: RunContext,
  err: any,
  severity: 'warn' | 'error' | 'fatal' = 'error',
): void {
  const raw = err?.message || String(err || 'unknown error');
  const key = String(raw).substring(0, 80);
  const existing = ctx.errors.find((e) => e.msg === key && e.severity === severity);
  if (existing) {
    existing.count++;
  } else {
    ctx.errors.push({ msg: key, severity, count: 1 });
  }
  const logFn = severity === 'warn' ? console.warn : console.error;
  logFn(`[${ctx.invocationId}] recordError[${severity}]: ${key}`);
}

/**
 * Close a sync_log row with final status + stats, and write side-table payload.
 * Non-fatal — if the side-table upsert fails, the header row is still closed.
 */
export async function endRun(
  ctx: RunContext,
  params: {
    status: 'completed' | 'failed' | 'timed_out';
    recordsFetched?: number;
    recordsUpdated?: number;
    recordsDetail?: Record<string, any>;
    apifyRunId?: string;
    apifyRunIds?: string[];
    apifyBilledCostUsd?: number;
    valueProducingCostUsd?: number;
    errorMessage?: string;
    customSummary?: Record<string, any>;
    sourceLabel?: string;
    suburb?: string;
    batchNumber?: number;
    totalBatches?: number;
    rawPayload?: Record<string, any>;
  },
): Promise<void> {
  const { admin, syncLogId, invocationId, sourceId, startedAt } = ctx;
  const durationMs = Date.now() - startedAt;

  // Prefer the explicit apify_run_id param; fall back to first of the list.
  const joinedRunIdFromList = params.apifyRunIds && params.apifyRunIds.length > 0
    ? params.apifyRunIds.filter(Boolean).join(',') || null
    : null;
  const joinedRunId = params.apifyRunId ?? joinedRunIdFromList;

  // Coerce error list into a single capped string for the header column.
  const accumulatedErrors = ctx.errors.map((e) => `${e.msg}${e.count > 1 ? ` (×${e.count})` : ''}`);
  const accumulatedErrorMessage = accumulatedErrors.length > 0
    ? accumulatedErrors.join(' | ').substring(0, 500)
    : null;
  const errorMessage = params.errorMessage ?? accumulatedErrorMessage;

  const header: Record<string, any> = {
    status: params.status,
    completed_at: new Date().toISOString(),
  };
  if (params.sourceLabel !== undefined) header.source_label = params.sourceLabel;
  if (params.suburb !== undefined) header.suburb = params.suburb;
  if (params.batchNumber !== undefined) header.batch_number = params.batchNumber;
  if (params.totalBatches !== undefined) header.total_batches = params.totalBatches;
  if (params.recordsFetched !== undefined) header.records_fetched = params.recordsFetched;
  if (params.recordsUpdated !== undefined) header.records_updated = params.recordsUpdated;
  if (params.recordsDetail !== undefined) header.records_detail = params.recordsDetail;
  if (joinedRunId) header.apify_run_id = joinedRunId;
  if (errorMessage) header.error_message = errorMessage;

  console.log(
    `[${invocationId}] endRun source=${sourceId} status=${params.status} ` +
    `fetched=${params.recordsFetched ?? 0} updated=${params.recordsUpdated ?? 0} ` +
    `duration_ms=${durationMs} errors=${ctx.errors.length}`,
  );

  const { error: headerErr } = await admin
    .from('pulse_sync_logs')
    .update(header)
    .eq('id', syncLogId);
  if (headerErr) {
    console.error(`[${invocationId}] endRun header update failed: ${headerErr.message}`);
  }

  // Build the side-table result_summary. Heavy/arbitrary stats live here per
  // migration 095 — the header columns only accept the narrow vocab above.
  const resultSummary: Record<string, any> = {
    duration_ms: durationMs,
    status: params.status,
    ...(params.customSummary || {}),
    errors: accumulatedErrors,
  };
  if (params.apifyRunIds && params.apifyRunIds.length > 0) {
    resultSummary.apify_run_ids = params.apifyRunIds;
  }
  if (params.apifyBilledCostUsd !== undefined) {
    resultSummary.apify_billed_cost_usd = params.apifyBilledCostUsd;
  }
  if (params.valueProducingCostUsd !== undefined) {
    resultSummary.value_producing_cost_usd = params.valueProducingCostUsd;
  }
  if (errorMessage && !resultSummary.error_message) {
    resultSummary.error_message = errorMessage;
  }

  try {
    const sideTableRow: Record<string, any> = {
      sync_log_id: syncLogId,
      result_summary: resultSummary,
    };
    if (params.rawPayload) sideTableRow.raw_payload = params.rawPayload;

    const { error: sideErr } = await admin
      .from('pulse_sync_log_payloads')
      .upsert(sideTableRow, { onConflict: 'sync_log_id' });
    if (sideErr) {
      console.warn(`[${invocationId}] endRun side-table upsert failed (non-fatal): ${sideErr.message}`);
    }
  } catch (err: any) {
    console.warn(`[${invocationId}] endRun side-table threw (non-fatal): ${err?.message}`);
  }
}

// ── Circuit breaker helpers ───────────────────────────────────────────────

/**
 * Read the breaker for `sourceId`. `open=true` means the caller must bail out
 * (short-circuit). Honours B12 semantics from pulseDetailEnrich: if state is
 * 'open' but reopen_at is NULL (data corruption / manual flip), treat as
 * permanently open. Otherwise auto-reopen when reopen_at is in the past.
 */
export async function breakerCheckOpen(
  admin: SupabaseClient,
  sourceId: string,
): Promise<BreakerStatus> {
  const { data } = await admin
    .from('pulse_source_circuit_breakers')
    .select('state, consecutive_failures, opened_at, reopen_at')
    .eq('source_id', sourceId)
    .maybeSingle();

  const state = (data as any)?.state || 'closed';
  const reopenAtIso = (data as any)?.reopen_at || null;
  const consecutiveFailures = (data as any)?.consecutive_failures || 0;

  if (state !== 'open') {
    return { open: false, reopenAt: reopenAtIso, consecutiveFailures, state };
  }

  const reopenAtMs = reopenAtIso ? new Date(reopenAtIso).getTime() : null;
  // B12: null reopen_at means the open is indefinite; treat as permanently open.
  const stillOpen = reopenAtMs === null || reopenAtMs > Date.now();
  return { open: stillOpen, reopenAt: reopenAtIso, consecutiveFailures, state };
}

/**
 * Mark a successful run — closes the breaker and resets the failure counter.
 */
export async function breakerRecordSuccess(
  admin: SupabaseClient,
  sourceId: string,
): Promise<void> {
  await admin.from('pulse_source_circuit_breakers').upsert({
    source_id: sourceId,
    state: 'closed',
    consecutive_failures: 0,
    opened_at: null,
    reopen_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'source_id' });
}

/**
 * Mark a failed run. Opens the breaker once consecutive_failures reaches the
 * per-source `failure_threshold` (default 3) and schedules reopen_at =
 * now + `cooldown_minutes` (default 30).
 */
export async function breakerRecordFailure(
  admin: SupabaseClient,
  sourceId: string,
): Promise<void> {
  const { data: cur } = await admin
    .from('pulse_source_circuit_breakers')
    .select('consecutive_failures, failure_threshold, cooldown_minutes, total_opens')
    .eq('source_id', sourceId)
    .maybeSingle();

  const fails = ((cur as any)?.consecutive_failures || 0) + 1;
  const threshold = (cur as any)?.failure_threshold || 3;
  const cooldownMins = (cur as any)?.cooldown_minutes || 30;
  const shouldOpen = fails >= threshold;
  const now = new Date();
  const reopenAt = shouldOpen ? new Date(now.getTime() + cooldownMins * 60 * 1000) : null;

  await admin.from('pulse_source_circuit_breakers').upsert({
    source_id: sourceId,
    state: shouldOpen ? 'open' : 'closed',
    consecutive_failures: fails,
    ...(shouldOpen ? {
      opened_at: now.toISOString(),
      reopen_at: reopenAt!.toISOString(),
      total_opens: ((cur as any)?.total_opens || 0) + 1,
    } : {}),
    updated_at: now.toISOString(),
  }, { onConflict: 'source_id' });
}
