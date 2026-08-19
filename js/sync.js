import { dbGetAll, dbPut, uid } from "./db.js";
import { APP_CONFIG } from "./config.js";

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

function flattenAplicacion(r) {
  const out = { ...r };
  (r.productos || []).forEach((p, i) => {
    out[`producto${i + 1}Nombre`] = p.productoNombre;
    out[`producto${i + 1}Cantidad`] = p.cantidad;
    out[`producto${i + 1}Unidad`] = p.unidad;
  });
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
  out.lotes = undefined;
  out.productosPlanificados = undefined;
  return out;
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

async function contarPendientes() {
  let total = 0;
  for (const { store } of TIPOS) {
    const items = await dbGetAll(store);
    total += items.filter((r) => !r.sincronizado).length;
  }
  return total;
}

async function llamarBackend(body) {
  const res = await fetch(APP_CONFIG.sheetsWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: APP_CONFIG.sheetsSyncToken, ...body }),
  });
  return res.json();
}

async function syncAll(onProgress) {
  if (syncing) return;
  if (!navigator.onLine) return;
  if (!APP_CONFIG.sheetsWebAppUrl) return;

  syncing = true;
  try {
    for (const { store, tipo, flatten } of TIPOS) {
      const items = await dbGetAll(store);
      const pendientes = items.filter((r) => !r.sincronizado);
      for (const registro of pendientes) {
        try {
          const payload = flatten(registro);
          if (registro.foto && !registro.fotoUrl) {
            try {
              payload.fotoBase64 = await comprimirFotoABase64(registro.foto);
            } catch (err) {
              console.warn("No se pudo preparar la foto para subir (se sincroniza el resto igual):", tipo, err);
            }
          }
          const data = await llamarBackend({ tipo, registro: payload });
          if (data.ok) {
            registro.sincronizado = true;
            if (data.fotoUrl) registro.fotoUrl = data.fotoUrl;
            await dbPut(store, registro);
          } else {
            console.warn("Sync rechazado por el servidor:", tipo, data.error);
          }
        } catch (err) {
          console.warn("No se pudo sincronizar un registro (sin conexión real o error de red):", tipo, err);
        }
        if (onProgress) await onProgress();
      }
    }
  } finally {
    syncing = false;
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

  // Plan de Siembra: clave compuesta (loteNombre + cultivo + campañaNombre), no un "nombre" único.
  {
    const filas = data.maestros.planSiembra || [];
    const existentes = await dbGetAll("planSiembra");
    let nuevos = 0;
    let actualizados = 0;
    for (const fila of filas) {
      const loteNombre = String(fila.loteNombre || "").trim();
      const cultivo = String(fila.cultivo || "").trim();
      const campaniaNombre = String(fila.campaniaNombre || "").trim();
      if (!loteNombre || !cultivo) continue;
      const loteId = await resolverIdPorNombre("lotes", loteNombre);
      const campaniaId = campaniaNombre ? await resolverIdPorNombre("campanias", campaniaNombre, { activa: false }) : null;
      const existente = existentes.find(
        (p) => p.loteId === loteId && p.cultivo.trim().toLowerCase() === cultivo.toLowerCase() && (p.campaniaId || null) === campaniaId
      );
      const record = existente
        ? { ...existente }
        : { id: uid(), loteId, loteNombre, cultivo, campaniaId, campaniaNombre };
      record.superficieTeorica = parseFloat(fila.superficieTeorica) || 0;
      await dbPut("planSiembra", record);
      if (existente) actualizados++;
      else nuevos++;
    }
    resumen[MAESTROS_ETIQUETAS.planSiembra] = { nuevos, actualizados };
  }

  return { ok: true, resumen };
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
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
}

async function unflattenMovimiento(fila) {
  const insumoId = await resolverIdPorNombre("insumos", fila.insumoNombre, { unidad: fila.unidad || "" });
  const base = {
    id: fila.id,
    tipo: fila.tipo,
    fecha: fila.fecha,
    insumoId,
    insumoNombre: String(fila.insumoNombre || "").trim(),
    unidad: fila.unidad || "",
    cantidad: parseFloat(fila.cantidad) || 0,
    observaciones: fila.observaciones || "",
    sincronizado: true,
    fechaCreacionRegistro: fila.fechaCreacionRegistro || new Date().toISOString(),
  };
  if (fila.tipo === "ingreso") {
    const proveedorId = await resolverIdPorNombre("proveedores", fila.proveedorNombre);
    return { ...base, proveedorId, proveedorNombre: String(fila.proveedorNombre || "").trim(), foto: null };
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
  for (let i = 1; i <= 6; i++) {
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
  for (let i = 1; i <= 6; i++) {
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
  return {
    id: existente ? existente.id : fila.id || uid(),
    nombre: nombreOrden,
    contratistaId,
    contratistaNombre: String(fila.contratistaNombre || "").trim(),
    lotes,
    fechaAsignacion: fila.fechaAsignacion || "",
    fechaLimite: fila.fechaLimite || "",
    has: parseFloat(fila.has) || 0,
    productosPlanificados,
    observaciones: fila.observaciones || "",
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

async function pullAll() {
  if (!navigator.onLine) return;
  if (!APP_CONFIG.sheetsWebAppUrl) return;

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

  for (const { tipo, store, unflatten } of TIPOS_PULL) {
    const filas = data.registros[tipo] || [];
    if (filas.length === 0) continue;
    const existentes = await dbGetAll(store);
    const idsExistentes = new Set(existentes.map((e) => e.id));
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
      } else if (!fila.id || idsExistentes.has(fila.id)) {
        continue;
      }
      try {
        const registro = await unflatten(fila);
        await dbPut(store, registro);
      } catch (err) {
        console.warn("No se pudo traer un registro:", tipo, fila.id, err);
      }
    }
  }
}

export { syncAll, contarPendientes, importarMaestros, pullAll };
