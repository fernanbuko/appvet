const CACHE_NAME = "vetdata-v3";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Estrategia: primero red, y si falla (sin conexión), usa lo que haya en caché.
// Así siempre ves la versión más reciente cuando hay internet, y la app sigue
// abriendo aunque no haya conexión.
// IMPORTANTE: solo se aplica a peticiones del propio sitio; las peticiones a
// Firebase/Google (login, base de datos) se dejan pasar sin tocar, para no
// interferir con el inicio de sesión ni la sincronización de datos.
//
// "cache: no-store" en el fetch: evita que el propio navegador (no solo este
// Service Worker) devuelva una copia intermedia guardada por su cuenta —
// así, cada vez que hay internet, se pide SIEMPRE la versión más nueva al
// servidor, sin atajos por el camino.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
