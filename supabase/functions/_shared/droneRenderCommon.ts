/**
 * droneRenderCommon.ts
 * ────────────────────
 * Pipeline-agnostic helpers shared between drone-render (raw pipeline) and
 * drone-render-edited (edited pipeline). All exports here MUST be free of
 * pipeline-specific routing logic — that lives in the per-pipeline Edge
 * Function. This module is the proof that both pipelines can share the same
 * Modal call, theme chain resolution, scene assembly, and POI/boundary
 * fetching without coupling.
 *
 * Wave 5 Phase 2 (S2). Public surface is treated as stable from this commit
 * forward — S3/S4/S5/S6 may import any export below. Breaking-change to a
 * signature is a coordination event, not a refactor.
 *
 * Hard rule reiterated: this module knows NOTHING about
 *   - drone_renders.pipeline ('raw' vs 'edited')
 *   - which source path to use (raw dropbox_path vs edited_dropbox_path)
 *   - which folder kind to write outputs to
 *   - which column_state lane to write
 * Those are pipeline routing decisions; each Edge Function makes them and
 * passes the resolved values into the shared helpers below.
 */

import { getAdminClient } from "./supabase.ts";

// ──────────────────────────────────────────────────────────────────────
// Constants & env
// ──────────────────────────────────────────────────────────────────────

/** Modal HTTP endpoint that runs render_engine.py end-to-end. */
export const MODAL_RENDER_URL =
  Deno.env.get("MODAL_RENDER_URL") ||
  "https://joseph-89037--flexstudios-drone-render-render-http.modal.run";

/**
 * Bearer token expected by the Modal worker. Edge Function must hard-fail
 * if missing — render bridge unavailable. The token is sent as a Bearer
 * header AND in the body's `_token` field for back-compat with deployed
 * Modal workers; the body field can be dropped once Modal accepts
 * header-only auth.
 */
export const RENDER_TOKEN = Deno.env.get("FLEXSTUDIOS_RENDER_TOKEN") || "";

/**
 * Modal call timeout. 120s is below the Edge Function 145s wall-clock cap
 * and slightly above p99 Modal render latency observed in prod (~25-40s
 * for orbital + boundary). Tunable per-call via callModalRender opts.
 */
export const MODAL_RENDER_TIMEOUT_MS = 120_000;

/**
 * External-facing Supabase URL — used as the base for sub-calls because
 * `req.url` (visible inside the Edge Function) is the *internal* route
 * without the `/functions/v1/` prefix. Same pattern drone-raw-preview uses.
 */
export const PUBLIC_SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ||
  "https://rjzdznwkxnzfekgcdkei.supabase.co";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/** drone_renders.kind enum (CHECK constraint from migration 225). */
export type RenderKind = "poi" | "boundary" | "poi_plus_boundary";
export const ALLOWED_RENDER_KINDS: RenderKind[] = ["poi", "boundary", "poi_plus_boundary"];

/**
 * drone_custom_pins row shape — UNIFIED model (mig 268). Carries both
 * operator-created pins (source='manual') and AI-fetched POIs
 * (source='ai'). Pixel-anchored vs world-anchored is determined by
 * whether pixel_anchored_shot_id + pixel_x/y or world_lat/lng are set.
 */
export type CustomPinRow = {
  id: string;
  pin_type: 'poi_manual' | 'text' | 'line' | 'measurement';
  source: 'manual' | 'ai';
  subsource: string | null;
  external_ref: string | null;
  world_lat: number | null;
  world_lng: number | null;
  pixel_anchored_shot_id: string | null;
  pixel_x: number | null;
  pixel_y: number | null;
  content: Record<string, unknown> | null;
  style_overrides: Record<string, unknown> | null;
  priority: number;
};

/** Theme chain entry surfaced by loadThemeChain — mirrors drone_themes columns
 *  needed by render-time stamping (theme_id_at_render, version_int). */
export type ThemeChainEntry = {
  owner_kind: string;
  theme_id: string;
  config: Record<string, unknown>;
  version_int: number | null;
};

/** Result returned for each shot rendered in a batch. Same shape as the legacy
 *  drone-render local type — kept stable so S3 can return identical responses. */
export type RenderResult = {
  shot_id: string;
  filename: string;
  ok: boolean;
  out_path?: string;
  error?: string;
  /**
   * True when the shot was skipped because it has no edited_dropbox_path
   * and the render context requires the edited source. Surfaced separately
   * from generic failures so the caller (UI / dispatcher) can distinguish
   * "editor team owes us a file" from "render genuinely failed". Only
   * meaningful for the edited pipeline (S3); raw pipeline never sets it.
   */
  skipped_no_edit?: boolean;
  /** Diagnostic: number of POIs that the renderer passed to Modal for this shot. */
  pois_passed?: number;
  /** Diagnostic: shape of the first POI (key list) — to confirm lon mapping landed. */
  pois_first_keys?: string[];
  /** Diagnostic: raw count from fetchPois (before the orbital-only gate). */
  pois_from_fetch?: number;
  /** Diagnostic: shot role at time of render. */
  shot_role_at_render?: string;
  /** Diagnostic: needsPois(kind) result. */
  needs_pois?: boolean;
  /** Diagnostic: the resolved drone-pois sub-call URL the renderer computed. */
  pois_subcall_url?: string;
  /** Diagnostic: HTTP status returned by the drone-pois sub-call. */
  pois_subcall_status?: number;
  /** Diagnostic: first 200 chars of the drone-pois sub-call response body. */
  pois_subcall_body_head?: string;
  variants?: Array<{ variant: string; out_path: string }>;
};

/** Modal render response — what the Modal worker actually returns. */
export type ModalRenderResponse = {
  image_b64?: string;
  format?: string;
  variants?: Record<string, { image_b64: string; format?: string }>;
};

/** Decoded single-image variant uniform across single/multi response shapes. */
export type RenderVariantBytes = { name: string; bytes: Uint8Array; format: string };

/** Stash of the most recent drone-pois sub-call telemetry, surfaced per-shot. */
export type PoisSubcallTelemetry = {
  url?: string;
  status?: number;
  body_head?: string;
};

// ──────────────────────────────────────────────────────────────────────
// Kind helpers
// ──────────────────────────────────────────────────────────────────────

export function needsPois(kind: RenderKind): boolean {
  return kind === "poi" || kind === "poi_plus_boundary";
}

export function needsBoundary(kind: RenderKind): boolean {
  return kind === "boundary" || kind === "poi_plus_boundary";
}

/**
 * Validate caller-supplied `kind`, mapping the special-case 'preview' signal
 * to 'poi_plus_boundary'. Returns `{ kind, error }` — when error is set, the
 * caller should 400.
 *
 * The 'preview' string was historically allowed to flow through as a kind,
 * but writing it to drone_renders.kind violates the CHECK constraint from
 * mig 225. Map it to poi_plus_boundary + isPreviewRun=true at the call site.
 */
export function resolveRenderKind(rawKindRequest: string | undefined): { kind: RenderKind; error?: undefined } | { kind?: undefined; error: string } {
  if (rawKindRequest === "preview" || !rawKindRequest) {
    return { kind: "poi_plus_boundary" };
  }
  if (ALLOWED_RENDER_KINDS.includes(rawKindRequest as RenderKind)) {
    return { kind: rawKindRequest as RenderKind };
  }
  return {
    error: `kind '${rawKindRequest}' is not allowed (allowed: ${ALLOWED_RENDER_KINDS.join(", ")} or 'preview')`,
  };
}

/**
 * Apply per-kind theme tweaks. Defensive deep-clone of the incoming theme
 * so the caller's resolved theme isn't mutated. Render engine reads
 * boundary.enabled and pois length to decide what to draw.
 */
export function applyKindToTheme(theme: Record<string, unknown>, kind: RenderKind): Record<string, unknown> {
  const t = JSON.parse(JSON.stringify(theme || {})) as Record<string, unknown>;
  const boundary = (t.boundary as Record<string, unknown> | undefined) || {};
  const poiSel = (t.poi_selection as Record<string, unknown> | undefined) || {};
  if (kind === "poi") {
    if (t.boundary) (t.boundary as Record<string, unknown>).enabled = false;
  }
  if (kind === "boundary") {
    // FORCE boundary.enabled = true. Without this, kind='boundary' silently
    // produces a no-op render whenever the theme ships with boundary.enabled
    // = false (which most themes do, since most renders are POI-only).
    // Operators saw no boundary lines on the boundary-only render. (QC2 #20.)
    t.boundary = { ...boundary, enabled: true };
    t.poi_selection = { ...poiSel, max_pins_per_shot: 0 };
  }
  if (kind === "poi_plus_boundary") {
    if (t.boundary) (t.boundary as Record<string, unknown>).enabled = true;
  }
  return t;
}

// ──────────────────────────────────────────────────────────────────────
// Theme chain
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the inheritance chain (person → organisation → system) and return
 * the active default themes in order of priority (highest first). Brand
 * level is forward-compat (skipped). Pure DB read; no mutation.
 *
 * Returns version_int alongside id/config so the render-insert path can
 * stamp drone_renders.theme_version_int_at_render and the swimlane's
 * drone_renders_stale_against_theme RPC can later badge cards whose theme
 * has been edited since they were rendered (mig 244).
 */
export async function loadThemeChain(
  admin: ReturnType<typeof getAdminClient>,
  ids: { person_id: string | null; organisation_id: string | null },
): Promise<ThemeChainEntry[]> {
  const chain: ThemeChainEntry[] = [];

  if (ids.person_id) {
    const { data } = await admin
      .from("drone_themes")
      .select("id, config, version_int")
      .eq("owner_kind", "person")
      .eq("owner_id", ids.person_id)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();
    if (data) chain.push({ owner_kind: "person", theme_id: data.id, config: data.config, version_int: data.version_int ?? null });
  }
  if (ids.organisation_id) {
    const { data } = await admin
      .from("drone_themes")
      .select("id, config, version_int")
      .eq("owner_kind", "organisation")
      .eq("owner_id", ids.organisation_id)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();
    if (data) chain.push({ owner_kind: "organisation", theme_id: data.id, config: data.config, version_int: data.version_int ?? null });
  }
  // Brand level: forward-compat (skip)

  // System default — always last
  const { data: sys } = await admin
    .from("drone_themes")
    .select("id, config, version_int")
    .eq("owner_kind", "system")
    .eq("is_default", true)
    .eq("status", "active")
    .maybeSingle();
  if (sys) chain.push({ owner_kind: "system", theme_id: sys.id, config: sys.config, version_int: sys.version_int ?? null });

  return chain;
}

// ──────────────────────────────────────────────────────────────────────
// Custom pins (drone_custom_pins UNIFIED, mig 268)
// ──────────────────────────────────────────────────────────────────────

/**
 * Load active custom pins for a shoot+project and split them into
 *   - worldCustomPins: world-anchored (lat/lng) — fan out across every shot
 *   - pixelPinsByShot: pixel-anchored, indexed by pixel_anchored_shot_id
 *
 * Filters: lifecycle='active'; shoot OR project scope. Sorted by
 * priority DESC at query time so when max_pins truncates, manual edits
 * beat AI proposals (manual default priority=20, ai default=10).
 */
export async function loadCustomPins(
  admin: ReturnType<typeof getAdminClient>,
  ids: { shoot_id: string; project_id: string },
): Promise<{
  all: CustomPinRow[];
  worldCustomPins: CustomPinRow[];
  pixelPinsByShot: Map<string, CustomPinRow[]>;
  warning?: string;
}> {
  const { data: customPinsRaw, error: pinsErr } = await admin
    .from("drone_custom_pins")
    .select(
      "id, pin_type, source, subsource, external_ref, world_lat, world_lng, pixel_anchored_shot_id, pixel_x, pixel_y, content, style_overrides, priority",
    )
    .eq("lifecycle", "active")
    .or(`shoot_id.eq.${ids.shoot_id},project_id.eq.${ids.project_id}`)
    .order("priority", { ascending: false });

  const all: CustomPinRow[] = (customPinsRaw as CustomPinRow[] | null) || [];
  const worldCustomPins = all.filter(
    (p) =>
      (p.pin_type === 'poi_manual' ||
        p.pin_type === 'text' ||
        p.pin_type === 'line' ||
        p.pin_type === 'measurement') &&
      p.world_lat !== null &&
      p.world_lng !== null,
  );
  const pixelPinsByShot = new Map<string, CustomPinRow[]>();
  for (const p of all) {
    if (p.pixel_anchored_shot_id && p.pixel_x !== null && p.pixel_y !== null) {
      const arr = pixelPinsByShot.get(p.pixel_anchored_shot_id) || [];
      arr.push(p);
      pixelPinsByShot.set(p.pixel_anchored_shot_id, arr);
    }
  }
  return {
    all,
    worldCustomPins,
    pixelPinsByShot,
    warning: pinsErr ? `drone_custom_pins lookup failed (non-fatal): ${pinsErr.message}` : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POI + cadastral sub-calls
// ──────────────────────────────────────────────────────────────────────

/**
 * Fetch POIs from drone-pois Edge Function. Returns [] on any failure
 * (telemetry stashed in `telemetry` for diagnostic reporting).
 *
 * The pipeline argument is informational telemetry only — drone-pois
 * treats both pipelines identically (same Google Places call, same
 * drone_custom_pins materialisation). It exists so dropbox-webhook (S6)
 * can pass `pipeline:'edited'` when it kicks off a fresh fetch on editor
 * delivery, and the receiving function can log/branch in the future.
 */
export async function fetchPois(
  req: Request,
  projectId: string,
  telemetry: PoisSubcallTelemetry,
  opts: {
    radiusM?: number;
    typeQuotas?: Record<string, { priority?: number; max?: number }> | null;
    pipeline?: 'raw' | 'edited';
  } = {},
): Promise<Array<Record<string, unknown>>> {
  const baseUrl = `${PUBLIC_SUPABASE_URL}/functions/v1/drone-pois`;
  const auth = req.headers.get("Authorization");
  telemetry.url = baseUrl;
  telemetry.status = undefined;
  telemetry.body_head = undefined;
  const includeQuotas = !!opts.typeQuotas && typeof opts.typeQuotas === 'object' && Object.keys(opts.typeQuotas).length > 0;
  let r: Response;
  try {
    r = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({
        project_id: projectId,
        ...(opts.radiusM ? { radius_m: opts.radiusM } : {}),
        ...(includeQuotas ? { type_quotas: opts.typeQuotas } : {}),
        ...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
      }),
    });
  } catch (e) {
    telemetry.body_head = `THREW: ${e instanceof Error ? e.message : e}`;
    return [];
  }
  telemetry.status = r.status;
  const text = await r.text().catch(() => "");
  telemetry.body_head = text.slice(0, 200);
  if (!r.ok) return [];
  let j: { pois?: unknown[] } = {};
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  return (j.pois as Array<Record<string, unknown>>) || [];
}

/**
 * Fetch the cadastral DCDB polygon for a project. Returns null on any
 * failure or when drone-cadastral reports !success.
 */
export async function fetchCadastral(
  req: Request,
  projectId: string,
): Promise<{ polygon?: Array<{ lat: number; lng: number }>; [k: string]: unknown } | null> {
  const baseUrl = `${PUBLIC_SUPABASE_URL}/functions/v1/drone-cadastral`;
  const auth = req.headers.get("Authorization");
  const r = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!r.ok) {
    console.warn(`drone-cadastral sub-call failed ${r.status}`);
    return null;
  }
  const j = await r.json().catch(() => ({}));
  return j.success ? j : null;
}

// ──────────────────────────────────────────────────────────────────────
// Modal render call
// ──────────────────────────────────────────────────────────────────────

/**
 * POST a render request to the Modal HTTP endpoint. Returns the parsed
 * JSON response (caller maps variants → bytes via decodeModalVariants).
 *
 * RENDER_TOKEN is sent as a Bearer header to avoid leaking it through
 * Modal's request-body error logs. The body field (_token) is retained
 * for backward compat with the deployed Modal worker.
 *
 * Throws on non-2xx with a message that includes status + first 200
 * chars of the body. Caller decides how to surface (per-shot error vs
 * batch failure).
 */
export async function callModalRender(args: {
  imageBytes: Uint8Array;
  theme: Record<string, unknown>;
  scene: Record<string, unknown>;
  variants: boolean;
  timeoutMs?: number;
}): Promise<ModalRenderResponse> {
  if (!RENDER_TOKEN) {
    throw new Error("FLEXSTUDIOS_RENDER_TOKEN not set");
  }
  const resp = await fetch(MODAL_RENDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RENDER_TOKEN}`,
    },
    body: JSON.stringify({
      _token: RENDER_TOKEN,
      image_b64: base64Encode(args.imageBytes),
      theme: args.theme,
      scene: args.scene,
      variants: args.variants,
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? MODAL_RENDER_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Modal returned ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return await resp.json() as ModalRenderResponse;
}

/**
 * Map the Modal response into a uniform `[{ name, bytes, format }, ...]`
 * regardless of single-image vs multi-variant response shape.
 */
export function decodeModalVariants(modalJson: ModalRenderResponse): RenderVariantBytes[] {
  const out: RenderVariantBytes[] = [];
  if (modalJson.variants && typeof modalJson.variants === "object") {
    for (const [name, v] of Object.entries(modalJson.variants)) {
      if (v?.image_b64) {
        out.push({
          name,
          bytes: base64Decode(v.image_b64),
          format: (v.format || "JPEG").toUpperCase(),
        });
      }
    }
  }
  if (out.length === 0 && modalJson.image_b64) {
    out.push({
      name: "default",
      bytes: base64Decode(modalJson.image_b64),
      format: (modalJson.format || "JPEG").toUpperCase(),
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Scene + filename + base64 helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the address overlay text for a project. Strips empties and
 * comma-joins. Mirrors what render_engine.py expects in scene.address.
 */
export function buildAddressOverlay(project: { property_address?: string | null; property_suburb?: string | null }): string {
  return [project.property_address, project.property_suburb].filter(Boolean).join(", ");
}

/**
 * Normalise a POI list into the shape Modal's render_engine expects.
 * drone-pois (Google Places) returns `lng`; render_engine reads `poi["lon"]`.
 * Map both — keep `lng` for downstream JS readers, add `lon` for Modal.
 */
export function normalisePoisForModal(pois: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return pois.map((p) => ({ ...p, lon: (p as { lng?: number; lon?: number }).lng ?? (p as { lon?: number }).lon }));
}

/**
 * Build a uniform `pinsForThisShot` list combining world-anchored (project/
 * shoot scope) + pixel-anchored (this shot only) pins. Applies role-gating
 * so AI POIs only show on roles where they're appropriate.
 *
 * `poisAllowedForRole` should be true ONLY for shot_role='orbital' per
 * Joseph's call 2026-04-25 spot-checking Everton previews. Building hero,
 * oblique hero, nadir hero, and unclassified are framing-driven
 * deliverables where POI labels add visual clutter without useful context.
 */
export function buildSceneCustomPins(args: {
  worldCustomPins: CustomPinRow[];
  pixelPinsByShot: Map<string, CustomPinRow[]>;
  shotId: string;
  poisAllowedForRole: boolean;
}): Array<{
  pin_type: string;
  source?: string;
  external_ref?: string | null;
  world_lat?: number;
  world_lng?: number;
  pixel_x?: number;
  pixel_y?: number;
  content?: Record<string, unknown> | null;
  style_overrides?: Record<string, unknown> | null;
}> {
  const out: ReturnType<typeof buildSceneCustomPins> = [];
  for (const wp of args.worldCustomPins) {
    // AI pins are POI labels — gate by role like the legacy POI loop.
    if (wp.source === 'ai' && !args.poisAllowedForRole) continue;
    out.push({
      pin_type: wp.pin_type,
      source: wp.source,
      external_ref: wp.external_ref,
      world_lat: wp.world_lat as number,
      world_lng: wp.world_lng as number,
      content: wp.content,
      style_overrides: wp.style_overrides,
    });
  }
  const myPixelPins = args.pixelPinsByShot.get(args.shotId) || [];
  for (const pp of myPixelPins) {
    out.push({
      pin_type: pp.pin_type,
      source: pp.source,
      external_ref: pp.external_ref,
      pixel_x: pp.pixel_x as number,
      pixel_y: pp.pixel_y as number,
      content: pp.content,
      style_overrides: pp.style_overrides,
    });
  }
  return out;
}

/**
 * Apply the theme-driven max_pins_per_shot truncation. Caller is
 * responsible for sorting by priority DESC before calling (the
 * loadCustomPins helper does this at query time).
 */
export function capPinsByMax(
  pins: ReturnType<typeof buildSceneCustomPins>,
  themeForKind: Record<string, unknown> | undefined,
): ReturnType<typeof buildSceneCustomPins> {
  const sel = (themeForKind?.poi_selection as Record<string, unknown> | undefined) || {};
  const maxPins = Number(sel.max_pins_per_shot);
  const cap = Number.isFinite(maxPins) && maxPins > 0 ? Math.floor(maxPins) : null;
  return cap !== null ? pins.slice(0, cap) : pins;
}

/**
 * Build the output filename for a render: <basename>__<kind>[__<variant>].<ext>
 * The "default" variant (single-output themes) keeps the legacy shape with
 * no variant suffix to avoid churning existing renders.
 */
export function filenameForRender(
  srcFilename: string,
  kind: RenderKind,
  variantName?: string,
  format?: string,
): string {
  const dot = srcFilename.lastIndexOf(".");
  const base = dot > 0 ? srcFilename.slice(0, dot) : srcFilename;
  const fmt = (format || "JPEG").toUpperCase();
  const ext = fmt === "PNG" ? "png" : fmt === "TIFF" ? "tif" : "jpg";
  if (!variantName || variantName === "default") {
    return `${base}__${kind}.${ext}`;
  }
  return `${base}__${kind}__${variantName}.${ext}`;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
