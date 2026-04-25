/**
 * drone-render-preview
 * ────────────────────
 * Lightweight, in-memory render preview for the Theme Editor.
 *
 * Differences from `drone-render` (the full pipeline):
 *   - No project / shoot / shot lookup. Caller passes a theme config directly.
 *   - No Dropbox download. We use a small bundled DJI fixture (~170 KB) at
 *     ./_fixture.jpg, with a known synthetic scene (a few canned POIs +
 *     property pin coordinates derived from the fixture's real EXIF GPS).
 *   - No drone_renders insert; nothing is persisted. Pure read-only.
 *   - Returns the rendered JPEG inline as base64 in the JSON response so the
 *     editor can show it as `<img src="data:image/jpeg;base64,...">`.
 *
 * POST body:
 *   {
 *     theme_config:    object  (required) — the in-progress theme JSON
 *     sample_image_url?: string (ignored in v1; always uses bundled fixture)
 *     scene_overrides?: object — partial scene to merge over DEFAULT_SCENE
 *   }
 *
 * Response:
 *   { success: true, image_b64: string, format: "JPEG", elapsed_ms: number }
 *
 * Auth: any authenticated FlexStudios user.  Read-only operation; no writes.
 *
 * Speed target: <2 s round-trip (Modal warm-path is ~0.5 s).
 *
 * See IMPLEMENTATION_PLAN_V2.md §6.4 — Theme Editor live preview.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from "../_shared/supabase.ts";
import { getFixtureBytes } from "./_fixture.ts";

const GENERATOR = "drone-render-preview";

const MODAL_RENDER_URL =
  Deno.env.get("MODAL_RENDER_URL") ||
  "https://joseph-89037--flexstudios-drone-render-render-http.modal.run";
const RENDER_TOKEN = Deno.env.get("FLEXSTUDIOS_RENDER_TOKEN") || "";

// Roles permitted to call the preview. Employees / contractors don't author
// themes, so we drop them from the allow-list — narrows the SSRF surface and
// mirrors the Theme Editor UI gate. (#27 audit fix)
const PREVIEW_ALLOWED_ROLES = new Set(["master_admin", "admin", "manager"]);

// In-memory rate limit: 30 requests per minute per user. Theme Editor live
// preview spams the endpoint as the user moves a slider, so a soft cap keeps
// any single account from hammering Modal. The Map persists across requests
// in a single Edge Function isolate; cold starts reset the bucket but that's
// acceptable (worst case a user gets 60 requests in a row across two warm
// isolates). (#27 audit fix)
const PREVIEW_RATE_WINDOW_MS = 60 * 1000;
const PREVIEW_RATE_MAX = 30;
const previewBuckets = new Map<string, number[]>();

function rateLimitOk(userId: string): { ok: boolean; resetMs?: number } {
  const now = Date.now();
  const cutoff = now - PREVIEW_RATE_WINDOW_MS;
  const arr = previewBuckets.get(userId) || [];
  // Drop timestamps older than the window.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  const recent = i === 0 ? arr : arr.slice(i);
  if (recent.length >= PREVIEW_RATE_MAX) {
    return { ok: false, resetMs: PREVIEW_RATE_WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  previewBuckets.set(userId, recent);
  return { ok: true };
}

/**
 * Recursively scan a theme_config object and reject any `content.url` field —
 * the Modal renderer fetches that URL server-side, which would let an
 * authenticated caller pivot the Edge Function into an SSRF probe. We force
 * callers to inline `content_b64` instead, which has no network reach. (#28 audit fix)
 */
function findContentUrl(node: unknown, path: string[] = []): string | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findContentUrl(node[i], [...path, String(i)]);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  // Reject `content.url` exactly (the renderer's documented field) AND any
  // nested object with a top-level `url` under a key called `content`.
  for (const [k, v] of Object.entries(obj)) {
    if (k === "content" && v && typeof v === "object" && !Array.isArray(v)) {
      const cv = v as Record<string, unknown>;
      if (typeof cv.url === "string") return [...path, k, "url"].join(".");
    }
    const hit = findContentUrl(v, [...path, k]);
    if (hit) return hit;
  }
  return null;
}

// Bundled fixture: 800×599 DJI Mavic 3 Pro Cine sample (~170 KB JPEG),
// downscaled with Lanczos from supabase/functions/_shared/_fixtures/dji_sample.jpg
// and embedded as base64 in `_fixture.ts` (Supabase's eszip bundler only
// follows import edges, not Deno.readFile() URLs). See _fixture.ts for the
// real EXIF GPS values that DEFAULT_SCENE below mirrors.

// Default scene values. Lat/lon = the fixture's real EXIF GPS, alt/yaw/pitch
// ditto. The fixture is a NADIR shot (pitch=-90°) from ~36 m altitude, so
// only the area directly below the drone is visible — POIs and the property
// pin must be within ~30 m horizontal of the drone or they project off-frame
// and the render engine's bounds check (-200 < px < w+200) silently drops
// them. Compass-bearing labels are reflected in the metadata fields below.
const DEFAULT_SCENE: Record<string, unknown> = {
  // Drone EXIF (real values from fixture):
  lat: -33.944708,
  lon: 150.942519,
  alt: 35.9, // RelativeAltitude from original XMP
  yaw: -147.3, // FlightYawDegree (irrelevant under perfect nadir)
  pitch: -90.0, // GimbalPitchDegree (nadir)
  // Property pin: ~10 m NE of drone (well within the nadir footprint)
  property_lat: -33.944636,
  property_lon: 150.942573,
  address: "9 Chauvel Ave, Wattle Grove",
  street_number: "9",
  street_name: "Chauvel Ave",
  // Canned POIs at three different compass headings around the drone, all
  // within ~25 m so they land inside the visible sensor footprint.
  pois: [
    {
      name: "Wattle Grove Public School",
      lat: -33.944843,
      lon: 150.942519,
      distance_m: 280,
      type: "school",
    },
    {
      name: "Wattle Grove Park",
      lat: -33.944708,
      lon: 150.942324,
      distance_m: 220,
      type: "park",
    },
    {
      name: "Wattle Grove Shops",
      lat: -33.944600,
      lon: 150.942389,
      distance_m: 350,
      type: "shopping",
    },
  ],
  // Boundary polygon (a small rectangle around the property pin).
  // Render only uses this when theme.boundary.enabled === true.
  polygon_latlon: [
    [-33.944620, 150.942540],
    [-33.944620, 150.942610],
    [-33.944660, 150.942610],
    [-33.944660, 150.942540],
  ],
};

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  let body: {
    theme_config?: Record<string, unknown>;
    sample_image_url?: string;
    scene_overrides?: Record<string, unknown>;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: "v1.0", _fn: GENERATOR }, 200, req);
  }

  // Auth: master_admin / admin / manager only. Employees / contractors can't
  // author themes, so they don't need preview access. (#27 audit fix)
  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse("Authentication required", 401, req);
  const isService = user.id === "__service_role__";
  if (!isService && !PREVIEW_ALLOWED_ROLES.has(user.role || "")) {
    return errorResponse(`Role ${user.role || "(none)"} not permitted`, 403, req);
  }

  // Per-user rate limit. (#27 audit fix)
  if (!isService) {
    const rl = rateLimitOk(user.id);
    if (!rl.ok) {
      return errorResponse(
        `Rate limit exceeded (${PREVIEW_RATE_MAX} req/min). Retry in ${Math.ceil((rl.resetMs || 0) / 1000)}s.`,
        429,
        req,
      );
    }
  }

  if (!body.theme_config || typeof body.theme_config !== "object") {
    return errorResponse("theme_config required (object)", 400, req);
  }
  // Reject any content.url field — server-side fetch surface. (#28 audit fix)
  const ssrfHit = findContentUrl(body.theme_config);
  if (ssrfHit) {
    return errorResponse(
      `theme_config contains forbidden 'content.url' field at ${ssrfHit}; use 'content_b64' instead`,
      400,
      req,
    );
  }
  if (!RENDER_TOKEN) {
    return errorResponse(
      "FLEXSTUDIOS_RENDER_TOKEN secret not set; preview unavailable",
      500,
      req,
    );
  }

  // Load bundled fixture (decoded from embedded base64)
  let fixtureBytes: Uint8Array;
  try {
    fixtureBytes = getFixtureBytes();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`Fixture decode failed: ${msg}`, 500, req);
  }

  const scene = { ...DEFAULT_SCENE, ...(body.scene_overrides || {}) };

  const t0 = Date.now();

  // POST to Modal render_http endpoint. RENDER_TOKEN goes in the Authorization
  // header to keep it out of Modal's request-body error logs. The body field
  // is retained for backward compat with the deployed Modal worker.
  // TODO Wave 4: drop the body _token once Modal accepts header-only auth. (#7 audit)
  let modalResp: Response;
  try {
    modalResp = await fetch(MODAL_RENDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RENDER_TOKEN}`,
      },
      body: JSON.stringify({
        _token: RENDER_TOKEN,
        image_b64: base64Encode(fixtureBytes),
        theme: body.theme_config,
        scene,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`Modal request failed: ${msg}`, 502, req);
  }

  if (!modalResp.ok) {
    const errText = await modalResp.text().catch(() => "");
    return errorResponse(
      `Modal returned ${modalResp.status}: ${errText.slice(0, 300)}`,
      502,
      req,
    );
  }

  let modalJson: { image_b64?: string; format?: string };
  try {
    modalJson = await modalResp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`Modal returned non-JSON: ${msg}`, 502, req);
  }
  if (!modalJson.image_b64 || typeof modalJson.image_b64 !== "string") {
    return errorResponse("Modal response missing image_b64", 502, req);
  }

  const elapsed = Date.now() - t0;

  return jsonResponse(
    {
      success: true,
      image_b64: modalJson.image_b64,
      format: modalJson.format || "JPEG",
      elapsed_ms: elapsed,
    },
    200,
    req,
  );
});

// ── helpers ───────────────────────────────────────────────────────────────────

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as number[],
    );
  }
  return btoa(binary);
}
