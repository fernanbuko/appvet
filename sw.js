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

/* ---------------------------------------------------------
   Notificaciones push (Firebase Cloud Messaging)
   Se agrega AQUÍ, en el mismo service worker que ya controla el sitio (en
   vez de un archivo separado), para evitar que dos service workers
   distintos compitan por controlar la misma página — eso puede hacer que
   las notificaciones no lleguen de forma confiable.
----------------------------------------------------------*/
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBvkkovcmGKGgm-X7inBcl54N9AnxoVU7w",
  authDomain: "vetdata-1557e.firebaseapp.com",
  projectId: "vetdata-1557e",
  storageBucket: "vetdata-1557e.firebasestorage.app",
  messagingSenderId: "420928741564",
  appId: "1:420928741564:web:f15d24133b8dbf3f1fb0b9",
});

const messaging = firebase.messaging();

// Cuando llega una notificación con la app cerrada o en segundo plano.
messaging.onBackgroundMessage((payload) => {
  // Se lee desde "data" (no "notification"): el robot manda el mensaje
  // solo como data para que el propio navegador nunca la muestre por su
  // cuenta, evitando que salga duplicada.
  const title = payload.data?.title || "VetData";
  const options = {
    body: payload.data?.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: payload.data || {},
  };
  self.registration.showNotification(title, options);
});

// Si tocan la notificación, abre (o enfoca) la app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
