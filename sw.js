const CACHE_NAME = "roseberry-shell-v15";
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

/* ---------- Push notifications ----------
   The sender puts a JSON body on the wire ({title, body, url, tag}); anything else — a malformed
   payload, or a browser-generated wake-up with no data at all — still has to show *something*,
   because the subscription is userVisibleOnly and Chrome will show its own "This site has been
   updated in the background" notice if we don't. Hence the fallbacks rather than an early return.

   `tag` collapses repeats: re-sending the same morning digest replaces the existing notification
   instead of stacking a second copy in the shade. */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }

  const title = payload.title || "Roseberry Planner";
  const options = {
    body: payload.body || "You have tasks due.",
    tag: payload.tag || "roseberry",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: payload.url || "./roseberry-planner.html" },
    // Farm phones live in pockets and gloves — let the OS decide vibration, but keep the
    // notification sticky enough that a glance later still finds it.
    renotify: !!payload.tag,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* Tapping a notification should land in the already-open app if there is one, rather than starting
   a second copy — an app relaunch would lose whatever was on screen and re-fetch everything. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./roseberry-planner.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("roseberry-planner") && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
