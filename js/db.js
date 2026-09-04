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

// Borra la base local entera (todas las pestañas) para forzar una
// resincronización de cero desde la Sheet — ver APP_CONFIG.resetVersion en
// config.js. Cierra la conexión abierta antes de borrar (si no, el borrado
// queda "blocked" indefinidamente) y limpia dbPromise para que la próxima
// llamada a openDb() abra una base nueva en vez de reusar la cerrada.
async function borrarTodoLocal() {
  const db = await openDb();
  db.close();
  dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // No debería bloquearse (recién cerramos la única conexión abierta),
    // pero por las dudas no lo dejamos colgado esperando para siempre.
    req.onblocked = () => resolve();
  });
}

export { openDb, uid, dbGetAll, dbGet, dbPut, dbDelete, borrarTodoLocal };
