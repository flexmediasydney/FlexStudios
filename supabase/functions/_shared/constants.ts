// ─── Time constants ──────────────────────────────────────────────────────────
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR   = 60 * MS_PER_MINUTE;
export const MS_PER_DAY    = 24 * MS_PER_HOUR;
export const MS_PER_WEEK   = 7 * MS_PER_DAY;

// ─── Gmail sync defaults ────────────────────────────────────────────────────
export const GMAIL_DEFAULT_LOOKBACK_DAYS = 30;
export const GMAIL_HISTORY_FALLBACK_LOOKBACK_DAYS = 60;
export const GMAIL_LOOKBACK_MINUTES = 30;
export const MAX_MESSAGES_PER_SYNC = 2000;

// ─── Entity list limits (guard against unbounded queries) ───────────────────
export const MAX_AGENTS_FETCH  = 1000;
export const MAX_PROJECTS_FETCH = 2000;
export const MAX_USERS_FETCH   = 200;
