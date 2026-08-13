import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getInsumosConStock, getSaldoOrden } from "./stockUtils.js";

const STORE = "movimientosInsumos";

function nowLocalDatetime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function opts(list, { withStock } = {}) {
  return list
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">${i.nombre}${withStock ? ` — stock: ${i.stock} ${i.unidad || ""}` : ""}</option>`)
    .join("");
}

function renderStockCard(container, insumos) {
  const el = container.querySelector("#stockCard");
  const conStock = insumos.filter((i) => i.stock > 0).sort((a, b) => a.nombre.localeCompare(b.nombre));
  el.innerHTML =
    `<h2 style="margin-top:0;">Stock actual</h2>` +
    (conStock.length
      ? conStock
          .map(
            (i) => `<div class="list-item"><div>${i.nombre}</div><div><strong>${i.stock}</strong> ${i.unidad || ""}</div></div>`
          )
          .join("")
      : '<div class="empty-state">Todavía no hay insumos con stock cargado.</div>');
}

const movimientosInsumosView = {
  state: { tipo: "ingreso" },

  async render(container) {
    const [insumos, proveedores, contratistas, ordenes] = await Promise.all([
      getInsumosConStock(),
      dbGetAll("proveedores"),
      dbGetAll("contratistas"),
      dbGetAll("ordenesTrabajo"),
    ]);

    if (insumos.length === 0) {
      container.innerHTML = `
        <h2>Insumos</h2>
        <div class="card empty-state">
          Todavía no cargaste ningún <strong>Insumo</strong>.<br/>
          Andá a Maestros → Insumos para cargarlo antes de registrar movimientos.
        </div>`;
      return;
    }

    container.innerHTML = `
      <h2>Insumos</h2>
      <div class="card" id="stockCard"></div>
      <div class="card">
        <div class="tipo-toggle" id="tipoToggle">
          <button type="button" data-tipo="ingreso">Ingreso</button>
          <button type="button" data-tipo="salida">Salida</button>
          <button type="button" data-tipo="devolucion">Devolución</button>
        </div>
        <div id="formArea"></div>
      </div>
      <div class="card" id="listaMovs"></div>
    `;

    renderStockCard(container, insumos);

    const tipoToggle = container.querySelector("#tipoToggle");
    tipoToggle.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tipo === this.state.tipo);
      btn.addEventListener("click", () => {
        this.state.tipo = btn.dataset.tipo;
        this.render(container);
      });
    });

    const ctx = { insumos, proveedores, contratistas, ordenes };
    const formArea = container.querySelector("#formArea");

    if (this.state.tipo === "ingreso") {
      renderFormIngreso(container, formArea, ctx, () => this.render(container));
    } else if (this.state.tipo === "salida") {
      renderFormSalida(container, formArea, ctx, () => this.render(container));
    } else {
      renderFormDevolucion(container, formArea, ctx, () => this.render(container));
    }

    await renderListadoMovs(container);
  },
};

function renderFormIngreso(container, formArea, { proveedores, insumos }, onSaved) {
  if (proveedores.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Proveedor</strong>.<br/>Andá a Maestros → Proveedores para cargarlo.</div>`;
    return;
  }
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
      </div>
      <div class="field">
        <label>Proveedor</label>
        <select id="fProveedor" required><option value="">Seleccionar...</option>${opts(proveedores)}</select>
      </div>
      <div class="field">
        <label>Insumo</label>
        <select id="fInsumo" required><option value="">Seleccionar...</option>${opts(insumos, { withStock: true })}</select>
      </div>
      <div class="field">
        <label>Cantidad</label>
        <input type="number" step="0.01" id="fCantidad" required />
      </div>
      <div class="field">
        <label>Foto del remito (opcional)</label>
        <input type="file" accept="image/*" capture="environment" id="fFoto" />
        <div class="muted">Se sube a Google Drive al sincronizar y queda linkeada en la planilla. El autocompletado automático de estos datos a partir de la foto es una mejora pendiente.</div>
      </div>
      <div class="field">
        <label>Observaciones</label>
        <textarea id="fObs"></textarea>
      </div>
      <button type="submit">Guardar ingreso</button>
    </form>
  `;

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const proveedorId = container.querySelector("#fProveedor").value;
    const insumoId = container.querySelector("#fInsumo").value;
    if (!proveedorId || !insumoId) return;
    const proveedor = proveedores.find((p) => p.id === proveedorId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const fotoInput = container.querySelector("#fFoto");

    const registro = {
      id: uid(),
      tipo: "ingreso",
      fecha: container.querySelector("#fFecha").value,
      proveedorId,
      proveedorNombre: proveedor ? proveedor.nombre : "",
      insumoId,
      insumoNombre: insumo ? insumo.nombre : "",
      unidad: insumo ? insumo.unidad : "",
      cantidad: parseFloat(container.querySelector("#fCantidad").value) || 0,
      foto: fotoInput.files && fotoInput.files[0] ? fotoInput.files[0] : null,
      observaciones: container.querySelector("#fObs").value.trim(),
      sincronizado: false,
      fechaCreacionRegistro: new Date().toISOString(),
    };
    await dbPut(STORE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    onSaved();
  });
}

function renderFormSalida(container, formArea, { contratistas, insumos, ordenes }, onSaved) {
  if (contratistas.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Contratista</strong>.<br/>Andá a Maestros → Contratistas para cargarlo.</div>`;
    return;
  }
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
      </div>
      <div class="field">
        <label>Orden de trabajo</label>
        <input type="text" id="fOrden" list="ordenesDatalist" placeholder="Escribí el número/nombre de la orden" required />
        <datalist id="ordenesDatalist">${ordenes.map((o) => `<option value="${o.nombre}"></option>`).join("")}</datalist>
      </div>
      <div class="field">
        <label>Contratista</label>
        <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
      </div>
      <div class="field">
        <label>Insumo</label>
        <select id="fInsumo" required><option value="">Seleccionar...</option>${opts(insumos, { withStock: true })}</select>
      </div>
      <div class="field">
        <label>Cantidad</label>
        <input type="number" step="0.01" id="fCantidad" required />
      </div>
      <div class="field">
        <label>Observaciones</label>
        <textarea id="fObs"></textarea>
      </div>
      <button type="submit">Guardar salida</button>
    </form>
  `;

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ordenNombre = container.querySelector("#fOrden").value.trim();
    const contratistaId = container.querySelector("#fContratista").value;
    const insumoId = container.querySelector("#fInsumo").value;
    if (!ordenNombre || !contratistaId || !insumoId) return;

    const contratista = contratistas.find((c) => c.id === contratistaId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const cantidad = parseFloat(container.querySelector("#fCantidad").value) || 0;

    if (insumo && cantidad > insumo.stock) {
      const continuar = confirm(
        `El insumo "${insumo.nombre}" tiene ${insumo.stock} ${insumo.unidad || ""} en stock y estás sacando ${cantidad}.\n¿Confirmás igual?`
      );
      if (!continuar) return;
    }

    let orden = ordenes.find((o) => o.nombre.toLowerCase() === ordenNombre.toLowerCase());
    if (!orden) {
      orden = {
        id: uid(),
        nombre: ordenNombre,
        contratistaId,
        contratistaNombre: contratista ? contratista.nombre : "",
        fechaCreacion: new Date().toISOString(),
      };
      await dbPut("ordenesTrabajo", orden);
    } else if (orden.contratistaId !== contratistaId) {
      orden.contratistaId = contratistaId;
      orden.contratistaNombre = contratista ? contratista.nombre : orden.contratistaNombre;
      await dbPut("ordenesTrabajo", orden);
    }

    const registro = {
      id: uid(),
      tipo: "salida",
      fecha: container.querySelector("#fFecha").value,
      ordenTrabajoId: orden.id,
      ordenTrabajoNombre: orden.nombre,
      contratistaId,
      contratistaNombre: contratista ? contratista.nombre : "",
      insumoId,
      insumoNombre: insumo ? insumo.nombre : "",
      unidad: insumo ? insumo.unidad : "",
      cantidad,
      observaciones: container.querySelector("#fObs").value.trim(),
      sincronizado: false,
      fechaCreacionRegistro: new Date().toISOString(),
    };
    await dbPut(STORE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    onSaved();
  });
}

function renderFormDevolucion(container, formArea, { ordenes, insumos }, onSaved) {
  if (ordenes.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no hay ninguna <strong>Orden de trabajo</strong>.<br/>Se crean automáticamente al registrar una Salida.</div>`;
    return;
  }
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
      </div>
      <div class="field">
        <label>Orden de trabajo</label>
        <select id="fOrdenId" required>
          <option value="">Seleccionar...</option>
          ${ordenes
            .slice()
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map((o) => `<option value="${o.id}">${o.nombre}${o.contratistaNombre ? " — " + o.contratistaNombre : ""}</option>`)
            .join("")}
        </select>
      </div>
      <div class="saldo-orden hidden" id="saldoOrden"></div>
      <div class="field">
        <label>Insumo a devolver</label>
        <select id="fInsumo" required><option value="">Elegí primero la orden...</option></select>
      </div>
      <div class="field">
        <label>Cantidad devuelta</label>
        <input type="number" step="0.01" id="fCantidad" required />
      </div>
      <div class="field">
        <label>Observaciones</label>
        <textarea id="fObs"></textarea>
      </div>
      <button type="submit">Guardar devolución</button>
    </form>
  `;

  let saldoActual = [];

  container.querySelector("#fOrdenId").addEventListener("change", async (e) => {
    const ordenId = e.target.value;
    const saldoDiv = container.querySelector("#saldoOrden");
    const insumoSel = container.querySelector("#fInsumo");
    if (!ordenId) {
      saldoDiv.classList.add("hidden");
      insumoSel.innerHTML = '<option value="">Elegí primero la orden...</option>';
      saldoActual = [];
      return;
    }
    saldoActual = await getSaldoOrden(ordenId);
    const pendientes = saldoActual.filter((s) => s.pendiente > 0);
    saldoDiv.classList.remove("hidden");
    saldoDiv.innerHTML = saldoActual.length
      ? saldoActual
          .map(
            (s) =>
              `<div class="item"><span>${s.insumoNombre}</span><span>salió ${s.salida} · devuelto ${s.devuelto} · pendiente <strong>${s.pendiente}</strong> ${s.unidad || ""}</span></div>`
          )
          .join("")
      : "Esta orden no tiene insumos registrados.";

    insumoSel.innerHTML = pendientes.length
      ? '<option value="">Seleccionar...</option>' +
        pendientes.map((s) => `<option value="${s.insumoId}">${s.insumoNombre} (pendiente: ${s.pendiente} ${s.unidad || ""})</option>`).join("")
      : '<option value="">No hay insumos pendientes de devolver</option>';
  });

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ordenId = container.querySelector("#fOrdenId").value;
    const insumoId = container.querySelector("#fInsumo").value;
    if (!ordenId || !insumoId) return;

    const orden = ordenes.find((o) => o.id === ordenId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const cantidad = parseFloat(container.querySelector("#fCantidad").value) || 0;
    const saldo = saldoActual.find((s) => s.insumoId === insumoId);

    if (saldo && cantidad > saldo.pendiente) {
      const continuar = confirm(
        `Para "${insumo.nombre}" quedaba pendiente ${saldo.pendiente} ${insumo.unidad || ""} y estás devolviendo ${cantidad}.\n¿Confirmás igual?`
      );
      if (!continuar) return;
    }

    const registro = {
      id: uid(),
      tipo: "devolucion",
      fecha: container.querySelector("#fFecha").value,
      ordenTrabajoId: ordenId,
      ordenTrabajoNombre: orden ? orden.nombre : "",
      contratistaId: orden ? orden.contratistaId : "",
      contratistaNombre: orden ? orden.contratistaNombre : "",
      insumoId,
      insumoNombre: insumo ? insumo.nombre : "",
      unidad: insumo ? insumo.unidad : "",
      cantidad,
      observaciones: container.querySelector("#fObs").value.trim(),
      sincronizado: false,
      fechaCreacionRegistro: new Date().toISOString(),
    };
    await dbPut(STORE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    onSaved();
  });
}

async function renderListadoMovs(container) {
  const lista = container.querySelector("#listaMovs");
  const movs = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  if (movs.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no registraste movimientos.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Últimos movimientos</h2>`;
  const etiquetas = { ingreso: "Ingreso", salida: "Salida", devolucion: "Devolución" };
  for (const m of movs) {
    const row = document.createElement("div");
    row.className = "list-item";
    let detalle = "";
    if (m.tipo === "ingreso") detalle = `de ${m.proveedorNombre}`;
    else if (m.tipo === "salida") detalle = `orden ${m.ordenTrabajoNombre} (${m.contratistaNombre})`;
    else detalle = `orden ${m.ordenTrabajoNombre}`;
    const fotoTxt = m.fotoUrl
      ? ` · <a href="${m.fotoUrl}" target="_blank" rel="noopener">Ver foto</a>`
      : m.foto
      ? " · Foto pendiente de subir"
      : "";
    row.innerHTML = `
      <div>
        <div><span class="pill">${etiquetas[m.tipo]}</span> <strong>${m.insumoNombre}</strong> — ${m.cantidad} ${m.unidad || ""}</div>
        <div class="muted">${m.fecha?.replace("T", " ")} · ${detalle}${fotoTxt}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${m.sincronizado ? "sincronizado" : "pendiente"}">${m.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="danger" data-id="${m.id}">Borrar</button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      if (confirm("¿Borrar este movimiento?")) {
        await dbDelete(STORE, m.id);
        movimientosInsumosView.render(container);
      }
    });
    lista.appendChild(row);
  }
}

export { movimientosInsumosView };
