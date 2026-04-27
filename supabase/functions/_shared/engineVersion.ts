/**
 * engineVersion.ts — Wave 8 (W8.4) engine code version stamp.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §3 + R4.
 *
 * Single hardcoded constant bumped per wave-completion commit. Not pulled
 * from `process.env.GIT_SHA` — Vercel deploys vs Supabase edge-fn deploys
 * have different git SHAs and would create false noise (R4). A wave-stamped
 * string matches what the analytics need: "rounds run under the Wave 8
 * engine".
 *
 * Imported by:
 *   - shortlisting-ingest (writes to shortlisting_rounds.engine_version at bootstrap)
 *   - shortlisting-benchmark-runner (already records engine_version per benchmark)
 *   - simulate-tier-config (round provenance check)
 *
 * When bumping for a hotfix or new wave, update this constant in a follow-up
 * commit. The TypeScript value is a literal type so misspellings surface at
 * compile time.
 */

export const ENGINE_VERSION = 'wave-8-v1';
