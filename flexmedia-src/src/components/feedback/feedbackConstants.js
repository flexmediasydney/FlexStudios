/**
 * Shared constants for the feedback tracker.
 * All colour classes are tailwind utility strings so the bundler can tree-shake.
 */

export const TYPE_META = {
  bug: {
    label: 'Bug',
    badge: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800',
    dot: 'bg-red-500',
  },
  improvement: {
    label: 'Improvement',
    badge: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800',
    dot: 'bg-blue-500',
  },
  feature_request: {
    label: 'Feature',
    badge: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800',
    dot: 'bg-purple-500',
  },
};

export const SEVERITY_META = {
  critical: { label: 'Critical', dot: 'bg-red-500', ring: 'ring-red-500' },
  high:     { label: 'High',     dot: 'bg-orange-500', ring: 'ring-orange-500' },
  medium:   { label: 'Medium',   dot: 'bg-amber-500', ring: 'ring-amber-500' },
  low:      { label: 'Low',      dot: 'bg-slate-400', ring: 'ring-slate-400' },
};

/**
 * Kanban columns.
 * 'duplicate' is intentionally folded into the Declined column so triage
 * doesn't need to hunt across two buckets for closed items.
 */
export const STATUS_COLUMNS = [
  { id: 'new',         label: 'New',      color: 'bg-slate-100 dark:bg-slate-800/60' },
  { id: 'triaging',    label: 'Triaging', color: 'bg-amber-100 dark:bg-amber-900/40' },
  { id: 'accepted',    label: 'Up Next',  color: 'bg-blue-100 dark:bg-blue-900/40' },
  { id: 'in_progress', label: 'In Prog.', color: 'bg-indigo-100 dark:bg-indigo-900/40' },
  { id: 'shipped',     label: 'Shipped',  color: 'bg-green-100 dark:bg-green-900/40' },
  { id: 'declined',    label: 'Declined', color: 'bg-rose-100 dark:bg-rose-900/40' },
];

export const STATUS_META = STATUS_COLUMNS.reduce((acc, c) => {
  acc[c.id] = c;
  return acc;
}, {});

// Map 'duplicate' -> declined column for rendering purposes
export function columnForStatus(status) {
  if (status === 'duplicate') return 'declined';
  return status;
}

export const AREA_OPTIONS = [
  'Pricing',
  'Industry Pulse',
  'Tonomo',
  'Media',
  'Tasks',
  'Projects',
  'Calendar',
  'Email',
  'Other',
];
