// Web Push VAPID public key — safe to ship to the client. Rotating this
// requires unsubscribing every device (the new key won't match), so it is
// pinned here rather than in env.
export const VAPID_PUBLIC_KEY =
  'BJfGrB9XRH-QXSiogYOJJVuLnLFMmCbexaMBdiHRhnIE4M8Yml1aPCMrqeXIV7N8360jNyzPRn7Rmp22Z1MnBOw';

// applicationServerKey wants a Uint8Array of the URL-safe base64 public key.
export function vapidPublicKeyAsBytes() {
  const base64 = VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
