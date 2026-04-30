const CACHE_VERSION = 3;
const CACHE_NAME = `flexstudios-v${CACHE_VERSION}`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install: pre-cache static shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches and notify clients of update
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('flexstudios-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => {
      // Notify all clients that a new version is active
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
  self.clients.claim();
});

// Listen for SKIP_WAITING message from the client (update prompt)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch: network-first for navigation, cache-first for static assets, network-only for API
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests and cross-origin requests
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  // Navigation requests: network-first with fallback to cached shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (JS, CSS, images, fonts): cache-first
  // Vite hashes filenames, so cached versions are always correct for that hash
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // API calls and other requests: network-only (do NOT cache dynamic data)
  // This prevents stale Supabase/API responses from being served from cache
  event.respondWith(fetch(request));
});

// ─── Web Push (RFC 8030) ──────────────────────────────────────────────────────
//
// `push` fires when the OS delivers a push from our edge function. We render
// an OS-level notification (lock screen banner / notification center entry).
//
// `notificationclick` fires when the user taps it — we focus an existing
// FlexStudios tab if one exists, otherwise open a new one at the deep-link
// URL the edge function sent.
//
// Payload contract (set by sendNotificationEmails-equivalent edge fn):
//   { title, body, url, tag?, notificationId?, icon? }

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'FlexStudios', body: event.data.text() }; }

  const title = payload.title || 'FlexStudios';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192x192.png',
    badge: payload.badge || '/icons/icon-192x192.png',
    tag: payload.tag,                  // collapses duplicate notifications for the same target
    data: { url: payload.url || '/', notificationId: payload.notificationId || null },
    requireInteraction: false,
    vibrate: [180, 80, 180],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer focusing an existing tab on the same origin, then navigate it.
    for (const client of allClients) {
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl).catch(() => {});
          return;
        }
      } catch { /* ignore malformed url */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// Some browsers fire `pushsubscriptionchange` when the subscription is
// invalidated server-side (key rotation, browser data clear, etc). When we
// see this, post a message to any open clients so they can re-subscribe and
// PUT the new endpoint to our DB. If no clients are open, the next app
// session will pick it up via usePushSubscription.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGE' }));
  })());
});
