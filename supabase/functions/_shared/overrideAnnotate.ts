/**
 * overrideAnnotate.ts — Wave 10.3 P1-16 pure validation + normalisation
 * helpers for the shortlisting-overrides "annotate" action.
 *
 * The annotate path lets the SignalAttributionModal patch a primary signal
 * onto an existing shortlisting_overrides row after the optimistic-UI override
 * row has already been inserted by the events path. Keeping the validation
 * logic in a pure helper means we can test its branches without spinning up a
 * Supabase mock (the index.ts wires the helper to the DB roundtrip).
 *
 * Spec: docs/design-specs/W10-3-override-metadata-columns.md §3 + §"Engine
 * integration".
 *
 * Contract:
 *   POST /shortlisting-overrides
 *   body: { annotate: { override_id: UUID, primary_signal_overridden: string|null } }
 *
 * The signal MAY be null (modal dismissed → row stays NULL, the legitimate
 * "editor was in flow, didn't annotate" signal). The signal MUST NOT exceed
 * 200 chars when non-null (matches mig 285's TEXT column with no DDL length
 * cap, but we cap at 200 for sanity / log-noise reasons).
 */

export interface AnnotateInput {
  override_id?: unknown;
  primary_signal_overridden?: unknown;
}

export type AnnotateValidationResult =
  | {
      ok: true;
      override_id: string;
      primary_signal_overridden: string | null;
    }
  | {
      ok: false;
      error_code:
        | 'ANNOTATE_NOT_OBJECT'
        | 'ANNOTATE_OVERRIDE_ID_REQUIRED'
        | 'ANNOTATE_SIGNAL_TYPE_INVALID'
        | 'ANNOTATE_SIGNAL_TOO_LONG';
      message: string;
    };

const SIGNAL_MAX_LEN = 200;

/**
 * Validate + normalise an annotate body. Pure — no DB, no Supabase clients,
 * no env access. The shortlisting-overrides edge fn calls this immediately
 * after JSON-parsing the body and before doing the project-access check +
 * UPDATE.
 */
export function validateAnnotate(body: unknown): AnnotateValidationResult {
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      error_code: 'ANNOTATE_NOT_OBJECT',
      message: 'annotate must be an object',
    };
  }
  const a = body as AnnotateInput;
  if (!a.override_id || typeof a.override_id !== 'string') {
    return {
      ok: false,
      error_code: 'ANNOTATE_OVERRIDE_ID_REQUIRED',
      message: 'annotate.override_id required (string UUID)',
    };
  }

  // primary_signal_overridden is optional — null/undefined collapses to null.
  const raw = a.primary_signal_overridden;
  let signal: string | null;
  if (raw === null || raw === undefined) {
    signal = null;
  } else if (typeof raw !== 'string') {
    return {
      ok: false,
      error_code: 'ANNOTATE_SIGNAL_TYPE_INVALID',
      message: 'annotate.primary_signal_overridden must be string or null',
    };
  } else {
    const trimmed = raw.trim();
    if (trimmed.length > SIGNAL_MAX_LEN) {
      return {
        ok: false,
        error_code: 'ANNOTATE_SIGNAL_TOO_LONG',
        message: `annotate.primary_signal_overridden must be ≤${SIGNAL_MAX_LEN} chars`,
      };
    }
    // Empty-after-trim collapses to null — semantically equivalent to "no
    // signal specified" and saves us a NULL-vs-empty-string ambiguity in
    // analytics queries downstream.
    signal = trimmed.length === 0 ? null : trimmed;
  }

  return {
    ok: true,
    override_id: a.override_id,
    primary_signal_overridden: signal,
  };
}
