import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getInsumosConStock, getSaldoInsumosPendientes } from "./stockUtils.js";
import { toast, parseNumero } from "./ui.js";

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
    const [insumos, proveedores, contratistas, saldoInsumosPendientes] = await Promise.all([
      getInsumosConStock(),
      dbGetAll("proveedores"),
      dbGetAll("contratistas"),
      getSaldoInsumosPendientes(),
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

    const ctx = { insumos, proveedores, contratistas, saldoInsumosPendientes };
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
        <input type="text" inputmode="decimal" id="fCantidad" required />
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
      cantidad: parseNumero(container.querySelector("#fCantidad").value),
      foto: fotoInput.files && fotoInput.files[0] ? fotoInput.files[0] : null,
      observaciones: container.querySelector("#fObs").value.trim(),
      sincronizado: false,
      fechaCreacionRegistro: new Date().toISOString(),
    };
    await dbPut(STORE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    toast("Ingreso registrado.");
    onSaved();
  });
}

function renderFormSalida(container, formArea, { contratistas, insumos }, onSaved) {
  if (contratistas.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Contratista</strong>.<br/>Andá a Maestros → Contratistas para cargarlo.</div>`;
    return;
  }
  // Solo se ofrecen insumos con stock > 0 — no tiene sentido armar una salida
  // de algo que ya está en 0. Si igual se saca más de lo que queda (llevando
  // el stock a negativo), el aviso de abajo lo avisa al confirmar.
  const insumosConStock = insumos.filter((i) => i.stock > 0);
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
      </div>
      <div class="field">
        <label>Contratista</label>
        <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
      </div>
      <div class="field">
        <label>Insumo</label>
        ${
          insumosConStock.length === 0
            ? '<div class="empty-state">No hay insumos con stock disponible para sacar.</div>'
            : `<select id="fInsumo" required><option value="">Seleccionar...</option>${opts(insumosConStock, { withStock: true })}</select>`
        }
      </div>
      <div class="field">
        <label>Cantidad</label>
        <input type="text" inputmode="decimal" id="fCantidad" required />
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
    const contratistaId = container.querySelector("#fContratista").value;
    const insumoId = container.querySelector("#fInsumo")?.value || "";
    if (!contratistaId || !insumoId) return;

    const contratista = contratistas.find((c) => c.id === contratistaId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const cantidad = parseNumero(container.querySelector("#fCantidad").value);

    if (insumo && cantidad > insumo.stock) {
      const continuar = confirm(
        `El insumo "${insumo.nombre}" tiene ${insumo.stock} ${insumo.unidad || ""} en stock y estás sacando ${cantidad}.\n¿Confirmás igual?`
      );
      if (!continuar) return;
    }

    const registro = {
      id: uid(),
      tipo: "salida",
      fecha: container.querySelector("#fFecha").value,
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
    toast("Salida registrada.");
    onSaved();
  });
}

function renderFormDevolucion(container, formArea, { contratistas, insumos, saldoInsumosPendientes }, onSaved) {
  if (contratistas.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Contratista</strong>.<br/>Andá a Maestros → Contratistas para cargarlo.</div>`;
    return;
  }
  if (saldoInsumosPendientes.length === 0) {
    formArea.innerHTML = `<div class="empty-state">No hay insumos con saldo pendiente de devolver.<br/>Se genera saldo al registrar una Salida.</div>`;
    return;
  }
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
      </div>
      <div class="field">
        <label>Contratista</label>
        <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
      </div>
      <div class="field">
        <label>Insumo a devolver</label>
        <select id="fInsumo" required>
          <option value="">Seleccionar...</option>
          ${saldoInsumosPendientes
            .slice()
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map((s) => `<option value="${s.id}">${s.nombre} (pendiente: ${s.pendiente} ${s.unidad || ""})</option>`)
            .join("")}
        </select>
      </div>
      <div class="field">
        <label>Cantidad devuelta</label>
        <input type="text" inputmode="decimal" id="fCantidad" required />
      </div>
      <div class="field">
        <label>Observaciones</label>
        <textarea id="fObs"></textarea>
      </div>
      <button type="submit">Guardar devolución</button>
    </form>
  `;

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const contratistaId = container.querySelector("#fContratista").value;
    const insumoId = container.querySelector("#fInsumo").value;
    if (!contratistaId || !insumoId) return;

    const contratista = contratistas.find((c) => c.id === contratistaId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const cantidad = parseNumero(container.querySelector("#fCantidad").value);
    const saldo = saldoInsumosPendientes.find((s) => s.id === insumoId);

    if (saldo && cantidad > saldo.pendiente) {
      const continuar = confirm(
        `El saldo pendiente de devolver de "${insumo.nombre}" (entre todos los contratistas) es ${saldo.pendiente} ${insumo.unidad || ""} y estás devolviendo ${cantidad}.\n¿Confirmás igual?`
      );
      if (!continuar) return;
    }

    const registro = {
      id: uid(),
      tipo: "devolucion",
      fecha: container.querySelector("#fFecha").value,
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
    toast("Devolución registrada.");
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
    else detalle = m.contratistaNombre || "";
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
