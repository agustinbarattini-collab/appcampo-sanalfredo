import { dbGetAll } from "./db.js";
import { getOrdenesConEstado } from "./stockUtils.js";
import { formatearFechaCorta } from "./ui.js";
import { APP_CONFIG } from "./config.js";

// App de un contratista (contratistaFijo en config.js): solo trae sus órdenes,
// así que no tiene sentido el filtro por contratista.
const ES_APP_CONTRATISTA = !!APP_CONFIG.contratistaFijo;

// Órdenes de Trabajo pasó a ser de solo lectura (2026-08-17): las carga el
// asesor directo en la Sheet ("Órdenes de Trabajo"), no hay alta desde acá.
// La app solo las muestra, separadas en pendientes/realizadas y ordenadas
// por fecha de inicio, con un filtro por contratista (mismo criterio que la
// tarjeta de stock pendiente en Fitosanitarios) y otro por lote ("con este
// lote" / "sin este lote") para que cada uno vea rápido lo suyo: has, y por producto la dosis/ha cargada por el asesor junto con
// la necesidad total ya calculada (dosis × has).
const ordenesTrabajoView = {
  state: { contratistaId: "", loteId: "", loteModo: "con" },

  async render(container) {
    const [contratistas, ordenes] = await Promise.all([
      dbGetAll("contratistas"),
      getOrdenesConEstado(),
    ]);

    if (ordenes.length === 0) {
      container.innerHTML = `
        <h2>Órdenes de Trabajo</h2>
        <div class="card empty-state">
          Todavía no hay ninguna Orden de Trabajo cargada en la planilla.<br/>
          ${ES_APP_CONTRATISTA ? "Cuando te carguen una, aparece sola al abrir la app con conexión a internet." : 'Las carga el asesor directo en la pestaña "Órdenes de Trabajo" de la Sheet — tocá "Actualizar desde Sheets" en Maestros para traerlas.'}
        </div>`;
      return;
    }

    // Lotes que aparecen en alguna orden (los únicos que sirven para filtrar).
    const lotesEnOrdenes = new Map();
    for (const o of ordenes) for (const l of o.lotes) lotesEnOrdenes.set(l.loteId, l.loteNombre);
    const lotesOpciones = [...lotesEnOrdenes.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    if (this.state.loteId && !lotesEnOrdenes.has(this.state.loteId)) this.state.loteId = "";

    container.innerHTML = `
      <h2>Órdenes de Trabajo</h2>
      <div class="card">
        <div class="${ES_APP_CONTRATISTA ? "hidden" : ""}">
          <label style="font-size:0.8rem;">Ver órdenes de</label>
          <select id="fContratistaFiltro">
            <option value="">Todos los contratistas</option>
            ${contratistas
              .slice()
              .sort((a, b) => a.nombre.localeCompare(b.nombre))
              .map((c) => `<option value="${c.id}" ${c.id === this.state.contratistaId ? "selected" : ""}>${c.nombre}</option>`)
              .join("")}
          </select>
        </div>
        <div style="${ES_APP_CONTRATISTA ? "" : "margin-top:10px;"}">
          <label style="font-size:0.8rem;">Lote</label>
          <select id="fLoteFiltro">
            <option value="">Todos los lotes</option>
            ${lotesOpciones
              .map(([id, nombre]) => `<option value="${id}" ${id === this.state.loteId ? "selected" : ""}>${nombre}</option>`)
              .join("")}
          </select>
          <select id="fLoteModo" class="${this.state.loteId ? "" : "hidden"}" style="margin-top:6px;">
            <option value="con" ${this.state.loteModo === "con" ? "selected" : ""}>Órdenes que incluyen este lote</option>
            <option value="sin" ${this.state.loteModo === "sin" ? "selected" : ""}>Órdenes que NO incluyen este lote</option>
          </select>
        </div>
      </div>
      <div class="card" id="listaPendientes"></div>
      <div class="card" id="listaRealizadas"></div>
    `;

    container.querySelector("#fContratistaFiltro").addEventListener("change", (e) => {
      this.state.contratistaId = e.target.value;
      this.render(container);
    });
    container.querySelector("#fLoteFiltro").addEventListener("change", (e) => {
      this.state.loteId = e.target.value;
      this.state.loteModo = "con";
      this.render(container);
    });
    container.querySelector("#fLoteModo").addEventListener("change", (e) => {
      this.state.loteModo = e.target.value;
      this.render(container);
    });

    let ordenesFiltradas = this.state.contratistaId
      ? ordenes.filter((o) => o.contratistaId === this.state.contratistaId)
      : ordenes;
    if (this.state.loteId) {
      const incluye = (o) => o.lotes.some((l) => l.loteId === this.state.loteId);
      ordenesFiltradas = ordenesFiltradas.filter((o) => (this.state.loteModo === "sin" ? !incluye(o) : incluye(o)));
    }
    const hayFiltro = !!(this.state.contratistaId || this.state.loteId);

    // Por fecha de inicio (fechaAsignacion) — antes se ordenaba por plazo,
    // ahora separado en 2 grupos así que el orden de "arranque" es más útil.
    const porFechaInicio = (a, b) => (a.fechaAsignacion || "").localeCompare(b.fechaAsignacion || "");
    const pendientes = ordenesFiltradas.filter((o) => o.estado !== "completada").sort(porFechaInicio);
    const realizadas = ordenesFiltradas.filter((o) => o.estado === "completada").sort(porFechaInicio);

    renderListado(container.querySelector("#listaPendientes"), "Pendientes", pendientes, hayFiltro, "No hay órdenes pendientes con este filtro.");
    // Realizadas: se listan solo para consultar, así que van colapsadas
    // (lote + fecha) y ocupan una sola línea hasta que se las abre a
    // propósito — el detalle completo (productos, dosis, necesidad total)
    // ya no importa para el día a día una vez que la orden está hecha.
    renderListadoRealizadas(container.querySelector("#listaRealizadas"), realizadas, hayFiltro);
  },
};

function tablaProductos(o) {
  const filasProductos = o.comparacionProductos.length
    ? o.comparacionProductos
        .map(
          (p) => `
      <tr>
        <td>${p.productoNombre}</td>
        <td>${p.dosisPorHa} ${p.unidad || ""}/ha</td>
        <td>${p.necesidadTotal} ${p.unidad || ""}</td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="3" class="muted">Sin productos cargados.</td></tr>';
  return `
    <table class="tabla-orden">
      <thead><tr><th>Producto</th><th>Dosis</th><th>Necesidad total</th></tr></thead>
      <tbody>${filasProductos}</tbody>
    </table>`;
}

function renderListado(lista, titulo, ordenes, hayFiltro, mensajeVacioConFiltro) {
  if (ordenes.length === 0) {
    lista.innerHTML = `<h2 style="margin-top:0;">${titulo} (0)</h2><div class="empty-state">${
      hayFiltro ? mensajeVacioConFiltro : "No hay órdenes en este grupo."
    }</div>`;
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">${titulo} (${ordenes.length})</h2>`;
  for (const o of ordenes) {
    const lotesTxt = o.lotes.map((l) => l.loteNombre).join(", ");
    const row = document.createElement("div");
    row.className = "list-item";
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";
    row.innerHTML = `
      <div><strong>${o.nombre}</strong></div>
      <div class="muted">Lote${o.lotes.length > 1 ? "s" : ""}: ${lotesTxt} · ${o.has} ha</div>
      ${o.observaciones ? `<div class="muted">Observaciones: ${o.observaciones}</div>` : ""}
      <div class="muted">Fecha: ${formatearFechaCorta(o.fechaAsignacion)}${o.fechaLimite ? " – " + formatearFechaCorta(o.fechaLimite) : ""}</div>
      ${tablaProductos(o)}
    `;
    lista.appendChild(row);
  }
}

function tablaProductosRealizada(o) {
  const filasProductos = o.comparacionProductos.length
    ? o.comparacionProductos
        .map(
          (p) => `
      <tr>
        <td>${p.productoNombre}</td>
        <td>${p.dosisPorHa} ${p.unidad || ""}/ha</td>
        <td>${p.dosisReal !== null ? p.dosisReal + " " + (p.unidad || "") + "/ha" : "—"}</td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="3" class="muted">Sin productos cargados.</td></tr>';
  return `
    <table class="tabla-orden">
      <thead><tr><th>Producto</th><th>Dosis</th><th>Dosis real</th></tr></thead>
      <tbody>${filasProductos}</tbody>
    </table>`;
}

function renderListadoRealizadas(lista, ordenes, hayFiltro) {
  if (ordenes.length === 0) {
    lista.innerHTML = `<h2 style="margin-top:0;">Realizadas (0)</h2><div class="empty-state">${
      hayFiltro ? "No hay órdenes realizadas con este filtro." : "No hay órdenes realizadas."
    }</div>`;
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Realizadas (${ordenes.length})</h2>`;
  for (const o of ordenes) {
    const lotesTxt = o.lotes.map((l) => l.loteNombre).join(", ");
    const det = document.createElement("details");
    det.className = "orden-realizada";
    det.innerHTML = `
      <summary>${lotesTxt} — ${formatearFechaCorta(o.fechaAsignacion)}</summary>
      <div style="padding-top:8px;">
        <div><strong>${o.nombre}</strong></div>
        ${o.observaciones ? `<div class="muted">Observaciones: ${o.observaciones}</div>` : ""}
        <div class="muted">Fecha: ${formatearFechaCorta(o.fechaAsignacion)}${o.fechaLimite ? " – " + formatearFechaCorta(o.fechaLimite) : ""}</div>
        <div class="muted">Has realizadas: ${o.hasAplicadas} ha</div>
        ${tablaProductosRealizada(o)}
      </div>
    `;
    lista.appendChild(det);
  }
}

export { ordenesTrabajoView };
