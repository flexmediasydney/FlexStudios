import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye } from "lucide-react";

const HEARTBEAT_INTERVAL = 15000; // 15s

const roleColors = {
  master_admin: { bg: "bg-red-500", border: "border-red-600", ring: "ring-red-400" },
  employee:     { bg: "bg-blue-500", border: "border-blue-600", ring: "ring-blue-400" },
  contractor:   { bg: "bg-amber-500", border: "border-amber-600", ring: "ring-amber-400" },
  default:      { bg: "bg-slate-500", border: "border-slate-600", ring: "ring-slate-400" },
};

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AvatarBubble({ viewer, index, total, showLabel = false }) {
  const colors = roleColors[viewer.user_role] || roleColors.default;
  const isSelf = viewer.is_self;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`
              relative flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
              text-white text-xs font-bold select-none cursor-default
              border-2 border-white shadow-sm
              transition-all duration-300 ease-out
              ${colors.bg}
              ${isSelf ? `ring-2 ${colors.ring} ring-offset-1` : ""}
            `}
            style={{ zIndex: total - index }}
          >
            {getInitials(viewer.user_name)}
            {/* Pulsing dot for "live" indicator */}
            <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${colors.bg}`} />
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${colors.bg} border border-white`} />
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <p className="font-medium">{viewer.user_name}{isSelf ? " (you)" : ""}</p>
          <p className="text-muted-foreground capitalize">{viewer.user_role?.replace("_", " ") || "Viewer"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function ProjectPresenceIndicator({ projectId, currentUser, label }) {
  const [viewers, setViewers] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const heartbeatRef = useRef(null);
  const isMounted = useRef(true);

  const sendHeartbeat = useCallback(async (action = "heartbeat") => {
    if (!projectId || !currentUser) return;
    try {
      const res = await api.functions.invoke("projectPresenceHeartbeat", {
        project_id: projectId,
        action
      });
      if (isMounted.current && res?.data?.viewers) {
        setViewers(res.data.viewers);
        setIsConnected(true);
      }
    } catch (err) {
      if (isMounted.current) setIsConnected(false);
      console.warn("[Presence] heartbeat failed:", err.message);
    }
  }, [projectId, currentUser]);

  useEffect(() => {
    if (!projectId || !currentUser) return;
    isMounted.current = true;

    // Immediate first heartbeat
    sendHeartbeat("heartbeat");

    // Periodic heartbeat
    heartbeatRef.current = setInterval(() => {
      sendHeartbeat("heartbeat");
    }, HEARTBEAT_INTERVAL);

    // Leave on unmount
    return () => {
      isMounted.current = false;
      clearInterval(heartbeatRef.current);
      // Fire-and-forget leave signal
      api.functions.invoke("projectPresenceHeartbeat", {
        project_id: projectId,
        action: "leave"
      }).catch(() => {});
    };
  }, [projectId, currentUser, sendHeartbeat]);

  // Also send leave signal when page visibility changes
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        clearInterval(heartbeatRef.current);
      } else {
        sendHeartbeat("heartbeat");
        heartbeatRef.current = setInterval(() => sendHeartbeat("heartbeat"), HEARTBEAT_INTERVAL);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [sendHeartbeat]);

  if (!viewers.length && !isConnected) return null;

  const others = viewers.filter(v => !v.is_self);
  const self = viewers.find(v => v.is_self);
  const displayViewers = [...viewers]; // self first, then others
  const sortedViewers = self
    ? [self, ...viewers.filter(v => !v.is_self)]
    : viewers;

  const MAX_SHOWN = 5;
  const visibleViewers = sortedViewers.slice(0, MAX_SHOWN);
  const overflow = sortedViewers.length - MAX_SHOWN;

  return (
    <div className="flex items-center gap-2">
      {/* Eye icon + count label */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Eye className="h-3.5 w-3.5" />
        <span className="font-medium tabular-nums">
          {viewers.length} {label || "viewing"}
        </span>
      </div>

      {/* Avatar stack */}
      <div className="flex items-center" style={{ gap: "-4px" }}>
        <div className="flex items-center" style={{ display: "flex" }}>
          {visibleViewers.map((viewer, i) => (
            <div key={viewer.user_id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <AvatarBubble
                viewer={viewer}
                index={i}
                total={visibleViewers.length}
              />
            </div>
          ))}
          {overflow > 0 && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
                      text-xs font-bold bg-muted text-muted-foreground border-2 border-white shadow-sm cursor-default"
                    style={{ marginLeft: -8, zIndex: 0 }}
                  >
                    +{overflow}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {sortedViewers.slice(MAX_SHOWN).map(v => (
                    <p key={v.user_id}>{v.user_name}</p>
                  ))}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </div>
  );
}