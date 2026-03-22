// Shared constants and types for processTonomoQueue

export const PROCESSOR_VERSION = "v3.1";
export const BATCH_SIZE = 25;
export const LOCK_TTL_SECONDS = 90;

export const ACTIVE_STAGES = ['scheduled', 'onsite', 'uploaded', 'submitted', 'in_revision', 'in_production'];
