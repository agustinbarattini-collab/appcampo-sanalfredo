import { cargaGranosView } from "./cargaGranos.js";
import { movimientosInsumosView } from "./movimientosInsumos.js";
import { aplicacionesFitosanitariosView } from "./aplicacionesFitosanitarios.js";
import { siembraView } from "./siembra.js";
import { maestrosHubView } from "./maestrosHub.js";
import { APP_CONFIG } from "./config.js";
import { syncAll, pullAll, contarPendientes } from "./sync.js";

const routes = {
  carga: { view: cargaGranosView, label: "Carga de Granos" },
  insumos: { view: movimientosInsumosView, label: "Insumos" },
  fitosanitarios: { view: aplicacionesFitosanitariosView, label: "Fitosanitarios" },
  siembra: { view: siembraView, label: "Siembra" },
  maestros: { view: maestrosHubView, label: "Maestros" },
};

// Links por rol: cada uno oculta las pestañas que no le corresponden y abre
// directo en la primera. "Maestros" queda visible para todos los roles
// porque ahí se actualizan los datos base (lotes, insumos, etc.) desde Sheets.
// Ejemplos de link para compartir: "https://.../?rol=granos", "?rol=siembra", "?rol=fitoinsumos".
const ROLES = {
  granos: { rutas: ["carga", "maestros"] },
  siembra: { rutas: ["siembra", "maestros"] },
  fitoinsumos: { rutas: ["insumos", "fitosanitarios", "maestros"] },
};
const ROL_STORAGE_KEY = "appcampo_rol";

function resolverRol() {
  const rolUrl = new URLSearchParams(location.search).get("rol");
  if (rolUrl === "todos") {
    localStorage.removeItem(ROL_STORAGE_KEY);
    return null;
  }
  if (rolUrl && ROLES[rolUrl]) {
    localStorage.setItem(ROL_STORAGE_KEY, rolUrl);
    return rolUrl;
  }
  const guardado = localStorage.getItem(ROL_STORAGE_KEY);
  return ROLES[guardado] ? guardado : null;
}

// Si es null, no hay restricción (acceso completo, comportamiento de siempre).
const rolActivo = resolverRol();
const rutasPermitidas = rolActivo ? ROLES[rolActivo].rutas : null;

const main = document.getElementById("main");
const tabLinks = document.querySelectorAll("nav.tabbar a");
if (rutasPermitidas) {
  tabLinks.forEach((a) => {
    if (!rutasPermitidas.includes(a.dataset.route)) a.classList.add("hidden");
  });
}

async function updateSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!el || !APP_CONFIG.sheetsWebAppUrl) return;
  el.classList.remove("hidden");
  const pendientes = await contarPendientes();
  if (pendientes === 0) {
    el.textContent = "Todo sincronizado";
    el.classList.add("ok");
  } else {
    el.textContent = `${pendientes} pendiente${pendientes === 1 ? "" : "s"} de sincronizar`;
    el.classList.remove("ok");
  }
}

async function runSync() {
  await syncAll();
  await pullAll();
  await updateSyncStatus();
  // Refresca la vista actual por si trajo datos nuevos de otros dispositivos.
  await router();
}

// Versión liviana: solo sube lo pendiente y actualiza el badge, sin traer datos
// de otros dispositivos ni redibujar la pantalla (para no pisar un formulario
// que el usuario ya empezó a llenar de nuevo). Se dispara justo después de
// guardar cualquier registro, además del sync completo en reconexión/apertura.
async function syncNow() {
  await syncAll();
  await updateSyncStatus();
}

window.addEventListener("appcampo-sync-now", syncNow);

// Evita que dos llamadas a router() se pisen entre sí (por ejemplo, el render
// inicial de la app y el que dispara runSync() al terminar de sincronizar):
// sin esto, un render a medio terminar puede terminar enganchando sus
// listeners a los elementos del OTRO render, duplicando comportamiento
// (ej: un <select> que se termina poblando dos veces).
let routerEnCurso = false;
let routerPendiente = false;

async function router() {
  if (routerEnCurso) {
    routerPendiente = true;
    return;
  }
  routerEnCurso = true;
  try {
    const hashRaw = (location.hash || "").replace("#", "");
    const [mainKeyRaw, subKey] = hashRaw.split("/");
    const defaultKey = rutasPermitidas ? rutasPermitidas[0] : "carga";
    const mainKey = mainKeyRaw || defaultKey;

    if (rutasPermitidas && !rutasPermitidas.includes(mainKey)) {
      location.hash = defaultKey;
      return; // el cambio de hash vuelve a disparar router() con la ruta permitida
    }
    if (!mainKeyRaw) {
      location.hash = mainKey;
      return;
    }

    const route = routes[mainKey] || routes.carga;
    tabLinks.forEach((a) => a.classList.toggle("active", a.dataset.route === mainKey));
    await route.view.render(main, subKey);
    updateSyncStatus();
  } finally {
    routerEnCurso = false;
    if (routerPendiente) {
      routerPendiente = false;
      router();
    }
  }
}

function updateOnlineBadge() {
  const badge = document.getElementById("syncBadge");
  if (!badge) return;
  if (navigator.onLine) {
    badge.textContent = "En línea";
    badge.classList.add("ok");
  } else {
    badge.textContent = "Sin conexión";
    badge.classList.remove("ok");
  }
}

window.addEventListener("hashchange", router);
window.addEventListener("online", () => {
  updateOnlineBadge();
  runSync();
});
window.addEventListener("offline", updateOnlineBadge);

window.addEventListener("DOMContentLoaded", () => {
  document.title = APP_CONFIG.empresaNombre;
  const appTitle = document.getElementById("appTitle");
  if (appTitle) appTitle.textContent = APP_CONFIG.empresaNombre;
  document.documentElement.style.setProperty("--color-primario", APP_CONFIG.colorPrimario);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute("content", APP_CONFIG.colorPrimario);

  router();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((reg) => {
        // Revisa si hay una versión nueva publicada cada vez que la app
        // vuelve a primer plano (no solo al abrirla desde cero).
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update();
        });
      })
      .catch((err) => {
        console.warn("No se pudo registrar el service worker:", err);
      });

    // El service worker usa skipWaiting()+clients.claim(), así que apenas
    // una versión nueva termina de activarse toma el control de la página
    // sola. Cuando eso pasa, recargamos para que se vea la versión nueva
    // sin depender de que el usuario cierre y reabra la app a mano.
    let recargandoPorActualizacion = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recargandoPorActualizacion) return;
      recargandoPorActualizacion = true;
      location.reload();
    });
  }

  updateOnlineBadge();
  if (navigator.onLine) runSync();
});
