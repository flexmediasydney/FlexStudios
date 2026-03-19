/**
 * useSmartEntityData.jsx
 *
 * Legacy shim — re-exports from the rewritten useEntityData hooks.
 * All caching, dedup, and fan-out now happen there.
 *
 * Call-site options (skipCache, priority) are accepted but silently ignored —
 * caching is automatic and global, priority queuing is no longer needed
 * because dedup prevents redundant requests entirely.
 */

export { useEntityList as useSmartEntityList, useEntityData as useSmartEntityData, clearEntityCache } from '@/components/hooks/useEntityData';