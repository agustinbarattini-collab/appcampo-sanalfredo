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
    // La carga esta pensada para el asesor, directo en esta pestaña (no hay
    // formulario de alta en la app — Órdenes de Trabajo pasó a ser de solo
    // lectura para los contratistas, 2026-08-17). Cada producto ahora es
    // dosis por hectárea, no cantidad total fija — la app calcula la
    // necesidad total multiplicando por "has". Reordenado 2026-08-17 para
    // que se cargue de corrido (nombre, contratista, lotes, has, fechas,
    // productos) y con "has" pegado a "lotesNombres" para completarlo más
    // fácil; "id" y las fechas de sistema van al final — no hace falta
    // tocarlas nunca, se llenan solas (ver aplicarValidacionOrdenesTrabajo,
    // que además las pinta de gris y arma los desplegables validados).
    headers: [
      "nombre", "contratistaNombre", "lotesNombres", "has", "fechaAsignacion", "fechaLimite",
      "producto1Nombre", "producto1DosisPorHa", "producto1Unidad",
      "producto2Nombre", "producto2DosisPorHa", "producto2Unidad",
      "producto3Nombre", "producto3DosisPorHa", "producto3Unidad",
      "producto4Nombre", "producto4DosisPorHa", "producto4Unidad",
      "producto5Nombre", "producto5DosisPorHa", "producto5Unidad",
      "producto6Nombre", "producto6DosisPorHa", "producto6Unidad",
      "observaciones", "id", "fechaCreacion", "fechaCreacionRegistro", "fechaSincronizacion",
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

// Pestaña chica de clave/valor para ajustes puntuales editables desde la
// Sheet sin tocar código — hoy solo tiene "resetVersion" (ver más abajo,
// forzarResetTelefonos), pero sirve como lugar genérico si hace falta otro
// ajuste similar más adelante.
const CONFIG_SHEET = { name: "Config", headers: ["clave", "valor"] };

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
  crearPestana(ss, CONFIG_SHEET);
  asegurarValorConfigInicial("resetVersion", 0);
  ["Hoja 1", "Sheet1"].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  aplicarValidacionCampanias();
  aplicarValidacionOrdenesTrabajo();
}

/**
 * Se corre sola cada vez que se abre la planilla (trigger simple de Apps
 * Script, no hace falta activarlo a mano) y agrega el menú "App de Campo"
 * con acciones que conviene poder hacer sin entrar al editor de código.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("App de Campo")
    .addItem("Forzar reset en todos los celulares...", "forzarResetTelefonos")
    .addToUi();
}

/**
 * Lee un valor guardado en la pestaña "Config" (clave/valor). Devuelve null
 * si esa clave todavía no tiene fila.
 */
function leerValorConfig(clave) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG_SHEET.name);
  if (!hoja) return null;
  const lastRow = hoja.getLastRow();
  if (lastRow < 2) return null;
  const filas = hoja.getRange(2, 1, lastRow - 1, 2).getValues();
  for (const fila of filas) {
    if (String(fila[0]).trim() === clave) return fila[1];
  }
  return null;
}

/**
 * Escribe (o crea) la fila clave/valor de "Config" correspondiente a clave.
 */
function escribirValorConfig(clave, valor) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(CONFIG_SHEET.name);
  if (!hoja) {
    crearPestana(ss, CONFIG_SHEET);
    hoja = ss.getSheetByName(CONFIG_SHEET.name);
  }
  const lastRow = hoja.getLastRow();
  if (lastRow >= 2) {
    const claves = hoja.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < claves.length; i++) {
      if (String(claves[i][0]).trim() === clave) {
        hoja.getRange(i + 2, 2).setValue(valor);
        return;
      }
    }
  }
  hoja.appendRow([clave, valor]);
}

// Se llama desde setup(): asegura que "resetVersion" tenga un valor inicial
// en Config, sin pisar uno que ya se haya subido a mano (correr setup() de
// nuevo después de forzar un reset no debe volver el contador para atrás).
function asegurarValorConfigInicial(clave, porDefecto) {
  if (leerValorConfig(clave) === null) {
    escribirValorConfig(clave, porDefecto);
  }
}

/**
 * Sube en 1 el contador "resetVersion" de Config. Cada celular lo revisa al
 * sincronizar (viene incluido en la respuesta de "leerMaestros"): si ve un
 * número más alto que el que tiene guardado, borra TODO lo que tiene
 * guardado localmente y vuelve a descargar todo de cero desde esta
 * planilla (ver verificarResetRemoto() en app.js). No es instantáneo: se
 * aplica recién la próxima vez que cada celular sincronice con conexión.
 * Antes de tocar nada, muestra un aviso que hay que confirmar a propósito.
 */
function forzarResetTelefonos() {
  const ui = SpreadsheetApp.getUi();
  const mensaje =
    "Esto va a borrar los datos guardados en TODOS los celulares que usan esta app " +
    "y hacer que vuelvan a descargar todo de cero desde esta planilla.\n\n" +
    "Usalo solo cuando ya borraste o reorganizaste algo grande directo en la Sheet " +
    "(por ejemplo, el stock de Insumos o las Aplicaciones de Fitosanitarios) y " +
    "necesitás que los celulares dejen de mostrar lo viejo.\n\n" +
    "Tené en cuenta:\n" +
    "• No es instantáneo: se aplica recién la próxima vez que cada celular abra " +
    "la app CON conexión a internet.\n" +
    "• Si un celular tiene algo cargado todavía sin sincronizar, no se le borra " +
    "nada — espera solo a que sincronice y reintenta después, sin perder nada.\n" +
    "• Esto no borra ni modifica nada de esta planilla, solo lo que cada celular " +
    "tiene guardado en su propia memoria.\n\n" +
    "¿Confirmás que querés forzar el reset en todos los celulares?";
  const respuesta = ui.alert("Forzar reset en todos los celulares", mensaje, ui.ButtonSet.OK_CANCEL);
  if (respuesta !== ui.Button.OK) return;
  const actual = Number(leerValorConfig("resetVersion")) || 0;
  escribirValorConfig("resetVersion", actual + 1);
  ui.alert("Listo. Se va a aplicar en cada celular la próxima vez que sincronice con conexión a internet.");
}

/**
 * Lee la columna A (a partir de la fila 2) de una pestaña de maestro y
 * devuelve los nombres no vacíos — helper chico para armar listas de
 * desplegables sin repetir el mismo getRange/getValues/filter cada vez.
 */
function nombresDeMaestro(nombrePestana) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(nombrePestana);
  if (!hoja) return [];
  const lastRow = hoja.getLastRow();
  if (lastRow < 2) return [];
  return hoja
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (n) { return n !== ""; });
}

/**
 * Arma los desplegables validados de "Órdenes de Trabajo" (contratista,
 * lotes, cada producto y su unidad) contra los maestros correspondientes, y
 * pinta de gris las columnas que llena el sistema (id y las 3 fechas de
 * sincronización) para que se note a simple vista que no hay que tocarlas.
 * Se corre sola al final de setup() — si algún maestro todavía no tiene
 * filas cargadas, esa validación puntual se salta (no deja una lista vacía
 * que bloquee todo).
 */
function aplicarValidacionOrdenesTrabajo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(SHEETS.ordenTrabajo.name);
  if (!hoja) return;
  const headers = SHEETS.ordenTrabajo.headers;
  const FILAS = 499;

  function colDe(campo) {
    return headers.indexOf(campo) + 1;
  }

  // Contratista: desplegable estricto (un solo contratista por orden).
  const contratistas = nombresDeMaestro(MAESTROS_SHEETS.contratistas.name);
  if (contratistas.length > 0) {
    const regla = SpreadsheetApp.newDataValidation().requireValueInList(contratistas, true).setAllowInvalid(false).build();
    const col = colDe("contratistaNombre");
    if (col > 0) hoja.getRange(2, col, FILAS, 1).setDataValidation(regla);
  }

  // Lotes: desplegable SUGERIDO, no estricto — una orden puede tener varios
  // lotes separados por coma en la misma celda, y una validación estricta
  // rechazaría eso. Ayuda a elegir el nombre exacto sin tipeo cuando es un
  // solo lote, pero deja escribir una lista igual.
  const lotes = nombresDeMaestro(MAESTROS_SHEETS.lotes.name);
  if (lotes.length > 0) {
    const regla = SpreadsheetApp.newDataValidation().requireValueInList(lotes, true).setAllowInvalid(true).build();
    const col = colDe("lotesNombres");
    if (col > 0) hoja.getRange(2, col, FILAS, 1).setDataValidation(regla);
  }

  // Productos: desplegable estricto contra Maestros - Insumos, uno por cada
  // una de las 6 filas de producto posibles.
  const insumos = nombresDeMaestro(MAESTROS_SHEETS.insumos.name);
  if (insumos.length > 0) {
    const reglaProducto = SpreadsheetApp.newDataValidation().requireValueInList(insumos, true).setAllowInvalid(false).build();
    for (let i = 1; i <= 6; i++) {
      const col = colDe("producto" + i + "Nombre");
      if (col > 0) hoja.getRange(2, col, FILAS, 1).setDataValidation(reglaProducto);
    }
  }

  // Unidad: desplegable estricto con las unidades que ya existen en
  // Maestros - Insumos (ej. Kg, Lts, Bls) — evita variantes tipo "kg"/"Kg."
  // que después no coincidan al comparar contra el insumo real.
  const ssInsumos = ss.getSheetByName(MAESTROS_SHEETS.insumos.name);
  if (ssInsumos) {
    const lastRow = ssInsumos.getLastRow();
    const unidadesSet = {};
    if (lastRow >= 2) {
      ssInsumos.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (fila) {
        const u = String(fila[1] || "").trim();
        if (u) unidadesSet[u] = true;
      });
    }
    const unidades = Object.keys(unidadesSet);
    if (unidades.length > 0) {
      const reglaUnidad = SpreadsheetApp.newDataValidation().requireValueInList(unidades, true).setAllowInvalid(false).build();
      for (let i = 1; i <= 6; i++) {
        const col = colDe("producto" + i + "Unidad");
        if (col > 0) hoja.getRange(2, col, FILAS, 1).setDataValidation(reglaUnidad);
      }
    }
  }

  // Columnas que llena el sistema, no el asesor — se pintan de gris para
  // que se note a simple vista que no hay que tocarlas.
  ["id", "fechaCreacion", "fechaCreacionRegistro", "fechaSincronizacion"].forEach(function (campo) {
    const col = colDe(campo);
    if (col > 0) hoja.getRange(1, col, 500, 1).setBackground("#e8e8e8");
  });
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
 * Reacomoda las filas YA CARGADAS de una pestaña al orden nuevo de
 * sheetCfg.headers, sin perder ni desalinear ningún dato — lee cada fila
 * usando el encabezado REAL que hoy tiene la fila 1 (no un orden fijo
 * pegado en el código), la reconstruye por nombre de columna, y reescribe
 * toda la pestaña con el orden nuevo. Segura de correr de más: si la fila 1
 * ya está en el orden nuevo, no hace nada. No se llama directo — usar los
 * wrappers de abajo (uno por pestaña) para poder elegirlos por nombre en el
 * desplegable de funciones del editor (▶).
 */
function migrarOrdenColumnas(sheetCfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetCfg.name);
  if (!sheet) {
    Logger.log('No existe la pestaña "' + sheetCfg.name + '".');
    return;
  }
  const headerActual = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const nuevoOrden = sheetCfg.headers;
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
  Logger.log("Migradas " + filasNuevas.length + " filas al orden nuevo en \"" + sheetCfg.name + "\".");
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
  migrarOrdenColumnas(SHEETS.cargaGranos);
}

/**
 * Mismo criterio que migrarOrdenColumnasCargaGranos(), para "Órdenes de
 * Trabajo" — correr UNA vez después de pegar el cambio que reordenó sus
 * columnas (has al lado de lotesNombres, id al final). Nota: como el
 * producto1Cantidad viejo se renombró a producto1DosisPorHa (son conceptos
 * distintos, no una cantidad total), esa columna puntual no se migra con
 * datos viejos — queda vacía para completarla de nuevo con la dosis real.
 */
function migrarOrdenColumnasOrdenesTrabajo() {
  migrarOrdenColumnas(SHEETS.ordenTrabajo);
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
  const resetVersion = Number(leerValorConfig("resetVersion")) || 0;
  return respond({ ok: true, maestros: maestros, resetVersion: resetVersion });
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
