/* Copyright (C) 2026 Sean O'Neill. SPDX-License-Identifier: AGPL-3.0-or-later. See the LICENSE file. */
/* Range Book offline support: keeps the app itself and your target photos on the phone
   so the site opens with no signal. Your data is cached and queued by the page itself. */
/* v2 (1.7.2): reinstalled so it runs under the server's updated security policy, which lets it fetch the
   spreadsheet reader (chronograph .xlsx import) and fonts from their CDNs. */
const SHELL = "rb-shell-v1", PHOTOS = "rb-photos-v1", EXT = "rb-ext-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, PHOTOS, EXT].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const networkFirst = async (req, cacheName, key) => {
  const c = await caches.open(cacheName);
  try {
    const r = await fetch(req);
    if (r && r.ok) c.put(key || req, r.clone());
    return r;
  } catch (e) {
    const hit = await c.match(key || req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
};
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (/^\/api\/photos\/[^/]+$/.test(url.pathname)) {
      // photo files never change, so serve the saved copy first
      e.respondWith(caches.open(PHOTOS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const r = await fetch(req);
        if (r && r.ok) c.put(req, r.clone());
        return r;
      }));
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return; // the page handles data itself
    if (req.mode === "navigate") { e.respondWith(networkFirst(req, SHELL, "/")); return; }
    e.respondWith(networkFirst(req, SHELL));
    return;
  }
  // fonts and the spreadsheet library from their CDNs
  if (/fonts\.(googleapis|gstatic)\.com$|cdnjs\.cloudflare\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(EXT).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
