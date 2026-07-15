// Incrémenter ce numéro à chaque mise à jour de l'appli pour forcer le rechargement du cache.
const CACHE_NAME = "ite-devis-cache-v19";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./vendor/html2canvas.min.js",
  "./vendor/jspdf.umd.min.js",
  "./vendor/firebase-app-compat.js",
  "./vendor/firebase-auth-compat.js",
  "./vendor/firebase-firestore-compat.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache d'abord : l'appli marche hors ligne dès qu'elle a été ouverte une première fois.
// En parallèle, on va chercher une version plus fraîche sur le réseau pour la prochaine visite.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Ne jamais mettre en cache les appels vers Firebase (auth / Firestore) : ce sont des
  // requêtes réseau temps réel (connexion, synchronisation) qui ne doivent pas être rejouées
  // depuis un cache, sous peine de casser la connexion ou la synchro.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
