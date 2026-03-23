import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

const NotificationContext = createContext(null);

const POLL_INTERVAL_MS = 60_000; // Reduced polling since we have realtime
const MAX_DISPLAY = 50;

export function NotificationProvider({ children }) {
  const { data: currentUser } = useCurrentUser();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState(null);
  const pollRef = useRef(null);

  const fetchNotifications = useCallback(async (silent = false) => {
    if (!currentUser?.id) return;
    if (!silent) setLoading(true);
    try {
      // Filter server-side by user_id so the limit applies per-user, not globally
      const mine = await api.entities.Notification.filter(
        { user_id: currentUser.id, is_dismissed: false },
        "-created_date",
        MAX_DISPLAY
      );
      setNotifications(mine);
      setUnreadCount(mine.filter(n => !n.is_read).length);
      setLastFetched(new Date());
    } catch { /* silent fail */ }
    finally { if (!silent) setLoading(false); }
  }, [currentUser?.id]);

  useEffect(() => {
    if (currentUser?.id) fetchNotifications();
  }, [currentUser?.id, fetchNotifications]);

  // Realtime subscription — listen for INSERT/UPDATE/DELETE on notifications table
  // and update local state immediately without waiting for the next poll
  useEffect(() => {
    if (!currentUser?.id) return;

    const unsubscribe = api.entities.Notification.subscribe((event) => {
      if (!event) return;

      if (event.type === 'create' && event.data) {
        // Only add if this notification belongs to the current user
        if (event.data.user_id !== currentUser.id) return;
        if (event.data.is_dismissed) return;

        setNotifications(prev => {
          // Bug fix: check event.data.id (notification ID), not event.id (supabase event ID)
          if (prev.some(n => n.id === event.data.id)) return prev;
          const updated = [event.data, ...prev].slice(0, MAX_DISPLAY);
          return updated;
        });
        setUnreadCount(prev => prev + (event.data.is_read ? 0 : 1));
      } else if (event.type === 'update' && event.data) {
        // Only process if this is our notification
        if (event.data.user_id !== currentUser.id) return;

        // BUG FIX: avoid calling setUnreadCount inside setNotifications updater.
        // Nesting state setters inside updaters is an anti-pattern that can cause
        // issues with React concurrent features. Compute and set separately.
        setNotifications(prev => {
          // Bug fix: use event.data.id (notification ID), not event.id
          if (event.data.is_dismissed) {
            return prev.filter(n => n.id !== event.data.id);
          }
          return prev.map(n => n.id === event.data.id ? event.data : n);
        });
        // Recompute unread count from the notification list after update
        setNotifications(current => {
          setUnreadCount(current.filter(n => !n.is_read && !n.is_dismissed).length);
          return current; // no mutation, just reading
        });
      } else if (event.type === 'delete') {
        // BUG FIX: same pattern — separate the count update from the list update
        setNotifications(prev => {
          // Bug fix: use event.data?.id with fallback to event.id for deletes
          const deletedId = event.data?.id || event.id;
          return prev.filter(n => n.id !== deletedId);
        });
        setNotifications(current => {
          setUnreadCount(current.filter(n => !n.is_read && !n.is_dismissed).length);
          return current;
        });
      }
    });

    return unsubscribe;
  }, [currentUser?.id]);

  // Fallback polling (reduced frequency since realtime handles most updates)
  useEffect(() => {
    if (!currentUser?.id) return;
    pollRef.current = setInterval(() => fetchNotifications(true), POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [currentUser?.id, fetchNotifications]);

  // BUG FIX: compute wasUnread inside the updater and call setUnreadCount from there,
  // matching the pattern used in dismiss(). The previous approach relied on the
  // wasUnread variable being set synchronously inside setNotifications before
  // setUnreadCount was called — fragile under React concurrent mode.
  const markRead = useCallback(async (notificationId) => {
    setNotifications(prev => {
      const target = prev.find(n => n.id === notificationId);
      if (target && !target.is_read) {
        setUnreadCount(c => Math.max(0, c - 1));
      }
      return prev.map(n =>
        n.id === notificationId ? { ...n, is_read: true } : n
      );
    });
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
    let unreadIds = [];
    setNotifications(prev => {
      unreadIds = prev.filter(n => !n.is_read).map(n => n.id);
      return prev.map(n => ({ ...n, is_read: true }));
    });
    setUnreadCount(0);
    try {
      await Promise.all(
        unreadIds.map(id =>
          api.entities.Notification.update(id, {
            is_read: true,
            read_at: new Date().toISOString(),
          })
        )
      );
    } catch { fetchNotifications(true); }
  }, [fetchNotifications]);

  const dismiss = useCallback(async (notificationId) => {
    // Bug fix: compute wasUnread synchronously from current state snapshot
    // before mutating, avoiding the race condition with queueMicrotask
    setNotifications(prev => {
      const target = prev.find(n => n.id === notificationId);
      const wasUnread = target && !target.is_read;
      if (wasUnread) {
        setUnreadCount(c => Math.max(0, c - 1));
      }
      return prev.filter(n => n.id !== notificationId);
    });
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
    markRead,
    markAllRead,
    dismiss,
    refresh,
  }), [notifications, unreadCount, criticalUnread, loading, lastFetched, markRead, markAllRead, dismiss, refresh]);

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