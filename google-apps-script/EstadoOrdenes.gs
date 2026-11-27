/**
 * Estado de cada orden según lo que cargó el aplicador en la app.
 *
 * Va como archivo NUEVO dentro del Apps Script de la planilla de la app
 * (Extensiones → Apps Script → + → Secuencia de comandos → "EstadoOrdenes").
 * No toca el Code.gs ni hace falta crear una nueva versión de la implementación.
 * Después correr instalarEstadoOrdenes() UNA vez (▶) y aceptar los permisos.
 *
 * Agrega al final de la pestaña "Órdenes de Trabajo" la columna
 * "Realizada por aplicador" con:
 *   - Realizada 18/11 · 132 ha       (verde)    todos los lotes de la orden tienen su carga
 *   - Parcial: 1 de 3 lotes · falta SAA09 (amarillo)
 *   - Pendiente                       (sin color)
 *   - Pendiente · vencida 20/11       (rojo)     pasó la fecha límite sin carga completa
 *   - Anulada                         (gris)
 *
 * Mismo criterio que la app: una orden está realizada cuando cada lote de
 * "lotesNombres" tiene una aplicación en "Fitosanitarios" con esa orden en
 * "ordenTrabajoNombre". Se recalcula sola cada 10 minutos y al abrir la planilla.
 * La app no lee esta columna (solo lee las que conoce), así que no la afecta.
 * Si alguna vez se borra (por ejemplo al correr setup), se vuelve a crear sola.
 */

const ESTADO_ORDENES_COLUMNA = "Realizada por aplicador";
const ESTADO_ORDENES_HOJA_ORDENES = "Órdenes de Trabajo";
const ESTADO_ORDENES_HOJA_APLICACIONES = "Fitosanitarios";
const ESTADO_ORDENES_COLORES = {
  realizada: "#d9ead3",
  parcial: "#fff2cc",
  vencida: "#f4cccc",
  anulada: "#e8e8e8",
  pendiente: null,
};

function estadoOrdenesNormalizar_(t) {
  return String(t == null ? "" : t).trim().toLowerCase();
}

// Lotes comparados sin espacios ni mayúsculas ("SAA 08" = "saa08").
function estadoOrdenesClaveLote_(t) {
  return estadoOrdenesNormalizar_(t).replace(/\s+/g, "");
}

/**
 * Cálculo puro (sin tocar la planilla): recibe las filas de las dos pestañas
 * (con su fila de encabezados) y devuelve, por cada fila de órdenes, el texto
 * y el tipo de estado. hoyClave y formatearDia vienen de afuera para poder
 * probarlo.
 *   formatearDia(fecha) -> "yyyy-MM-dd"
 */
function calcularEstadoOrdenes(ordenes, aplicaciones, hoyClave, formatearDia) {
  const encO = ordenes[0].map(String);
  const cO = (n) => encO.indexOf(n);
  const encA = aplicaciones.length ? aplicaciones[0].map(String) : [];
  const cA = (n) => encA.indexOf(n);
  if (cO("nombre") === -1) throw new Error('En "' + ESTADO_ORDENES_HOJA_ORDENES + '" no encuentro la columna "nombre".');

  // Aplicaciones agrupadas por nombre de orden.
  const porOrden = {};
  for (let r = 1; r < aplicaciones.length; r++) {
    const f = aplicaciones[r];
    const k = estadoOrdenesNormalizar_(f[cA("ordenTrabajoNombre")]);
    if (!k) continue;
    const fecha = f[cA("fecha")];
    const dia = fecha instanceof Date ? formatearDia(fecha) : String(fecha || "").slice(0, 10);
    (porOrden[k] = porOrden[k] || []).push({
      lote: String(f[cA("loteNombre")] || "").trim(),
      has: Number(String(f[cA("hectareas")] || "0").replace(",", ".")) || 0,
      dia: dia,
    });
  }

  const corto = (dia) => (dia && dia.length >= 10 ? dia.slice(8, 10) + "/" + dia.slice(5, 7) : "");
  const salida = [];
  for (let r = 1; r < ordenes.length; r++) {
    const f = ordenes[r];
    const nombre = String(f[cO("nombre")] || "").trim();
    if (!nombre) {
      salida.push({ texto: "", tipo: "vacia" });
      continue;
    }
    if (cO("estado") !== -1 && estadoOrdenesNormalizar_(f[cO("estado")]) === "anulada") {
      salida.push({ texto: "Anulada", tipo: "anulada" });
      continue;
    }
    const apps = porOrden[estadoOrdenesNormalizar_(nombre)] || [];
    const lotes = String(cO("lotesNombres") !== -1 ? f[cO("lotesNombres")] || "" : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const lotesConCarga = {};
    apps.forEach((a) => (lotesConCarga[estadoOrdenesClaveLote_(a.lote)] = true));
    const faltan = lotes.filter((l) => !lotesConCarga[estadoOrdenesClaveLote_(l)]);
    const deLaOrden = lotes.length
      ? apps.filter((a) => lotes.some((l) => estadoOrdenesClaveLote_(l) === estadoOrdenesClaveLote_(a.lote)))
      : apps;
    const has = Math.round(deLaOrden.reduce((s, a) => s + a.has, 0) * 100) / 100;
    const ultimoDia = deLaOrden.reduce((m, a) => (a.dia > m ? a.dia : m), "");
    const hasTxt = has > 0 ? " · " + String(has).replace(".", ",") + " ha" : "";

    if (deLaOrden.length && faltan.length === 0) {
      salida.push({ texto: "Realizada " + corto(ultimoDia) + hasTxt, tipo: "realizada" });
      continue;
    }
    const limite = cO("fechaLimite") !== -1 ? f[cO("fechaLimite")] : "";
    const limiteDia = limite instanceof Date ? formatearDia(limite) : "";
    const vencida = limiteDia && limiteDia < hoyClave;
    // Carga ligada a la orden pero en un lote que no figura en la orden.
    const otros = apps
      .filter((a) => deLaOrden.indexOf(a) === -1)
      .map((a) => a.lote)
      .filter((l, i, arr) => l && arr.indexOf(l) === i);
    const notaOtros = otros.length ? " · hay carga en otro lote: " + otros.join(", ") : "";
    if (deLaOrden.length) {
      salida.push({
        texto: "Parcial: " + (lotes.length - faltan.length) + " de " + lotes.length + " lotes · falta " + faltan.join(", ") + (vencida ? " · vencida " + corto(limiteDia) : "") + notaOtros,
        tipo: vencida ? "vencida" : "parcial",
      });
      continue;
    }
    salida.push({ texto: "Pendiente" + (vencida ? " · vencida " + corto(limiteDia) : "") + notaOtros, tipo: vencida ? "vencida" : "pendiente" });
  }
  return salida;
}

/** Recalcula la columna. La corre el disparador cada 10 minutos; también se puede correr a mano (▶). */
function actualizarEstadoOrdenes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(ESTADO_ORDENES_HOJA_ORDENES);
  if (!hoja || hoja.getLastRow() < 1) return "No encuentro la pestaña " + ESTADO_ORDENES_HOJA_ORDENES;
  const hojaA = ss.getSheetByName(ESTADO_ORDENES_HOJA_APLICACIONES);
  const tz = ss.getSpreadsheetTimeZone();
  const formatearDia = (d) => Utilities.formatDate(d, tz, "yyyy-MM-dd");

  // Columna destino: la que ya tiene el encabezado o, si no existe, una nueva al final.
  const ultimaCol = Math.max(1, hoja.getLastColumn());
  const encabezados = hoja.getRange(1, 1, 1, ultimaCol).getValues()[0].map(String);
  let col = encabezados.indexOf(ESTADO_ORDENES_COLUMNA) + 1;
  if (col === 0) {
    col = ultimaCol + 1;
    const celda = hoja.getRange(1, col);
    celda.setValue(ESTADO_ORDENES_COLUMNA).setFontWeight("bold").setBackground("#d9ead3");
    celda.setNote("La llena sola el script EstadoOrdenes según lo que el aplicador cargó en Fitosanitarios (cada 10 minutos). No hace falta tocarla.");
    hoja.setColumnWidth(col, 260);
  }
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return "Sin órdenes";

  // Se leen las órdenes SIN la columna de estado (para no mezclarla con los datos).
  const ordenes = hoja.getRange(1, 1, ultimaFila, Math.max(1, col - 1)).getValues();
  const aplicaciones = hojaA && hojaA.getLastRow() >= 1 ? hojaA.getDataRange().getValues() : [];
  const res = calcularEstadoOrdenes(ordenes, aplicaciones, formatearDia(new Date()), formatearDia);

  const rango = hoja.getRange(2, col, res.length, 1);
  rango.setValues(res.map((e) => [e.texto]));
  rango.setBackgrounds(res.map((e) => [ESTADO_ORDENES_COLORES[e.tipo] || null]));
  const cuenta = res.reduce((m, e) => ((m[e.tipo] = (m[e.tipo] || 0) + 1), m), {});
  return JSON.stringify(cuenta);
}

/**
 * Correr UNA vez (▶): crea los disparadores (cada 10 minutos y al abrir la
 * planilla) y llena la columna. Correrla de nuevo no duplica nada.
 */
function instalarEstadoOrdenes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "actualizarEstadoOrdenes")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("actualizarEstadoOrdenes").timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger("actualizarEstadoOrdenes").forSpreadsheet(ss).onOpen().create();
  const r = actualizarEstadoOrdenes();
  try {
    ss.toast("Columna \"" + ESTADO_ORDENES_COLUMNA + "\" lista. Se actualiza sola cada 10 minutos.", "Estado de órdenes", 8);
  } catch (e) {}
  return r;
}

if (typeof module !== "undefined") module.exports = { calcularEstadoOrdenes };
