import { useEntityAccess } from '@/components/auth/useEntityAccess';

/**
 * Price display component with role-based visibility.
 *
 * Wraps any monetary value with automatic show/hide/blur based on the
 * user's `pricing_visibility` access level in entity_access_rules.
 *
 * Usage:
 *   <Price value={249.99} />              → "$249.99"
 *   <Price value={1500} compact />        → "$1.5k"
 *   <Price value={0} fallback="Free" />   → "Free"
 *   <Price>{someFormattedString}</Price>   → wraps children
 *
 * Access levels:
 *   edit  → shown normally (full access)
 *   view  → shown normally (can see prices)
 *   none  → replaced with "••••" (prices hidden)
 */

const fmt = (val, compact) => {
  const n = Number(val) || 0;
  if (compact && Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`;
  }
  return `$${n.toFixed(2)}`;
};

export default function Price({ value, compact, fallback, children, className = '' }) {
  const { canView } = useEntityAccess('pricing_visibility');

  // If user can't view pricing, show masked placeholder
  if (!canView) {
    return (
      <span className={`inline-flex items-center ${className}`} data-sensitive="price" aria-label="Price hidden">
        <span className="text-muted-foreground select-none">$•••</span>
      </span>
    );
  }

  // If children provided, just wrap them
  if (children) {
    return <span className={className} data-sensitive="price">{children}</span>;
  }

  // Format the value
  const n = Number(value);
  if ((!n && n !== 0) || (n === 0 && fallback)) {
    return <span className={className} data-sensitive="price">{fallback || '$0.00'}</span>;
  }

  return <span className={`tabular-nums ${className}`} data-sensitive="price">{fmt(n, compact)}</span>;
}

/**
 * Hook for programmatic price visibility checks.
 * Use when you need to conditionally render entire sections (not just values).
 */
export function usePriceVisibility() {
  const { canView, canEdit } = useEntityAccess('pricing_visibility');
  return { canViewPricing: canView, canEditPricing: canEdit };
}
