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

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import PinEditor from "@/components/drone/PinEditor";
import { SHARED_THUMB_CACHE, enqueueFetch, fetchMediaProxy } from "@/utils/mediaPerf";


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
  const [searchParams] = useSearchParams();
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

  const customPinsQ = useQuery({
    queryKey: ["drone_custom_pins", "by-shoot", shootId],
    queryFn: () =>
      shootId
        ? api.entities.DroneCustomPin.filter(
            { shoot_id: shootId },
            "-created_at",
            500,
          )
        : [],
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
        // Filter to renders whose shot belongs to this shoot.
        const sid = evt?.data?.shot_id;
        if (sid && !shotIds.has(sid)) return;
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
  // requests don't carry an Authorization header. mediaPerf.fetchMediaProxy
  // does the POST and returns a `blob:` URL — which <img> happily renders.
  const [imageUrl, setImageUrl] = useState(null);
  const [imageError, setImageError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setImageError(null);
    if (!imageDropboxPath) {
      setImageUrl(null);
      return;
    }
    enqueueFetch(() => fetchMediaProxy(SHARED_THUMB_CACHE, imageDropboxPath, "proxy"))
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          setImageError("Image not available — render may still be processing.");
          setImageUrl(null);
        } else {
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

  // Distinguish "theme fetched but empty" from "theme failed to load". A failed
  // theme load means the editor would silently render POIs that won't appear in
  // real renders — we surface that as a blocking error inside PinEditor.
  // (Audit finding #11.)
  const themeError =
    themeQ.error || (!themeQ.isLoading && themeQ.data == null) || null;

  return (
    <PinEditor
      shoot={shootQ.data}
      shots={shots}
      currentShotId={currentShotId}
      theme={themeQ.data}
      themeError={themeError}
      customPins={customPinsQ.data || []}
      projectCoord={projectCoord}
      imageUrl={imageUrl}
      imageError={imageError}
      poseAvailable={poseAvailable}
      onSave={goBackToProject}
      onCancel={goBackToProject}
    />
  );
}
