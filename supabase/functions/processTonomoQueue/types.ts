// Shared constants and types for processTonomoQueue

export const PROCESSOR_VERSION = "v3.1";
export const BATCH_SIZE = 25;
// LOCK_TTL_SECONDS removed Wave 7 P1-11 follow-up: was the legacy advisory-lock
// fallback TTL. The new dispatcher_locks mutex (W7.5) self-cleans via the
// dispatcher's 20-minute stale-row sweep — no per-fn TTL constant needed.

export const ACTIVE_STAGES = ['scheduled', 'onsite', 'uploaded', 'in_progress', 'in_revision', 'in_production'];
