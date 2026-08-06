import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getCuentaContratistas } from "./stockUtils.js";

const STORE = "aplicacionesFitosanitarios";
const NUM_PRODUCTOS = 6;

function nowLocalDatetime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function opts(list) {
  return list
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">${i.nombre}</option>`)
    .join("");
}

function renderCuentaCard(container, cuenta) {
  const el = container.querySelector("#cuentaCard");
  const relevantes = cuenta.filter((c) => c.retirado > 0).sort((a, b) => a.contratistaNombre.localeCompare(b.contratistaNombre));
  el.innerHTML = `<h2 style="margin-top:0;">Cuenta por contratista</h2>` +
    (relevantes.length
      ? relevantes
          .map(
            (c) => `
        <div class="list-item">
          <div>
            <div><strong>${c.contratistaNombre}</strong> — ${c.insumoNombre}</div>
            <div class="muted">retiró ${c.retirado} · usó ${c.usado} · devolvió ${c.devuelto}</div>
          </div>
          <div class="pill ${c.pendiente > 0 ? "pendiente" : "sincronizado"}">${c.pendiente} ${c.unidad || ""} pend.</div>
        </div>`
          )
          .join("")
      : '<div class="empty-state">Todavía no hay retiros de insumos registrados (Insumos → Salida).</div>');
}

function actualizarPendienteFila(filaEl, contratistaId, cuenta) {
  const productoId = filaEl.querySelector(".fProductoRow").value;
  const pendienteEl = filaEl.querySelector(".pendienteRow");
  if (!contratistaId || !productoId) {
    pendienteEl.classList.add("hidden");
    return;
  }
  const c = cuenta.find((x) => x.contratistaId === contratistaId && x.insumoId === productoId);
  pendienteEl.classList.remove("hidden");
  if (c) {
    pendienteEl.textContent = `Pendiente: ${c.pendiente} ${c.unidad || ""} (retiró ${c.retirado}, usó ${c.usado}, devolvió ${c.devuelto})`;
  } else {
    pendienteEl.textContent = "Este contratista no tiene retiros registrados de este producto.";
  }
}

const aplicacionesFitosanitariosView = {
  async render(container) {
    const [contratistas, lotes, insumos, cuenta] = await Promise.all([
      dbGetAll("contratistas"),
      dbGetAll("lotes"),
      dbGetAll("insumos"),
      getCuentaContratistas(),
    ]);

    if (contratistas.length === 0 || lotes.length === 0 || insumos.length === 0) {
      const faltan = [];
      if (contratistas.length === 0) faltan.push("Contratistas");
      if (lotes.length === 0) faltan.push("Lotes");
      if (insumos.length === 0) faltan.push("Insumos");
      container.innerHTML = `
        <h2>Aplicación de Fitosanitarios</h2>
        <div class="card empty-state">
          Todavía no cargaste: <strong>${faltan.join(", ")}</strong>.<br/>
          Andá a Maestros para cargarlos antes de registrar una aplicación.
        </div>`;
      return;
    }

    container.innerHTML = `
      <h2>Aplicación de Fitosanitarios</h2>
      <div class="card" id="cuentaCard"></div>
      <div class="card">
        <form id="formAplicacion">
          <div class="field">
            <label>Contratista</label>
            <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
          </div>
          <div class="field">
            <label>Fecha</label>
            <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
          </div>
          <div class="field">
            <label>Lote</label>
            <select id="fLote" required><option value="">Seleccionar...</option>${opts(lotes)}</select>
          </div>
          <div class="field">
            <label>Has aplicadas</label>
            <input type="number" step="0.01" id="fHas" required />
          </div>
          <div class="field">
            <label>Productos utilizados (hasta ${NUM_PRODUCTOS})</label>
            <div id="productoRows">
              ${Array.from({ length: NUM_PRODUCTOS })
                .map(
                  (_, i) => `
                <div class="field fila-aplicacion">
                  <div class="row producto-row">
                    <select class="fProductoRow"><option value="">Producto ${i + 1}...</option>${opts(insumos)}</select>
                    <input type="number" step="0.01" class="fCantidadRow" placeholder="Cantidad total" />
                  </div>
                  <div class="muted hidden pendienteRow"></div>
                </div>`
                )
                .join("")}
            </div>
          </div>
          <div class="field">
            <label>Comentarios</label>
            <textarea id="fComentarios"></textarea>
          </div>
          <button type="submit">Guardar aplicación</button>
        </form>
      </div>
      <div class="card" id="listaAplicaciones"></div>
    `;

    renderCuentaCard(container, cuenta);

    const fContratista = container.querySelector("#fContratista");
    const filas = Array.from(container.querySelectorAll(".fila-aplicacion"));

    filas.forEach((fila) => {
      fila.querySelector(".fProductoRow").addEventListener("change", () => {
        actualizarPendienteFila(fila, fContratista.value, cuenta);
      });
    });
    fContratista.addEventListener("change", () => {
      filas.forEach((fila) => actualizarPendienteFila(fila, fContratista.value, cuenta));
    });

    container.querySelector("#formAplicacion").addEventListener("submit", async (e) => {
      e.preventDefault();
      const contratistaId = fContratista.value;
      const loteId = container.querySelector("#fLote").value;
      if (!contratistaId || !loteId) return;

      const contratista = contratistas.find((c) => c.id === contratistaId);
      const lote = lotes.find((l) => l.id === loteId);

      const productos = [];
      const avisos = [];
      for (const fila of filas) {
        const productoId = fila.querySelector(".fProductoRow").value;
        const cantidad = parseFloat(fila.querySelector(".fCantidadRow").value) || 0;
        if (!productoId || cantidad <= 0) continue;

        const producto = insumos.find((i) => i.id === productoId);
        productos.push({
          productoId,
          productoNombre: producto ? producto.nombre : "",
          unidad: producto ? producto.unidad : "",
          cantidad,
        });

        const cuentaActual = cuenta.find((x) => x.contratistaId === contratistaId && x.insumoId === productoId);
        const pendiente = cuentaActual ? cuentaActual.pendiente : 0;
        if (cantidad > pendiente) {
          avisos.push(`"${producto ? producto.nombre : productoId}": pendiente ${pendiente} ${producto ? producto.unidad || "" : ""}, estás cargando ${cantidad}`);
        }
      }

      if (productos.length === 0) {
        alert("Cargá al menos un producto con cantidad.");
        return;
      }

      const idsVistos = new Set();
      for (const p of productos) {
        if (idsVistos.has(p.productoId)) {
          alert(`Elegiste "${p.productoNombre}" en más de una fila. Sumalo en una sola.`);
          return;
        }
        idsVistos.add(p.productoId);
      }

      if (avisos.length > 0) {
        const continuar = confirm(
          `Según la cuenta de "${contratista.nombre}":\n${avisos.join("\n")}\n¿Confirmás igual?`
        );
        if (!continuar) return;
      }

      const registro = {
        id: uid(),
        fecha: container.querySelector("#fFecha").value,
        contratistaId,
        contratistaNombre: contratista ? contratista.nombre : "",
        loteId,
        loteNombre: lote ? lote.nombre : "",
        hectareas: parseFloat(container.querySelector("#fHas").value) || 0,
        productos,
        comentarios: container.querySelector("#fComentarios").value.trim(),
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
      await dbPut(STORE, registro);
      window.dispatchEvent(new Event("appcampo-sync-now"));
      this.render(container);
    });

    await renderListadoAplicaciones(container);
  },
};

async function renderListadoAplicaciones(container) {
  const lista = container.querySelector("#listaAplicaciones");
  const aplicaciones = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  if (aplicaciones.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no registraste aplicaciones.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Últimas aplicaciones</h2>`;
  for (const a of aplicaciones) {
    const row = document.createElement("div");
    row.className = "list-item";
    const productosTxt = (a.productos || []).map((p) => `${p.productoNombre}: ${p.cantidad} ${p.unidad || ""}`).join(", ");
    row.innerHTML = `
      <div>
        <div><strong>${a.loteNombre}</strong> — ${productosTxt} (${a.hectareas} ha)</div>
        <div class="muted">${a.fecha?.replace("T", " ")} · ${a.contratistaNombre}${a.comentarios ? " · " + a.comentarios : ""}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${a.sincronizado ? "sincronizado" : "pendiente"}">${a.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="danger" data-id="${a.id}">Borrar</button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      if (confirm("¿Borrar este registro?")) {
        await dbDelete(STORE, a.id);
        aplicacionesFitosanitariosView.render(container);
      }
    });
    lista.appendChild(row);
  }
}

export { aplicacionesFitosanitariosView };
