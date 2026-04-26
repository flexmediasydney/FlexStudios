/**
 * useDronePipelineState — Wave 9 S2
 * ──────────────────────────────────
 * Live pipeline state hook for the drone tab. Wraps:
 *   - get_drone_pipeline_state RPC (Stream 1) → returns full per-shoot pipeline JSONB
 *   - drone_jobs / drone_sfm_runs / drone_shoots realtime subscriptions
 *   - drone-job-fire-now / drone-stage-rerun edge function mutations
 *   - 1-second tick for countdown/ETA components
 *
 * Adaptive polling: 10s while a stage is running/pending, 60s when idle, off when delivered.
 *
 * Important integration notes (from supabaseClient.js audit):
 *   - api.rpc() returns data DIRECTLY, not { data, error } — wraps PostgREST and throws on error.
 *   - api.functions.invoke() returns { data } where data may itself contain { success, error, ... }.
 *   - api.entities.X.subscribe(cb) returns an UNSUBSCRIBE FUNCTION (not an object with .unsubscribe()).
 *   - .subscribe() has no built-in filter option — we filter in the callback against payload data.
 *
 * Expected RPC shape (per architect Section A.2 — Stream 1 contract):
 *   {
 *     project_id, shoot_id, shoot_status,
 *     current_stage,             // e.g. 'drone-sfm'
 *     operator_actions_unlocked, // boolean — true once initial pipeline finished
 *     stages: [
 *       { stage_key: 'drone-ingest',
 *         status: 'done'|'running'|'pending'|'blocked-on-operator'|'failed'|'future',
 *         started_at, completed_at, duration_ms, eta_ms,
 *         job_id, scheduled_for, attempt_count,
 *         error_message },
 *       ...
 *     ],
 *     active_job: { id, function_name, scheduled_for, attempt_count, status, error_message } | null,
 *     dead_letter_count: number,
 *     system: { dispatcher_health: 'ok'|'degraded'|'down', last_tick_at }
 *   }
 *
 * Public API (consumed by S3):
 *   const {
 *     pipelineState,    // RPC result or null while loading / on error
 *     isLoading,
 *     error,            // Error or null
 *     refetch,          // () => Promise<QueryObserverResult>
 *     tick,             // increments every 1s while a stage is running/pending
 *     forceFireNow,     // (jobId) => void  — fire-and-forget, toasts on success/failure
 *     rerunStage,       // (stage) => void  — fire-and-forget, toasts on success/failure
 *     isFiring,         // mutation pending
 *     isRerunning,      // mutation pending
 *   } = useDronePipelineState(projectId, shootId);
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useDronePipelineState(projectId, shootId) {
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => ['drone_pipeline_state', projectId || null, shootId || null],
    [projectId, shootId],
  );

  // ── Primary state query ────────────────────────────────────────────────────
  const stateQuery = useQuery({
    queryKey,
    queryFn: async () => {
      if (!projectId) return null;
      // api.rpc returns data directly (see supabaseClient.js:849).
      // Stream 1's RPC: get_drone_pipeline_state(p_project_id uuid, p_shoot_id uuid) returns jsonb.
      const data = await api.rpc('get_drone_pipeline_state', {
        p_project_id: projectId,
        p_shoot_id: shootId || null,
      });
      return data || null;
    },
    enabled: Boolean(projectId),
    // Adaptive polling — refetchInterval receives the QUERY object in v5
    refetchInterval: (query) => {
      const data = query?.state?.data;
      if (!data) return 30_000; // unknown shape — moderate cadence
      const stage = data?.current_stage;
      const stageRow = (data?.stages || []).find((s) => s?.stage_key === stage);
      const status = stageRow?.status;
      // Terminal — stop polling entirely
      if (data?.shoot_status === 'delivered') return false;
      // Hot — running or queued
      if (status === 'running' || status === 'pending') return 10_000;
      // Cold — idle / waiting on operator / done-but-not-delivered
      return 60_000;
    },
    staleTime: 5_000,
    retry: 1, // RPC may be missing while Stream 1 not deployed — fail fast
  });

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  // Filter happens in the callback because api.entities.X.subscribe has no
  // built-in filter option (see supabaseClient.js:369). The shape of evt is:
  //   { id, type: 'create'|'update'|'delete', data: row|null }
  useEffect(() => {
    if (!projectId) return undefined;

    const unsubscribers = [];
    const invalidate = () => queryClient.invalidateQueries({ queryKey });

    // drone_jobs — fires whenever a job is enqueued / picked up / completes.
    try {
      const unsubJobs = api.entities.DroneJob.subscribe((evt) => {
        if (!evt) return;
        // DELETE events have evt.data === null — invalidate anyway, the
        // RPC re-derives the active job. Cheaper than maintaining a job
        // index on the client.
        if (evt.type === 'delete' || evt?.data?.project_id === projectId) {
          invalidate();
        }
      });
      if (typeof unsubJobs === 'function') unsubscribers.push(unsubJobs);
    } catch (e) {
      // DroneJob entity / table may be absent in some envs — realtime is
      // optional, polling will still pick up changes.
      // eslint-disable-next-line no-console
      console.warn('[useDronePipelineState] DroneJob subscribe failed:', e);
    }

    // drone_sfm_runs — granular signal during the SfM stage.
    if (shootId) {
      try {
        const unsubSfm = api.entities.DroneSfmRun.subscribe((evt) => {
          if (!evt) return;
          if (evt.type === 'delete' || evt?.data?.shoot_id === shootId) {
            invalidate();
          }
        });
        if (typeof unsubSfm === 'function') unsubscribers.push(unsubSfm);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[useDronePipelineState] DroneSfmRun subscribe failed:', e);
      }
    }

    // drone_shoots — status flips (sfm_failed → ready_for_review → delivered).
    try {
      const unsubShoots = api.entities.DroneShoot.subscribe((evt) => {
        if (!evt) return;
        if (evt.type === 'delete' || evt?.data?.project_id === projectId) {
          invalidate();
        }
      });
      if (typeof unsubShoots === 'function') unsubscribers.push(unsubShoots);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[useDronePipelineState] DroneShoot subscribe failed:', e);
    }

    return () => {
      unsubscribers.forEach((unsub) => {
        try { unsub(); } catch { /* swallow — cleanup is best-effort */ }
      });
    };
  }, [projectId, shootId, queryKey, queryClient]);

  // ── Sub-second tick for countdown display ──────────────────────────────────
  // Components consume `tick` (changes every 1s while a stage is hot) to
  // re-render their elapsed/ETA text without us having to re-fetch from server.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const data = stateQuery.data;
    if (!data) return undefined;
    const stage = data?.current_stage;
    const stageRow = (data?.stages || []).find((s) => s?.stage_key === stage);
    const status = stageRow?.status;
    if (status !== 'running' && status !== 'pending') return undefined;
    const interval = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(interval);
  }, [stateQuery.data]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const forceFireMutation = useMutation({
    mutationFn: async ({ jobId }) => {
      if (!jobId) throw new Error('jobId is required');
      const result = await api.functions.invoke('drone-job-fire-now', { job_id: jobId });
      const data = result?.data;
      if (!data || data.success === false) {
        throw new Error(data?.error || 'Force fire failed');
      }
      return data;
    },
    onSuccess: () => {
      toast.success('Job firing now — dispatcher triggered');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast.error(err?.message || 'Force fire failed');
    },
  });

  const rerunStageMutation = useMutation({
    mutationFn: async ({ stage }) => {
      if (!stage) throw new Error('stage is required');
      const result = await api.functions.invoke('drone-stage-rerun', {
        stage,
        project_id: projectId,
        shoot_id: shootId || null,
      });
      const data = result?.data;
      if (!data || data.success === false) {
        throw new Error(data?.error || `Re-run ${stage} failed`);
      }
      return data;
    },
    onSuccess: (data, variables) => {
      const stage = variables?.stage || 'stage';
      if (data?.no_op) {
        toast.info(`${stage} already in progress (no-op)`);
      } else {
        toast.success(`Re-running ${stage}`);
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast.error(err?.message || 'Re-run failed');
    },
  });

  return {
    pipelineState: stateQuery.data ?? null,
    isLoading: stateQuery.isLoading,
    error: stateQuery.error || null,
    refetch: stateQuery.refetch,
    tick,
    forceFireNow: (jobId) => forceFireMutation.mutate({ jobId }),
    rerunStage: (stage) => rerunStageMutation.mutate({ stage }),
    isFiring: forceFireMutation.isPending,
    isRerunning: rerunStageMutation.isPending,
  };
}

export default useDronePipelineState;
