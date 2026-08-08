import { dbGetAll } from "./db.js";

async function getSilosBolsaConStock() {
  const [silos, cargas] = await Promise.all([dbGetAll("silosBolsa"), dbGetAll("cargasGranos")]);
  return silos.map((s) => {
    let usado = 0;
    for (const c of cargas) {
      const kgOrigen2 = c.kgOrigen2 || 0;
      const kgOrigen1 = (c.kgNeto || 0) - kgOrigen2;
      if (c.origenTipo === "silo" && c.origenId === s.id) usado += kgOrigen1;
      if (c.origen2Tipo === "silo" && c.origen2Id === s.id) usado += kgOrigen2;
    }
    // Un silo finalizado queda en 0 aunque el cálculo teórico diera otro número
    // (la diferencia real ya quedó registrada como ajuste al finalizarlo).
    const kgResidual = s.finalizado ? 0 : Math.max(0, (s.kgTotalInicial || 0) - usado);
    return { ...s, kgUsado: usado, kgResidual };
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
    return { ...i, ingresos, salidas, devoluciones, stock: ingresos - salidas + devoluciones };
  });
}

async function getSaldoOrden(ordenId) {
  const movs = (await dbGetAll("movimientosInsumos")).filter((m) => m.ordenTrabajoId === ordenId);
  const map = {};
  for (const m of movs) {
    if (m.tipo !== "salida" && m.tipo !== "devolucion") continue;
    if (!map[m.insumoId]) {
      map[m.insumoId] = { insumoId: m.insumoId, insumoNombre: m.insumoNombre, unidad: m.unidad, salida: 0, devuelto: 0 };
    }
    if (m.tipo === "salida") map[m.insumoId].salida += m.cantidad;
    else map[m.insumoId].devuelto += m.cantidad;
  }
  return Object.values(map).map((x) => ({ ...x, pendiente: Math.max(0, x.salida - x.devuelto) }));
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

export {
  getSilosBolsaConStock,
  getStockGranosPorCultivo,
  getInsumosConStock,
  getSaldoOrden,
  getCuentaContratistas,
  getAvancePlanes,
};
