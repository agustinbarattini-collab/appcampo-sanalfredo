import { dbGetAll, dbPut, uid } from "./db.js";
import { guardarEdicion, eliminarRegistro, listarCambios, claveDe } from "./cambios.js";
import { getInsumosConStock, getStockPorGalpon, getSaldoInsumosPendientes } from "./stockUtils.js";
import { toast, parseNumero, formatearFechaCorta, asegurarOpcion } from "./ui.js";

const STORE = "movimientosInsumos";

// Movimiento que se está corrigiendo (null = formularios de siempre).
let editando = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function opts(list, { withStock } = {}) {
  return list
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">${i.nombre}${withStock ? ` — stock: ${i.stock} ${i.unidad || ""}` : ""}</option>`)
    .join("");
}

function optsGalpones(galpones, placeholder = "Seleccionar...") {
  return (
    `<option value="">${placeholder}</option>` +
    galpones
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((g) => `<option value="${g.id}">${g.nombre}</option>`)
      .join("")
  );
}

function renderStockCard(container, insumos, stockPorGalpon) {
  const el = container.querySelector("#stockCard");
  if (stockPorGalpon) {
    const { galpones, insumosConStock } = stockPorGalpon;
    const conStock = insumosConStock.filter((i) => i.total > 0).sort((a, b) => a.nombre.localeCompare(b.nombre));
    el.innerHTML =
      `<h2 style="margin-top:0;">Stock actual</h2>` +
      (conStock.length
        ? `<div style="overflow-x:auto;">
            <table class="tabla-orden">
              <thead><tr><th>Insumo</th>${galpones.map((g) => `<th>${g.nombre}</th>`).join("")}<th>Total</th></tr></thead>
              <tbody>
                ${conStock
                  .map(
                    (i) => `
                  <tr>
                    <td>${i.nombre}</td>
                    ${galpones.map((g) => `<td>${i.porGalpon[g.id]} ${i.unidad || ""}</td>`).join("")}
                    <td><strong>${i.total} ${i.unidad || ""}</strong></td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : '<div class="empty-state">Todavía no hay insumos con stock cargado.</div>');
    return;
  }
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
    const [insumos, proveedores, contratistas, saldoInsumosPendientes, galpones, stockPorGalpon] = await Promise.all([
      getInsumosConStock(),
      dbGetAll("proveedores"),
      dbGetAll("contratistas"),
      getSaldoInsumosPendientes(),
      dbGetAll("galpones"),
      getStockPorGalpon(),
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

    // Con "Movimiento" (transferencia entre galpones/ajuste) recién viene el
    // segundo botón; sin galpones cargados en Maestros, queda todo igual que
    // siempre (3 tipos, sin desglose por depósito).
    const conGalpones = galpones.length > 0;
    if (conGalpones && !["ingreso", "salida", "devolucion", "movimiento"].includes(this.state.tipo)) {
      this.state.tipo = "ingreso";
    }

    container.innerHTML = `
      <h2>Insumos</h2>
      <div class="card" id="stockCard"></div>
      <div class="card">
        <div class="tipo-toggle" id="tipoToggle">
          <button type="button" data-tipo="ingreso">Ingreso</button>
          <button type="button" data-tipo="salida">Salida</button>
          <button type="button" data-tipo="devolucion">Devolución</button>
          ${conGalpones ? '<button type="button" data-tipo="movimiento">Movimiento</button>' : ""}
        </div>
        <div id="formArea"></div>
      </div>
      <div class="card" id="listaMovs"></div>
    `;

    renderStockCard(container, insumos, stockPorGalpon);

    const tipoToggle = container.querySelector("#tipoToggle");
    tipoToggle.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tipo === this.state.tipo);
      btn.addEventListener("click", () => {
        this.state.tipo = btn.dataset.tipo;
        editando = null;
        this.render(container);
      });
    });

    const ctx = { insumos, proveedores, contratistas, saldoInsumosPendientes, galpones, stockPorGalpon };
    const formArea = container.querySelector("#formArea");

    if (editando) {
      renderFormEdicion(container, formArea, editando, ctx, () => {
        editando = null;
        this.render(container);
      });
    } else if (this.state.tipo === "ingreso") {
      renderFormIngreso(container, formArea, ctx, () => this.render(container));
    } else if (this.state.tipo === "salida") {
      renderFormSalida(container, formArea, ctx, () => this.render(container));
    } else if (this.state.tipo === "movimiento") {
      renderFormMovimiento(container, formArea, ctx, () => this.render(container));
    } else {
      renderFormDevolucion(container, formArea, ctx, () => this.render(container));
    }

    await renderListadoMovs(container);
  },
};

function renderFormIngreso(container, formArea, { proveedores, insumos, galpones }, onSaved) {
  if (proveedores.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Proveedor</strong>.<br/>Andá a Maestros → Proveedores para cargarlo.</div>`;
    return;
  }
  const conGalpones = galpones.length > 0;
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="fFecha" value="${today()}" required />
      </div>
      ${
        conGalpones
          ? `<div class="field">
              <label>Galpón</label>
              <select id="fGalpon" required>${optsGalpones(galpones, "Seleccionar...")}</select>
            </div>`
          : ""
      }
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
    const galponId = conGalpones ? container.querySelector("#fGalpon").value : "";
    if (!proveedorId || !insumoId || (conGalpones && !galponId)) return;
    const proveedor = proveedores.find((p) => p.id === proveedorId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const galpon = galpones.find((g) => g.id === galponId);
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
      galponId: galponId || null,
      galponNombre: galpon ? galpon.nombre : "",
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

function renderFormSalida(container, formArea, { contratistas, insumos, galpones, stockPorGalpon }, onSaved) {
  if (contratistas.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Contratista</strong>.<br/>Andá a Maestros → Contratistas para cargarlo.</div>`;
    return;
  }
  const conGalpones = galpones.length > 0;

  // Sin galpones: mismo criterio de siempre (solo insumos con stock total > 0).
  // Con galpones: el desplegable de insumo se arma recién al elegir el
  // galpón, mostrando solo lo que ESE galpón tiene (no tiene sentido sacar
  // de un depósito algo que no está ahí, aunque sí esté en el otro).
  const insumosConStockGlobal = insumos.filter((i) => i.stock > 0);

  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="fFecha" value="${today()}" required />
      </div>
      ${
        conGalpones
          ? `<div class="field">
              <label>Galpón</label>
              <select id="fGalpon" required>${optsGalpones(galpones, "Seleccionar...")}</select>
            </div>`
          : ""
      }
      <div class="field">
        <label>Contratista</label>
        <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
      </div>
      <div class="field">
        <label>Insumo</label>
        <div id="insumoWrap">
          ${
            conGalpones
              ? '<div class="empty-state">Elegí el galpón arriba...</div>'
              : insumosConStockGlobal.length === 0
              ? '<div class="empty-state">No hay insumos con stock disponible para sacar.</div>'
              : `<select id="fInsumo" required><option value="">Seleccionar...</option>${opts(insumosConStockGlobal, { withStock: true })}</select>`
          }
        </div>
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

  if (conGalpones) {
    container.querySelector("#fGalpon").addEventListener("change", (e) => {
      const galponId = e.target.value;
      const wrap = container.querySelector("#insumoWrap");
      if (!galponId) {
        wrap.innerHTML = '<div class="empty-state">Elegí el galpón arriba...</div>';
        return;
      }
      const conStockEnGalpon = stockPorGalpon.insumosConStock.filter((i) => (i.porGalpon[galponId] || 0) > 0);
      wrap.innerHTML = conStockEnGalpon.length
        ? `<select id="fInsumo" required><option value="">Seleccionar...</option>${conStockEnGalpon
            .slice()
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map((i) => `<option value="${i.id}">${i.nombre} — stock: ${i.porGalpon[galponId]} ${i.unidad || ""}</option>`)
            .join("")}</select>`
        : '<div class="empty-state">Este galpón no tiene stock disponible para sacar.</div>';
    });
  }

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const contratistaId = container.querySelector("#fContratista").value;
    const insumoId = container.querySelector("#fInsumo")?.value || "";
    const galponId = conGalpones ? container.querySelector("#fGalpon").value : "";
    if (!contratistaId || !insumoId || (conGalpones && !galponId)) return;

    const contratista = contratistas.find((c) => c.id === contratistaId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const galpon = galpones.find((g) => g.id === galponId);
    const cantidad = parseNumero(container.querySelector("#fCantidad").value);

    const stockDisponible = conGalpones
      ? (stockPorGalpon.insumosConStock.find((i) => i.id === insumoId)?.porGalpon[galponId] ?? 0)
      : insumo?.stock ?? 0;
    if (cantidad > stockDisponible) {
      const continuar = confirm(
        `El insumo "${insumo.nombre}"${galpon ? ` en "${galpon.nombre}"` : ""} tiene ${stockDisponible} ${insumo.unidad || ""} en stock y estás sacando ${cantidad}.\n¿Confirmás igual?`
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
      galponId: galponId || null,
      galponNombre: galpon ? galpon.nombre : "",
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

function renderFormDevolucion(container, formArea, { contratistas, insumos, saldoInsumosPendientes, galpones }, onSaved) {
  if (contratistas.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Contratista</strong>.<br/>Andá a Maestros → Contratistas para cargarlo.</div>`;
    return;
  }
  if (saldoInsumosPendientes.length === 0) {
    formArea.innerHTML = `<div class="empty-state">No hay insumos con saldo pendiente de devolver.<br/>Se genera saldo al registrar una Salida.</div>`;
    return;
  }
  const conGalpones = galpones.length > 0;
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="fFecha" value="${today()}" required />
      </div>
      ${
        conGalpones
          ? `<div class="field">
              <label>Galpón (a dónde vuelve)</label>
              <select id="fGalpon" required>${optsGalpones(galpones, "Seleccionar...")}</select>
            </div>`
          : ""
      }
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
    const galponId = conGalpones ? container.querySelector("#fGalpon").value : "";
    if (!contratistaId || !insumoId || (conGalpones && !galponId)) return;

    const contratista = contratistas.find((c) => c.id === contratistaId);
    const insumo = insumos.find((i) => i.id === insumoId);
    const galpon = galpones.find((g) => g.id === galponId);
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
      galponId: galponId || null,
      galponNombre: galpon ? galpon.nombre : "",
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

// "Movimiento" no afecta la cuenta de ningún contratista ni ninguna orden de
// trabajo (por diseño: getCuentaContratistas y getOrdenesConEstado no leen
// este tipo) — es puramente interno entre depósitos. Dos sub-tipos:
// "Transferencia" mueve stock de un galpón a otro sin cambiar el total, y
// "Ajuste por diferencia" suma o resta al total de un solo galpón puntual
// (ej. una diferencia de inventario).
function renderFormMovimiento(container, formArea, { insumos, galpones, stockPorGalpon }, onSaved) {
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="fFecha" value="${today()}" required />
      </div>
      <div class="field">
        <label>Tipo</label>
        <select id="fSubtipo">
          <option value="transferencia">Transferencia entre galpones</option>
          <option value="ajuste">Ajuste por diferencia</option>
        </select>
      </div>
      <div class="field">
        <label>Insumo</label>
        <select id="fInsumo" required><option value="">Seleccionar...</option>${opts(insumos)}</select>
      </div>
      <div id="camposTransferencia">
        <div class="field">
          <label>Galpón origen</label>
          <select id="fGalponOrigen" required>${optsGalpones(galpones, "Seleccionar...")}</select>
        </div>
        <div class="field">
          <label>Galpón destino</label>
          <select id="fGalponDestino" required>${optsGalpones(galpones, "Seleccionar...")}</select>
        </div>
      </div>
      <div id="camposAjuste" class="hidden">
        <div class="field">
          <label>Galpón</label>
          <select id="fGalponAjuste">${optsGalpones(galpones, "Seleccionar...")}</select>
        </div>
        <div class="field">
          <label>Tipo de diferencia</label>
          <select id="fTipoDiferencia">
            <option value="sobra">Sobra (+)</option>
            <option value="falta">Falta (−)</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Cantidad</label>
        <input type="text" inputmode="decimal" id="fCantidad" required />
      </div>
      <div class="field">
        <label>Observaciones</label>
        <textarea id="fObs"></textarea>
      </div>
      <button type="submit">Guardar movimiento</button>
    </form>
  `;

  const fSubtipo = container.querySelector("#fSubtipo");
  const camposTransferencia = container.querySelector("#camposTransferencia");
  const camposAjuste = container.querySelector("#camposAjuste");
  const fGalponOrigen = container.querySelector("#fGalponOrigen");
  const fGalponDestino = container.querySelector("#fGalponDestino");
  const fGalponAjuste = container.querySelector("#fGalponAjuste");

  fSubtipo.addEventListener("change", () => {
    const esTransferencia = fSubtipo.value === "transferencia";
    camposTransferencia.classList.toggle("hidden", !esTransferencia);
    camposAjuste.classList.toggle("hidden", esTransferencia);
    fGalponOrigen.required = esTransferencia;
    fGalponDestino.required = esTransferencia;
  });

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoId = container.querySelector("#fInsumo").value;
    const cantidad = parseNumero(container.querySelector("#fCantidad").value);
    if (!insumoId || cantidad <= 0) return;
    const insumo = insumos.find((i) => i.id === insumoId);
    const subtipo = fSubtipo.value;
    const fecha = container.querySelector("#fFecha").value;
    const observaciones = container.querySelector("#fObs").value.trim();

    let registro;
    if (subtipo === "transferencia") {
      const origenId = fGalponOrigen.value;
      const destinoId = fGalponDestino.value;
      if (!origenId || !destinoId) return;
      if (origenId === destinoId) {
        alert("El galpón de origen y destino no pueden ser el mismo.");
        return;
      }
      const origen = galpones.find((g) => g.id === origenId);
      const destino = galpones.find((g) => g.id === destinoId);
      const stockEnOrigen = stockPorGalpon.insumosConStock.find((i) => i.id === insumoId)?.porGalpon[origenId] ?? 0;
      if (cantidad > stockEnOrigen) {
        const continuar = confirm(
          `El insumo "${insumo.nombre}" tiene ${stockEnOrigen} ${insumo.unidad || ""} en "${origen.nombre}" y estás transfiriendo ${cantidad}.\n¿Confirmás igual?`
        );
        if (!continuar) return;
      }
      registro = {
        id: uid(),
        tipo: "movimiento",
        subtipoMovimiento: "transferencia",
        fecha,
        insumoId,
        insumoNombre: insumo ? insumo.nombre : "",
        unidad: insumo ? insumo.unidad : "",
        cantidad,
        galponId: origenId,
        galponNombre: origen ? origen.nombre : "",
        galponDestinoId: destinoId,
        galponDestinoNombre: destino ? destino.nombre : "",
        observaciones,
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
    } else {
      const galponId = fGalponAjuste.value;
      if (!galponId) return;
      const galpon = galpones.find((g) => g.id === galponId);
      registro = {
        id: uid(),
        tipo: "movimiento",
        subtipoMovimiento: "ajuste",
        fecha,
        insumoId,
        insumoNombre: insumo ? insumo.nombre : "",
        unidad: insumo ? insumo.unidad : "",
        cantidad,
        tipoDiferencia: container.querySelector("#fTipoDiferencia").value,
        galponId,
        galponNombre: galpon ? galpon.nombre : "",
        observaciones,
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
    }

    await dbPut(STORE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    toast("Movimiento registrado.");
    onSaved();
  });
}

// Corrección de un movimiento ya guardado: se cambian los datos que suelen estar mal (fecha,
// insumo, cantidad, contratista/proveedor, galpón, observaciones). El tipo no se cambia y la
// foto del remito queda como estaba. No se vuelve a avisar por stock: es una corrección.
function renderFormEdicion(container, formArea, m, { insumos, proveedores, contratistas, galpones }, onDone) {
  const conGalpones = galpones.length > 0;
  const etiquetas = { ingreso: "ingreso", salida: "salida", devolucion: "devolución", movimiento: "movimiento" };
  const esMov = m.tipo === "movimiento";
  const esTransf = esMov && m.subtipoMovimiento === "transferencia";
  const selGalpon = (id, etiqueta) =>
    `<div class="field"><label>${etiqueta}</label><select id="${id}">${optsGalpones(galpones, "Seleccionar...")}</select></div>`;
  formArea.innerHTML = `
    <div class="card" style="border:2px solid var(--color-primario);">
      <strong>Estás corrigiendo un ${etiquetas[m.tipo] || "movimiento"} ya guardado</strong>
      <div class="muted">${formatearFechaCorta(m.fecha)} · ${m.insumoNombre} · ${m.cantidad} ${m.unidad || ""}. Cambiá lo que esté mal y tocá "Guardar cambios".</div>
    </div>
    <form id="formEdicion">
      <div class="field"><label>Fecha</label><input type="date" id="eFecha" required /></div>
      ${m.tipo === "ingreso" ? '<div class="field"><label>Proveedor</label><select id="eProveedor" required></select></div>' : ""}
      ${m.tipo === "salida" || m.tipo === "devolucion" ? '<div class="field"><label>Contratista</label><select id="eContratista" required></select></div>' : ""}
      <div class="field"><label>Insumo</label><select id="eInsumo" required></select></div>
      <div class="field"><label>Cantidad</label><input type="text" inputmode="decimal" id="eCantidad" required /></div>
      ${conGalpones && !esMov ? selGalpon("eGalpon", "Galpón") : ""}
      ${esTransf ? selGalpon("eGalponOrigen", "Galpón de origen") + selGalpon("eGalponDestino", "Galpón de destino") : ""}
      ${esMov && !esTransf ? selGalpon("eGalpon", "Galpón ajustado") + `<div class="field"><label>Diferencia</label><select id="eTipoDiferencia"><option value="falta">Falta</option><option value="sobra">Sobra</option></select></div>` : ""}
      <div class="field"><label>Observaciones</label><textarea id="eObs"></textarea></div>
      <button type="submit">Guardar cambios</button>
      <button type="button" class="secondary" id="btnCancelarEdicion" style="margin-top:8px;">Cancelar corrección</button>
    </form>
  `;
  const q = (sel) => container.querySelector(sel);
  q("#eFecha").value = String(m.fecha || today()).slice(0, 10);
  const llenar = (sel, lista, id, nombre) => {
    const el = q(sel);
    if (!el) return;
    el.innerHTML = '<option value="">Seleccionar...</option>' + opts(lista);
    asegurarOpcion(el, id, nombre);
  };
  llenar("#eProveedor", proveedores, m.proveedorId, m.proveedorNombre);
  llenar("#eContratista", contratistas, m.contratistaId, m.contratistaNombre);
  llenar("#eInsumo", insumos, m.insumoId, m.insumoNombre);
  q("#eCantidad").value = String(m.cantidad ?? "");
  const fijarGalpon = (sel, id, nombre) => {
    const el = q(sel);
    if (el) asegurarOpcion(el, id, nombre);
  };
  fijarGalpon("#eGalpon", m.galponId, m.galponNombre);
  fijarGalpon("#eGalponOrigen", m.galponId, m.galponNombre);
  fijarGalpon("#eGalponDestino", m.galponDestinoId, m.galponDestinoNombre);
  if (q("#eTipoDiferencia")) q("#eTipoDiferencia").value = m.tipoDiferencia === "sobra" ? "sobra" : "falta";
  q("#eObs").value = m.observaciones || "";
  q("#btnCancelarEdicion").addEventListener("click", onDone);
  formArea.scrollIntoView({ block: "start" });

  q("#formEdicion").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cantidad = parseNumero(q("#eCantidad").value);
    const insumo = insumos.find((i) => i.id === q("#eInsumo").value);
    if (!insumo || cantidad <= 0) return;
    const nombreGalpon = (id) => (galpones.find((g) => g.id === id) || {}).nombre || "";
    const corregido = {
      ...m,
      fecha: q("#eFecha").value,
      insumoId: insumo.id,
      insumoNombre: insumo.nombre,
      unidad: insumo.unidad || "",
      cantidad,
      observaciones: q("#eObs").value.trim(),
    };
    if (m.tipo === "ingreso") {
      const prov = proveedores.find((p) => p.id === q("#eProveedor").value);
      if (!prov && !q("#eProveedor").value) return;
      corregido.proveedorId = q("#eProveedor").value;
      corregido.proveedorNombre = prov ? prov.nombre : m.proveedorNombre;
    }
    if (m.tipo === "salida" || m.tipo === "devolucion") {
      const con = contratistas.find((c) => c.id === q("#eContratista").value);
      if (!con && !q("#eContratista").value) return;
      corregido.contratistaId = q("#eContratista").value;
      corregido.contratistaNombre = con ? con.nombre : m.contratistaNombre;
    }
    if (q("#eGalpon")) {
      corregido.galponId = q("#eGalpon").value || null;
      corregido.galponNombre = nombreGalpon(q("#eGalpon").value) || (q("#eGalpon").value === m.galponId ? m.galponNombre : "");
    }
    if (esTransf) {
      if (q("#eGalponOrigen").value === q("#eGalponDestino").value) {
        alert("El galpón de origen y destino no pueden ser el mismo.");
        return;
      }
      corregido.galponId = q("#eGalponOrigen").value || null;
      corregido.galponNombre = nombreGalpon(q("#eGalponOrigen").value) || m.galponNombre;
      corregido.galponDestinoId = q("#eGalponDestino").value || null;
      corregido.galponDestinoNombre = nombreGalpon(q("#eGalponDestino").value) || m.galponDestinoNombre;
    }
    if (q("#eTipoDiferencia")) corregido.tipoDiferencia = q("#eTipoDiferencia").value;
    await guardarEdicion(STORE, "movimientoInsumo", corregido);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    toast("Movimiento corregido.");
    onDone();
  });
}

async function renderListadoMovs(container) {
  const lista = container.querySelector("#listaMovs");
  const movs = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  const cambiosEnCola = new Map((await listarCambios()).map((x) => [x.clave, x]));
  if (movs.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no registraste movimientos.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Últimos movimientos</h2>`;
  const etiquetas = { ingreso: "Ingreso", salida: "Salida", devolucion: "Devolución", movimiento: "Movimiento" };
  for (const m of movs) {
    const row = document.createElement("div");
    row.className = "list-item";
    let detalle = "";
    if (m.tipo === "ingreso") detalle = `${m.galponNombre ? m.galponNombre + " · " : ""}de ${m.proveedorNombre}`;
    else if (m.tipo === "movimiento") {
      detalle =
        m.subtipoMovimiento === "transferencia"
          ? `${m.galponNombre} → ${m.galponDestinoNombre}`
          : `Ajuste en ${m.galponNombre} (${m.tipoDiferencia === "falta" ? "falta" : "sobra"})`;
    } else detalle = `${m.galponNombre ? m.galponNombre + " · " : ""}${m.contratistaNombre || ""}`;
    const fotoTxt = m.fotoUrl
      ? ` · <a href="${m.fotoUrl}" target="_blank" rel="noopener">Ver foto</a>`
      : m.foto
      ? " · Foto pendiente de subir"
      : "";
    const cambio = cambiosEnCola.get(claveDe("movimientoInsumo", m.id));
    const correccionPendiente = m.sincronizado && cambio && cambio.accion === "editar";
    const errorTxt = cambio && cambio.error ? `<div class="muted" style="color:#c0392b;">No se pudo subir la corrección: ${cambio.error}</div>` : "";
    row.innerHTML = `
      <div>
        <div><span class="pill">${etiquetas[m.tipo]}</span> <strong>${m.insumoNombre}</strong> — ${m.cantidad} ${m.unidad || ""}</div>
        <div class="muted">${formatearFechaCorta(m.fecha)} · ${detalle}${fotoTxt}</div>
        ${errorTxt}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${m.sincronizado && !correccionPendiente ? "sincronizado" : "pendiente"}">${correccionPendiente ? "Corrección pendiente" : m.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="secondary" data-accion="editar">Editar</button>
        <button class="danger" data-accion="eliminar">Eliminar</button>
      </div>
    `;
    row.querySelector('[data-accion="editar"]').addEventListener("click", () => {
      editando = m;
      movimientosInsumosView.state.tipo = m.tipo;
      movimientosInsumosView.render(container);
    });
    row.querySelector('[data-accion="eliminar"]').addEventListener("click", async () => {
      const resumen = `${etiquetas[m.tipo]} · ${formatearFechaCorta(m.fecha)} · ${m.insumoNombre} · ${m.cantidad} ${m.unidad || ""}`;
      const aviso = m.sincronizado
        ? "\n\nSe elimina también de la planilla (queda una copia en la pestaña \"Historial de cambios\")."
        : "";
      if (!confirm(`¿Eliminar este movimiento?\n\n${resumen}${aviso}`)) return;
      await eliminarRegistro(STORE, "movimientoInsumo", m.id);
      if (editando && editando.id === m.id) editando = null;
      window.dispatchEvent(new Event("appcampo-sync-now"));
      movimientosInsumosView.render(container);
    });
    lista.appendChild(row);
  }
}

export { movimientosInsumosView };
