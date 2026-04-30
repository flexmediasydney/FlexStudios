import { useEffect, useState, useCallback } from 'react';
import { api } from '@/api/supabaseClient';
import { vapidPublicKeyAsBytes } from './pushConfig';

/**
 * Web Push subscription manager.
 *
 * Returns:
 *   supported    — boolean. False on browsers without Service Worker / Push.
 *                  iOS Safari only supports this in installed PWAs (iOS 16.4+).
 *   permission   — 'default' | 'granted' | 'denied' | 'unsupported'
 *   subscribed   — true if THIS browser/device is currently registered.
 *   subscribe()  — prompts permission (if needed) and registers with the SW
 *                  + persists endpoint+keys to push_subscriptions.
 *   unsubscribe()— removes from both browser and DB.
 *
 * Multi-device aware: each browser is its own row keyed by the unique endpoint
 * URL the browser hands out. Subscribing on a phone PWA does not affect a
 * desktop subscription for the same user.
 */

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

async function getRegistration() {
  if (!isSupported()) return null;
  // Wait for any existing SW (Vite/our sw.js registers it from main.jsx);
  // ready resolves once one is active.
  return navigator.serviceWorker.ready;
}

async function persistSubscription(userId, sub) {
  const json = sub.toJSON();
  const payload = {
    user_id: userId,
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 255) : null,
    last_used_at: new Date().toISOString(),
  };

  // Idempotent upsert: a given device endpoint either exists (refresh
  // last_used_at and keep the same id) or is created fresh.
  const existing = await api.entities.PushSubscription.filter({ endpoint: json.endpoint }, null, 1);
  if (existing.length > 0) {
    await api.entities.PushSubscription.update(existing[0].id, {
      p256dh: payload.p256dh,
      auth: payload.auth,
      user_agent: payload.user_agent,
      last_used_at: payload.last_used_at,
      failure_count: 0,
      last_error: null,
    });
  } else {
    await api.entities.PushSubscription.create(payload);
  }
}

async function deleteSubscriptionRow(endpoint) {
  try {
    const rows = await api.entities.PushSubscription.filter({ endpoint }, null, 1);
    if (rows.length > 0) await api.entities.PushSubscription.delete(rows[0].id);
  } catch { /* best-effort */ }
}

export function usePushSubscription(userId) {
  const [supported]   = useState(() => isSupported());
  const [permission, setPermission] = useState(() =>
    !isSupported() ? 'unsupported' : (typeof Notification !== 'undefined' ? Notification.permission : 'default')
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Detect existing subscription on mount + when the user changes.
  useEffect(() => {
    if (!supported || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await getRegistration();
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setSubscribed(!!sub);
        // If the browser thinks we're subscribed but the DB row is missing
        // (e.g. user logged out and back in), re-persist so the server can
        // reach this device. Cheap to do.
        if (sub) await persistSubscription(userId, sub).catch(() => {});
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [supported, userId]);

  // Listen for the SW telling us our subscription was invalidated.
  useEffect(() => {
    if (!supported) return;
    const handler = async (e) => {
      if (e.data?.type !== 'PUSH_SUBSCRIPTION_CHANGE') return;
      try {
        const reg = await getRegistration();
        const newSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidPublicKeyAsBytes(),
        });
        if (userId) await persistSubscription(userId, newSub);
        setSubscribed(true);
      } catch (err) {
        setError(err?.message || 'Resubscription failed');
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [supported, userId]);

  const subscribe = useCallback(async () => {
    if (!supported || !userId) return false;
    setBusy(true); setError(null);
    try {
      // iOS only allows the permission prompt to be triggered from a user
      // gesture. This function is meant to be called from a button onClick.
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError(perm === 'denied'
          ? 'Notifications were blocked. To enable, go to your device Settings → FlexStudios → Notifications.'
          : 'Permission not granted.'
        );
        return false;
      }

      const reg = await getRegistration();
      // If a subscription already exists for this browser, reuse it.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidPublicKeyAsBytes(),
        });
      }
      await persistSubscription(userId, sub);
      setSubscribed(true);
      return true;
    } catch (err) {
      setError(err?.message || 'Failed to enable push notifications');
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported, userId]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setBusy(true); setError(null);
    try {
      const reg = await getRegistration();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await deleteSubscriptionRow(endpoint);
      }
      setSubscribed(false);
    } catch (err) {
      setError(err?.message || 'Failed to disable push notifications');
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, permission, subscribed, busy, error, subscribe, unsubscribe };
}

// Helper for the diagnostic surface used in Settings: returns the rows the
// current user has registered, so the UI can show "Subscribed on 2 devices".
export async function listMySubscriptions(userId) {
  if (!userId) return [];
  try {
    return await api.entities.PushSubscription.filter({ user_id: userId }, '-created_date', 20);
  } catch {
    return [];
  }
}

// Best-effort utility for the firstPrompt CTA: arePushPromptable returns true
// when (a) supported and (b) permission is still 'default' (we haven't asked
// yet — once denied on iOS, the only way back is uninstall/reinstall the PWA).
export function arePushPromptable() {
  if (!isSupported()) return false;
  if (typeof Notification === 'undefined') return false;
  return Notification.permission === 'default';
}
