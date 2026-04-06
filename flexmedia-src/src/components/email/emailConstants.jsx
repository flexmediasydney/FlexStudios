/**
 * Shared constants for email inbox and thread components
 */

// Priority badge styling
export const PRIORITY_STYLES = {
  none: 'bg-slate-50',
  yellow: 'bg-yellow-50',
  medium: 'bg-orange-50',
  attention: 'bg-red-50',
  completed: 'bg-green-50'
};

export const PRIORITY_LIST_STYLES = {
  none: '',
  yellow: 'bg-yellow-50/60 border-l-2 border-l-yellow-400',
  medium: 'bg-orange-50/60 border-l-2 border-l-orange-400',
  attention: 'bg-red-50/60 border-l-2 border-l-red-400',
  completed: 'bg-green-50/60 border-l-2 border-l-green-400'
};

// UI constants
export const HOVER_CARD_DELAY_MS = 200;
export const SEARCH_DEBOUNCE_MS = 300;
export const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
export const MAX_THREADS_TO_DISPLAY = 500;
export const MAX_UNDO_STACK = 20;
export const COLUMN_SAVE_DEBOUNCE_MS = 500;
export const SYNC_DEDUP_WINDOW_MS = 10000; // Minimum time between syncs