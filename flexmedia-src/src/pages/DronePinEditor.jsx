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

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Loader2, AlertCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import PinEditor from "@/components/drone/PinEditor";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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

// Build a Dropbox proxy URL for a render's stored path.
function dropboxProxyUrl(dropboxPath) {
  if (!dropboxPath) return null;
  if (!SUPABASE_URL) return null;
  // Same pattern as src/utils/mediaActions.js::getVideoStreamUrl, which the
  // drone Files tab also uses to fetch images.
  return `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed?stream=${encodeURIComponent(
    dropboxPath,
  )}`;
}

export default function DronePinEditor() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
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

  const bestRender = useMemo(
    () => pickBestRender(rendersQ.data || [], currentShotId),
    [rendersQ.data, currentShotId],
  );

  const imageUrl = useMemo(() => {
    if (bestRender?.dropbox_path) return dropboxProxyUrl(bestRender.dropbox_path);
    const shot = shots.find((s) => s.id === currentShotId);
    if (shot?.dropbox_path) return dropboxProxyUrl(shot.dropbox_path);
    return null;
  }, [bestRender, shots, currentShotId]);

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

  const poseAvailable = useMemo(() => {
    const sfm =
      Array.isArray(sfmQ.data) && sfmQ.data.length > 0 ? sfmQ.data[0] : null;
    return Boolean(sfm?.sparse_bin_dropbox_path);
  }, [sfmQ.data]);

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

  return (
    <PinEditor
      shoot={shootQ.data}
      shots={shots}
      currentShotId={currentShotId}
      theme={themeQ.data}
      customPins={customPinsQ.data || []}
      projectCoord={projectCoord}
      imageUrl={imageUrl}
      poseAvailable={poseAvailable}
      onSave={goBackToProject}
      onCancel={goBackToProject}
    />
  );
}
