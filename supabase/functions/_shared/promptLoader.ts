/**
 * promptLoader.ts — Wave 6 P8 follow-up
 *
 * Reads the active prompt scaffolding from `shortlisting_prompt_versions` for
 * a given pass_kind. Edge functions call this at runtime so master_admin can
 * tune prompts via the SettingsShortlistingPrompts page without a redeploy.
 *
 * Resolution contract:
 *   - On hit: returns the active row's prompt_text + version.
 *   - On miss (no row, error, or empty text): returns null. Caller falls
 *     back to hardcoded constants from the source files. This means a DB
 *     outage or migration regression NEVER breaks the engine — it just
 *     reverts to whatever was committed in code.
 *
 * Pass kinds:
 *   pass0_reject  — full Haiku user-message text for the hard-reject call
 *   pass1_system  — Sonnet `system` message for Pass 1 classification
 *   pass2_system  — Sonnet `system` message for Pass 2 shortlisting
 *
 * Cost: a single SELECT per pass call. No caching today — Supabase RLS check
 * is fast enough at our volume. If we ever shortlist 1000+ rounds/hour we
 * can add a 60-second module-level cache here.
 */

import { getAdminClient } from './supabase.ts';

export type PassKind = 'pass0_reject' | 'pass1_system' | 'pass2_system';

export interface ActivePrompt {
  text: string;
  version: number;
}

/**
 * Fetch the active prompt for a pass_kind. Returns null on any failure mode
 * — caller MUST treat null as "use the hardcoded fallback".
 */
export async function getActivePrompt(passKind: PassKind): Promise<ActivePrompt | null> {
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('shortlisting_prompt_versions')
      .select('prompt_text, version')
      .eq('pass_kind', passKind)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.warn(`[promptLoader] ${passKind} query failed: ${error.message} — using code fallback`);
      return null;
    }
    if (!data || typeof data.prompt_text !== 'string' || data.prompt_text.trim().length === 0) {
      return null;
    }
    // Audit defect #55: a master_admin editing the prompt via the
    // SettingsShortlistingPrompts UI could remove the "ONLY JSON" guardrail
    // (or its equivalent) and break Sonnet's structured output. We fail safe
    // by validating the loaded prompt mentions JSON in some form; if not,
    // log a warning and fall back to the hardcoded constant in the caller
    // — that constant always contains the JSON guardrail.
    const promptText = data.prompt_text;
    const hasJsonGuardrail = /\bjson\b/i.test(promptText);
    if (!hasJsonGuardrail) {
      console.warn(
        `[promptLoader] ${passKind} v${data.version} appears to be missing a 'JSON' guardrail keyword — falling back to code default to avoid breaking the engine. Edit the prompt in SettingsShortlistingPrompts to include 'JSON' (case-insensitive).`,
      );
      return null;
    }
    return {
      text: promptText,
      version: typeof data.version === 'number' ? data.version : 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[promptLoader] ${passKind} threw: ${msg} — using code fallback`);
    return null;
  }
}
