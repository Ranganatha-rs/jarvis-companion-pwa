"use strict";
const CACHE = "jarvis-companion-v2";
const CACHE_NAMESPACE = "jarvis-companion-";
const ASSETS = ["./", "./index.html", "./app.js", "./audio-playback.js", "./audio-worklet.js", "./style.css", "./manifest.webmanifest", "./icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(
  keys.filter(key => key.startsWith(CACHE_NAMESPACE) && key !== CACHE).map(key => caches.delete(key))
))));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
});
