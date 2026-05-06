// Bottom-right toast for newly-arriving notifications.
//
// Behaviors:
//   1. Only toasts items created AFTER component mount — old unread items
//      stay in the bell, never blast on initial login.
//   2. Severity-aware styling and duration: critical=red/7s,
//      warning=amber/5s, info=neutral/4s.
//   3. Skips notifications whose `source_user_id` matches the current user
//      (self-actions don't toast yourself).
//   4. Skips notifications whose CTA target matches the current page
//      (you're already there, no need to nudge).
//
// User preference: `digestSettings.toast_enabled` (default true). Toggle
// lives in the notification settings page.

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Bell, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useNotifications } from "./NotificationContext";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { cn } from "@/lib/utils";

const SEVERITY_DEFAULTS = {
  critical: { duration: 7000, container: "bg-red-600 text-white",        secondary: "text-red-100",   accent: "text-red-200 hover:text-white",   Icon: AlertCircle },
  warning:  { duration: 5000, container: "bg-amber-500 text-white",      secondary: "text-amber-100", accent: "text-amber-100 hover:text-white", Icon: AlertTriangle },
  info:     { duration: 4000, container: "bg-card text-foreground border border-border shadow-xl", secondary: "text-muted-foreground", accent: "text-primary hover:underline", Icon: Bell },
};

function styleFor(severity) {
  return SEVERITY_DEFAULTS[severity] || SEVERITY_DEFAULTS.info;
}

function parseCtaParams(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

// Quiet-hours window check. Compares current local time against the
// digest's HH:mm window. Treats "22:00 → 08:00" as wrapping past midnight.
function isInQuietHours(digestSettings) {
  if (!digestSettings?.quiet_hours_enabled) return false;
  const start = digestSettings.quiet_hours_start || "22:00";
  const end = digestSettings.quiet_hours_end || "08:00";
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = (sh || 0) * 60 + (sm || 0);
  const e = (eh || 0) * 60 + (em || 0);
  if (s === e) return false;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

// Returns true when the notification's CTA target matches the page the
// user is currently on (e.g. notification points at /ProjectDetails?id=X
// and the URL is already /ProjectDetails?id=X). On-page = no toast.
function isAlreadyOnTarget(notification, location) {
  if (!notification.cta_url) return false;
  const targetPage = String(notification.cta_url).replace(/^\/+/, "").trim();
  if (!targetPage) return false;
  // location.pathname is e.g. "/ProjectDetails" — strip leading slash and compare case-insensitively.
  const currentPage = (location.pathname || "").replace(/^\/+/, "");
  if (currentPage.toLowerCase() !== targetPage.toLowerCase()) return false;
  // Compare ?id= when the notification names a specific record
  const params = parseCtaParams(notification.cta_params);
  if (params?.id) {
    const currentId = new URLSearchParams(location.search).get("id");
    if (currentId !== params.id) return false;
  }
  return true;
}

export default function NotificationToast() {
  const { notifications, digestSettings, markRead } = useNotifications();
  const { data: currentUser } = useCurrentUser();
  const [toasts, setToasts] = useState([]);
  const seenRef = useRef(new Set());
  const dismissTimersRef = useRef(new Set());
  // Anchor — only notifications created strictly after this point
  // become toast candidates. Snapshotted ONCE per mount so the backlog
  // stays in the bell silently.
  const mountedAtRef = useRef(Date.now());
  const navigate = useNavigate();
  const location = useLocation();
  // Use a ref for location so the toast effect doesn't re-run every nav.
  const locationRef = useRef(location);
  locationRef.current = location;

  const toastEnabled = digestSettings?.toast_enabled !== false; // default true

  // Drop seen IDs that are no longer present (user switch / dismiss-all).
  useEffect(() => {
    const currentIds = new Set(notifications.map(n => n.id));
    for (const id of seenRef.current) {
      if (!currentIds.has(id)) seenRef.current.delete(id);
    }
  }, [notifications]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      dismissTimersRef.current.forEach(clearTimeout);
      dismissTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!toastEnabled) return;
    if (!notifications.length) return;

    const newToasts = [];
    for (const n of notifications) {
      if (seenRef.current.has(n.id)) continue;
      if (n.is_read || n.is_dismissed) {
        // Mark as seen so we don't toast it later if it's flipped unread again.
        seenRef.current.add(n.id);
        continue;
      }
      // 1. Backlog filter: must have been created after we mounted.
      const createdMs = new Date(n.created_date || n.created_at || 0).getTime();
      if (!createdMs || createdMs < mountedAtRef.current) {
        seenRef.current.add(n.id);
        continue;
      }
      // 3. Self-action filter: don't toast notifications you triggered.
      if (currentUser?.id && n.source_user_id && n.source_user_id === currentUser.id) {
        seenRef.current.add(n.id);
        continue;
      }
      // 4. On-page suppression: skip if user is already viewing the target.
      if (isAlreadyOnTarget(n, locationRef.current)) {
        seenRef.current.add(n.id);
        continue;
      }
      // 5. Quiet hours: suppress non-critical toasts during the configured window.
      if (n.severity !== "critical" && isInQuietHours(digestSettings)) {
        seenRef.current.add(n.id);
        continue;
      }
      seenRef.current.add(n.id);
      newToasts.push(n);
    }

    if (newToasts.length === 0) return;

    // Cap visible toasts at 5; new ones push the oldest out.
    setToasts(prev => [...newToasts.slice(0, 3), ...prev].slice(0, 5));

    // Per-severity auto-dismiss.
    newToasts.forEach(n => {
      const { duration } = styleFor(n.severity);
      const timer = setTimeout(() => {
        dismissTimersRef.current.delete(timer);
        setToasts(prev => prev.filter(t => t.id !== n.id));
      }, duration);
      dismissTimersRef.current.add(timer);
    });
  }, [notifications, currentUser?.id, toastEnabled, digestSettings]);

  if (!toastEnabled) return null;
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map(toast => {
        const { container, secondary, accent, Icon } = styleFor(toast.severity);
        return (
          <div
            key={toast.id}
            className={cn(
              "rounded-xl shadow-2xl p-4 flex items-start gap-3",
              "animate-in slide-in-from-bottom-4 fade-in",
              container
            )}
            role={toast.severity === "critical" ? "alert" : "status"}
          >
            <Icon className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm leading-snug">{toast.title}</p>
              {digestSettings?.show_previews !== false && toast.message && (
                <p className={cn("text-xs mt-0.5 line-clamp-2", secondary)}>{toast.message}</p>
              )}
              {toast.cta_url && (
                <button
                  className={cn("text-xs underline mt-1 cursor-pointer transition-colors", accent)}
                  aria-label={`${toast.cta_label || "View"}: ${toast.title}`}
                  onClick={() => {
                    try {
                      const params = parseCtaParams(toast.cta_params);
                      const pageName = String(toast.cta_url).replace(/^\/+/, "");
                      navigate(createPageUrl(pageName) + (params.id ? `?id=${params.id}` : ""));
                    } catch { /* ignore */ }
                    markRead(toast.id);
                    setToasts(prev => prev.filter(t => t.id !== toast.id));
                  }}
                >
                  {toast.cta_label || "View"} →
                </button>
              )}
            </div>
            <button
              className={cn("shrink-0 cursor-pointer transition-colors", accent)}
              onClick={() => {
                markRead(toast.id);
                setToasts(prev => prev.filter(t => t.id !== toast.id));
              }}
              aria-label="Dismiss notification"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
