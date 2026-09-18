// Ledgr service worker (slices 16 + 18). Deliberately conservative (PRD
// §4.5): it caches the app shell (offline fallback, icons, hashed build
// assets), never item data on its own — the PWA promises no offline writes
// and no stale reads. The one exception is deliberate: Save Offline (PRD
// §4.7) pins verified documents (and their images) into PIN_CACHE from the
// page; this worker only ever *reads* that cache, as a fallback when the
// network fails.
//
// Bump VERSION on any change to this file's caching behavior; activate
// drops older shell caches (pins survive — they are user-meaningful data).
// v3 (slice 30): push + notificationclick handlers for Web Push notifications
// (morning agenda, meeting-prep-ready). These never touch any cache.
// v4: notification badge points at a monochrome silhouette (badge-96.png) so
// Android renders the "L" mark in the status bar, not a solid white square.
// v5 (ADR-129): the push handler sets the PWA app-icon badge to the unread
// notification count (data.count), and a message listener lets the page sync
// the badge after read/archive actions. Both no-op where the Badging API is
// unsupported.
// v6: dev self-heal. A worker left registered by a prior local `next build`/
// `next start` used to keep serving its cache-first `/_next/static` chunks under
// `next dev` after a recompile; the browser then hit ChunkLoadError and
// auto-reloaded *through* the worker, which served the same dead chunks — an
// infinite reload loop that survived server restarts (the cache is client-side)
// and that PwaRegister's React-side unregister couldn't break, because the page
// never hydrated far enough to run it. On localhost this worker now precaches
// nothing, intercepts nothing (pure network passthrough), and unregisters itself
// on activate, so a leftover registration tears itself down on the next load.
// v7: fix a double-respond in the fetch handler. The navigation branch called
// event.respondWith() but fell through (missing return) into the catch-all
// branch, which called respondWith() a second time — throwing InvalidStateError
// ("respondWith() was already called") and making hard navigations (direct
// open / reload of a URL, notification taps) resolve as a network error. Added
// the missing return so the four fetch branches stay mutually exclusive.
// v8: fix Android share-target cold-start. Sharing to a fully-closed PWA
// cold-launches Chrome to `POST /capture/share` at the exact moment this worker
// is booting. The old `method !== "GET"` early-return handed the POST navigation
// to the browser's default path, which races the worker startup and renders
// "URL not found" until the worker is warmed (open the app, retry). Now the
// worker explicitly owns that POST via respondWith(fetch(...)), which keeps it
// alive across the request. The request's manual redirect mode yields an
// opaqueredirect the browser follows to the 303 target (/items/… etc.).
// v9: no behavior change here — the bump exists to REPLACE the precached
// offline.html, which is now a live directory of what Save Offline has pinned on
// this device (ADR-193). offline.html is served cache-first out of SHELL_CACHE,
// so editing that file without bumping VERSION leaves every installed device on
// the old copy, silently and with nothing to debug. Any future edit to
// offline.html (or anything else in PRECACHE) needs this same bump.
// v10: the app icons are REPLACED (the stacked-layers mark, Tyler 2026-08-18)
// and a maskable variant joins the precache — same rule as v9: the icons are
// served cache-first, so without this bump installed devices keep the old "L".
const VERSION = "v10";
const SHELL_CACHE = `ledgr-shell-${VERSION}`;
const PIN_CACHE = "ledgr-pin-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/badge-96.png",
];

// Local dev origins. In dev this worker must never cache or serve build assets
// (see the v6 note above) — it self-unregisters instead of running the prod
// caching path, which is what breaks the stale-chunk reload loop.
const IS_DEV =
  self.location.hostname === "localhost" ||
  self.location.hostname === "127.0.0.1" ||
  self.location.hostname.endsWith(".local");

self.addEventListener("install", (event) => {
  // Dev: precache nothing; activate tears this worker down.
  if (IS_DEV) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Dev: drop every ledgr cache (including any stale shell chunks) and
  // unregister, then claim so currently-controlled tabs stop routing through
  // this worker on their next load. This is what breaks the reload loop.
  if (IS_DEV) {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k.startsWith("ledgr-")).map((k) => caches.delete(k))
          )
        )
        .then(() => self.registration.unregister())
        .then(() => self.clients.claim())
    );
    return;
  }
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("ledgr-shell-") && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Dev: never intercept — pure network passthrough, so no stale cached chunk is
  // ever served while this worker unregisters itself (the reload-loop fix).
  if (IS_DEV) return;
  const { request } = event;
  const url = new URL(request.url);

  // Share-target POST (Android share sheet → /capture/share). Own it explicitly
  // so respondWith keeps this worker alive across the request on a cold launch;
  // letting the POST navigation fall through races worker startup and shows
  // "URL not found" (v8). The manual redirect surfaces the route's 303 target.
  if (request.method === "POST" && url.pathname === "/capture/share") {
    event.respondWith(fetch(request));
    return;
  }

  if (request.method !== "GET") return;

  // Cross-origin GETs (R2 attachment images): network, falling back to a
  // pinned copy if Save Offline stored one. Never cached here.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(request).catch(async () => {
        const pinned = await caches
          .open(PIN_CACHE)
          .then((cache) => cache.match(request));
        return pinned ?? Response.error();
      })
    );
    return;
  }

  // Hashed immutable build assets: cache-first. Safe because the hash in the
  // path changes with the content; activate clears old shell caches.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Navigations: always network (fresh data); when it fails, a pinned copy
  // wins (Save Offline seam), else the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const pinned = await caches
          .open(PIN_CACHE)
          .then((cache) => cache.match(request, { ignoreSearch: true }));
        if (pinned) return pinned;
        const offline = await caches.match(OFFLINE_URL);
        return offline ?? Response.error();
      })
    );
    return;
  }
  // Everything else (API, same-origin images, fonts): network, falling back
  // to a pinned copy when one exists. The SW itself never writes item data
  // to any cache.
  event.respondWith(
    fetch(request).catch(async () => {
      const pinned = await caches
        .open(PIN_CACHE)
        .then((cache) => cache.match(request));
      return pinned ?? Response.error();
    })
  );
});

// Web Push (slice 30, PRD §4.11). The server sends an encrypted JSON payload
// ({title, body, url, tag}); we render it as a notification. A malformed or
// empty payload still shows a generic notice rather than dropping silently.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Ledgr";
  const options = {
    body: data.body || "",
    tag: data.tag,
    // Replace a same-tag notification rather than stacking duplicates.
    renotify: !!data.tag,
    icon: "/icons/icon-192.png",
    // Status-bar glyph: a monochrome silhouette (Android masks the badge to its
    // alpha channel, so the full-color app icon would show as a white square).
    badge: "/icons/badge-96.png",
    data: { url: data.url || "/" },
  };
  // Reflect the unread total on the installed-app icon (ADR-129). The Badging
  // API is exposed on the worker's navigator; guard for browsers without it.
  if (typeof data.count === "number" && self.navigator && "setAppBadge" in self.navigator) {
    if (data.count > 0) self.navigator.setAppBadge(data.count).catch(() => {});
    else self.navigator.clearAppBadge?.().catch(() => {});
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

// Let an open page push the authoritative unread count to the app-icon badge
// (ADR-129) after the owner reads/archives notifications, without a round-trip
// through the push service. The page posts { type: "set-badge", count }.
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type !== "set-badge") return;
  if (!self.navigator || !("setAppBadge" in self.navigator)) return;
  if (typeof msg.count === "number" && msg.count > 0) {
    self.navigator.setAppBadge(msg.count).catch(() => {});
  } else {
    self.navigator.clearAppBadge?.().catch(() => {});
  }
});

// Tapping a notification focuses an existing app window (navigating it to the
// target) or opens a new one. Same-origin only.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin === self.location.origin && "focus" in client) {
            return client.focus().then((c) => (c && "navigate" in c ? c.navigate(target) : c));
          }
        }
        return self.clients.openWindow(target);
      })
  );
});
