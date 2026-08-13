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

const SHEETS = {
  cargaGranos: {
    name: "Carga de Granos",
    headers: [
      "id", "fecha", "origenTipo", "origenNombre", "cultivo", "ctg", "chofer", "patente",
      "corredorNombre", "kgBrutos", "tara", "kgNeto", "humedad", "gpsLat", "gpsLng",
      "observaciones", "fechaCreacionRegistro", "fechaSincronizacion",
      // Agregados después (van al final para no correr de lugar los datos ya cargados
      // en planillas existentes): segundo origen opcional, para cuando el camión se
      // carga de 2 bolsas o 2 lotes en el mismo viaje.
      "origen2Tipo", "origen2Nombre", "kgOrigen2",
      // Va al final por el mismo motivo: no correr de lugar los datos ya cargados.
      "campaniaNombre",
      // La foto del ticket/báscula, si se sacó una (ver guardarFotoEnDrive).
      "fotoUrl",
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
  silosBolsa: { name: "Maestros - Silos Bolsa", headers: ["nombre", "cultivo", "kgTotalInicial"] },
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
}

function crearPestana(ss, cfg) {
  let sheet = ss.getSheetByName(cfg.name);
  if (!sheet) sheet = ss.insertSheet(cfg.name);
  sheet.getRange(1, 1, 1, cfg.headers.length).setValues([cfg.headers]);
  sheet.setFrozenRows(1);
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
    const raiz = obtenerOCrearCarpeta("App de Campo - Fotos", null);
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
