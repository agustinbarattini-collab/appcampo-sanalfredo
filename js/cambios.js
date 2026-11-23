import { dbGet, dbGetAll, dbPut, dbDelete } from "./db.js";

// Editar y eliminar registros desde el celular.
//
// Un registro nuevo se sube a la planilla como una fila más (ver syncAll). Pero
// una EDICIÓN o una ELIMINACIÓN hay que avisarlas aparte: la planilla ya tiene
// la fila vieja. Cada cambio queda anotado en la tabla local "cambiosPendientes"
// (una cola) y syncAll() la sube cuando hay internet — el celular puede estar
// sin señal cuando se corrige un error, y el cambio igual se acuerda de subirse.
//
// Todo lo que se elimina acá se saca de inmediato del celular (así stock y
// totales quedan bien al instante); en la planilla se borra la fila y se deja
// una copia en la pestaña "Historial de cambios".

const STORE_CAMBIOS = "cambiosPendientes";

function claveDe(tipo, id) {
  return `${tipo}:${id}`;
}

async function anotarCambio(store, tipo, id, accion) {
  const clave = claveDe(tipo, id);
  const previo = await dbGet(STORE_CAMBIOS, clave);
  // Si ya hay una eliminación esperando, esa manda sobre cualquier otra cosa.
  if (previo && previo.accion === "eliminar") return;
  await dbPut(STORE_CAMBIOS, {
    clave,
    store,
    tipo,
    id,
    accion,
    // Sirve para saber, al terminar de subirlo, si mientras tanto se volvió a tocar.
    version: Date.now() + Math.random(),
    error: "",
  });
}

// Guarda un registro corregido. El registro tiene que conservar su id.
async function guardarEdicion(store, tipo, registro) {
  // La pantalla puede estar mostrando una copia vieja del registro (por ejemplo, se
  // guardó hace un instante y recién ahora terminó de subir): lo que dice el estado
  // de sincronización siempre se toma de lo que hay guardado, no de la pantalla.
  const actual = await dbGet(store, registro.id);
  const final = actual
    ? {
        ...registro,
        sincronizado: actual.sincronizado,
        sincronizadoEn: actual.sincronizadoEn,
        fotoUrl: actual.fotoUrl || registro.fotoUrl,
        huellaSheet: actual.huellaSheet,
      }
    : { ...registro, sincronizado: false };
  await dbPut(store, final);
  await anotarCambio(store, tipo, final.id, "editar");
}

// Elimina el registro del celular y anota que hay que sacarlo de la planilla.
// Se anota SIEMPRE, también si el registro figuraba como "Pendiente": puede que
// la planilla ya lo haya recibido y el celular nunca se enteró (se cortó la señal
// justo antes de la respuesta).
async function eliminarRegistro(store, tipo, id) {
  await dbDelete(store, id);
  await anotarCambio(store, tipo, id, "eliminar");
}

async function listarCambios() {
  return dbGetAll(STORE_CAMBIOS);
}

async function quitarCambio(clave) {
  await dbDelete(STORE_CAMBIOS, clave);
}

export { STORE_CAMBIOS, claveDe, guardarEdicion, eliminarRegistro, listarCambios, quitarCambio };
