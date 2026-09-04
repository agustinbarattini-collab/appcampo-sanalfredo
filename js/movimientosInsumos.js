import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getInsumosConStock, getStockPorGalpon, getSaldoInsumosPendientes } from "./stockUtils.js";
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
        this.render(container);
      });
    });

    const ctx = { insumos, proveedores, contratistas, saldoInsumosPendientes, galpones, stockPorGalpon };
    const formArea = container.querySelector("#formArea");

    if (this.state.tipo === "ingreso") {
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
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
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
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
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
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
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
        <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
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

async function renderListadoMovs(container) {
  const lista = container.querySelector("#listaMovs");
  const movs = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
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
