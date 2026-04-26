/**
 * DroneBoundaryEditor — page wrapper, Wave 5 Phase 2 Stream S5
 *
 * Mirrors DronePinEditor.jsx's shape — a full-screen route that loads
 * everything the canvas needs and hands it to <DroneBoundaryEditor />.
 *
 * URL convention:
 *   /DroneBoundaryEditor?project=<projectId>[&shoot=<shootId>][&shot=<shotId>]
 *
 * `shoot` / `shot` are optional. When present they pin the source image to
 * a specific Edited render (matching the swimlane card the operator was
 * looking at). When absent we fall back to the project's first available
 * Edited render across any shoot — the polygon edits are project-scoped so
 * the choice of which Edited image we draw on is purely visual context.
 *
 * Loads:
 *   - drone_property_boundary (by project_id) — null on first edit
 *   - drone-cadastral fetch when no boundary row exists, so the canvas has
 *     a polygon to start from
 *   - drone_renders (Edited pipeline only) → pick one with column_state in
 *     ('proposed','adjustments','final') for source image
 *   - the rendered JPG via Dropbox proxy → blob URL
 *   - drone_shoots / drone_shots → poseShot for projection
 *   - project (for property_address + property_suburb fallback for the
 *     address overlay's auto text)
 *
 * Save handler:
 *   - api.functions.invoke('drone-boundary-save', payload)
 *   - On 200: toast "Re-rendering N edited shoots — boundary updated",
 *     invalidate drone_renders + drone_property_boundary, navigate back.
 *   - On 409 (version mismatch): the editor shows the conflict dialog
 *     and exposes an Accept-server / Keep-mine choice.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import DroneBoundaryEditor from "@/components/drone/DroneBoundaryEditor";
import { enqueueFetch } from "@/utils/mediaPerf";
import { usePermissions } from "@/components/auth/PermissionGuard";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// Authenticated POST → blob URL fetcher (mirrors DronePinEditor).
//
// W6 FIX 9 (QC3-2 B14): the Authorization header was hard-coded to the
// anon key — but getDeliveryMediaFeed's `action:'proxy'` path requires a
// real user session (the function checks RLS via the user's row in
// `users` to decide which Dropbox account to proxy through). With anon,
// the proxy returned 401 for any operator who hadn't been auto-bootstrapped
// into the anon-allowed row set. Switch to the live session token; fall
// back to anon if (somehow) no session is present, preserving the previous
// failure mode rather than blowing up the editor mount.
async function _proxyFetchToBlob(path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const { data: sessData } = await supabase.auth.getSession();
    const token = sessData?.session?.access_token || SUPABASE_ANON;
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "proxy", file_path: path }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type?.startsWith("image/") && blob.size < 200) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

const COLUMN_PRIORITY = ["final", "adjustments", "proposed", "raw"];

function pickEditedRender(renders) {
  if (!Array.isArray(renders) || renders.length === 0) return null;
  // Prefer the edited pipeline; fall back to any if no pipeline column.
  const edited = renders.filter(
    (r) => r.pipeline === "edited" || r.column_state === "adjustments",
  );
  const pool = edited.length > 0 ? edited : renders;
  for (const col of COLUMN_PRIORITY) {
    const r = pool.find((x) => x.column_state === col && x.dropbox_path);
    if (r) return r;
  }
  return pool.find((r) => r.dropbox_path) || null;
}

export default function DroneBoundaryEditorPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // W6 FIX 9 (route guard): the boundary editor mutates project-scoped
  // drone_property_boundary + cascades a project-wide re-render. The
  // DroneEditsSubtab's "Boundary" button is gated on isManagerOrAbove,
  // but a deep-link to /DroneBoundaryEditor?project=... bypassed that.
  // Add the equivalent check here. Hook lives at the top so the early-
  // return gate below it doesn't trigger React #310 (cf. FIX 2).
  const { isManagerOrAbove } = usePermissions();

  const projectId = searchParams.get("project");
  const shootIdParam = searchParams.get("shoot");
  const shotIdParam = searchParams.get("shot");

  // ── Project context ─────────────────────────────────────────────────────
  const projectQ = useQuery({
    queryKey: ["projects", "boundary-editor", projectId],
    queryFn: () => (projectId ? api.entities.Project.get(projectId) : null),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  // ── Boundary row (may not exist yet) ────────────────────────────────────
  const boundaryQ = useQuery({
    queryKey: ["drone_property_boundary", projectId],
    queryFn: async () => {
      if (!projectId) return null;
      const rows = await api.entities.DronePropertyBoundary.filter(
        { project_id: projectId },
        null,
        1,
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  // ── Cadastral fallback (only when no boundary row exists) ───────────────
  const cadastralQ = useQuery({
    queryKey: ["drone_cadastral", "boundary-editor", projectId],
    queryFn: async () => {
      if (!projectId) return null;
      try {
        const resp = await api.functions.invoke("drone-cadastral", {
          project_id: projectId,
        });
        return resp?.data || null;
      } catch (e) {
        console.warn("[DroneBoundaryEditor] drone-cadastral failed:", e);
        return null;
      }
    },
    enabled: Boolean(projectId) && boundaryQ.isFetched && !boundaryQ.data,
    staleTime: 5 * 60_000,
  });

  // ── Shoots / shots / renders for the source image ──────────────────────
  const shootsQ = useQuery({
    queryKey: ["drone_shoots", "by-project", projectId],
    queryFn: () =>
      projectId
        ? api.entities.DroneShoot.filter({ project_id: projectId }, "-created_at", 50)
        : [],
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  const shootIds = useMemo(
    () => (Array.isArray(shootsQ.data) ? shootsQ.data.map((s) => s.id) : []),
    [shootsQ.data],
  );

  const shotsQ = useQuery({
    queryKey: ["drone_shots", "by-shoots", shootIds.join(",")],
    queryFn: async () => {
      if (shootIds.length === 0) return [];
      return api.entities.DroneShot.filter(
        { shoot_id: { $in: shootIds } },
        "dji_index",
        2000,
      );
    },
    enabled: shootIds.length > 0,
    staleTime: 30_000,
  });

  const rendersQ = useQuery({
    queryKey: ["drone_renders", "by-shoots", shootIds.join(",")],
    queryFn: async () => {
      const shots = Array.isArray(shotsQ.data) ? shotsQ.data : [];
      const ids = shots.map((s) => s.id);
      if (ids.length === 0) return [];
      return api.entities.DroneRender.filter(
        { shot_id: { $in: ids } },
        "-created_at",
        2000,
      );
    },
    enabled:
      Array.isArray(shotsQ.data) && shotsQ.data.length > 0,
    staleTime: 30_000,
  });

  // ── Resolve which render → which shot we project against ───────────────
  const sourceRender = useMemo(() => {
    const all = rendersQ.data || [];
    if (shotIdParam) {
      const exact = all.find(
        (r) => r.shot_id === shotIdParam && r.dropbox_path,
      );
      if (exact) return exact;
    }
    return pickEditedRender(all);
  }, [rendersQ.data, shotIdParam]);

  const poseShot = useMemo(() => {
    if (!sourceRender || !Array.isArray(shotsQ.data)) return null;
    return shotsQ.data.find((s) => s.id === sourceRender.shot_id) || null;
  }, [sourceRender, shotsQ.data]);

  // ── Dropbox blob URL for the source image ──────────────────────────────
  const blobCacheRef = useRef(null);
  if (blobCacheRef.current === null) blobCacheRef.current = new Map();
  const [imageUrl, setImageUrl] = useState(null);
  const [imageError, setImageError] = useState(null);
  const imagePath = sourceRender?.dropbox_path || null;
  useEffect(() => {
    let cancelled = false;
    setImageError(null);
    if (!imagePath) {
      setImageUrl(null);
      return;
    }
    const cache = blobCacheRef.current;
    if (cache.has(imagePath)) {
      setImageUrl(cache.get(imagePath));
      return;
    }
    enqueueFetch(() => _proxyFetchToBlob(imagePath))
      .then((url) => {
        if (cancelled) {
          if (url && url.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* ignore */
            }
          }
          return;
        }
        if (!url) {
          setImageError("Image not available — render may still be processing.");
          setImageUrl(null);
        } else {
          cache.set(imagePath, url);
          setImageUrl(url);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setImageError(e?.message || "Failed to load image");
        setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath]);

  // Unmount: revoke every blob this page minted.
  useEffect(() => {
    return () => {
      const cache = blobCacheRef.current;
      if (!cache) return;
      for (const url of cache.values()) {
        if (typeof url === "string" && url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
        }
      }
      cache.clear();
    };
  }, []);

  // ── Build initial state for the editor ─────────────────────────────────
  const initialBoundary = useMemo(() => {
    const b = boundaryQ.data;
    if (b) {
      return {
        polygon: Array.isArray(b.polygon_latlng) ? b.polygon_latlng : [],
        source: b.source || "operator",
        overrides: extractOverridesFromRow(b),
        savedVersion: typeof b.version === "number" ? b.version : null,
      };
    }
    // No boundary row yet — seed from the cadastral fetch (if available).
    const cad = cadastralQ.data;
    const polygonFromCad =
      cad && Array.isArray(cad.polygon)
        ? cad.polygon
            .filter(
              (v) =>
                v &&
                typeof v === "object" &&
                Number.isFinite(v.lat) &&
                Number.isFinite(v.lng),
            )
            .map((v) => [v.lat, v.lng])
        : [];
    return {
      polygon: polygonFromCad,
      source: "cadastral",
      overrides: null,
      savedVersion: null,
    };
  }, [boundaryQ.data, cadastralQ.data]);

  const cadastralAvailable = Boolean(
    boundaryQ.data?.cadastral_snapshot &&
      Array.isArray(boundaryQ.data.cadastral_snapshot) &&
      boundaryQ.data.cadastral_snapshot.length >= 3,
  );

  // ── Save / reset handlers ──────────────────────────────────────────────
  // The editor calls these and gets back { ok, status, body } so it can
  // distinguish 200 / 409 / 500. We do the page-level toasts + invalidations
  // here so the editor stays decoupled from react-query / navigation.
  const invokeBoundary = useCallback(
    async (payload) => {
      // W8 FIX 3 (P0, F1): pass throwOnError:false so the rich error is
      // returned in `error` instead of thrown. W6 FIX 1's default-throw
      // behavior collapsed our 409 conflict UX into a generic exception
      // (the dialog never opened); we need the structured shape to branch
      // on status===409 → server `current_row` / `current_version` → open
      // the merge dialog with the operator's view of the latest server
      // state side-by-side.
      const res = await api.functions.invoke("drone-boundary-save", payload, {
        throwOnError: false,
      });
      // api.functions.invoke wraps the function's response in { data, error }.
      // For a non-2xx the wrapper returns either error: { name, status, message }
      // or just .data with the body — check both.
      const body = res?.data ?? null;
      const status =
        res?.error?.status ??
        res?.error?.context?.status ??
        (body?.success === false ? body?.status || (body?.error === "version_mismatch" ? 409 : 500) : 200);
      const ok = status >= 200 && status < 300 && body?.success !== false;
      return { ok, status, body };
    },
    [],
  );

  const handleSave = useCallback(
    async (payload) => {
      const result = await invokeBoundary(payload);
      if (result.ok) {
        toast.success(
          result.body?.cascade_pending
            ? "Boundary saved — re-rendering edited shoots"
            : "Boundary saved",
        );
        queryClient.invalidateQueries({
          queryKey: ["drone_property_boundary", projectId],
        });
        // Renders will swap server-side; nudge the cache.
        queryClient.invalidateQueries({
          queryKey: ["drone_renders", "by-shoots", shootIds.join(",")],
        });
      }
      return result;
    },
    [invokeBoundary, projectId, queryClient, shootIds],
  );

  const handleReset = useCallback(
    async (payload) => {
      const result = await invokeBoundary(payload);
      if (result.ok) {
        toast.success("Reset to NSW DCDB — re-rendering edited shoots");
        queryClient.invalidateQueries({
          queryKey: ["drone_property_boundary", projectId],
        });
        queryClient.invalidateQueries({
          queryKey: ["drone_renders", "by-shoots", shootIds.join(",")],
        });
      }
      return result;
    },
    [invokeBoundary, projectId, queryClient, shootIds],
  );

  const goBack = useCallback(() => {
    navigate(
      createPageUrl(`ProjectDetails?id=${projectId}&tab=drones&subtab=edits`),
    );
  }, [navigate, projectId]);

  // ── Loading / error states ──────────────────────────────────────────────
  // (No more hook calls below this line — only render branches.)
  if (!projectId) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <p className="text-sm">Missing project id in URL.</p>
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  // W6 FIX 9 (route guard): editing the boundary cascades a project-wide
  // re-render — must be gated like the swimlane button. Deep-links from
  // shared URLs / browser history hit this; non-managers see a friendly
  // forbidden screen rather than a hung Save call.
  if (!isManagerOrAbove) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-8">
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <p className="text-sm font-medium">You don't have access to the Boundary Editor</p>
        <p className="text-xs text-muted-foreground max-w-md text-center">
          Editing the property boundary requires Manager-or-above
          permissions. Ask an admin to make the change for you, or
          request a role upgrade.
        </p>
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Go back
        </Button>
      </div>
    );
  }

  const isLoading =
    projectQ.isLoading ||
    boundaryQ.isLoading ||
    shootsQ.isLoading ||
    shotsQ.isLoading ||
    rendersQ.isLoading ||
    (boundaryQ.isFetched && !boundaryQ.data && cadastralQ.isLoading);

  const fatal = projectQ.error || boundaryQ.error;

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="text-xs text-muted-foreground">Loading boundary editor…</p>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-8">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="text-sm font-medium">Failed to load boundary editor</p>
        <p className="text-xs text-muted-foreground max-w-md text-center">
          {fatal?.message || "Unknown error"}
        </p>
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Go back
        </Button>
      </div>
    );
  }

  // Polygon required to render the editor — if neither boundary row nor
  // cadastral has one, show a friendly empty state.
  if (!initialBoundary.polygon || initialBoundary.polygon.length < 3) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-8">
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <p className="text-sm font-medium">No polygon available</p>
        <p className="text-xs text-muted-foreground max-w-md text-center">
          Couldn't load a property boundary or fetch the NSW cadastral
          polygon. Try refreshing once the cadastral cache is warm, or
          contact support.
        </p>
        <Button variant="outline" onClick={goBack} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to project
        </Button>
      </div>
    );
  }

  const projectAddress = projectQ.data?.property_address
    ? [projectQ.data.property_address, projectQ.data.property_suburb]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <DroneBoundaryEditor
      initialBoundary={initialBoundary}
      imageUrl={imageUrl}
      imageError={imageError}
      poseShot={poseShot}
      projectId={projectId}
      projectAddress={projectAddress}
      cadastralAvailable={cadastralAvailable}
      onSave={handleSave}
      onReset={handleReset}
      onCancel={goBack}
    />
  );
}

// ── Helper (mirrors the one in DroneBoundaryEditor.jsx) ──────────────────
function extractOverridesFromRow(row) {
  if (!row) return null;
  return {
    side_measurements_enabled: row.side_measurements_enabled !== false,
    side_measurements_overrides: row.side_measurements_overrides || null,
    sqm_total_enabled: row.sqm_total_enabled !== false,
    sqm_total_position_offset_px: row.sqm_total_position_offset_px || null,
    sqm_total_value_override:
      row.sqm_total_value_override === undefined ? null : row.sqm_total_value_override,
    address_overlay_enabled: row.address_overlay_enabled !== false,
    address_overlay_position_latlng: row.address_overlay_position_latlng || null,
    address_overlay_text_override:
      row.address_overlay_text_override === undefined
        ? null
        : row.address_overlay_text_override,
  };
}
