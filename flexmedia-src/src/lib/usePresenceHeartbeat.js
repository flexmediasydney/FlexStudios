import { useEffect, useRef } from 'react';
import { api } from '@/api/supabaseClient';

const HEARTBEAT_MS = 60_000;

/**
 * Stamps users.last_seen_at on a 60s cadence while the tab is visible and a
 * user is signed in. Pauses when the tab is hidden (saves DB writes when the
 * user has the app in a background tab). Fires immediately on mount and on
 * visibility-resume so a user who alt-tabs back is recorded as online without
 * a delay.
 *
 * Groundwork for offline-email fallback: the email worker reads
 * users.last_seen_at to decide whether a notification recipient was online
 * recently enough to skip the email.
 */
export function usePresenceHeartbeat(userId) {
  const lastPingRef = useRef(0);

  useEffect(() => {
    if (!userId) return undefined;

    let cancelled = false;

    const ping = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastPingRef.current < HEARTBEAT_MS - 1000) return; // debounce
      lastPingRef.current = now;
      try {
        await api.rpc('record_user_presence', {});
      } catch {
        // silent — presence is best-effort
      }
    };

    ping();
    const interval = setInterval(ping, HEARTBEAT_MS);
    const onVisibility = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId]);
}
