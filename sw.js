const CACHE_NAME = "vetdata-v5";
// Los 4 scripts de Firebase se cargan desde el servidor de Google
// (gstatic.com), no desde este mismo sitio — por eso hay que guardarlos
// aparte a propósito. Sin ellos guardados, sin internet la librería de
// Firebase nunca llega a cargar, y la app se queda pegada para siempre
// esperándola (nunca llega ni a mostrar el login de verdad ni los datos
// guardados).
const ASSETS_FIREBASE = [
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // El resto del sitio (archivos propios) se cachea junto, todo o
      // nada — si alguno falla es señal de un problema real.
      await cache.addAll(["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"]).catch(() => {});
      // Los scripts de Firebase se guardan APARTE, uno por uno: si alguno
      // fallara al guardarse (por ejemplo, por un problema pasajero de
      // CORS con el servidor de Google), no debe tumbar el guardado de
      // TODO lo demás — mejor guardar los que sí se puedan.
      await Promise.all(ASSETS_FIREBASE.map((url) => cache.add(url).catch(() => {})));
    })
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
// IMPORTANTE: se aplica a los archivos del propio sitio Y a los 4
// scripts de Firebase (ver ASSETS_FIREBASE) — las demás peticiones a
// Firebase (el inicio de sesión en sí, la base de datos) se dejan pasar
// sin tocar, para no interferir con la sincronización de datos.
//
// "cache: no-store" en el fetch: evita que el propio navegador (no solo este
// Service Worker) devuelva una copia intermedia guardada por su cuenta —
// así, cada vez que hay internet, se pide SIEMPRE la versión más nueva al
// servidor, sin atajos por el camino.
// Con conexiones "raras" (por ejemplo, planes de datos que solo dejan
// pasar WhatsApp y bloquean todo lo demás en silencio, sin rechazar la
// conexión de una vez), el fetch() de arriba puede quedarse esperando una
// respuesta que nunca llega — y como nunca "falla", tampoco cae nunca al
// .catch() que usa la copia guardada. Por eso se le pone un límite de
// tiempo: si a los 4 segundos no hay respuesta, se da por vencido y usa
// la caché de una vez, en vez de dejar la app cargando sin abrir.
function fetchConLimiteDeTiempo(request, milisegundos) {
  return new Promise((resolve, reject) => {
    const vencido = setTimeout(() => reject(new Error("tiempo de espera agotado")), milisegundos);
    fetch(request, { cache: "no-store" }).then(
      (respuesta) => {
        clearTimeout(vencido);
        resolve(respuesta);
      },
      (error) => {
        clearTimeout(vencido);
        reject(error);
      }
    );
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const esDelPropioSitio = event.request.url.startsWith(self.location.origin);
  const esScriptDeFirebase = ASSETS_FIREBASE.includes(event.request.url);
  if (!esDelPropioSitio && !esScriptDeFirebase) return;

  event.respondWith(
    fetchConLimiteDeTiempo(event.request, 4000)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(async () => {
        // Primero se busca una coincidencia exacta con lo que se pidió
        // (ignorando "?parámetros" en la URL, que no cambian qué archivo
        // es).
        const exacto = await caches.match(event.request, { ignoreSearch: true });
        if (exacto) return exacto;
        // Si de todos modos no hay coincidencia exacta y esto es abrir la
        // app (no pedir una imagen o un archivo suelto) — por ejemplo, en
        // iPhone, abrir la app "Agregada a pantalla de inicio" a veces
        // hace la petición con una URL que no es idéntica, letra por
        // letra, a la guardada — se usa la página principal guardada de
        // todos modos. Es mejor mostrar la app (aunque tenga que volver a
        // pedir esa URL exacta después) que una pantalla en blanco.
        if (event.request.mode === "navigate") {
          const indice = await caches.match("./index.html") || await caches.match("./");
          if (indice) return indice;
        }
        return new Response("Sin conexión y todavía no hay una copia guardada de esto. Abre la app una vez con internet primero.", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        });
      })
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
  // Si el paciente tiene foto, se muestra como imagen grande dentro de la
  // notificación (compatible en Android/Chrome; en algunos navegadores
  // simplemente no se ve la imagen extra, pero el resto del aviso sigue
  // funcionando igual).
  if (payload.data?.foto) {
    options.image = payload.data.foto;
  }
  self.registration.showNotification(title, options);
});

// Si tocan la notificación, abre (o enfoca) la app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Si la notificación trae el ID del paciente, se abre/enfoca la app
  // directo en su ficha (la propia app se encarga de saltar la pantalla
  // de bienvenida cuando detecta este parámetro en la URL).
  const patientId = event.notification.data?.patientId;
  const destino = patientId ? "./?patient=" + encodeURIComponent(patientId) : "./";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(destino);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(destino);
    })
  );
});
