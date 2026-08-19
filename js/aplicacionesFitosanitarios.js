import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getCuentaContratistas, getOrdenesConEstado } from "./stockUtils.js";
import { toast, formatearFechaCorta, parseNumero } from "./ui.js";

const STORE = "aplicacionesFitosanitarios";
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

// Filtrada por el contratista elegido arriba del formulario — antes mostraba
// la cuenta de TODOS los contratistas juntos, mezclado; ahora que seleccionás
// el contratista primero, tiene más sentido ver solo lo suyo.
function renderCuentaCard(container, cuenta, contratistaId, contratistaNombre) {
  const el = container.querySelector("#cuentaCard");
  if (!contratistaId) {
    el.innerHTML = `<h2 style="margin-top:0;">Stock pendiente del contratista</h2><div class="empty-state">Elegí un contratista arriba para ver qué insumos tiene pendientes de usar.</div>`;
    return;
  }
  const relevantes = cuenta
    .filter((c) => c.contratistaId === contratistaId && c.retirado > 0)
    .sort((a, b) => a.insumoNombre.localeCompare(b.insumoNombre));
  el.innerHTML = `<h2 style="margin-top:0;">Stock pendiente de ${contratistaNombre}</h2>` +
    (relevantes.length
      ? relevantes
          .map(
            (c) => `
        <div class="list-item">
          <div>
            <div><strong>${c.insumoNombre}</strong></div>
            <div class="muted">retiró ${c.retirado} · usó ${c.usado} · devolvió ${c.devuelto}</div>
          </div>
          <div class="pill ${c.pendiente > 0 ? "pendiente" : "sincronizado"}">${c.pendiente} ${c.unidad || ""} pend.</div>
        </div>`
          )
          .join("")
      : '<div class="empty-state">Este contratista no tiene retiros de insumos registrados (Insumos → Salida).</div>');
}

// Solo ofrece los productos que el contratista elegido tiene con pendiente
// > 0 — los mismos que se ven en la tarjeta "Stock pendiente" de arriba. No
// tiene sentido dejar elegir un producto que este contratista no retiró (o
// ya usó/devolvió del todo). Sin contratista elegido todavía, no hay nada
// para ofrecer.
function optsConPendiente(cuenta, contratistaId) {
  if (!contratistaId) return "";
  return cuenta
    .filter((c) => c.contratistaId === contratistaId && c.pendiente > 0)
    .sort((a, b) => a.insumoNombre.localeCompare(b.insumoNombre))
    .map((c) => `<option value="${c.insumoId}">${c.insumoNombre} — pendiente: ${c.pendiente} ${c.unidad || ""}</option>`)
    .join("");
}

// Solo se ofrecen las órdenes no completadas — una vez que están todos los
// lotes aplicados no tiene sentido seguir eligiéndolas acá.
function optsOrdenes(ordenesConEstado) {
  return ordenesConEstado
    .filter((o) => o.estado !== "completada")
    .map((o) => `<option value="${o.id}">${o.nombre} — ${o.contratistaNombre}${o.fechaLimite ? " (plazo " + formatearFechaCorta(o.fechaLimite) + ")" : ""}</option>`)
    .join("");
}

const aplicacionesFitosanitariosView = {
  async render(container) {
    const [contratistas, lotes, insumos, cuenta, ordenesConEstado] = await Promise.all([
      dbGetAll("contratistas"),
      dbGetAll("lotes"),
      dbGetAll("insumos"),
      getCuentaContratistas(),
      getOrdenesConEstado(),
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
            <label>Orden de Trabajo</label>
            <select id="fOrden">
              <option value="">Sin orden (cargar manualmente)</option>
              ${optsOrdenes(ordenesConEstado)}
            </select>
            <div class="muted">Si elegís una orden, se completan solos el contratista, el lote y los productos planificados con su dosis.</div>
          </div>
          <div class="field">
            <label>Contratista</label>
            <select id="fContratista" required><option value="">Seleccionar...</option>${opts(contratistas)}</select>
          </div>
          <div class="field">
            <label>Fecha</label>
            <input type="date" id="fFecha" value="${today()}" required />
          </div>
          <div class="field">
            <label>Lote</label>
            <select id="fLote" required><option value="">Seleccionar...</option>${opts(lotes)}</select>
          </div>
          <div class="field">
            <label>Has aplicadas</label>
            <input type="text" inputmode="decimal" id="fHas" required />
            <div class="muted hidden" id="hasSugeridaInfo"></div>
          </div>
          <div class="field">
            <label>Productos utilizados (hasta ${NUM_PRODUCTOS})</label>
            <div id="productoRows">
              ${Array.from({ length: NUM_PRODUCTOS })
                .map(
                  (_, i) => `
                <div class="field fila-aplicacion">
                  <div class="row producto-row">
                    <select class="fProductoRow"><option value="">Elegí el contratista arriba...</option></select>
                    <input type="text" inputmode="decimal" class="fCantidadRow" placeholder="Cantidad total" />
                  </div>
                  <div class="muted hidden dosisRow"></div>
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

    renderCuentaCard(container, cuenta, "", "");

    const fContratista = container.querySelector("#fContratista");
    const fLote = container.querySelector("#fLote");
    const fOrden = container.querySelector("#fOrden");
    const fHas = container.querySelector("#fHas");
    const hasSugeridaInfo = container.querySelector("#hasSugeridaInfo");
    const filas = Array.from(container.querySelectorAll(".fila-aplicacion"));

    function ordenActiva() {
      const id = fOrden.value;
      return id ? ordenesConEstado.find((o) => o.id === id) : null;
    }

    // Sin orden: mismo comportamiento de siempre (solo ofrece lo que el
    // contratista tiene pendiente). Con una orden elegida: ofrece los
    // productos PLANIFICADOS de esa orden (con su dosis/ha de referencia),
    // no el stock pendiente — la orden puede incluir algo que el contratista
    // todavía no retiró por Insumos.
    function actualizarOpcionesProductos(contratistaId, orden) {
      filas.forEach((fila, i) => {
        const select = fila.querySelector(".fProductoRow");
        if (orden) {
          const plan = orden.comparacionProductos[i];
          select.innerHTML =
            '<option value="">Sin producto</option>' +
            orden.comparacionProductos
              .map((p) => `<option value="${p.productoId}">${p.productoNombre} (${p.dosisPorHa} ${p.unidad || ""}/ha)</option>`)
              .join("");
          select.value = plan ? plan.productoId : "";
        } else {
          const valorPrevio = select.value;
          const placeholder = contratistaId ? "Seleccionar..." : "Elegí el contratista arriba...";
          select.innerHTML = `<option value="">${placeholder}</option>${optsConPendiente(cuenta, contratistaId)}`;
          select.value = valorPrevio;
        }
      });
    }

    // Con orden activa, no se precarga la cantidad: el contratista escribe lo
    // que realmente usó ("total usado") y la dosis real (usado ÷ has
    // aplicadas) se muestra al lado, en vivo, para compararla con la dosis
    // sugerida de la orden (dosis/ha planificada).
    function actualizarDosisFila(fila, i) {
      const orden = ordenActiva();
      const dosisEl = fila.querySelector(".dosisRow");
      const cantidadInput = fila.querySelector(".fCantidadRow");
      const plan = orden ? orden.comparacionProductos[i] : null;
      if (!plan) {
        dosisEl.classList.add("hidden");
        cantidadInput.placeholder = "Cantidad total";
        return;
      }
      cantidadInput.placeholder = "Total usado";
      const has = parseNumero(fHas.value);
      const usado = parseNumero(cantidadInput.value);
      const dosisReal = has > 0 && usado > 0 ? Math.round((usado / has) * 100) / 100 : null;
      dosisEl.classList.remove("hidden");
      dosisEl.textContent = `Dosis sugerida: ${plan.dosisPorHa} ${plan.unidad || ""}/ha · Dosis real: ${
        dosisReal !== null ? dosisReal + " " + (plan.unidad || "") + "/ha" : "—"
      }`;
    }

    function actualizarDosisFilas() {
      filas.forEach((fila, i) => actualizarDosisFila(fila, i));
    }

    function actualizarHasSugerida(orden) {
      if (!orden || !orden.has) {
        hasSugeridaInfo.classList.add("hidden");
        return;
      }
      hasSugeridaInfo.classList.remove("hidden");
      hasSugeridaInfo.textContent = `Has sugeridas: ${orden.has} ha`;
    }

    function poblarLoteSegunOrden(orden) {
      if (!orden) {
        fLote.innerHTML = '<option value="">Seleccionar...</option>' + opts(lotes);
        return;
      }
      fLote.innerHTML =
        '<option value="">Seleccionar...</option>' +
        orden.lotes
          .slice()
          .sort((a, b) => a.loteNombre.localeCompare(b.loteNombre))
          .map((l) => `<option value="${l.loteId}">${l.loteNombre}${l.aplicado ? " (ya aplicado)" : ""}</option>`)
          .join("");
    }

    filas.forEach((fila, i) => {
      fila.querySelector(".fCantidadRow").addEventListener("input", () => actualizarDosisFila(fila, i));
    });

    fOrden.addEventListener("change", () => {
      const orden = ordenActiva();
      fContratista.disabled = !!orden;
      if (orden) fContratista.value = orden.contratistaId || "";
      const contratista = contratistas.find((c) => c.id === fContratista.value);
      renderCuentaCard(container, cuenta, fContratista.value, contratista ? contratista.nombre : "");
      poblarLoteSegunOrden(orden);
      actualizarHasSugerida(orden);
      actualizarOpcionesProductos(fContratista.value, orden);
      // Nueva orden: se limpia lo que se haya tipeado antes de "total usado"
      // para que el contratista cargue lo que realmente usó de esta orden.
      filas.forEach((fila) => (fila.querySelector(".fCantidadRow").value = ""));
      actualizarDosisFilas();
    });

    fContratista.addEventListener("change", () => {
      // Con una orden elegida, el contratista queda bloqueado (viene de la
      // orden) — este listener solo importa en el caso "sin orden".
      const contratista = contratistas.find((c) => c.id === fContratista.value);
      renderCuentaCard(container, cuenta, fContratista.value, contratista ? contratista.nombre : "");
      actualizarOpcionesProductos(fContratista.value, ordenActiva());
    });

    fHas.addEventListener("input", actualizarDosisFilas);

    container.querySelector("#formAplicacion").addEventListener("submit", async (e) => {
      e.preventDefault();
      const contratistaId = fContratista.value;
      const loteId = container.querySelector("#fLote").value;
      if (!contratistaId || !loteId) return;

      const contratista = contratistas.find((c) => c.id === contratistaId);
      const lote = lotes.find((l) => l.id === loteId);
      const ordenId = fOrden.value;
      const orden = ordenId ? ordenesConEstado.find((o) => o.id === ordenId) : null;

      const productos = [];
      const avisos = [];
      for (const fila of filas) {
        const productoId = fila.querySelector(".fProductoRow").value;
        const cantidad = parseNumero(fila.querySelector(".fCantidadRow").value);
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
        ordenTrabajoId: ordenId || null,
        ordenTrabajoNombre: orden ? orden.nombre : "",
        hectareas: parseNumero(container.querySelector("#fHas").value),
        productos,
        comentarios: container.querySelector("#fComentarios").value.trim(),
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
      await dbPut(STORE, registro);
      window.dispatchEvent(new Event("appcampo-sync-now"));
      toast("Aplicación registrada.");
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
        <div class="muted">${formatearFechaCorta(a.fecha)} · ${a.contratistaNombre}${a.ordenTrabajoNombre ? " · orden " + a.ordenTrabajoNombre : ""}${a.comentarios ? " · " + a.comentarios : ""}</div>
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
