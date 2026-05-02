# PWA service worker cache invalidation

`flexstudios.app` is installed as a PWA, with a service worker registered
at `/sw.js` and a runtime cache keyed `flexstudios-v3`. The SW intercepts
fetches for the SPA shell and chunks, returning the cached version on
hit. **A hard refresh in the browser does not bypass this cache** — the
SW intercepts the network request before the browser cache layer is
considered.

This is great for offline support and second-load performance. It is
also the single most common reason a user reports "your fix didn't ship"
when the deploy is in fact READY and the chunk hashes have rotated.

---

## When to suspect SW staleness

Run through this checklist before diagnosing anything else:

- Vercel deployment status for the most recent push is `READY`
- The new commit's chunk hashes are different from yesterday's (deploy
  succeeded, build is fresh)
- The user reports the bug is still present after a "hard refresh"
  (cmd-shift-R, ctrl-shift-R)
- Other users on machines that haven't visited recently see the fix

If three or more of those are true, you are looking at a stale SW. Do
not start re-debugging the underlying code path until you've confirmed
the user is running the new bundle.

The browser DevTools Network tab will show this clearly: if the
JavaScript chunk requests are returning from `(ServiceWorker)` rather
than the network, the cache is in play.

---

## Recipes

### For users (low-friction)

The app ships an in-app **Refresh** banner that triggers
`registration.update()` and reloads. This works most of the time but
is not foolproof — if the SW itself is the wrong version (e.g. its
own update flow is buggy), the banner can't escape the cache.

If the banner doesn't help, walk the user through:

1. Open DevTools (cmd-opt-i / ctrl-shift-i)
2. **Application** tab -> **Service Workers** in the sidebar
3. Click **Unregister** next to `flexstudios.app`
4. **Application** tab -> **Storage** in the sidebar -> **Clear site
   data** (check all boxes)
5. Close the tab fully, reopen `flexstudios.app`

After step 5, the next page load fetches `/sw.js` and the chunks fresh
from the network.

### For users (zero-friction, when the user is on phone)

Tell them to long-press the app icon on iOS / Android home screen, pick
**Remove App** (iOS) or **Uninstall** (Android), then reinstall via the
"Add to Home Screen" prompt the next time they visit
`flexstudios.app` in their browser. This nukes everything.

### For engineers (programmatic, via Chrome MCP)

When triaging a user-reported "fix didn't land," use the Chrome MCP
`javascript_tool` against the user's tab (or your own repro tab) to
nuke the SW + caches in one shot:

```js
// Paste verbatim into javascript_tool — runs in the page context.
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const r of regs) await r.unregister();
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  console.log('SW unregistered:', regs.length, 'caches deleted:', keys.length);
  location.reload();
})();
```

After that runs, the next request hits the network, fetches the new
`index.html`, picks up the new chunk hashes, registers the new SW.
Verify with one more reload that the chunks are loading from the
network not from `(ServiceWorker)`.

This is the canonical move when you're on a debugging call with a user
who has the bug, you have a Chrome MCP session attached to their tab,
and you need to confirm whether the bug is in the new bundle or just
stale cache.

---

## Why we don't just bump the SW cache key on every deploy

The cache key (`flexstudios-v3`) is deliberately stable. Bumping on
every deploy would invalidate the offline cache on every user every
time, which would defeat the point of the SW entirely. The intended
flow is:

1. New deploy ships
2. SW's own update logic detects a new `/sw.js` content (Vercel rotates
   chunk hashes, the SW notices)
3. SW installs the new version in the background
4. On next reload, the new SW takes over and refetches stale chunks
5. The in-app Refresh banner exists to nudge users on tabs that don't
   reload often

The failure mode is when step 2 or 3 silently fails — usually because
the user's browser is on a flaky network during the SW install, or
because the previous SW's update flow had a bug. The user is then
pinned on the old bundle until they manually invalidate.

If we ever need to **force** invalidation on every user (e.g. a
critical security fix in the SPA shell), bump the cache key in
`/sw.js` and ship that as a separate commit — every user's next visit
will see the new key, treat the old cache as invalid, and refetch.
This is the nuclear option; reserve it for genuine emergencies.

---

## Symptoms that look like SW staleness but aren't

- **Vercel deploy stuck in QUEUED**: not SW; check `vercel inspect` for
  the deployment id, look at build logs
- **CDN edge caching the HTML**: rare; if `index.html` itself is stale,
  curl it from a fresh IP and check the `etag`/`last-modified` against
  the deploy's expected values. Vercel sets `cache-control: max-age=0,
  must-revalidate` on `index.html` by default, so this is unusual
- **Browser memory cache** (separate from SW): cmd-shift-R bypasses
  this; SW does not
- **Vite HMR overlay surviving in dev**: only relevant if you're testing
  on `localhost`. Production has no HMR

If you are in any of those, do not run the SW invalidation snippet —
the snippet is for cache misses caused by the SW itself, and running
it on a non-SW symptom just adds noise.

---

## Reference

- SW source: `flexmedia-src/public/sw.js` (registered against site root
  by the build pipeline)
- Cache key: `flexstudios-v3` (bump only for forced global invalidation)
- In-app refresh banner: `flexmedia-src/src/components/RefreshBanner.jsx`
  (or wherever the registration listener lives — search for
  `serviceWorker.register`)
- Today's incident that triggered this doc: a TDZ fix shipped at
  19:54 UTC; user reported "still broken" at 20:05; Vercel deploy was
  READY, new chunk hashes confirmed; running the snippet above against
  the user's tab pulled in the new bundle and the bug was gone. ~10
  wasted minutes of "is the deploy actually live" before the SW was
  considered.
