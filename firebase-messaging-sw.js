// Este archivo lo requiere Firebase Cloud Messaging para poder mostrar
// notificaciones push aunque la pestaña de la app esté cerrada o en segundo
// plano. No se toca a mano: solo recibe el mensaje que manda el "robot" de
// GitHub Actions y lo muestra como notificación del sistema.

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

// Cuando llega una notificación con la app cerrada o en segundo plano,
// Firebase ya la muestra automáticamente si el mensaje trae un bloque
// "notification" (que es como la vamos a mandar desde el robot). Este
// manejador es un respaldo explícito por si acaso.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "VetData";
  const options = {
    body: payload.notification?.body || "",
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
