/**
 * DronePinEditor — Drone Phase 6 Stream L
 *
 * Full-screen page that hosts <PinEditor />. URL convention follows the rest of
 * FlexStudios (flat page name + query string):
 *
 *   /DronePinEditor?project=<projectId>&shoot=<shootId>&shot=<shotId>
 *
 * Loads:
 *   - drone_shoots (by id)
 *   - drone_shots[] (by shoot_id)
 *   - drone_renders (latest per shot, prefer column_state in:
 *       'final','adjustments','proposed','raw')
 *   - drone_custom_pins (by shoot_id)
 *   - drone_sfm_runs (latest succeeded for shoot — used to determine
 *       pose-availability flag)
 *   - getDroneTheme edge function (resolved theme)
 *   - project (for confirmed_lat/lng / geocoded_lat/lng + address)
 *
 * Rendering:
 *   - While loading → spinner
 *   - On error → user-friendly message with [Back to project] button
 *   - On success → <PinEditor />
 *
 * Save / Cancel both navigate back to /ProjectDetails?id=... &tab=drones
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import PinEditor from "@/components/drone/PinEditor";
import { enqueueFetch } from "@/utils/mediaPerf";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// ── Isolated Pin Editor blob cache ─────────────────────────────────────────
// PinEditor's `previousImageUrlRef` cleanup revokes the blob URL it was given
// when it unmounts. If we fed it a URL stored in SHARED_THUMB_CACHE, the
// global cache would still hold the now-revoked URL — opening the Pin Editor
// would silently break thumbnails app-wide (renders subtab, shots subtab,
// swimlane) until LRU eviction.
//
// Solution: every Pin Editor mount owns its own cache. The page revokes any
// blobs it created on unmount, and the swimlane's SHARED_THUMB_CACHE is
// never touched.
async function _pinEditorFetchProxy(path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON}`,
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


// Pick the "best" render for a given shot — prefer most-final column.
const COLUMN_PRIORITY = ["final", "adjustments", "proposed", "raw"];

function pickBestRender(renders, shotId) {
  if (!Array.isArray(renders) || renders.length === 0) return null;
  const forShot = renders.filter((r) => r.shot_id === shotId);
  for (const col of COLUMN_PRIORITY) {
    const r = forShot.find((x) => x.column_state === col);
    if (r) return r;
  }
  return forShot[0] || null;
}

// Why not the GET ?stream= URL? Because <img src="…/getDeliveryMediaFeed?stream=…">
// is rejected by Supabase's gateway with 401 UNAUTHORIZED_NO_AUTH_HEADER —
// browsers don't send an Authorization header on <img>/<video> requests, and
// the gateway's verify_jwt is on. The function's internal `?stream=` branch
// is auth-free by design but never executes because the gateway short-circuits.
// The swimlane (DroneRendersSubtab → DroneThumbnail → mediaPerf.fetchMediaProxy)
// works around this by doing an authenticated POST and turning the response
// blob into a `blob:` URL — which `<img src>` accepts. We do the same here.

export default function DronePinEditor() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectId = searchParams.get("project");
  const shootId = searchParams.get("shoot");
  const initialShotId = searchParams.get("shot");

  // ── Data fetching ────────────────────────────────────────────────────────
  const shootQ = useQuery({
    queryKey: ["drone_shoots", "single", shootId],
    queryFn: () => (shootId ? api.entities.DroneShoot.get(shootId) : null),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  const projectQ = useQuery({
    queryKey: ["projects", "drone-editor", projectId],
    queryFn: () => (projectId ? api.entities.Project.get(projectId) : null),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const shotsQ = useQuery({
    queryKey: ["drone_shots", "by-shoot", shootId],
    queryFn: () =>
      shootId
        ? api.entities.DroneShot.filter({ shoot_id: shootId }, "dji_index", 2000)
        : [],
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  // W3-PINS (mig 268): the editor now loads BOTH shoot-scoped manual pins
  // AND project-scoped AI pins (source='ai', shoot_id IS NULL) in a single
  // query. The OR clause is implemented via two filtered fetches merged
  // client-side because the entity helper doesn't expose Postgrest .or().
  const customPinsQ = useQuery({
    queryKey: ["drone_custom_pins", "by-shoot-or-project", shootId, projectId],
    queryFn: async () => {
      if (!shootId) return [];
      const [shootPins, projectPins] = await Promise.all([
        api.entities.DroneCustomPin.filter(
          { shoot_id: shootId, lifecycle: "active" },
          "-created_at",
          500,
        ),
        projectId
          ? api.entities.DroneCustomPin.filter(
              { project_id: projectId, source: "ai", lifecycle: "active" },
              "-created_at",
              500,
            )
          : [],
      ]);
      // Dedupe by id (a pin row can satisfy both filters in theory).
      const seen = new Set();
      const merged = [];
      for (const p of [...(shootPins || []), ...(projectPins || [])]) {
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
      return merged;
    },
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  const rendersQ = useQuery({
    queryKey: ["drone_renders", "by-shoot", shootId],
    queryFn: async () => {
      if (!shootId) return [];
      const shotIds =
        Array.isArray(shotsQ.data) && shotsQ.data.length
          ? shotsQ.data.map((s) => s.id)
          : null;
      if (!shotIds || shotIds.length === 0) return [];
      // Fetch all renders for any shot in this shoot.
      const out = await api.entities.DroneRender.filter(
        { shot_id: { $in: shotIds } },
        "-created_at",
        2000,
      );
      return Array.isArray(out) ? out : [];
    },
    enabled: Boolean(shootId) && Array.isArray(shotsQ.data),
    staleTime: 30_000,
  });

  const sfmQ = useQuery({
    queryKey: ["drone_sfm_runs", "latest", shootId],
    queryFn: () =>
      shootId
        ? api.entities.DroneSfmRun.filter(
            { shoot_id: shootId, status: "succeeded" },
            "-finished_at",
            1,
          )
        : [],
    enabled: Boolean(shootId),
    staleTime: 60_000,
  });

  const themeQ = useQuery({
    queryKey: ["drone_theme", "resolved", projectId],
    queryFn: async () => {
      if (!projectId) return null;
      const resp = await api.functions.invoke("getDroneTheme", {
        project_id: projectId,
      });
      // invoke wraps the function's JSON body in `.data` to mirror Base44.
      return resp?.data || null;
    },
    enabled: Boolean(projectId),
    staleTime: 60_000,
    retry: 1,
  });

  // W3-PINS: cached POIs are now first-class drone_custom_pins rows
  // (source='ai'), loaded via customPinsQ above. No separate query needed.
  // The legacy drone_pois_cache table is a raw audit log only.
  const cachedPoisQ = { data: [] };

  // ── Realtime: refresh renders when a re-render completes ─────────────────
  // (Audit finding #8.) Uses the same throttle pattern as DroneCommandCenter
  // so a burst of render writes (typical when re-render queues a batch of
  // shots) doesn't trigger one refetch per row.
  const INVALIDATE_WINDOW_MS = 2000;
  const invalidateThrottleRef = useRef({ last: 0, timeout: null });
  useEffect(() => {
    if (!shootId) return;
    const shotIds = new Set(
      Array.isArray(shotsQ.data) ? shotsQ.data.map((s) => s.id) : [],
    );
    if (shotIds.size === 0) return;

    const fire = () => {
      queryClient.invalidateQueries({
        queryKey: ["drone_renders", "by-shoot", shootId],
      });
    };
    const throttled = () => {
      const entry = invalidateThrottleRef.current;
      const now = Date.now();
      const elapsed = now - entry.last;
      if (elapsed >= INVALIDATE_WINDOW_MS) {
        if (entry.timeout) {
          clearTimeout(entry.timeout);
          entry.timeout = null;
        }
        entry.last = now;
        fire();
      } else if (!entry.timeout) {
        entry.timeout = setTimeout(() => {
          entry.last = Date.now();
          entry.timeout = null;
          fire();
        }, INVALIDATE_WINDOW_MS - elapsed);
      }
    };

    let active = true;
    let unsubscribe = null;
    try {
      unsubscribe = api.entities.DroneRender.subscribe((evt) => {
        if (!active) return;
        // (QC3 #1) Filter to renders whose shot belongs to this shoot.
        // For DELETE events evt.data is null and the prior `if (sid && !has(sid))`
        // short-circuit fail-opened the guard — every drone_render delete
        // app-wide queued an invalidation. Now we skip when shot_id is
        // missing OR not in our set.
        const sid = evt?.data?.shot_id;
        if (!sid || !shotIds.has(sid)) return;
        throttled();
      });
    } catch (e) {
      console.warn("[DronePinEditor] DroneRender subscribe failed:", e);
    }
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch {
        /* ignore */
      }
      const entry = invalidateThrottleRef.current;
      if (entry.timeout) {
        clearTimeout(entry.timeout);
        entry.timeout = null;
      }
    };
  }, [shootId, shotsQ.data, queryClient]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const shots = useMemo(
    () => (Array.isArray(shotsQ.data) ? shotsQ.data : []),
    [shotsQ.data],
  );

  const currentShotId = useMemo(() => {
    if (initialShotId && shots.some((s) => s.id === initialShotId)) {
      return initialShotId;
    }
    return shots[0]?.id || null;
  }, [initialShotId, shots]);

  // Honor `?render=<id>` URL param so clicking a specific render's "Edit"
  // loads that exact image, not whatever pickBestRender chooses by column
  // priority. (Audit finding #9.)
  const requestedRenderId = searchParams.get("render");
  const bestRender = useMemo(() => {
    const renders = rendersQ.data || [];
    if (requestedRenderId) {
      const exact = renders.find(
        (r) => r.id === requestedRenderId && r.shot_id === currentShotId,
      );
      if (exact) return exact;
    }
    return pickBestRender(renders, currentShotId);
  }, [rendersQ.data, currentShotId, requestedRenderId]);

  // Resolve the source path we want to load — render preferred, raw shot fallback.
  const imageDropboxPath = useMemo(() => {
    if (bestRender?.dropbox_path) return bestRender.dropbox_path;
    const shot = shots.find((s) => s.id === currentShotId);
    return shot?.dropbox_path || null;
  }, [bestRender, shots, currentShotId]);

  // Fetch as authenticated POST → blob URL (same pattern as DroneThumbnail).
  // <img src="…/?stream=…"> is 401'd by Supabase's gateway because <img>
  // requests don't carry an Authorization header. We POST and turn the blob
  // into an object URL.
  //
  // Important: write into an ISOLATED per-mount cache, not SHARED_THUMB_CACHE.
  // PinEditor's previousImageUrlRef cleanup revokes URLs we hand it on shot
  // change / unmount; if those URLs were owned by SHARED_THUMB_CACHE every
  // other consumer would see broken images.
  const pinEditorCacheRef = useRef(null);
  if (pinEditorCacheRef.current === null) pinEditorCacheRef.current = new Map();
  const [imageUrl, setImageUrl] = useState(null);
  const [imageError, setImageError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setImageError(null);
    if (!imageDropboxPath) {
      setImageUrl(null);
      return;
    }
    const cache = pinEditorCacheRef.current;
    // Same-shot revisits: serve cached blob directly (avoid double-fetch).
    if (cache.has(imageDropboxPath)) {
      setImageUrl(cache.get(imageDropboxPath));
      return;
    }
    enqueueFetch(() => _pinEditorFetchProxy(imageDropboxPath))
      .then((url) => {
        if (cancelled) {
          // We arrived after unmount or path-change — revoke the stray blob
          // we just minted so it doesn't leak.
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
          cache.set(imageDropboxPath, url);
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
  }, [imageDropboxPath]);

  // Unmount: revoke every blob this page created. PinEditor also revokes the
  // current URL via its own cleanup — that's fine, double-revoke is a no-op.
  useEffect(() => {
    return () => {
      const cache = pinEditorCacheRef.current;
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

  const projectCoord = useMemo(() => {
    const p = projectQ.data;
    if (!p) return null;
    const lat =
      p.confirmed_lat != null
        ? Number(p.confirmed_lat)
        : p.geocoded_lat != null
          ? Number(p.geocoded_lat)
          : null;
    const lng =
      p.confirmed_lng != null
        ? Number(p.confirmed_lng)
        : p.geocoded_lng != null
          ? Number(p.geocoded_lng)
          : null;
    if (lat == null || lng == null) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }, [projectQ.data]);

  // #85: Pose availability is per-shot, not per-shoot. The SfM worker never
  // populates `sparse_bin_dropbox_path` on drone_sfm_runs, so the previous
  // shoot-level check always returned false and the editor permanently fell
  // back to the GPS prior. Check at the active shot level instead: the shot
  // must be registered in SfM AND have a stored sfm_pose payload.
  const poseAvailable = useMemo(() => {
    const activeShot = shots.find((s) => s.id === currentShotId);
    if (!activeShot) return false;
    return (
      activeShot.registered_in_sfm === true &&
      activeShot.sfm_pose != null &&
      typeof activeShot.sfm_pose === "object" &&
      Object.keys(activeShot.sfm_pose).length > 0
    );
  }, [shots, currentShotId]);

  // ── Loading / error states ──────────────────────────────────────────────
  if (!projectId || !shootId) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <p className="text-sm">Missing project or shoot id in URL.</p>
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  const isLoading =
    shootQ.isLoading ||
    projectQ.isLoading ||
    shotsQ.isLoading ||
    customPinsQ.isLoading ||
    rendersQ.isLoading ||
    sfmQ.isLoading ||
    themeQ.isLoading;

  const fatal =
    shootQ.error ||
    projectQ.error ||
    shotsQ.error ||
    customPinsQ.error ||
    rendersQ.error;
  // Theme + sfm errors are non-fatal; the editor still works without them.

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="text-xs text-muted-foreground">Loading shoot data…</p>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-8">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="text-sm font-medium">Failed to load shoot data</p>
        <p className="text-xs text-muted-foreground max-w-md text-center">
          {fatal?.message || "Unknown error"}
        </p>
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Go back
        </Button>
      </div>
    );
  }

  if (!shootQ.data) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <AlertCircle className="h-10 w-10 text-amber-500" />
        <p className="text-sm">Shoot not found</p>
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  const goBackToProject = () =>
    navigate(createPageUrl(`ProjectDetails?id=${projectId}&tab=drones`));

  // Theme is non-fatal: only treat an actual fetch error as an error.
  // The previous version also treated `themeQ.data == null` as fatal, which
  // (a) blocked the editor when getDroneTheme legitimately returned no theme
  // (e.g. brand-new project pre-seed), and (b) fired during the brief window
  // before the query was enabled because `enabled: false` queries report
  // isLoading=false + data=undefined. Net result: editor was blocked for
  // most users. Revert to "only block on hard error". (Audit #11 softened.)
  const themeError = themeQ.error || null;

  // Shot-strip click → update the URL `?shot=` so currentShotId / imageUrl
  // re-derive against the new shot. Without this, clicking a thumbnail
  // updated PinEditor's local activeShotId but the source image (driven by
  // imageDropboxPath via currentShotId via the URL) never swapped — the
  // canvas stayed locked on the first opened shot.
  const handleShotChange = useCallback(
    (newShotId) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("shot", newShotId);
          // Clear the explicit ?render= pin so picking a new shot doesn't
          // try to load the previous render's image on the new shot.
          next.delete("render");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // After save: refetch custom pins + renders so the editor reflects the
  // server's authoritative state (incl. dbId for any newly-created rows).
  const handleAfterSave = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["drone_custom_pins", "by-shoot", shootId],
    });
    queryClient.invalidateQueries({
      queryKey: ["drone_renders", "by-shoot", shootId],
    });
  }, [queryClient, shootId]);

  return (
    <PinEditor
      shoot={shootQ.data}
      shots={shots}
      currentShotId={currentShotId}
      theme={themeQ.data}
      themeError={themeError}
      customPins={customPinsQ.data || []}
      cachedPois={Array.isArray(cachedPoisQ.data) ? cachedPoisQ.data : []}
      projectCoord={projectCoord}
      imageUrl={imageUrl}
      imageError={imageError}
      poseAvailable={poseAvailable}
      onShotChange={handleShotChange}
      onAfterSave={handleAfterSave}
      onSave={goBackToProject}
      onCancel={goBackToProject}
    />
  );
}
