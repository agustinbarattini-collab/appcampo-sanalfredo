const CACHE_NAME = "appcampo-sanalfredo-v30";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/config.js",
  "./js/db.js",
  "./js/app.js",
  "./js/sync.js",
  "./js/cambios.js",
  "./js/geoLotes.js",
  "./js/lotesGeo.js",
  "./js/zonaOrden.js",
  "./js/maestros.js",
  "./js/maestrosHub.js",
  "./js/cargaGranos.js",
  "./js/movimientosInsumos.js",
  "./js/aplicacionesFitosanitarios.js",
  "./js/siembra.js",
  "./js/ordenesTrabajo.js",
  "./js/stockUtils.js",
  "./js/ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: "reload" salta la copia que el navegador guarda hasta 10 minutos: sin
      // esto, una versión nueva podía instalarse con archivos viejos adentro.
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })))
    )
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const esNavegacion = req.mode === "navigate";
      // Los links con ?rol=... (o cualquier otro parámetro) son la misma página:
      // sin ignoreSearch no se encontraban en la caché y no abrían sin señal.
      let cached = await cache.match(req, { ignoreSearch: esNavegacion });
      if (!cached && esNavegacion) cached = await cache.match("./index.html");
      // no-cache: revalida contra el servidor (barato, 304) en vez de usar la copia del navegador.
      const fetchPromise = fetch(req, { cache: "no-cache" })
        .then((networkResponse) => {
          // Solo se guardan respuestas buenas: un error pasajero del servidor
          // no debe pisar la copia que sirve para trabajar sin señal.
          if (networkResponse && networkResponse.ok) cache.put(req, networkResponse.clone());
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })()
  );
});
