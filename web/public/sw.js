/*
 * Service worker — offline shell only.
 *
 * The one rule here: NOTHING under /api/ is ever cached. This app's whole value
 * is live state — which run is going, what a report scored, whether the tracker
 * row exists. A stale cached answer is worse than an honest failure, because
 * you cannot tell it is stale. The connection banner reports unreachability;
 * this file only makes sure the app still *opens* when the Mac is asleep, with
 * its own chrome instead of Safari's dinosaur.
 *
 * Requires a secure context, which is why it landed after Tailscale HTTPS —
 * over the plain-http LAN address registration is refused outright.
 */

// Bump to evict everything from a previous deploy. Next hashes its own asset
// URLs, so stale entries would otherwise accumulate forever rather than break.
const VERSION = "co-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const PRECACHE = ["/offline", "/icon-192.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(SHELL);
      // Individually, not addAll: addAll rejects atomically, so one 404 during
      // a partial deploy would leave the worker with no cache at all.
      await Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data — always the network, never a cache entry, not even as a
  // fallback. An offline /api/jobs must fail so the UI can say so.
  if (url.pathname.startsWith("/api/")) return;

  // Hashed build output is immutable: cache-first is free and makes a second
  // launch instant.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network-first, because a stale page is a lie about live state.
  // Only when the network fails do we fall back — to the last good copy of this
  // page, else the offline notice.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        } catch {
          return (await caches.match(request)) || (await caches.match("/offline")) || Response.error();
        }
      })(),
    );
  }
});
