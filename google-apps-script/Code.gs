/**
 * Backend de sincronización para App de Campo.
 * Se pega en el editor de Apps Script de una Google Sheet (Extensiones → Apps Script)
 * y se despliega como Web App. Ver DUPLICAR.md para el paso a paso completo.
 */

// Reemplazar por un texto random propio (no hace falta recordarlo, solo copiarlo a config.js).
const SHARED_SECRET = "REEMPLAZAR_CON_UN_TOKEN_SECRETO";

// Nombre de la empresa: se usa para armar la carpeta de Drive donde se guardan
// las fotos (ver guardarFotoEnDrive), para que quede clara la separación entre
// empresas aunque varias usen la misma cuenta de Google.
const EMPRESA_NOMBRE = "San Alfredo";

// Opcional: ID de una carpeta de Drive YA EXISTENTE donde tiene que vivir
// "App de Campo - Fotos", en vez de crearse suelta en la raíz de Drive. Se
// saca del final de la URL de esa carpeta: drive.google.com/drive/folders/ESTE_ID
// Dejar en "" para que se cree en la raíz de Drive (comportamiento por defecto).
const CARPETA_DRIVE_PADRE_ID = "";

const SHEETS = {
  cargaGranos: {
    name: "Carga de Granos",
    // Reordenado el 2026-08-15 para que se lea de corrido: identificación,
    // campaña, origen 1 (tipo+nombre+kg), origen 2 (tipo+nombre+kg), total,
    // datos del viaje, y al final lo más técnico (gps, bruto/tara sin usar
    // en esta empresa, timestamps de sistema). Como esto reordena columnas
    // que ya tenían datos cargados, correr migrarOrdenColumnasCargaGranos()
    // UNA vez (ver más abajo) para reacomodar las filas existentes sin
    // perder nada — no alcanza con pegar este archivo y ya está.
    headers: [
      "id", "fecha", "campaniaNombre",
      "origenTipo", "origenNombre", "kgOrigen1",
      "origen2Tipo", "origen2Nombre", "kgOrigen2",
      "kgNeto",
      "cultivo", "ctg", "chofer", "patente", "corredorNombre", "humedad",
      "observaciones", "fotoUrl",
      "gpsLat", "gpsLng", "kgBrutos", "tara",
      "fechaCreacionRegistro", "fechaSincronizacion",
    ],
  },
  movimientoInsumo: {
    name: "Movimientos Insumos",
    headers: [
      "id", "tipo", "fecha", "proveedorNombre", "ordenTrabajoNombre", "contratistaNombre",
      "insumoNombre", "unidad", "cantidad", "observaciones", "fechaCreacionRegistro",
      "fechaSincronizacion",
      // La foto del remito, si se sacó una (ver guardarFotoEnDrive).
      "fotoUrl",
    ],
  },
  aplicacionFitosanitaria: {
    name: "Fitosanitarios",
    headers: [
      "id", "fecha", "contratistaNombre", "loteNombre", "hectareas",
      "producto1Nombre", "producto1Cantidad", "producto1Unidad",
      "producto2Nombre", "producto2Cantidad", "producto2Unidad",
      "producto3Nombre", "producto3Cantidad", "producto3Unidad",
      "producto4Nombre", "producto4Cantidad", "producto4Unidad",
      "producto5Nombre", "producto5Cantidad", "producto5Unidad",
      "comentarios", "fechaCreacionRegistro", "fechaSincronizacion",
      // Va al final para no correr de lugar los datos ya cargados en planillas existentes.
      "producto6Nombre", "producto6Cantidad", "producto6Unidad",
      "ordenTrabajoNombre",
    ],
  },
  avanceSiembra: {
    name: "Avance Siembra",
    headers: [
      "id", "fecha", "loteNombre", "cultivo", "hasSembradas", "comentarios", "marcaCierre",
      "fechaCreacionRegistro", "fechaSincronizacion",
      "campaniaNombre",
    ],
  },
  cierreSiembra: {
    name: "Cierres Siembra",
    headers: [
      "id", "fecha", "loteNombre", "cultivo", "semillaKg", "semillaVariedad", "semillaBolsas",
      "semillaHibrido", "fertilizanteKg", "fertilizanteTipo", "comentarios",
      "fechaCreacionRegistro", "fechaSincronizacion",
      "campaniaNombre",
    ],
  },
  ajusteSiloBolsa: {
    name: "Ajustes Silo Bolsa",
    headers: [
      "id", "fecha", "siloBolsaNombre", "cultivo", "kgTotalInicial", "kgTotalRetirado",
      "diferenciaKg", "tipoDiferencia", "observaciones", "fechaCreacionRegistro", "fechaSincronizacion",
      // Va al final para no correr de lugar los datos ya cargados: campaña del
      // silo bolsa que se finalizó (heredada del maestro, no se elige a mano).
      "campaniaNombre",
    ],
  },
  ordenTrabajo: {
    name: "Órdenes de Trabajo",
    headers: [
      "id", "nombre", "contratistaNombre", "lotesNombres", "fechaAsignacion", "fechaLimite",
      "producto1Nombre", "producto1Cantidad", "producto1Unidad",
      "producto2Nombre", "producto2Cantidad", "producto2Unidad",
      "producto3Nombre", "producto3Cantidad", "producto3Unidad",
      "producto4Nombre", "producto4Cantidad", "producto4Unidad",
      "producto5Nombre", "producto5Cantidad", "producto5Unidad",
      "producto6Nombre", "producto6Cantidad", "producto6Unidad",
      "observaciones", "fechaCreacion", "fechaCreacionRegistro", "fechaSincronizacion",
    ],
  },
};

// Pestañas de maestros: las edita la persona directamente en la Sheet.
// La app las lee (POST con accion:"leerMaestros") para importar Lotes, Insumos, etc.
// sin tipearlos a mano.
const MAESTROS_SHEETS = {
  lotes: { name: "Maestros - Lotes", headers: ["nombre", "cultivo"] },
  // campaniaNombre agregado al final (2026-08-15): a qué campaña pertenece
  // cada silo bolsa, para poder generar métricas por campaña más adelante y
  // para que dos silos con el mismo nombre+cultivo de campañas distintas no
  // se traten como el mismo pool de stock (ver agruparSilosPorNombreCultivo
  // en stockUtils.js). Completar a mano por fila, igual que las demás
  // columnas de este maestro — no hace falta que coincida con ninguna
  // campaña "activa" en particular, es la campaña en la que se armó ESE silo.
  silosBolsa: { name: "Maestros - Silos Bolsa", headers: ["nombre", "cultivo", "kgTotalInicial", "campaniaNombre"] },
  corredores: { name: "Maestros - Corredores", headers: ["nombre"] },
  insumos: { name: "Maestros - Insumos", headers: ["nombre", "unidad"] },
  proveedores: { name: "Maestros - Proveedores", headers: ["nombre"] },
  contratistas: { name: "Maestros - Contratistas", headers: ["nombre"] },
  campanias: { name: "Maestros - Campañas", headers: ["nombre", "activa"] },
  planSiembra: { name: "Maestros - Plan Siembra", headers: ["loteNombre", "cultivo", "superficieTeorica", "campaniaNombre"] },
};

/**
 * Correr esta función UNA vez desde el editor (▶) para crear las pestañas con sus
 * encabezados. Google va a pedir autorización la primera vez: es normal, hay que
 * aceptar (la app es tuya, solo actúa sobre esta planilla). Si ya la corriste antes
 * y agregaste pestañas de maestros nuevas, volver a correrla es seguro (no borra nada).
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (key) {
    crearPestana(ss, SHEETS[key]);
  });
  Object.keys(MAESTROS_SHEETS).forEach(function (key) {
    crearPestana(ss, MAESTROS_SHEETS[key]);
  });
  ["Hoja 1", "Sheet1"].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  aplicarValidacionCampanias();
}

/**
 * Convierte la columna "campaniaNombre" de Silos Bolsa y Plan de Siembra en
 * una lista desplegable con los nombres que hoy existen en "Maestros -
 * Campañas", en vez de texto libre. Así se evita el problema real que ya
 * pasó una vez (una campaña "2025/26" con barra, escrita a mano, terminó
 * creando una campaña fantasma separada de la "2025-26" real con guion) —
 * ahora solo se puede elegir un nombre que YA existe, no tipear uno nuevo
 * por error. Se corre sola al final de setup(), así que se mantiene
 * actualizada cada vez que se agrega/renombra una campaña y se vuelve a
 * correr setup() (idempotente, no rompe nada si se corre de más). Si
 * "Maestros - Campañas" todavía no tiene ninguna fila cargada, no hace nada
 * (evita dejar una lista vacía que bloquee cualquier valor).
 */
function aplicarValidacionCampanias() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaCampanias = ss.getSheetByName(MAESTROS_SHEETS.campanias.name);
  if (!hojaCampanias) return;
  const lastRow = hojaCampanias.getLastRow();
  if (lastRow < 2) return;

  const nombres = hojaCampanias
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (n) { return n !== ""; });
  if (nombres.length === 0) return;

  const regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(nombres, true)
    .setAllowInvalid(false)
    .build();

  [MAESTROS_SHEETS.silosBolsa, MAESTROS_SHEETS.planSiembra].forEach(function (cfg) {
    const hoja = ss.getSheetByName(cfg.name);
    if (!hoja) return;
    const col = cfg.headers.indexOf("campaniaNombre") + 1;
    if (col < 1) return;
    // Rango amplio (499 filas) para cubrir filas que se agreguen después,
    // sin tener que correr esto de nuevo cada vez que se suma una carga.
    hoja.getRange(2, col, 499, 1).setDataValidation(regla);
  });
}

function crearPestana(ss, cfg) {
  let sheet = ss.getSheetByName(cfg.name);
  if (!sheet) sheet = ss.insertSheet(cfg.name);
  sheet.getRange(1, 1, 1, cfg.headers.length).setValues([cfg.headers]);
  sheet.setFrozenRows(1);
}

/**
 * Correr esta función UNA sola vez desde el editor (▶) después de pegar un
 * cambio que reordena SHEETS.cargaGranos.headers, para reacomodar las filas
 * YA CARGADAS al orden nuevo sin perder ni desalinear ningún dato. Lee cada
 * fila existente usando el encabezado REAL que hoy tiene la fila 1 de la
 * planilla (no un orden fijo pegado en el código), la reconstruye por
 * nombre de columna, y reescribe toda la pestaña con el orden nuevo.
 * Segura de correr de más: si la fila 1 ya está en el orden nuevo, no hace
 * nada (evita reinterpretar datos ya migrados con el header viejo).
 */
function migrarOrdenColumnasCargaGranos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.cargaGranos.name);
  if (!sheet) {
    Logger.log('No existe la pestaña "' + SHEETS.cargaGranos.name + '".');
    return;
  }
  const headerActual = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const nuevoOrden = SHEETS.cargaGranos.headers;
  if (JSON.stringify(headerActual) === JSON.stringify(nuevoOrden)) {
    Logger.log("Ya está en el orden nuevo, no hace falta correr esto de nuevo.");
    return;
  }
  const lastRow = sheet.getLastRow();
  const filasViejas = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, headerActual.length).getValues()
    : [];
  const filasNuevas = filasViejas.map(function (fila) {
    const obj = {};
    headerActual.forEach(function (h, i) { obj[h] = fila[i]; });
    return nuevoOrden.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
  });
  sheet.clearContents();
  sheet.getRange(1, 1, 1, nuevoOrden.length).setValues([nuevoOrden]);
  if (filasNuevas.length > 0) {
    sheet.getRange(2, 1, filasNuevas.length, nuevoOrden.length).setValues(filasNuevas);
  }
  sheet.setFrozenRows(1);
  Logger.log("Migradas " + filasNuevas.length + " filas al orden nuevo.");
}

/**
 * Correr esta función UNA vez desde el editor (▶) para completar "kgOrigen1"
 * en las filas viejas que quedaron vacías ahí — son cargas hechas ANTES de
 * que el backend tuviera esa columna, así que el dato nunca se guardó (el
 * cliente ya lo mandaba, pero el Code.gs viejo lo ignoraba). Se puede
 * reconstruir sin ambigüedad porque kgNeto siempre es kgOrigen1+kgOrigen2:
 * kgOrigen1 = kgNeto - kgOrigen2 (con kgOrigen2 en 0 para cargas de un solo
 * origen, da el total completo). Solo toca filas con kgOrigen1 vacío — no
 * pisa ningún valor ya cargado por una sincronización posterior a este fix.
 */
function backfillKgOrigen1CargaGranos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.cargaGranos.name);
  if (!sheet) {
    Logger.log('No existe la pestaña "' + SHEETS.cargaGranos.name + '".');
    return;
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colKgOrigen1 = headers.indexOf("kgOrigen1");
  const colKgOrigen2 = headers.indexOf("kgOrigen2");
  const colKgNeto = headers.indexOf("kgNeto");
  if (colKgOrigen1 === -1 || colKgOrigen2 === -1 || colKgNeto === -1) {
    Logger.log("Faltan columnas kgOrigen1/kgOrigen2/kgNeto en la fila 1 — no se puede completar.");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const rango = sheet.getRange(2, 1, lastRow - 1, headers.length);
  const filas = rango.getValues();
  let completadas = 0;
  filas.forEach(function (fila) {
    if (fila[colKgOrigen1] === "" || fila[colKgOrigen1] === null) {
      const kgNeto = parseFloat(fila[colKgNeto]) || 0;
      const kgOrigen2 = parseFloat(fila[colKgOrigen2]) || 0;
      fila[colKgOrigen1] = kgNeto - kgOrigen2;
      completadas++;
    }
  });
  rango.setValues(filas);
  Logger.log("Completadas " + completadas + " filas con kgOrigen1 calculado (kgNeto - kgOrigen2).");
}

/**
 * Todo pasa por POST (incluida la lectura de maestros). Los pedidos GET a un Web App
 * de Apps Script no siempre devuelven headers CORS utilizables desde fetch() en el
 * navegador (por el redirect interno a script.googleusercontent.com), así que se evita
 * doGet por completo y se usa un campo "accion" para distinguir lectura de escritura.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SHARED_SECRET) {
      return respond({ ok: false, error: "token inválido" });
    }

    if (body.accion === "leerMaestros") {
      return responderMaestros();
    }
    if (body.accion === "leerRegistros") {
      return responderRegistros();
    }

    const cfg = SHEETS[body.tipo];
    if (!cfg) {
      return respond({ ok: false, error: "tipo desconocido: " + body.tipo });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(cfg.name);
    if (!sheet) {
      crearPestana(ss, cfg);
      sheet = ss.getSheetByName(cfg.name);
    }
    const r = body.registro || {};
    let fotoUrl = "";
    if (r.fotoBase64) {
      fotoUrl = guardarFotoEnDrive(r.fotoBase64, body.tipo, r.id);
    }
    const row = cfg.headers.map(function (h) {
      if (h === "fechaSincronizacion") return new Date().toISOString();
      if (h === "fotoUrl") return fotoUrl;
      const v = r[h];
      if (v === undefined || v === null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    });
    sheet.appendRow(row);
    return respond({ ok: true, fotoUrl: fotoUrl });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

// Carpeta de Drive por tipo de registro, dentro de "App de Campo - Fotos/<EMPRESA_NOMBRE>/".
// Agregar una entrada acá cuando se sume otro formulario con foto (ej. Órdenes de Trabajo).
const CARPETAS_POR_TIPO = {
  cargaGranos: "Carga de Granos",
  movimientoInsumo: "Insumos - Remitos",
};

// Guarda la foto (viene en base64 desde el cliente, ya comprimida) en Drive,
// ordenada en "App de Campo - Fotos/<empresa>/<tema>/", y devuelve el link.
// Si algo falla, devuelve "" en vez de tirar error — no tiene que bloquear
// el guardado del resto del registro por un problema con la foto.
function guardarFotoEnDrive(fotoBase64, tipo, idRegistro) {
  try {
    const partes = String(fotoBase64).split(",");
    const datos = partes.length > 1 ? partes[1] : partes[0];
    const bytes = Utilities.base64Decode(datos);
    const blob = Utilities.newBlob(bytes, "image/jpeg", (idRegistro || "foto") + ".jpg");
    const carpetaPadre = CARPETA_DRIVE_PADRE_ID ? DriveApp.getFolderById(CARPETA_DRIVE_PADRE_ID) : null;
    const raiz = obtenerOCrearCarpeta("App de Campo - Fotos", carpetaPadre);
    const carpetaEmpresa = obtenerOCrearCarpeta(EMPRESA_NOMBRE, raiz);
    const carpetaTema = obtenerOCrearCarpeta(CARPETAS_POR_TIPO[tipo] || "Otros", carpetaEmpresa);
    const file = carpetaTema.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return "";
  }
}

function obtenerOCrearCarpeta(nombre, padre) {
  const base = padre || DriveApp;
  const existentes = base.getFoldersByName(nombre);
  return existentes.hasNext() ? existentes.next() : base.createFolder(nombre);
}

function responderMaestros() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const maestros = {};
  Object.keys(MAESTROS_SHEETS).forEach(function (key) {
    const cfg = MAESTROS_SHEETS[key];
    const sheet = ss.getSheetByName(cfg.name);
    maestros[key] = sheet ? leerPestana(sheet, cfg.headers) : [];
  });
  return respond({ ok: true, maestros: maestros });
}

function responderRegistros() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const registros = {};
  Object.keys(SHEETS).forEach(function (key) {
    const cfg = SHEETS[key];
    const sheet = ss.getSheetByName(cfg.name);
    registros[key] = sheet ? leerPestana(sheet, cfg.headers) : [];
  });
  return respond({ ok: true, registros: registros });
}

function leerPestana(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values
    .filter(function (row) { return String(row[0]).trim() !== ""; })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
