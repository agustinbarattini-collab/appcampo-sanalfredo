import { APP_CONFIG } from "./config.js";

const DB_NAME = `appcampo_${APP_CONFIG.empresaId}`;
const DB_VERSION = 9;

const STORES = {
  lotes: "id",
  silosBolsa: "id",
  corredores: "id",
  cargasGranos: "id",
  insumos: "id",
  proveedores: "id",
  contratistas: "id",
  ordenesTrabajo: "id",
  movimientosInsumos: "id",
  aplicacionesFitosanitarios: "id",
  avanceSiembra: "id",
  cierresSiembra: "id",
  planSiembra: "id",
  ajustesSiloBolsa: "id",
  campanias: "id",
  // Depósitos/galpones para llevar stock de Insumos desglosado por lugar
  // físico (LCDP, 2026-08-21) — vacío/no usado en empresas de un solo pool.
  galpones: "id",
};

const STORES_ELIMINADOS = ["productosSiembra"];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
      for (const name of STORES_ELIMINADOS) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function uid() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function dbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Vacía todas las tablas locales para forzar una resincronización de cero
// desde la Sheet — ver verificarResetRemoto() en app.js. NO usa
// indexedDB.deleteDatabase(): si la app está abierta en otra pestaña o
// ventana a la vez (pasa seguido en el celular, ej. el ícono instalado más
// una pestaña de Chrome), ese borrado queda "bloqueado" por la otra
// conexión, la promesa volvía igual como si hubiera terminado, la app marcaba
// el reset como hecho y nunca lo reintentaba — con los datos viejos todavía
// ahí. Vaciar las tablas con una transacción no depende de que las demás
// conexiones se cierren, y si falla rechaza la promesa (así el reset no se
// marca como hecho y se reintenta en la próxima revisión).
async function borrarTodoLocal() {
  const db = await openDb();
  const tablas = Array.from(db.objectStoreNames);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(tablas, "readwrite");
    tablas.forEach((nombre) => tx.objectStore(nombre).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export { openDb, uid, dbGetAll, dbGet, dbPut, dbDelete, borrarTodoLocal };
