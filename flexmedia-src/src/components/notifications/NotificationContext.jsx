import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
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
          // Avoid duplicates
          if (prev.some(n => n.id === event.id)) return prev;
          const updated = [event.data, ...prev].slice(0, MAX_DISPLAY);
          return updated;
        });
        setUnreadCount(prev => prev + (event.data.is_read ? 0 : 1));
      } else if (event.type === 'update' && event.data) {
        // Only process if this is our notification
        if (event.data.user_id !== currentUser.id) return;

        setNotifications(prev => {
          let updated;
          if (event.data.is_dismissed) {
            updated = prev.filter(n => n.id !== event.id);
          } else {
            updated = prev.map(n => n.id === event.id ? event.data : n);
          }
          setUnreadCount(updated.filter(n => !n.is_read && !n.is_dismissed).length);
          return updated;
        });
      } else if (event.type === 'delete') {
        setNotifications(prev => {
          const updated = prev.filter(n => n.id !== event.id);
          setUnreadCount(updated.filter(n => !n.is_read && !n.is_dismissed).length);
          return updated;
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

  const markAllRead = useCallback(async () => {
    const unread = notifications.filter(n => !n.is_read);
    if (unread.length === 0) return;
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      // Batch in chunks of 20 to avoid overwhelming the API
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
  }, [notifications, fetchNotifications]);

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

  const criticalUnread = notifications.filter(
    n => n.severity === 'critical' && !n.is_read && !n.is_dismissed
  );

  return (
    <NotificationContext.Provider value={{
      notifications,
      unreadCount,
      criticalUnread,
      loading,
      lastFetched,
      markRead,
      markAllRead,
      dismiss,
      refresh,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside NotificationProvider");
  return ctx;
}