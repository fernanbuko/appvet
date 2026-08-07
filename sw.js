const CACHE_NAME = "airescare-cache-v26";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./consejo-filtro.png",
  "./consejo-temp.png",
  "./consejo-mantenimiento.png",
  "./consejo-eco.png",
  "./ac-hero.png",
  "./ac-unit.png"
];

// --- Firebase Cloud Messaging: recibir notificaciones push en segundo plano ---
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyClrv-TpgdZCdFVGYvBGSjEeBEXoxCM5_U",
  authDomain: "airescare-20bf4.firebaseapp.com",
  projectId: "airescare-20bf4",
  storageBucket: "airescare-20bf4.firebasestorage.app",
  messagingSenderId: "441921693356",
  appId: "1:441921693356:web:b1f8584ea98b729b3ce109"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const titulo = (payload.data && payload.data.title) || "AiresCare";
  const opciones = {
    body: (payload.data && payload.data.body) || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: (payload.data && payload.data.tag) || undefined
  };
  self.registration.showNotification(titulo, opciones);
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: siempre intenta traer la version mas reciente de internet.
// Solo usa la copia guardada si no hay conexion.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const scopeUrl = self.registration.scope;
      for (const client of clientsArr) {
        if (client.url.startsWith(scopeUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(scopeUrl);
      }
    })
  );
});

