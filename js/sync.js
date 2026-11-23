import { dbGetAll, dbGet, dbPut, dbDelete, uid } from "./db.js";
import { APP_CONFIG } from "./config.js";
import { STORE_CAMBIOS, listarCambios, quitarCambio, claveDe } from "./cambios.js";

function flattenCarga(r) {
  return {
    ...r,
    gpsLat: r.gps ? r.gps.lat : "",
    gpsLng: r.gps ? r.gps.lng : "",
    foto: undefined,
  };
}

function flattenMovimiento(r) {
  return { ...r, foto: undefined };
}

// Achica la foto antes de mandarla (una foto de cámara sin comprimir puede
// pesar varios MB, lento/caro en datos móviles) y la devuelve en base64 lista
// para mandar en el body del POST. Se corre recién al sincronizar (no al
// sacar la foto), así que tiene que funcionar aunque el Blob venga de una
// captura vieja guardada offline.
function comprimirFotoABase64(blob, maxDim = 1600, calidad = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const escala = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * escala) || 1;
      const h = Math.round(img.height * escala) || 1;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", calidad));
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

// Cantidad máxima de productos por aplicación/orden: 6 por defecto, y cada
// empresa puede subirlo con maxProductos en config.js (requiere que su Sheet
// tenga las columnas productoN... correspondientes, ver Code.gs).
const MAX_PRODUCTOS = APP_CONFIG.maxProductos || 6;

function flattenAplicacion(r) {
  const out = { ...r };
  // Se mandan TODAS las posiciones (las que sobran, vacías): si al corregir una
  // aplicación se saca un producto, la planilla tiene que borrar esa celda.
  for (let i = 0; i < MAX_PRODUCTOS; i++) {
    const p = (r.productos || [])[i];
    out[`producto${i + 1}Nombre`] = p ? p.productoNombre : "";
    out[`producto${i + 1}Cantidad`] = p ? p.cantidad : "";
    out[`producto${i + 1}Unidad`] = p ? p.unidad : "";
  }
  out.productos = undefined;
  return out;
}

function flattenAvance(r) {
  return { ...r };
}

function flattenCierre(r) {
  return { ...r };
}

function flattenAjusteSiloBolsa(r) {
  return { ...r };
}

function flattenOrdenTrabajo(r) {
  const out = { ...r };
  out.lotesNombres = (r.lotes || []).map((l) => l.loteNombre).join(", ");
  (r.productosPlanificados || []).forEach((p, i) => {
    out[`producto${i + 1}Nombre`] = p.productoNombre;
    out[`producto${i + 1}DosisPorHa`] = p.dosisPorHa;
    out[`producto${i + 1}Unidad`] = p.unidad;
  });
  out.estado = r.anulada ? "Anulada" : "";
  out.zona = r.zona && r.zona.length ? JSON.stringify(r.zona) : "";
  out.zonaPendiente = undefined;
  out.anulada = undefined;
  out.lotes = undefined;
  out.productosPlanificados = undefined;
  return out;
}

// Columna "estado" de la pestaña Órdenes de Trabajo: el asesor escribe
// "Anulada" para cancelar una orden sin borrar la fila (borrarla no la saca
// de los celulares, la sincronización nunca borra lo ya descargado).
function estaAnulada(estado) {
  const e = String(estado || "").trim().toLowerCase();
  return e.startsWith("anul") || e.startsWith("cancel");
}

const TIPOS = [
  { store: "cargasGranos", tipo: "cargaGranos", flatten: flattenCarga },
  { store: "movimientosInsumos", tipo: "movimientoInsumo", flatten: flattenMovimiento },
  { store: "aplicacionesFitosanitarios", tipo: "aplicacionFitosanitaria", flatten: flattenAplicacion },
  { store: "avanceSiembra", tipo: "avanceSiembra", flatten: flattenAvance },
  { store: "cierresSiembra", tipo: "cierreSiembra", flatten: flattenCierre },
  { store: "ajustesSiloBolsa", tipo: "ajusteSiloBolsa", flatten: flattenAjusteSiloBolsa },
  { store: "ordenesTrabajo", tipo: "ordenTrabajo", flatten: flattenOrdenTrabajo },
];

let syncing = false;
// Se incrementa al empezar y al terminar cada sincronización: pullAll() lo usa para
// descartar una lectura de la planilla que quedó vieja porque en el medio se subió algo.
let epocaSync = 0;

// Lo que se manda a la planilla no incluye datos internos de la app.
function limpiarPayload(payload) {
  delete payload.huellaSheet;
  delete payload.sincronizadoEn;
  return payload;
}

async function contarPendientes() {
  let total = 0;
  for (const { store } of TIPOS) {
    const items = await dbGetAll(store);
    total += items.filter((r) => !r.sincronizado).length;
  }
  // Zonas a aplicar marcadas en la app que todavía no se subieron a la Sheet.
  const ordenes = await dbGetAll("ordenesTrabajo");
  total += ordenes.filter((o) => o.zonaPendiente).length;
  // Ediciones y eliminaciones esperando subir (ver cambios.js). Una edición de un
  // registro que todavía no se subió ya se cuenta arriba (va a subir con los datos nuevos).
  for (const c of await listarCambios()) {
    if (c.accion === "editar") {
      const r = await dbGet(c.store, c.id);
      if (!r || !r.sincronizado) continue;
    }
    total++;
  }
  return total;
}

// Tiempo máximo de espera por llamada a la planilla. Sin esto, una llamada colgada
// por mala señal dejaba "syncing" trabado en true y TODAS las sincronizaciones
// siguientes salían sin hacer nada (ni avisar).
const TIEMPO_MAX_LLAMADA_MS = 90000;

async function llamarBackend(body) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIEMPO_MAX_LLAMADA_MS);
  try {
    const res = await fetch(APP_CONFIG.sheetsWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: APP_CONFIG.sheetsSyncToken, ...body }),
      signal: control.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// La zona a aplicar de una orden (cuando no va todo el lote) se marca desde la
// app sobre una orden que YA existe en la Sheet, así que no se manda como un
// registro nuevo (duplicaría la fila): el backend actualiza la columna "zona"
// de la fila con ese nombre.
// Texto claro de por qué falló una llamada a la planilla (para mostrarlo en pantalla).
function describirErrorDeRed(err) {
  const detalle = err && (err.message || err.name) ? ` [${err.name || "Error"}: ${err.message || ""}]` : "";
  if (err && err.name === "AbortError") return "la planilla tardó demasiado en responder (probá con mejor señal)";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "el celular no tiene internet en este momento";
  if (err instanceof SyntaxError) return "la planilla respondió algo inesperado (no es una respuesta válida)" + detalle;
  if (err instanceof TypeError) return "no se pudo conectar con la planilla (error de red)" + detalle;
  return "error inesperado" + detalle;
}

let subiendoZonas = false;

// Devuelve { ocupado, resultados: [{ nombre, ok, mensaje }] } para poder avisarle a
// quien toca "Subir ahora" qué pasó. No depende del candado de syncAll().
async function subirZonasPendientes() {
  if (subiendoZonas) return { ocupado: true, resultados: [] };
  subiendoZonas = true;
  const resultados = [];
  try {
    const ordenes = await dbGetAll("ordenesTrabajo");
    for (const o of ordenes.filter((x) => x.zonaPendiente)) {
      const zonaTxt = o.zona && o.zona.length ? JSON.stringify(o.zona) : "";
      const guardarError = async (mensaje) => {
        const fresca = (await dbGetAll("ordenesTrabajo")).find((x) => x.id === o.id);
        if (fresca) {
          fresca.zonaError = mensaje;
          await dbPut("ordenesTrabajo", fresca);
        }
      };
      try {
        const data = await llamarBackend({ accion: "guardarZonaOrden", nombre: o.nombre, zona: zonaTxt });
        // Se relee por si la zona se volvió a editar mientras se subía.
        const fresca = (await dbGetAll("ordenesTrabajo")).find((x) => x.id === o.id);
        const frescaTxt = fresca && fresca.zona && fresca.zona.length ? JSON.stringify(fresca.zona) : "";
        if (!data.ok && !data.noEncontrada) {
          // El servidor la rechazó: queda pendiente y se guarda el motivo para mostrarlo en la orden.
          const mensaje = String(data.error || "la planilla la rechazó");
          console.warn("La planilla rechazó la zona de la orden:", o.nombre, mensaje);
          await guardarError(mensaje);
          resultados.push({ nombre: o.nombre, ok: false, mensaje });
          continue;
        }
        if (data.noEncontrada) {
          console.warn("La orden no está en la planilla, la zona queda solo en este celular:", o.nombre);
        }
        if (fresca && frescaTxt === zonaTxt) {
          fresca.zonaPendiente = false;
          fresca.zonaError = data.noEncontrada ? "esa orden no está en la planilla (la zona queda solo en este celular)" : "";
          await dbPut("ordenesTrabajo", fresca);
        }
        resultados.push({
          nombre: o.nombre,
          ok: !data.noEncontrada,
          mensaje: data.noEncontrada ? "esa orden no está en la planilla" : "",
        });
      } catch (err) {
        const mensaje = describirErrorDeRed(err);
        console.warn("No se pudo subir la zona de la orden:", o.nombre, err);
        await guardarError(mensaje);
        resultados.push({ nombre: o.nombre, ok: false, mensaje });
      }
    }
  } finally {
    subiendoZonas = false;
  }
  return { ocupado: false, resultados };
}

// Helpers para anotar un cambio desde acá (cambios.js ya los tiene, pero sin dependencia circular).
async function anotarEdicion(store, tipo, id) {
  const clave = claveDe(tipo, id);
  const previo = await dbGet(STORE_CAMBIOS, clave);
  if (previo && previo.accion === "eliminar") return;
  await dbPut(STORE_CAMBIOS, { clave, store, tipo, id, accion: "editar", version: Date.now() + Math.random(), error: "" });
}

async function anotarEliminacion(store, tipo, id) {
  await dbPut(STORE_CAMBIOS, { clave: claveDe(tipo, id), store, tipo, id, accion: "eliminar", version: Date.now() + Math.random(), error: "" });
}

// Sube las ediciones y eliminaciones anotadas (ver cambios.js). Cada una se saca de
// la cola recién cuando la planilla confirma; si falla queda para el próximo intento.
async function subirCambiosPendientes() {
  const flattens = Object.fromEntries(TIPOS.map((t) => [t.tipo, t.flatten]));
  const cambios = (await listarCambios()).sort((a, b) => a.version - b.version);
  for (const c of cambios) {
    const guardarError = async (mensaje) => {
      const actual = await dbGet(STORE_CAMBIOS, c.clave);
      if (actual) await dbPut(STORE_CAMBIOS, { ...actual, error: mensaje });
    };
    try {
      let data;
      if (c.accion === "eliminar") {
        data = await llamarBackend({ accion: "eliminarRegistro", tipo: c.tipo, id: c.id });
      } else {
        const registro = await dbGet(c.store, c.id);
        if (!registro) {
          // Se eliminó después de editarlo: ya hay una eliminación en la cola que manda.
          await quitarCambio(c.clave);
          continue;
        }
        // Si todavía no se subió como registro nuevo, se espera: va a subir con los datos ya corregidos.
        if (!registro.sincronizado) continue;
        data = await llamarBackend({ accion: "actualizarRegistro", tipo: c.tipo, registro: limpiarPayload(flattens[c.tipo](registro)) });
      }
      if (data.ok) {
        // Si mientras subía se volvió a tocar (versión distinta), se deja para otra vuelta.
        const actual = await dbGet(STORE_CAMBIOS, c.clave);
        if (actual && actual.version === c.version) await quitarCambio(c.clave);
      } else {
        const mensaje = String(data.error || "la planilla lo rechazó");
        console.warn("La planilla rechazó un cambio:", c.tipo, c.id, mensaje);
        await guardarError(mensaje);
      }
    } catch (err) {
      console.warn("No se pudo subir un cambio (sin conexión real o error de red):", c.tipo, c.id, err);
      await guardarError(describirErrorDeRed(err));
    }
  }
}

async function syncAll(onProgress) {
  if (syncing) return;
  if (!navigator.onLine) return;
  if (!APP_CONFIG.sheetsWebAppUrl) return;

  syncing = true;
  epocaSync++;
  try {
    for (const { store, tipo, flatten } of TIPOS) {
      const items = await dbGetAll(store);
      const pendientes = items.filter((r) => !r.sincronizado);
      for (const registro of pendientes) {
        try {
          const payload = limpiarPayload(flatten(registro));
          if (registro.foto && !registro.fotoUrl) {
            try {
              payload.fotoBase64 = await comprimirFotoABase64(registro.foto);
            } catch (err) {
              console.warn("No se pudo preparar la foto para subir (se sincroniza el resto igual):", tipo, err);
            }
          }
          const data = await llamarBackend({ tipo, registro: payload });
          if (data.ok) {
            // Se vuelve a leer el registro: mientras se subía (puede tardar si hay mala
            // señal) alguien pudo corregirlo o eliminarlo desde la pantalla.
            const fresco = await dbGet(store, registro.id);
            if (!fresco) {
              await anotarEliminacion(store, tipo, registro.id);
            } else {
              const huboEdicion = JSON.stringify({ ...fresco, sincronizado: 0 }) !== JSON.stringify({ ...registro, sincronizado: 0 });
              fresco.sincronizado = true;
              fresco.sincronizadoEn = Date.now();
              if (data.fotoUrl && !fresco.fotoUrl) fresco.fotoUrl = data.fotoUrl;
              await dbPut(store, fresco);
              if (huboEdicion) await anotarEdicion(store, tipo, registro.id);
            }
          } else {
            console.warn("Sync rechazado por el servidor:", tipo, data.error);
          }
        } catch (err) {
          console.warn("No se pudo sincronizar un registro (sin conexión real o error de red):", tipo, err);
        }
        if (onProgress) await onProgress();
      }
    }
    await subirZonasPendientes();
    await subirCambiosPendientes();
  } finally {
    syncing = false;
    epocaSync++;
  }
  if (onProgress) await onProgress();
}

// ---------------------------------------------------------------------------
// Maestros (Lotes, Insumos, Proveedores, Contratistas, Silos Bolsa, Plan Siembra):
// se editan en la Sheet y se traen con "Actualizar desde Sheets". Nunca borran
// nada local, solo agregan/actualizan por nombre (o loteNombre+cultivo en Plan).
// ---------------------------------------------------------------------------

// Silos Bolsa se maneja aparte (ver más abajo, junto con Plan de Siembra):
// necesita resolver la campaña por nombre a un campaniaId local, algo que
// este loop genérico (upsert simple por "nombre") no hace.
const MAESTROS_CAMPOS = {
  lotes: ["nombre", "cultivo"],
  corredores: ["nombre"],
  proveedores: ["nombre"],
  contratistas: ["nombre"],
  insumos: ["nombre", "unidad"],
  campanias: ["nombre", "activa"],
  galpones: ["nombre"],
};

const MAESTROS_ETIQUETAS = {
  lotes: "Lotes",
  corredores: "Corredores",
  proveedores: "Proveedores",
  contratistas: "Contratistas",
  insumos: "Insumos",
  silosBolsa: "Silos Bolsa",
  campanias: "Campañas",
  planSiembra: "Plan de Siembra",
  galpones: "Galpones",
};

async function importarMaestros() {
  if (!APP_CONFIG.sheetsWebAppUrl) {
    return { ok: false, error: "La sincronización no está configurada." };
  }
  let data;
  try {
    data = await llamarBackend({ accion: "leerMaestros" });
  } catch (err) {
    return { ok: false, error: "No se pudo conectar con la planilla: " + err };
  }
  if (!data.ok) {
    return { ok: false, error: data.error || "La planilla rechazó el pedido." };
  }

  const resumen = {};
  for (const [store, campos] of Object.entries(MAESTROS_CAMPOS)) {
    const filas = data.maestros[store] || [];
    const existentes = await dbGetAll(store);
    let nuevos = 0;
    let actualizados = 0;
    for (const fila of filas) {
      const nombre = String(fila.nombre || "").trim();
      if (!nombre) continue;
      const existente = existentes.find((e) => e.nombre.trim().toLowerCase() === nombre.toLowerCase());
      const record = existente ? { ...existente } : { id: uid(), nombre };
      for (const campo of campos) {
        if (campo === "nombre") continue;
        let valor = fila[campo];
        if (campo === "kgTotalInicial") valor = parseFloat(valor) || 0;
        if (campo === "activa") valor = valor === true || valor === "TRUE" || valor === "true";
        record[campo] = valor;
      }
      await dbPut(store, record);
      if (existente) actualizados++;
      else nuevos++;
    }
    resumen[MAESTROS_ETIQUETAS[store]] = { nuevos, actualizados };
  }

  // Silos Bolsa: clave compuesta (nombre + cultivo + campaña), no un "nombre"
  // único — así un silo nuevo de la campaña que arranca no se confunde con
  // uno viejo que comparte nombre+cultivo de otra campaña (mismo criterio de
  // agrupamiento que agruparSilosPorNombreCultivo en stockUtils.js).
  {
    const filas = data.maestros.silosBolsa || [];
    const existentes = await dbGetAll("silosBolsa");
    let nuevos = 0;
    let actualizados = 0;
    for (const fila of filas) {
      const nombre = String(fila.nombre || "").trim();
      if (!nombre) continue;
      const cultivo = String(fila.cultivo || "").trim();
      const campaniaNombre = String(fila.campaniaNombre || "").trim();
      const campaniaId = campaniaNombre ? await resolverIdPorNombre("campanias", campaniaNombre, { activa: false }) : null;
      const mismoNombre = (s) => s.nombre.trim().toLowerCase() === nombre.toLowerCase();
      const mismoNombreCultivo = (s) => mismoNombre(s) && (s.cultivo || "").trim().toLowerCase() === cultivo.toLowerCase();
      // Un registro "cascarón" es uno creado por resolverIdPorNombre() al
      // traer una Carga de Granos que referencia un silo por nombre que
      // todavía no existía localmente (ej. en un dispositivo recién
      // reseteado) — nace con cultivo vacío, sin campaña y kgTotalInicial 0,
      // como puro marcador para no perder la referencia de esa carga.
      const esCascaron = (s) => !s.campaniaId && !s.cultivo && !s.kgTotalInicial;
      // 1) Coincidencia exacta por nombre+cultivo+campaña.
      let existente = existentes.find((s) => mismoNombreCultivo(s) && (s.campaniaId || null) === campaniaId);
      // 2) Si no hay exacta, puede ser un silo YA CARGADO en el dispositivo
      // de antes de que existiera esta columna (sin campaniaId todavía) al
      // que recién ahora se le asignó campaña en la Sheet — se actualiza ESE
      // registro en el lugar (conserva su id, y con él todo el historial de
      // cargas que ya lo tenían como origen) en vez de crear uno nuevo vacío.
      if (!existente) {
        existente = existentes.find((s) => mismoNombreCultivo(s) && !s.campaniaId);
      }
      // 3) Si tampoco hay eso, puede ser un cascarón (ver esCascaron arriba)
      // — el cultivo de este import es la primera info real que recibe, así
      // que se lo adopta por NOMBRE solo (el cultivo vacío del cascarón no
      // tiene por qué coincidir con el real).
      if (!existente) {
        existente = existentes.find((s) => mismoNombre(s) && esCascaron(s));
      }
      const record = existente ? { ...existente } : { id: uid(), nombre };
      record.cultivo = cultivo;
      record.campaniaId = campaniaId;
      record.campaniaNombre = campaniaNombre;
      record.kgTotalInicial = parseFloat(fila.kgTotalInicial) || 0;
      await dbPut("silosBolsa", record);
      if (existente) actualizados++;
      else nuevos++;
    }
    resumen[MAESTROS_ETIQUETAS.silosBolsa] = { nuevos, actualizados };
  }

  // Plan de Siembra: clave compuesta (loteNombre + cultivo + campañaNombre),
  // no un "nombre" único — un mismo lote puede tener más de un plan en la
  // misma campaña (doble cultivo, ej. Trigo y después Soja 2da).
  {
    const filas = data.maestros.planSiembra || [];
    const existentes = await dbGetAll("planSiembra");
    // Si alguien corrige a mano el cultivo de un plan ya cargado (ej. "Maiz"
    // por "Maiz Tardio" para el mismo lote), el cultivo es parte de la clave
    // de búsqueda de arriba — sin esto, la fila corregida no matchea a la
    // vieja y queda un plan "Maiz" suelto sin ningún avance, además del
    // nuevo "Maiz Tardio". Para distinguir "es una corrección" de "es
    // realmente un segundo cultivo nuevo" se mira si YA hay actividad real
    // cargada (un Avance o un Cierre) contra ese plan: si no hay ninguna,
    // es seguro asumir que es el mismo plan renombrado.
    const [avances, cierres] = await Promise.all([dbGetAll("avanceSiembra"), dbGetAll("cierresSiembra")]);
    const planesConActividad = new Set([...avances.map((a) => a.planId), ...cierres.map((c) => c.planId)]);
    let nuevos = 0;
    let actualizados = 0;
    for (const fila of filas) {
      const loteNombre = String(fila.loteNombre || "").trim();
      const cultivo = String(fila.cultivo || "").trim();
      const campaniaNombre = String(fila.campaniaNombre || "").trim();
      if (!loteNombre || !cultivo) continue;
      const loteId = await resolverIdPorNombre("lotes", loteNombre);
      const campaniaId = campaniaNombre ? await resolverIdPorNombre("campanias", campaniaNombre, { activa: false }) : null;
      let existente = existentes.find(
        (p) => p.loteId === loteId && p.cultivo.trim().toLowerCase() === cultivo.toLowerCase() && (p.campaniaId || null) === campaniaId
      );
      if (!existente) {
        const candidatos = existentes.filter(
          (p) => p.loteId === loteId && (p.campaniaId || null) === campaniaId && !planesConActividad.has(p.id)
        );
        // Solo se toma como corrección si hay exactamente un candidato sin
        // actividad — con más de uno no hay forma confiable de saber cuál
        // corregir, así que en ese caso se crea uno nuevo (más seguro que
        // adivinar mal).
        if (candidatos.length === 1) existente = candidatos[0];
      }
      const record = existente
        ? { ...existente }
        : { id: uid(), loteId, loteNombre, cultivo, campaniaId, campaniaNombre };
      record.loteNombre = loteNombre;
      record.cultivo = cultivo;
      record.campaniaNombre = campaniaNombre;
      record.superficieTeorica = parseFloat(fila.superficieTeorica) || 0;
      await dbPut("planSiembra", record);
      if (existente) actualizados++;
      else nuevos++;
    }
    resumen[MAESTROS_ETIQUETAS.planSiembra] = { nuevos, actualizados };
  }

  // Viene en la misma respuesta de "leerMaestros" — ver forzarResetTelefonos()
  // en Code.gs y verificarResetRemoto() en app.js.
  return { ok: true, resumen, resetVersion: Number(data.resetVersion) || 0 };
}

// ---------------------------------------------------------------------------
// Traer registros que cargaron OTROS dispositivos (bidireccional).
// Los IDs internos (loteId, insumoId, planId, etc.) NO son los mismos entre
// celulares — cada uno los genera de forma independiente — así que la única
// referencia en común son los NOMBRES. Al traer un registro, se resuelve cada
// nombre contra los maestros/planes/órdenes LOCALES, creándolos si hiciera
// falta (igual que ya pasa hoy al escribir una Orden de trabajo nueva a mano).
// ---------------------------------------------------------------------------

async function resolverIdPorNombre(store, nombre, camposNuevos = {}) {
  const n = String(nombre || "").trim();
  if (!n) return null;
  const existentes = await dbGetAll(store);
  const encontrado = existentes.find((e) => e.nombre.trim().toLowerCase() === n.toLowerCase());
  if (encontrado) return encontrado.id;
  const nuevo = { id: uid(), nombre: n, ...camposNuevos };
  await dbPut(store, nuevo);
  return nuevo.id;
}

async function resolverPlan(loteNombre, cultivo, campaniaNombre) {
  const lote = String(loteNombre || "").trim();
  const cult = String(cultivo || "").trim();
  const camp = String(campaniaNombre || "").trim();
  if (!lote) return null;
  const loteId = await resolverIdPorNombre("lotes", lote);
  const campaniaId = camp ? await resolverIdPorNombre("campanias", camp, { activa: false }) : null;
  const planes = await dbGetAll("planSiembra");
  let plan = planes.find(
    (p) => p.loteId === loteId && p.cultivo.trim().toLowerCase() === cult.toLowerCase() && (p.campaniaId || null) === campaniaId
  );
  if (!plan) {
    plan = { id: uid(), loteId, loteNombre: lote, cultivo: cult, campaniaId, campaniaNombre: camp, superficieTeorica: 0 };
    await dbPut("planSiembra", plan);
  }
  return plan;
}

async function resolverOrden(ordenTrabajoNombre, contratistaNombre) {
  const nombre = String(ordenTrabajoNombre || "").trim();
  if (!nombre) return null;
  const ordenes = await dbGetAll("ordenesTrabajo");
  let orden = ordenes.find((o) => o.nombre.trim().toLowerCase() === nombre.toLowerCase());
  if (!orden) {
    const contratistaId = await resolverIdPorNombre("contratistas", contratistaNombre);
    orden = {
      id: uid(),
      nombre,
      contratistaId,
      contratistaNombre: String(contratistaNombre || "").trim(),
      fechaCreacion: new Date().toISOString(),
    };
    await dbPut("ordenesTrabajo", orden);
  }
  return orden;
}

function numOrNull(v) {
  if (v === "" || v === undefined || v === null) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

async function unflattenCarga(fila) {
  const campaniaId = fila.campaniaNombre
    ? await resolverIdPorNombre("campanias", fila.campaniaNombre, { activa: false })
    : null;
  const origenTipo = fila.origenTipo === "silo" ? "silo" : "lote";
  const origenId = await resolverIdPorNombre(
    origenTipo === "silo" ? "silosBolsa" : "lotes",
    fila.origenNombre,
    origenTipo === "silo" ? { cultivo: "", kgTotalInicial: 0 } : {}
  );

  let origen2Tipo = "";
  let origen2Id = null;
  let origen2Nombre = "";
  if (fila.origen2Nombre) {
    origen2Tipo = fila.origen2Tipo === "silo" ? "silo" : "lote";
    origen2Id = await resolverIdPorNombre(
      origen2Tipo === "silo" ? "silosBolsa" : "lotes",
      fila.origen2Nombre,
      origen2Tipo === "silo" ? { cultivo: "", kgTotalInicial: 0 } : {}
    );
    origen2Nombre = String(fila.origen2Nombre).trim();
  }

  let origen3Tipo = "";
  let origen3Id = null;
  let origen3Nombre = "";
  if (fila.origen3Nombre) {
    origen3Tipo = fila.origen3Tipo === "silo" ? "silo" : "lote";
    origen3Id = await resolverIdPorNombre(
      origen3Tipo === "silo" ? "silosBolsa" : "lotes",
      fila.origen3Nombre,
      origen3Tipo === "silo" ? { cultivo: "", kgTotalInicial: 0 } : {}
    );
    origen3Nombre = String(fila.origen3Nombre).trim();
  }

  const corredorId = await resolverIdPorNombre("corredores", fila.corredorNombre);
  const gps = fila.gpsLat || fila.gpsLng ? { lat: parseFloat(fila.gpsLat) || 0, lng: parseFloat(fila.gpsLng) || 0 } : null;
  return {
    id: fila.id,
    fecha: fila.fecha,
    campaniaId,
    campaniaNombre: String(fila.campaniaNombre || "").trim(),
    origenTipo,
    origenId,
    origenNombre: String(fila.origenNombre || "").trim(),
    origen2Tipo,
    origen2Id,
    origen2Nombre,
    kgOrigen2: parseFloat(fila.kgOrigen2) || 0,
    origen3Tipo,
    origen3Id,
    origen3Nombre,
    kgOrigen3: parseFloat(fila.kgOrigen3) || 0,
    cultivo: fila.cultivo || "",
    ctg: fila.ctg || "",
    chofer: fila.chofer || "",
    patente: fila.patente || "",
    corredorId,
    corredorNombre: String(fila.corredorNombre || "").trim(),
    kgBrutos: parseFloat(fila.kgBrutos) || 0,
    tara: parseFloat(fila.tara) || 0,
    kgNeto: parseFloat(fila.kgNeto) || 0,
    humedad: numOrNull(fila.humedad),
    observaciones: fila.observaciones || "",
    gps,
    foto: null,
    fotoUrl: fila.fotoUrl || "",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

async function unflattenMovimiento(fila) {
  const insumoId = await resolverIdPorNombre("insumos", fila.insumoNombre, { unidad: fila.unidad || "" });
  // galponNombre solo tiene sentido en empresas que manejan más de un
  // depósito — en el resto viene vacío y queda null, sin efecto (ver
  // getStockPorGalpon en stockUtils.js, que devuelve null si no hay
  // ningún galpón cargado en Maestros).
  const galponId = fila.galponNombre ? await resolverIdPorNombre("galpones", fila.galponNombre) : null;
  const base = {
    id: fila.id,
    tipo: fila.tipo,
    fecha: fila.fecha,
    insumoId,
    insumoNombre: String(fila.insumoNombre || "").trim(),
    unidad: fila.unidad || "",
    cantidad: parseFloat(fila.cantidad) || 0,
    observaciones: fila.observaciones || "",
    galponId,
    galponNombre: String(fila.galponNombre || "").trim(),
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
  if (fila.tipo === "ingreso") {
    const proveedorId = await resolverIdPorNombre("proveedores", fila.proveedorNombre);
    return { ...base, proveedorId, proveedorNombre: String(fila.proveedorNombre || "").trim(), foto: null, fotoUrl: fila.fotoUrl || "" };
  }
  // "movimiento": transferencia entre galpones o ajuste por diferencia (ver
  // Insumos → Movimiento) — nunca afecta la cuenta de un contratista ni
  // ninguna orden de trabajo, por diseño (getCuentaContratistas y
  // getOrdenesConEstado no leen este tipo).
  if (fila.tipo === "movimiento") {
    const galponDestinoId = fila.galponDestinoNombre ? await resolverIdPorNombre("galpones", fila.galponDestinoNombre) : null;
    return {
      ...base,
      subtipoMovimiento: fila.subtipoMovimiento || "",
      galponDestinoId,
      galponDestinoNombre: String(fila.galponDestinoNombre || "").trim(),
      tipoDiferencia: fila.tipoDiferencia || "",
    };
  }
  // salida y devolución: ambas llevan contratista directo — ya no pasan por
  // una orden de trabajo (se sacó ese campo de Insumos → Salida/Devolución).
  const contratistaId = await resolverIdPorNombre("contratistas", fila.contratistaNombre);
  return {
    ...base,
    contratistaId,
    contratistaNombre: String(fila.contratistaNombre || "").trim(),
  };
}

async function unflattenAplicacion(fila) {
  const contratistaId = await resolverIdPorNombre("contratistas", fila.contratistaNombre);
  const loteId = await resolverIdPorNombre("lotes", fila.loteNombre);
  const orden = fila.ordenTrabajoNombre ? await resolverOrden(fila.ordenTrabajoNombre, fila.contratistaNombre) : null;
  const productos = [];
  for (let i = 1; i <= MAX_PRODUCTOS; i++) {
    const nombre = fila[`producto${i}Nombre`];
    const cantidad = fila[`producto${i}Cantidad`];
    if (!nombre || cantidad === "" || cantidad === undefined) continue;
    const productoId = await resolverIdPorNombre("insumos", nombre, { unidad: fila[`producto${i}Unidad`] || "" });
    productos.push({
      productoId,
      productoNombre: String(nombre).trim(),
      unidad: fila[`producto${i}Unidad`] || "",
      cantidad: parseFloat(cantidad) || 0,
    });
  }
  return {
    id: fila.id,
    fecha: fila.fecha,
    contratistaId,
    contratistaNombre: String(fila.contratistaNombre || "").trim(),
    loteId,
    loteNombre: String(fila.loteNombre || "").trim(),
    ordenTrabajoId: orden ? orden.id : null,
    ordenTrabajoNombre: orden ? orden.nombre : "",
    hectareas: parseFloat(fila.hectareas) || 0,
    productos,
    comentarios: fila.comentarios || "",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

async function unflattenAvance(fila) {
  const plan = await resolverPlan(fila.loteNombre, fila.cultivo, fila.campaniaNombre);
  return {
    id: fila.id,
    fecha: fila.fecha,
    planId: plan ? plan.id : null,
    loteId: plan ? plan.loteId : null,
    loteNombre: String(fila.loteNombre || "").trim(),
    cultivo: String(fila.cultivo || "").trim(),
    campaniaId: plan ? plan.campaniaId : null,
    campaniaNombre: String(fila.campaniaNombre || "").trim(),
    hasSembradas: parseFloat(fila.hasSembradas) || 0,
    comentarios: fila.comentarios || "",
    marcaCierre: fila.marcaCierre === true || fila.marcaCierre === "TRUE" || fila.marcaCierre === "true",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

async function unflattenCierre(fila) {
  const plan = await resolverPlan(fila.loteNombre, fila.cultivo, fila.campaniaNombre);
  return {
    id: fila.id,
    planId: plan ? plan.id : null,
    loteId: plan ? plan.loteId : null,
    loteNombre: String(fila.loteNombre || "").trim(),
    cultivo: String(fila.cultivo || "").trim(),
    campaniaId: plan ? plan.campaniaId : null,
    campaniaNombre: String(fila.campaniaNombre || "").trim(),
    fecha: fila.fecha,
    semillaKg: numOrNull(fila.semillaKg),
    semillaVariedad: fila.semillaVariedad || null,
    semillaBolsas: numOrNull(fila.semillaBolsas),
    semillaHibrido: fila.semillaHibrido || null,
    fertilizanteKg: numOrNull(fila.fertilizanteKg),
    fertilizanteTipo: fila.fertilizanteTipo || null,
    comentarios: fila.comentarios || "",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

async function unflattenAjusteSiloBolsa(fila) {
  const campaniaNombre = String(fila.campaniaNombre || "").trim();
  const campaniaId = campaniaNombre ? await resolverIdPorNombre("campanias", campaniaNombre, { activa: false }) : null;
  return {
    id: fila.id,
    fecha: fila.fecha,
    siloBolsaNombre: String(fila.siloBolsaNombre || "").trim(),
    cultivo: fila.cultivo || "",
    campaniaId,
    campaniaNombre,
    kgTotalInicial: parseFloat(fila.kgTotalInicial) || 0,
    kgTotalRetirado: parseFloat(fila.kgTotalRetirado) || 0,
    diferenciaKg: parseFloat(fila.diferenciaKg) || 0,
    tipoDiferencia: fila.tipoDiferencia || "exacto",
    observaciones: fila.observaciones || "",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

// A diferencia de las demás (cuyos ids son estables porque cada dispositivo
// solo escribe los suyos), una Orden de Trabajo puede existir localmente como
// placeholder liviano (autocreado por Insumos → Salida o por otra Aplicación
// que la referenció antes de que llegara esta versión completa) con un id
// LOCAL distinto al de la fila que estamos trayendo. Por eso se resuelve por
// NOMBRE — si ya existe una orden con ese nombre, se actualiza en el mismo id
// en vez de crear una duplicada.
async function unflattenOrdenTrabajo(fila) {
  const contratistaId = await resolverIdPorNombre("contratistas", fila.contratistaNombre);
  const nombresLotes = String(fila.lotesNombres || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lotes = [];
  for (const nombreLote of nombresLotes) {
    const loteId = await resolverIdPorNombre("lotes", nombreLote);
    lotes.push({ loteId, loteNombre: nombreLote });
  }
  const productosPlanificados = [];
  for (let i = 1; i <= MAX_PRODUCTOS; i++) {
    const nombre = fila[`producto${i}Nombre`];
    const dosisPorHa = fila[`producto${i}DosisPorHa`];
    if (!nombre || dosisPorHa === "" || dosisPorHa === undefined) continue;
    const productoId = await resolverIdPorNombre("insumos", nombre, { unidad: fila[`producto${i}Unidad`] || "" });
    productosPlanificados.push({
      productoId,
      productoNombre: String(nombre).trim(),
      unidad: fila[`producto${i}Unidad`] || "",
      dosisPorHa: parseFloat(dosisPorHa) || 0,
    });
  }
  const nombreOrden = String(fila.nombre || "").trim();
  const existentes = await dbGetAll("ordenesTrabajo");
  const existente = existentes.find((o) => o.nombre.trim().toLowerCase() === nombreOrden.toLowerCase());
  // "id" ahora es una columna que llena el sistema, no el asesor (queda
  // pintada de gris en la Sheet) — para una orden realmente nueva, casi
  // siempre va a venir vacía, así que hace falta generar un id acá mismo en
  // vez de asumir que la fila trae uno.
  // Zona a aplicar: viene como texto JSON en la columna "zona". Si en este
  // celular hay una zona marcada que todavía no se subió, esa manda (no se
  // pisa con lo que haya en la Sheet hasta que se suba).
  let zona = [];
  try {
    const crudo = typeof fila.zona === "string" ? (fila.zona.trim() ? JSON.parse(fila.zona) : []) : fila.zona;
    if (Array.isArray(crudo)) zona = crudo;
  } catch (_) {
    zona = [];
  }
  const zonaPendiente = !!(existente && existente.zonaPendiente);
  if (zonaPendiente) zona = existente.zona || [];
  return {
    id: existente ? existente.id : fila.id || uid(),
    zona,
    zonaPendiente,
    zonaError: zonaPendiente ? existente.zonaError || "" : "",
    nombre: nombreOrden,
    contratistaId,
    contratistaNombre: String(fila.contratistaNombre || "").trim(),
    lotes,
    fechaAsignacion: fila.fechaAsignacion || "",
    fechaLimite: fila.fechaLimite || "",
    has: parseFloat(fila.has) || 0,
    productosPlanificados,
    observaciones: fila.observaciones || "",
    anulada: estaAnulada(fila.estado),
    fechaCreacion: fila.fechaCreacion || new Date().toISOString(),
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

const TIPOS_PULL = [
  { tipo: "cargaGranos", store: "cargasGranos", unflatten: unflattenCarga },
  { tipo: "movimientoInsumo", store: "movimientosInsumos", unflatten: unflattenMovimiento },
  { tipo: "aplicacionFitosanitaria", store: "aplicacionesFitosanitarios", unflatten: unflattenAplicacion },
  { tipo: "avanceSiembra", store: "avanceSiembra", unflatten: unflattenAvance },
  { tipo: "cierreSiembra", store: "cierresSiembra", unflatten: unflattenCierre },
  { tipo: "ajusteSiloBolsa", store: "ajustesSiloBolsa", unflatten: unflattenAjusteSiloBolsa },
  { tipo: "ordenTrabajo", store: "ordenesTrabajo", unflatten: unflattenOrdenTrabajo },
];

// Tipos cuyas correcciones y eliminaciones se reflejan también en los OTROS celulares:
// si alguien edita o elimina una fila (desde un celular o directo en la planilla), al
// traer los registros este celular actualiza o saca su copia. Los demás tipos solo
// agregan lo nuevo, como siempre.
const TIPOS_RECONCILIAR = new Set(["cargaGranos", "movimientoInsumo", "aplicacionFitosanitaria"]);

// Si faltan más registros que esto de golpe, se asume que algo anda mal con la lectura
// (pestaña renombrada, planilla reemplazada) y NO se borra nada del celular.
const MAX_BORRADOS_POR_LECTURA = 5;

async function pullAll() {
  if (!navigator.onLine) return;
  if (!APP_CONFIG.sheetsWebAppUrl) return;

  const inicio = Date.now();
  const epocaInicio = epocaSync;
  let data;
  try {
    data = await llamarBackend({ accion: "leerRegistros" });
  } catch (err) {
    console.warn("No se pudieron traer registros de otros dispositivos:", err);
    return;
  }
  if (!data.ok) {
    console.warn("La planilla rechazó el pedido de registros:", data.error);
    return;
  }
  // Si mientras esperaba la respuesta se subió o se cambió algo, esta lectura puede
  // estar vieja (no incluir lo recién subido): se descarta y se vuelve a intentar la
  // próxima vez, antes que borrar o pisar algo por error.
  if (syncing || epocaSync !== epocaInicio) {
    console.warn("Se descarta la lectura de la planilla: hubo una sincronización en el medio.");
    return;
  }

  const cambiosEnCola = await listarCambios();

  for (const { tipo, store, unflatten } of TIPOS_PULL) {
    const filas = data.registros[tipo] || [];
    if (filas.length === 0) continue;
    const existentes = await dbGetAll(store);
    const porId = new Map(existentes.map((e) => [e.id, e]));
    // Ids con una edición o eliminación esperando subir: la planilla todavía tiene la
    // versión vieja, no hay que traerla de vuelta ni pisar lo que se corrigió acá.
    const idsEnCola = new Set(cambiosEnCola.filter((c) => c.tipo === tipo).map((c) => c.id));
    const reconciliar = TIPOS_RECONCILIAR.has(tipo);
    for (const fila of filas) {
      // "ordenTrabajo" es distinto a los demás tipos: el asesor no tipea un
      // id (esa columna la llena el sistema, ver aplicarValidacionOrdenesTrabajo
      // en Code.gs), así que una orden recién cargada en la Sheet llega con
      // fila.id vacío — el filtro genérico por id la descartaría siempre sin
      // llegar nunca a unflattenOrdenTrabajo (que sí sabe resolverla por
      // nombre). Para este tipo se usa "nombre" como señal de fila real, y
      // se deja que unflattenOrdenTrabajo decida si es nueva o ya existía.
      if (tipo === "ordenTrabajo") {
        if (!fila.nombre) continue;
      } else if (!fila.id || idsEnCola.has(String(fila.id))) {
        continue;
      }
      const local = porId.get(fila.id);
      if (tipo !== "ordenTrabajo" && local) {
        if (!reconciliar || !local.sincronizado) continue;
        // Ya está acá: solo se actualiza si la fila de la planilla cambió desde la última vez.
        const huella = JSON.stringify(fila);
        if (local.huellaSheet === huella) continue;
        try {
          const nuevo = await unflatten(fila);
          const fusionado = {
            ...local,
            ...nuevo,
            // Lo que la planilla no trae queda como estaba en este celular.
            foto: local.foto || null,
            fotoUrl: nuevo.fotoUrl || local.fotoUrl,
            fechaCreacionRegistro: local.fechaCreacionRegistro,
            sincronizado: true,
            huellaSheet: huella,
          };
          if (String(nuevo.fecha || "").slice(0, 10) === String(local.fecha || "").slice(0, 10)) fusionado.fecha = local.fecha;
          if (JSON.stringify(fusionado) !== JSON.stringify(local)) await dbPut(store, fusionado);
        } catch (err) {
          console.warn("No se pudo actualizar un registro:", tipo, fila.id, err);
        }
        continue;
      }
      try {
        const registro = await unflatten(fila);
        if (reconciliar) registro.huellaSheet = JSON.stringify(fila);
        await dbPut(store, registro);
      } catch (err) {
        console.warn("No se pudo traer un registro:", tipo, fila.id, err);
      }
    }

    // Registros que figuran sincronizados pero ya no están en la planilla: alguien los
    // eliminó (desde otro celular o a mano en la planilla) — se sacan de este también.
    if (reconciliar) {
      const idsPlanilla = new Set(filas.map((f) => String(f.id)));
      const sobran = existentes.filter(
        (e) =>
          e.sincronizado &&
          !idsPlanilla.has(String(e.id)) &&
          !idsEnCola.has(String(e.id)) &&
          // Recién subido por este celular: la lectura pudo haberse armado un instante antes.
          !(e.sincronizadoEn && e.sincronizadoEn >= inicio - 120000)
      );
      if (sobran.length > MAX_BORRADOS_POR_LECTURA) {
        console.warn(`Faltan ${sobran.length} registros de ${tipo} en la planilla: no se borran de este celular por seguridad.`);
      } else {
        for (const e of sobran) await dbDelete(store, e.id);
      }
    }
  }
}

export { syncAll, contarPendientes, importarMaestros, pullAll, subirZonasPendientes, describirErrorDeRed };
