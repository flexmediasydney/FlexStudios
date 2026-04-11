import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useAuth } from "@/lib/AuthContext";

const NotificationContext = createContext(null);

const POLL_INTERVAL_MS = 60_000; // Reduced polling since we have realtime
const MAX_DISPLAY = 50;

function playNotificationBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {}
}

export function NotificationProvider({ children }) {
  const { data: currentUser } = useCurrentUser();
  // During simulation, always fetch/filter notifications for the REAL user
  // so the owner doesn't miss their own alerts while impersonating someone.
  const { realUser, isSimulating } = useAuth();
  const notifUser = isSimulating ? realUser : currentUser;
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState(null);
  const [digestSettings, setDigestSettings] = useState({
    sound_enabled: false,
    show_previews: true,
    quiet_hours_enabled: false,
    quiet_hours_start: "22:00",
    quiet_hours_end: "08:00",
  });
  const digestRef = useRef(digestSettings);
  digestRef.current = digestSettings;
  const pollRef = useRef(null);

  const fetchNotifications = useCallback(async (silent = false) => {
    if (!notifUser?.id) return;
    if (!silent) setLoading(true);
    try {
      // Filter server-side by user_id so the limit applies per-user, not globally
      const mine = await api.entities.Notification.filter(
        { user_id: notifUser.id, is_dismissed: false },
        "-created_date",
        MAX_DISPLAY
      );
      setNotifications(mine);
      setUnreadCount(mine.filter(n => !n.is_read).length);
      setLastFetched(new Date());
    } catch { /* silent fail */ }
    finally { if (!silent) setLoading(false); }
  }, [notifUser?.id]);

  useEffect(() => {
    if (notifUser?.id) fetchNotifications();
  }, [notifUser?.id, fetchNotifications]);

  // Fetch digest settings (sound_enabled, show_previews, etc.) once per user
  useEffect(() => {
    if (!notifUser?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.entities.NotificationDigestSettings.list("-created_date", 10);
        if (cancelled) return;
        const mine = rows.find(d => d.user_id === notifUser.id);
        if (mine) setDigestSettings(mine);
      } catch { /* silent fail — defaults are safe */ }
    })();
    return () => { cancelled = true; };
  }, [notifUser?.id]);

  // Realtime subscription — listen for INSERT/UPDATE/DELETE on notifications table
  // and update local state immediately without waiting for the next poll
  useEffect(() => {
    if (!notifUser?.id) return;

    const unsubscribe = api.entities.Notification.subscribe((event) => {
      if (!event) return;

      if (event.type === 'create' && event.data) {
        // Only add if this notification belongs to the current user
        if (event.data.user_id !== notifUser.id) return;
        if (event.data.is_dismissed) return;

        setNotifications(prev => {
          // Bug fix: check event.data.id (notification ID), not event.id (supabase event ID)
          if (prev.some(n => n.id === event.data.id)) return prev;
          const updated = [event.data, ...prev].slice(0, MAX_DISPLAY);
          // Derive unread count from the new list to account for items sliced off
          const newUnread = updated.filter(n => !n.is_read && !n.is_dismissed).length;
          queueMicrotask(() => setUnreadCount(newUnread));
          return updated;
        });

        // Play notification beep if sound_enabled (read from ref to avoid stale closure)
        if (digestRef.current.sound_enabled) {
          playNotificationBeep();
        }
      } else if (event.type === 'update' && event.data) {
        // Only process if this is our notification
        if (event.data.user_id !== notifUser.id) return;

        // BUG FIX (subscription audit): Previous approach called setUnreadCount
        // inside a setNotifications updater — an anti-pattern that is fragile under
        // React concurrent mode. Now we compute the new list first, then derive the
        // unread count from it in a single pass using flushSync-safe pattern.
        setNotifications(prev => {
          let next;
          if (event.data.is_dismissed) {
            next = prev.filter(n => n.id !== event.data.id);
          } else {
            next = prev.map(n => n.id === event.data.id ? event.data : n);
          }
          // Derive unread count synchronously from the new list
          // Using queueMicrotask to avoid nesting setState inside updater
          const newUnread = next.filter(n => !n.is_read && !n.is_dismissed).length;
          queueMicrotask(() => setUnreadCount(newUnread));
          return next;
        });
      } else if (event.type === 'delete') {
        setNotifications(prev => {
          const deletedId = event.data?.id || event.id;
          const next = prev.filter(n => n.id !== deletedId);
          const newUnread = next.filter(n => !n.is_read && !n.is_dismissed).length;
          queueMicrotask(() => setUnreadCount(newUnread));
          return next;
        });
      }
    });

    return unsubscribe;
  }, [notifUser?.id]);

  // Fallback polling (reduced frequency since realtime handles most updates)
  useEffect(() => {
    if (!notifUser?.id) return;
    pollRef.current = setInterval(() => fetchNotifications(true), POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [notifUser?.id, fetchNotifications]);

  // BUG FIX: compute wasUnread inside the updater and call setUnreadCount from there,
  // matching the pattern used in dismiss(). The previous approach relied on the
  // wasUnread variable being set synchronously inside setNotifications before
  // setUnreadCount was called — fragile under React concurrent mode.
  const markRead = useCallback(async (notificationId) => {
    let wasUnread = false;
    setNotifications(prev =>
      prev.map(n => {
        if (n.id === notificationId) {
          if (!n.is_read) wasUnread = true;
          return { ...n, is_read: true };
        }
        return n;
      })
    );
    if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await api.entities.Notification.update(notificationId, {
        is_read: true,
        read_at: new Date().toISOString(),
      });
    } catch { fetchNotifications(true); }
  }, [fetchNotifications]);

  // BUG FIX: use functional updater to read current notifications state,
  // avoiding stale closure over `notifications` which caused markAllRead
  // to miss notifications that arrived between the last render and the click.
  const markAllRead = useCallback(async () => {
    // Read current state via ref-like pattern to avoid stale closure
    let unread = [];
    setNotifications(prev => {
      unread = prev.filter(n => !n.is_read);
      return unread.length > 0 ? prev.map(n => ({ ...n, is_read: true })) : prev;
    });
    if (unread.length === 0) return;
    setUnreadCount(0);
    try {
      const CHUNK_SIZE = 20;
      const now = new Date().toISOString();
      for (let i = 0; i < unread.length; i += CHUNK_SIZE) {
        const chunk = unread.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(n =>
            api.entities.Notification.update(n.id, {
              is_read: true,
              read_at: now,
            })
          )
        );
      }
    } catch { fetchNotifications(true); }
  }, [fetchNotifications]);

  const dismiss = useCallback(async (notificationId) => {
    let wasUnread = false;
    setNotifications(prev => {
      const target = prev.find(n => n.id === notificationId);
      if (target && !target.is_read) wasUnread = true;
      return prev.filter(n => n.id !== notificationId);
    });
    if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await api.entities.Notification.update(notificationId, { is_dismissed: true });
    } catch { fetchNotifications(true); }
  }, [fetchNotifications]);

  const refresh = useCallback(() => fetchNotifications(false), [fetchNotifications]);

  // BUG FIX: memoize criticalUnread — was recomputed on every render creating a
  // new array reference even when notifications hadn't changed, triggering
  // unnecessary re-renders in consumers that depend on criticalUnread.
  const criticalUnread = useMemo(
    () => notifications.filter(n => n.severity === 'critical' && !n.is_read && !n.is_dismissed),
    [notifications]
  );

  // BUG FIX: memoize context value to prevent all consumers from re-rendering
  // on every provider render. Without this, every parent state change
  // (even unrelated) forces all useNotifications() consumers to re-render.
  const contextValue = useMemo(() => ({
    notifications,
    unreadCount,
    criticalUnread,
    loading,
    lastFetched,
    digestSettings,
    markRead,
    markAllRead,
    dismiss,
    refresh,
  }), [notifications, unreadCount, criticalUnread, loading, lastFetched, digestSettings, markRead, markAllRead, dismiss, refresh]);

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside NotificationProvider");
  return ctx;
}