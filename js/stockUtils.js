import { dbGetAll } from "./db.js";

// Agrupa los maestros de Silo Bolsa por nombre+cultivo+campaña: puede haber
// más de uno con el mismo nombre (ej. varios bolsones que en el campo se
// llaman igual, cargados como filas separadas en la Sheet) — se tratan como
// un solo pool, sumando sus kg iniciales y su consumo, para que el stock y
// las diferencias al finalizar se calculen contra el total real, no contra
// una sola de las filas. La campaña entra en la clave para que un silo nuevo
// (ej. "Bolsa 1" de la campaña que arranca) no se mezcle sin querer con uno
// viejo que comparte nombre+cultivo pero es de otra campaña.
function agruparSilosPorNombreCultivo(silos) {
  const grupos = new Map();
  for (const s of silos) {
    const key = s.nombre.trim().toLowerCase() + "|" + (s.cultivo || "").trim().toLowerCase() + "|" + (s.campaniaId || "");
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(s);
  }
  return [...grupos.values()];
}

async function getSilosBolsaConStock() {
  const [silos, cargas] = await Promise.all([dbGetAll("silosBolsa"), dbGetAll("cargasGranos")]);

  return agruparSilosPorNombreCultivo(silos).map((miembros) => {
    // Representante estable de cara a la UI (el origen que se guarda en la
    // Carga de Granos): el id más "viejo" — uid() arranca con un timestamp,
    // así que ordenar los ids alfabéticamente también los ordena por fecha
    // de creación.
    const ids = miembros.map((m) => m.id);
    const idRepresentante = ids.slice().sort()[0];
    const representante = miembros.find((m) => m.id === idRepresentante);

    let usado = 0;
    for (const c of cargas) {
      const kgOrigen2 = c.kgOrigen2 || 0;
      const kgOrigen1 = (c.kgNeto || 0) - kgOrigen2;
      if (c.origenTipo === "silo" && ids.includes(c.origenId)) usado += kgOrigen1;
      if (c.origen2Tipo === "silo" && ids.includes(c.origen2Id)) usado += kgOrigen2;
    }

    const kgTotalInicial = miembros.reduce((sum, m) => sum + (m.kgTotalInicial || 0), 0);
    // Un silo finalizado queda en 0 aunque el cálculo teórico diera otro número
    // (la diferencia real ya quedó registrada como ajuste al finalizarlo).
    // El grupo entero se considera finalizado recién cuando TODOS sus
    // miembros lo están (ver finalizarSiloBolsa, que los finaliza a la vez).
    const finalizado = miembros.every((m) => m.finalizado);
    const kgResidual = finalizado ? 0 : Math.max(0, kgTotalInicial - usado);

    return {
      ...representante,
      id: idRepresentante,
      kgTotalInicial,
      kgUsado: usado,
      kgResidual,
      finalizado,
      cantidadMiembros: miembros.length,
    };
  });
}

// Stock total de grano embolsado por cultivo, sumando todos los silos bolsa
// activos (no finalizados) con saldo positivo. Para el visor general de
// Carga de Granos.
async function getStockGranosPorCultivo() {
  const silos = await getSilosBolsaConStock();
  const porCultivo = {};
  for (const s of silos) {
    if (s.kgResidual <= 0) continue;
    const key = s.cultivo?.trim() || "Sin cultivo";
    porCultivo[key] = (porCultivo[key] || 0) + s.kgResidual;
  }
  return Object.entries(porCultivo)
    .map(([cultivo, kg]) => ({ cultivo, kg }))
    .sort((a, b) => a.cultivo.localeCompare(b.cultivo));
}

async function getInsumosConStock() {
  const [insumos, movs] = await Promise.all([dbGetAll("insumos"), dbGetAll("movimientosInsumos")]);
  return insumos.map((i) => {
    const ingresos = movs.filter((m) => m.tipo === "ingreso" && m.insumoId === i.id).reduce((s, m) => s + m.cantidad, 0);
    const salidas = movs.filter((m) => m.tipo === "salida" && m.insumoId === i.id).reduce((s, m) => s + m.cantidad, 0);
    const devoluciones = movs.filter((m) => m.tipo === "devolucion" && m.insumoId === i.id).reduce((s, m) => s + m.cantidad, 0);
    // Ajustes por diferencia (Movimiento → Ajuste) suman o restan al total según
    // tipoDiferencia. Las transferencias entre galpones NO entran acá: son
    // neutras a nivel total (salen de un galpón y entran a otro), solo mueven
    // stock adentro de getStockPorGalpon().
    const ajustes = movs
      .filter((m) => m.tipo === "movimiento" && m.subtipoMovimiento === "ajuste" && m.insumoId === i.id)
      .reduce((s, m) => s + (m.tipoDiferencia === "falta" ? -m.cantidad : m.cantidad), 0);
    return { ...i, ingresos, salidas, devoluciones, ajustes, stock: ingresos - salidas + devoluciones + ajustes };
  });
}

// Stock de cada insumo desglosado por galpón + total, para empresas que
// manejan más de un depósito (ver Insumos → "Movimiento" para transferir
// entre galpones o ajustar por diferencia). Devuelve null si la empresa no
// tiene ningún galpón cargado en Maestros — en ese caso Insumos se comporta
// exactamente como antes (un solo pool de stock, sin desglose).
async function getStockPorGalpon() {
  const [insumos, galpones, movs] = await Promise.all([
    dbGetAll("insumos"),
    dbGetAll("galpones"),
    dbGetAll("movimientosInsumos"),
  ]);
  if (galpones.length === 0) return null;
  const galponesOrdenados = galpones.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  const insumosConStock = insumos.map((i) => {
    const porGalpon = {};
    galponesOrdenados.forEach((g) => (porGalpon[g.id] = 0));
    for (const m of movs) {
      if (m.insumoId !== i.id) continue;
      if (m.tipo === "ingreso" && m.galponId in porGalpon) porGalpon[m.galponId] += m.cantidad;
      else if (m.tipo === "salida" && m.galponId in porGalpon) porGalpon[m.galponId] -= m.cantidad;
      else if (m.tipo === "devolucion" && m.galponId in porGalpon) porGalpon[m.galponId] += m.cantidad;
      else if (m.tipo === "movimiento" && m.subtipoMovimiento === "transferencia") {
        if (m.galponId in porGalpon) porGalpon[m.galponId] -= m.cantidad;
        if (m.galponDestinoId in porGalpon) porGalpon[m.galponDestinoId] += m.cantidad;
      } else if (m.tipo === "movimiento" && m.subtipoMovimiento === "ajuste" && m.galponId in porGalpon) {
        porGalpon[m.galponId] += m.tipoDiferencia === "falta" ? -m.cantidad : m.cantidad;
      }
    }
    const total = Object.values(porGalpon).reduce((s, v) => s + v, 0);
    return { ...i, porGalpon, total };
  });
  return { galpones: galponesOrdenados, insumosConStock };
}

// Saldo global de cada insumo que salió (a cualquier contratista) y todavía
// no se devolvió — ya no se agrupa por orden de trabajo (se sacó ese campo
// de Insumos → Salida/Devolución), así que la devolución ofrece cualquier
// insumo con saldo pendiente, sin importar a quién se le entregó.
async function getSaldoInsumosPendientes() {
  const [insumos, movs] = await Promise.all([dbGetAll("insumos"), dbGetAll("movimientosInsumos")]);
  return insumos
    .map((i) => {
      const salidas = movs.filter((m) => m.tipo === "salida" && m.insumoId === i.id).reduce((s, m) => s + m.cantidad, 0);
      const devoluciones = movs.filter((m) => m.tipo === "devolucion" && m.insumoId === i.id).reduce((s, m) => s + m.cantidad, 0);
      return { ...i, pendiente: salidas - devoluciones };
    })
    .filter((i) => i.pendiente > 0);
}

async function getCuentaContratistas() {
  const [movs, aplicaciones] = await Promise.all([
    dbGetAll("movimientosInsumos"),
    dbGetAll("aplicacionesFitosanitarios"),
  ]);
  const map = {};
  const ensure = (contratistaId, contratistaNombre, insumoId, insumoNombre, unidad) => {
    const key = contratistaId + "|" + insumoId;
    if (!map[key]) {
      map[key] = { contratistaId, contratistaNombre, insumoId, insumoNombre, unidad, retirado: 0, usado: 0, devuelto: 0 };
    }
    return map[key];
  };
  for (const m of movs) {
    if (!m.contratistaId) continue;
    if (m.tipo === "salida") {
      ensure(m.contratistaId, m.contratistaNombre, m.insumoId, m.insumoNombre, m.unidad).retirado += m.cantidad;
    } else if (m.tipo === "devolucion") {
      ensure(m.contratistaId, m.contratistaNombre, m.insumoId, m.insumoNombre, m.unidad).devuelto += m.cantidad;
    }
  }
  for (const a of aplicaciones) {
    for (const p of a.productos || []) {
      ensure(a.contratistaId, a.contratistaNombre, p.productoId, p.productoNombre, p.unidad).usado += p.cantidad;
    }
  }
  return Object.values(map).map((x) => ({ ...x, pendiente: x.retirado - x.usado - x.devuelto }));
}

async function getAvancePlanes() {
  const [planes, avances, cierres] = await Promise.all([
    dbGetAll("planSiembra"),
    dbGetAll("avanceSiembra"),
    dbGetAll("cierresSiembra"),
  ]);
  return planes.map((p) => {
    const registros = avances
      .filter((a) => a.planId === p.id)
      .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    const hasSembradas = registros.reduce((s, a) => s + (a.hasSembradas || 0), 0);
    const cierre = cierres.find((c) => c.planId === p.id) || null;
    const marcadoCierre = registros.some((a) => a.marcaCierre);
    const avancePct = p.superficieTeorica > 0 ? Math.round((hasSembradas / p.superficieTeorica) * 1000) / 10 : null;
    return {
      ...p,
      registros,
      hasSembradas,
      cerrado: !!cierre,
      cierre,
      pendienteCierre: marcadoCierre && !cierre,
      avancePct,
    };
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Órdenes de trabajo "completas" (creadas con lotes + productos planificados,
// a diferencia de las livianas que se autocrean al tipear un nombre nuevo en
// Insumos → Salida). Para cada una calcula: cobertura por lote (según haya o
// no una Aplicación de Fitosanitarios vinculada a esa orden+lote), estado
// (pendiente/atrasada/completada) y la diferencia planificado vs. aplicado
// por producto (sumando TODAS las aplicaciones vinculadas, en cualquier lote).
async function getOrdenesConEstado() {
  const [ordenes, aplicaciones] = await Promise.all([
    dbGetAll("ordenesTrabajo"),
    dbGetAll("aplicacionesFitosanitarios"),
  ]);
  const hoy = today();
  return ordenes
    .filter((o) => (o.lotes || []).length > 0)
    .map((o) => {
      const aplicacionesOrden = aplicaciones.filter((a) => a.ordenTrabajoId === o.id);
      const lotesAplicadosIds = new Set(aplicacionesOrden.map((a) => a.loteId));
      const lotes = (o.lotes || []).map((l) => ({ ...l, aplicado: lotesAplicadosIds.has(l.loteId) }));
      const lotesFaltantes = lotes.filter((l) => !l.aplicado);
      const completada = lotes.length > 0 && lotesFaltantes.length === 0;
      const atrasada = !completada && !!o.fechaLimite && o.fechaLimite < hoy;
      const diasAtraso = atrasada ? Math.round((new Date(hoy) - new Date(o.fechaLimite)) / 86400000) : 0;

      const aplicadoPorProducto = {};
      for (const a of aplicacionesOrden) {
        for (const p of a.productos || []) {
          aplicadoPorProducto[p.productoId] = (aplicadoPorProducto[p.productoId] || 0) + p.cantidad;
        }
      }
      // Has realmente aplicadas: suma de las hectáreas cargadas en cada
      // Aplicación de Fitosanitarios vinculada a esta orden (una por lote),
      // a diferencia de "has" que es lo planificado por el asesor en la
      // Sheet. Con esto se puede calcular la dosis real (aplicado ÷ has
      // reales) para comparar contra la dosis sugerida una vez terminada.
      const hasAplicadas = Math.round(aplicacionesOrden.reduce((s, a) => s + (a.hectareas || 0), 0) * 100) / 100;
      // Cada producto planificado ahora se carga como dosis por hectárea
      // (no como cantidad total fija) — la necesidad total se calcula acá
      // multiplicando por las has de la orden, nunca se guarda, mismo
      // criterio que el resto de los saldos/stocks de la app.
      const has = o.has || 0;
      const comparacionProductos = (o.productosPlanificados || []).map((p) => {
        const dosisPorHa = p.dosisPorHa || 0;
        const necesidadTotal = Math.round(dosisPorHa * has * 100) / 100;
        const aplicado = aplicadoPorProducto[p.productoId] || 0;
        const dosisReal = hasAplicadas > 0 ? Math.round((aplicado / hasAplicadas) * 100) / 100 : null;
        return {
          productoId: p.productoId,
          productoNombre: p.productoNombre,
          unidad: p.unidad,
          dosisPorHa,
          necesidadTotal,
          aplicado,
          dosisReal,
          diferencia: Math.round((aplicado - necesidadTotal) * 100) / 100,
        };
      });

      return {
        ...o,
        has,
        hasAplicadas,
        lotes,
        lotesFaltantes,
        lotesAplicadosCount: lotes.length - lotesFaltantes.length,
        totalLotes: lotes.length,
        estado: completada ? "completada" : atrasada ? "atrasada" : "pendiente",
        diasAtraso,
        comparacionProductos,
      };
    })
    .sort((a, b) => (a.fechaLimite || a.fechaAsignacion || "").localeCompare(b.fechaLimite || b.fechaAsignacion || ""));
}

export {
  getSilosBolsaConStock,
  agruparSilosPorNombreCultivo,
  getStockGranosPorCultivo,
  getInsumosConStock,
  getStockPorGalpon,
  getSaldoInsumosPendientes,
  getCuentaContratistas,
  getAvancePlanes,
  getOrdenesConEstado,
};
