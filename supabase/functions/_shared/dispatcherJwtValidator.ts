/**
 * Dispatcher JWT structural validator.
 *
 * Wave 7 P0-2: shortlisting-job-dispatcher's `_health_check` endpoint uses
 * this to fail-loud with HTTP 503 when the SHORTLISTING_DISPATCHER_JWT
 * secret is missing OR set to a value that isn't a real Supabase
 * service-role JWT. Round 2 (2026-04-26) cost ~15 minutes debugging this
 * exact case — the secret was unset, the function ran, but every chained
 * call to extract/pass0/pass1/pass2/pass3 silently 401'd.
 *
 * Lives in _shared/ instead of inline in shortlisting-job-dispatcher/index.ts
 * so the unit test can import it without dragging in the full edge-runtime
 * env (which requires SUPABASE_URL etc to be set at module load).
 */

/**
 * Validate that a string is a Supabase service-role JWT.
 *
 * Performs a CHEAP structural check (no signature verification — the
 * downstream edge function's gateway does that):
 *   1. Three dot-separated parts.
 *   2. The middle part decodes from base64url to JSON.
 *   3. The decoded JSON has `role === 'service_role'`.
 *
 * Anything else (sb_secret_* env values, anon JWTs, garbage) returns
 * `{ ok: false, error: <reason> }`.
 *
 * Used at startup AND at health-probe time. SettingsOperationsHealth.jsx
 * relies on the dispatcher's `secrets_ok: true` field as a proxy for
 * "the dispatcher will be able to chain calls".
 */
export function validateDispatcherJwt(
  raw: string,
): { ok: true } | { ok: false; error: string } {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "JWT is empty" };
  }
  const parts = raw.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `expected 3 dot-separated parts, got ${parts.length}`,
    };
  }
  // Base64url decode the payload (middle segment). Pad as needed.
  let payloadJson: string;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    payloadJson = atob(padded);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `base64 decode failed: ${msg}` };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `payload is not JSON: ${msg}` };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload is not an object" };
  }
  if (payload.role !== "service_role") {
    return {
      ok: false,
      error: `role is "${payload.role ?? "<missing>"}", expected "service_role"`,
    };
  }
  return { ok: true };
}
