const CACHE_NAME = "roseberry-shell-v4";
const SHELL_FILES = [
  "./roseberry-planner.html",
  "./planner-shared.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

// GitHub Pages serves this app with `Cache-Control: max-age=600` (confirmed 2026-07-21). A plain
// `fetch(req)` honours that HTTP header — so even this "network-first" strategy could silently
// hand back a browser-disk-cached response up to 10 minutes old with NO real network round-trip,
// which is exactly what let a stale build sit invisible on a phone. `cache:"no-store"` forces every
// request this worker makes (both the install-time precache and every runtime fetch) to bypass the
// HTTP cache layer entirely, so "network-first" actually means network, every time.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "no-store" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch Airtable/cross-origin
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
