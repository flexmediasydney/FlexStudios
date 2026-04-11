import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, X, CheckCheck, ChevronRight, AlertTriangle, Info, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createPageUrl } from "@/utils";
import { useNotifications } from "./NotificationContext";

function relTime(ts) {
  if (!ts) return "";
  const safe = (ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) ? ts : ts + "Z";
  const ms = Date.now() - new Date(safe).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function groupByDay(notifications) {
  const sydneyDate = (dt) => dt.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const today = sydneyDate(new Date());
  const yesterday = sydneyDate(new Date(Date.now() - 86400000));
  const groups = { Today: [], Yesterday: [], Older: [] };
  for (const n of notifications) {
    const ts = n.created_date || "";
    const d = sydneyDate(new Date((ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) ? ts : ts + "Z"));
    if (d === today) groups.Today.push(n);
    else if (d === yesterday) groups.Yesterday.push(n);
    else groups.Older.push(n);
  }
  return groups;
}

const SEVERITY_ICON = {
  critical: <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />,
  warning:  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />,
  info:     <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />,
};

const CATEGORY_ICON = {
  task:       "📋",
  project:    "📁",
  revision:   "🔄",
  tonomo:     "⚡",
  financial:  "💰",
  scheduling: "📅",
  system:     "🔧",
};

function CriticalBanner({ notifications, onMarkRead, onDismiss, onNavigate, showPreviews = true }) {
  if (!notifications.length) return null;
  const n = notifications[0];
  return (
    <div className="bg-gradient-to-r from-red-600 to-red-500 text-white px-4 py-2.5 flex items-center gap-3 text-sm animate-in slide-in-from-top shadow-lg">
      <AlertCircle className="h-4 w-4 shrink-0 animate-pulse" />
      <span className="flex-1 font-semibold">{n.title}{showPreviews && n.message ? ` — ${n.message}` : ""}</span>
      {n.cta_url && (
        <button
          className="underline text-red-100 hover:text-white text-xs shrink-0 font-medium hover:bg-card/10 px-2 py-1 rounded transition-colors"
          onClick={() => { onNavigate(n); onMarkRead(n.id); }}
        >
          {n.cta_label || "View"} →
        </button>
      )}
      <button onClick={() => onDismiss(n.id)} className="text-red-200 hover:text-white hover:bg-card/10 p-1 rounded transition-colors" title="Dismiss" aria-label="Dismiss critical notification">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function NotificationItem({ n, onMarkRead, onDismiss, onNavigate, showPreviews = true }) {
  return (
    <div
      className={`px-4 py-3 hover:bg-muted/60 transition-all cursor-pointer group border-b border-border/50 last:border-0 active:bg-muted ${
        !n.is_read ? "bg-blue-50/50 dark:bg-blue-950/20" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-label={`${!n.is_read ? 'Unread: ' : ''}${n.title}`}
      onClick={() => { if (n.cta_url) onNavigate(n); if (!n.is_read) onMarkRead(n.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (n.cta_url) onNavigate(n); if (!n.is_read) onMarkRead(n.id); } }}
    >
      <div className="flex items-start gap-2.5">
        <span className="text-base shrink-0 mt-0.5">
          {CATEGORY_ICON[n.category] || "🔔"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={`text-sm leading-snug ${!n.is_read ? "font-semibold" : "font-medium"}`}>
              {n.title}
            </p>
            <div className="flex items-center gap-1 shrink-0">
              {!n.is_read && (
                <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0 animate-pulse" title="Unread" />
              )}
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted rounded p-0.5"
                onClick={e => { e.stopPropagation(); onDismiss(n.id); }}
                title="Dismiss notification"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {showPreviews && n.message && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{n.message}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {n.project_name && (
              <span className="text-xs text-muted-foreground font-medium truncate max-w-[140px]" title={n.project_name}>
                {n.project_name}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{relTime(n.created_date)}</span>
            {n.cta_url && (
              <span className="text-xs text-primary hover:text-primary/80 font-medium flex items-center gap-0.5 ml-auto transition-colors">
                {n.cta_label || 'View'} <ChevronRight className="h-3 w-3" />
              </span>
            )}
          </div>
        </div>
        {SEVERITY_ICON[n.severity]}
      </div>
    </div>
  );
}

/**
 * NotificationBell — the bell icon + dropdown panel.
 * Designed to be placed inside a header bar.
 */
export function NotificationBell() {
  const { notifications, unreadCount, criticalUnread, digestSettings, markRead, markAllRead, dismiss, refresh } =
    useNotifications();
  const [open, setOpen] = useState(false);
  const [prevUnread, setPrevUnread] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [confirmMarkAll, setConfirmMarkAll] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // BUG FIX: pulse setTimeout was not cleaned up on unmount — setPulse could fire
  // on an unmounted component. Now the timer is cleared in the useEffect cleanup.
  useEffect(() => {
    let pulseTimer;
    if (unreadCount > prevUnread && prevUnread !== 0) {
      setPulse(true);
      pulseTimer = setTimeout(() => setPulse(false), 2000);
    }
    setPrevUnread(unreadCount);
    return () => { if (pulseTimer) clearTimeout(pulseTimer); };
  }, [unreadCount, prevUnread]);

  useEffect(() => {
    function handler(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function handleNavigate(n) {
    if (!n.cta_url) return;
    try {
      const params = n.cta_params ? JSON.parse(n.cta_params) : {};
      const pageName = n.cta_url.replace(/^\/+/, '');
      navigate(createPageUrl(pageName) + (params.id ? `?id=${params.id}` : ""));
    } catch { /* ignore */ }
    setOpen(false);
  }

  const visible = notifications.filter(n => !n.is_dismissed);
  const groups = groupByDay(visible);
  const hasAny = visible.length > 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className={`relative p-2 rounded-lg hover:bg-muted/80 transition-all ${
          pulse ? "animate-bounce" : ""
        } ${open ? "bg-muted" : ""}`}
        onClick={() => { setOpen(v => !v); if (!open) refresh(); }}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        title={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
      >
        <Bell className={`h-5 w-5 transition-colors ${unreadCount > 0 ? "text-foreground" : "text-muted-foreground"} ${open ? "text-primary" : ""}`} />
        {unreadCount > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full
            bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1 shadow-md tabular-nums
            ${pulse ? "ring-4 ring-red-300/50 ring-offset-1 animate-pulse" : ""}`}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[540px] flex flex-col
          bg-background border border-border rounded-xl shadow-xl z-50 overflow-hidden
          animate-in slide-in-from-top-2 fade-in">

          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              <span className="font-semibold text-sm">Notifications</span>
              <span className="text-xs text-muted-foreground">({visible.length})</span>
              {unreadCount > 0 && (
                <Badge className="bg-red-100 text-red-700 text-xs h-5 font-bold animate-pulse tabular-nums">{unreadCount} unread</Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <Button
                  variant={confirmMarkAll ? "default" : "ghost"}
                  size="sm"
                  className={`h-7 text-xs gap-1 ${confirmMarkAll ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  onClick={() => {
                    if (confirmMarkAll) {
                      markAllRead();
                      setConfirmMarkAll(false);
                    } else {
                      setConfirmMarkAll(true);
                      setTimeout(() => setConfirmMarkAll(false), 3000);
                    }
                  }}
                  title={confirmMarkAll ? "Click again to confirm" : "Mark all as read"}
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{confirmMarkAll ? "Confirm?" : "Mark all read"}</span>
                </Button>
              )}
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {!hasAny ? (
              <div className="py-12 text-center text-muted-foreground">
                <CheckCheck className="h-10 w-10 mx-auto mb-3 text-green-500 opacity-50" />
                <p className="text-sm font-medium">You're all caught up</p>
                <p className="text-xs mt-1 opacity-70">No new notifications</p>
              </div>
            ) : (
              Object.entries(groups).map(([label, items]) =>
                items.length > 0 ? (
                  <div key={label}>
                    <div className="px-4 py-2 text-xs font-bold text-muted-foreground bg-muted/40 uppercase tracking-wider sticky top-0 z-10 backdrop-blur-sm border-b border-border/30">
                      {label}
                    </div>
                    {items.map(n => (
                      <NotificationItem
                        key={n.id}
                        n={n}
                        onMarkRead={markRead}
                        onDismiss={dismiss}
                        onNavigate={handleNavigate}
                        showPreviews={digestSettings?.show_previews !== false}
                      />
                    ))}
                  </div>
                ) : null
              )
            )}
          </div>

          {hasAny && (
            <div className="border-t border-border px-4 py-2.5 bg-muted/20">
              <button
                className="text-sm text-primary hover:text-primary/80 font-semibold w-full text-center py-1 hover:bg-muted/50 rounded-md transition-colors"
                aria-label="View all notifications"
                onClick={() => {
                  navigate(createPageUrl("NotificationsPage"));
                  setOpen(false);
                }}
              >
                View all notifications →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * GlobalNotificationBar — renders the critical banner at page top + the bell.
 * Default export for backward compatibility.
 * NOTE: The bell is now also exported separately as NotificationBell for
 * placement inside header bars.
 */
export default function GlobalNotificationBar() {
  const { criticalUnread, digestSettings, markRead, dismiss } = useNotifications();
  const navigate = useNavigate();

  function handleNavigate(n) {
    if (!n.cta_url) return;
    try {
      const params = n.cta_params ? JSON.parse(n.cta_params) : {};
      const pageName = n.cta_url.replace(/^\/+/, '');
      navigate(createPageUrl(pageName) + (params.id ? `?id=${params.id}` : ""));
    } catch { /* ignore */ }
  }

  return (
    <CriticalBanner
      notifications={criticalUnread}
      onMarkRead={markRead}
      onDismiss={dismiss}
      onNavigate={handleNavigate}
      showPreviews={digestSettings?.show_previews !== false}
    />
  );
}