import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getOrdenesConEstado } from "./stockUtils.js";

const STORE = "ordenesTrabajo";
const NUM_PRODUCTOS = 6;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function opts(list) {
  return list
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">${i.nombre}</option>`)
    .join("");
}

function etiquetaEstado(o) {
  if (o.estado === "completada") return { texto: "Completada", clase: "sincronizado" };
  if (o.estado === "atrasada") return { texto: `Atrasada (${o.diasAtraso} día${o.diasAtraso === 1 ? "" : "s"})`, clase: "pendiente" };
  return { texto: "Pendiente", clase: "" };
}

const ordenesTrabajoView = {
  async render(container) {
    const [contratistas, lotes, insumos, ordenes] = await Promise.all([
      dbGetAll("contratistas"),
      dbGetAll("lotes"),
      dbGetAll("insumos"),
      getOrdenesConEstado(),
    ]);

    if (contratistas.length === 0 || lotes.length === 0) {
      const faltan = [];
      if (contratistas.length === 0) faltan.push("Contratistas");
      if (lotes.length === 0) faltan.push("Lotes");
      container.innerHTML = `
        <h2>Órdenes de Trabajo</h2>
        <div class="card empty-state">
          Todavía no cargaste: <strong>${faltan.join(", ")}</strong>.<br/>
          Andá a Maestros para cargarlos antes de armar una orden.
        </div>`;
      return;
    }

    container.innerHTML = `
      <h2>Órdenes de Trabajo</h2>
      <div class="card">
        <form id="formOrden">
          <div class="field">
            <label>Nombre / N° de orden</label>
            <input type="text" id="fNombre" placeholder="Ej: OT-045" required />
          </div>
          <div class="field">
            <label>Contratista</label>
            <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
          </div>
          <div class="field">
            <label>Lotes</label>
            <div id="lotesCheckboxes" style="display:flex; flex-wrap:wrap; gap:10px;">
              ${lotes
                .slice()
                .sort((a, b) => a.nombre.localeCompare(b.nombre))
                .map(
                  (l) => `
                <label class="checkbox-field" style="width:auto;">
                  <input type="checkbox" class="fLoteCheck" value="${l.id}" data-nombre="${l.nombre}" /> ${l.nombre}
                </label>`
                )
                .join("")}
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Fecha de asignación</label>
              <input type="date" id="fFechaAsignacion" value="${today()}" required />
            </div>
            <div class="field">
              <label>Fecha límite</label>
              <input type="date" id="fFechaLimite" required />
            </div>
          </div>
          <div class="field">
            <label>Productos planificados (hasta ${NUM_PRODUCTOS})</label>
            <div id="productoRows">
              ${Array.from({ length: NUM_PRODUCTOS })
                .map(
                  (_, i) => `
                <div class="row producto-row">
                  <select class="fProductoRow"><option value="">Producto ${i + 1}...</option>${opts(insumos)}</select>
                  <input type="number" step="0.01" class="fCantidadRow" placeholder="Cantidad" />
                </div>`
                )
                .join("")}
            </div>
          </div>
          <div class="field">
            <label>Observaciones</label>
            <textarea id="fObs"></textarea>
          </div>
          <button type="submit">Crear orden</button>
        </form>
      </div>
      <div class="card" id="listaOrdenes"></div>
    `;

    container.querySelector("#formOrden").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nombre = container.querySelector("#fNombre").value.trim();
      const contratistaId = container.querySelector("#fContratista").value;
      if (!nombre || !contratistaId) return;
      const contratista = contratistas.find((c) => c.id === contratistaId);

      const lotesElegidos = Array.from(container.querySelectorAll(".fLoteCheck:checked")).map((el) => ({
        loteId: el.value,
        loteNombre: el.dataset.nombre,
      }));
      if (lotesElegidos.length === 0) {
        alert("Elegí al menos un lote.");
        return;
      }

      const filas = Array.from(container.querySelectorAll(".producto-row"));
      const productosPlanificados = [];
      const idsVistos = new Set();
      for (const fila of filas) {
        const productoId = fila.querySelector(".fProductoRow").value;
        const cantidad = parseFloat(fila.querySelector(".fCantidadRow").value) || 0;
        if (!productoId || cantidad <= 0) continue;
        if (idsVistos.has(productoId)) {
          alert("Elegiste el mismo producto en más de una fila. Sumalo en una sola.");
          return;
        }
        idsVistos.add(productoId);
        const producto = insumos.find((i) => i.id === productoId);
        productosPlanificados.push({
          productoId,
          productoNombre: producto ? producto.nombre : "",
          unidad: producto ? producto.unidad : "",
          cantidad,
        });
      }

      const registro = {
        id: uid(),
        nombre,
        contratistaId,
        contratistaNombre: contratista ? contratista.nombre : "",
        lotes: lotesElegidos,
        fechaAsignacion: container.querySelector("#fFechaAsignacion").value,
        fechaLimite: container.querySelector("#fFechaLimite").value,
        productosPlanificados,
        observaciones: container.querySelector("#fObs").value.trim(),
        fechaCreacion: new Date().toISOString(),
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
      await dbPut(STORE, registro);
      window.dispatchEvent(new Event("appcampo-sync-now"));
      this.render(container);
    });

    await renderListadoOrdenes(container, ordenes);
  },
};

async function renderListadoOrdenes(container, ordenes) {
  const lista = container.querySelector("#listaOrdenes");
  if (ordenes.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no creaste ninguna orden de trabajo.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Órdenes</h2>`;
  for (const o of ordenes) {
    const { texto: estadoTxt, clase: estadoClase } = etiquetaEstado(o);
    const lotesTxt = o.lotes.map((l) => `${l.loteNombre}${l.aplicado ? " ✓" : ""}`).join(", ");
    const productosTxt = o.comparacionProductos.length
      ? o.comparacionProductos
          .map(
            (p) =>
              `<div class="muted">${p.productoNombre}: planificado ${p.planificado} ${p.unidad || ""} · aplicado ${p.aplicado} ${p.unidad || ""}${
                p.diferencia !== 0
                  ? ` · <strong>${p.diferencia > 0 ? "+" : ""}${p.diferencia} ${p.unidad || ""}</strong>`
                  : " · sin diferencia"
              }</div>`
          )
          .join("")
      : "";

    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <div>
        <div><strong>${o.nombre}</strong> — ${o.contratistaNombre} <span class="pill ${estadoClase}">${estadoTxt}</span></div>
        <div class="muted">Lotes (${o.lotesAplicadosCount}/${o.totalLotes} aplicados): ${lotesTxt}</div>
        <div class="muted">Plazo: ${o.fechaLimite || "sin definir"}${o.observaciones ? " · " + o.observaciones : ""}</div>
        ${productosTxt}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${o.sincronizado ? "sincronizado" : "pendiente"}">${o.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="danger" data-id="${o.id}">Borrar</button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      if (confirm(`¿Borrar la orden "${o.nombre}"? Las aplicaciones ya vinculadas no se borran, pero dejan de mostrar la comparación.`)) {
        await dbDelete(STORE, o.id);
        ordenesTrabajoView.render(container);
      }
    });
    lista.appendChild(row);
  }
}

export { ordenesTrabajoView };
