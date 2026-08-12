import { dbGetAll, dbGet, dbPut, dbDelete, uid } from "./db.js";
import { getSilosBolsaConStock, getStockGranosPorCultivo } from "./stockUtils.js";

const STORE = "cargasGranos";
const STORE_AJUSTES = "ajustesSiloBolsa";

function nowLocalDatetime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

async function poblarOrigenSelect(select, tipo) {
  select.innerHTML = '<option value="">Seleccionar...</option>';
  if (tipo === "lote") {
    const lotes = (await dbGetAll("lotes")).sort((a, b) => a.nombre.localeCompare(b.nombre));
    for (const l of lotes) {
      select.innerHTML += `<option value="${l.id}">${l.nombre}</option>`;
    }
  } else if (tipo === "silo") {
    // Los silos finalizados o en 0 no se ofrecen como origen.
    const silos = (await getSilosBolsaConStock())
      .filter((s) => s.kgResidual > 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    for (const s of silos) {
      select.innerHTML += `<option value="${s.id}">${s.nombre} — ${s.kgResidual} kg restantes${s.cultivo ? ` (${s.cultivo})` : ""}</option>`;
    }
  }
}

async function poblarCorredorSelect(select) {
  const corredores = (await dbGetAll("corredores")).sort((a, b) => a.nombre.localeCompare(b.nombre));
  select.innerHTML = '<option value="">Seleccionar...</option>' +
    corredores.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
}

function renderStockGranosCard(container, stock) {
  const el = container.querySelector("#stockGranosCard");
  if (!el) return;
  el.innerHTML = `
    <h2 style="margin-top:0;">Stock de granos (Silos Bolsa)</h2>
    ${
      stock.length === 0
        ? '<div class="empty-state">No queda stock positivo en silos bolsa activos.</div>'
        : `<div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${stock.map((s) => `<div class="pill">${s.cultivo}: ${s.kg.toLocaleString("es-AR")} kg</div>`).join("")}
          </div>`
    }
  `;
}

// Marca el silo bolsa como finalizado (stock queda en 0, desaparece de la lista
// de orígenes) y registra la diferencia entre lo que la app calculaba como
// residual y lo que realmente se retiró en este último camión. diferenciaKg
// positiva = faltante (se sacó menos de lo que decía la app, mermó en el camino);
// negativa = sobrante (se sacó más de lo esperado).
async function finalizarSiloBolsa(siloId, kgResidualAntes, kgEsteViaje, fechaCarga) {
  const silo = await dbGet("silosBolsa", siloId);
  if (!silo) return null;
  const diferenciaKg = Math.round((kgResidualAntes - kgEsteViaje) * 100) / 100;
  await dbPut("silosBolsa", { ...silo, finalizado: true, fechaFinalizacion: new Date().toISOString() });
  const ajuste = {
    id: uid(),
    fecha: fechaCarga,
    siloBolsaNombre: silo.nombre,
    cultivo: silo.cultivo || "",
    kgTotalInicial: silo.kgTotalInicial || 0,
    kgTotalRetirado: Math.round(((silo.kgTotalInicial || 0) - diferenciaKg) * 100) / 100,
    diferenciaKg,
    tipoDiferencia: diferenciaKg > 0 ? "faltante" : diferenciaKg < 0 ? "sobrante" : "exacto",
    observaciones: "",
    sincronizado: false,
    fechaCreacionRegistro: new Date().toISOString(),
  };
  await dbPut(STORE_AJUSTES, ajuste);
  return ajuste;
}

function mensajeAjuste(ajuste) {
  if (!ajuste) return "";
  if (ajuste.tipoDiferencia === "exacto") {
    return `Silo "${ajuste.siloBolsaNombre}" finalizado. Coincidió exacto con lo calculado, sin diferencia.`;
  }
  const palabra = ajuste.tipoDiferencia === "faltante" ? "faltante" : "sobrante";
  return `Silo "${ajuste.siloBolsaNombre}" finalizado. Diferencia registrada: ${Math.abs(ajuste.diferenciaKg).toLocaleString("es-AR")} kg de ${palabra}.`;
}

const cargaGranosView = {
  state: { campaniaFiltro: null },

  async render(container) {
    const [lotes, silos, corredores, campanias, stockGranos] = await Promise.all([
      dbGetAll("lotes"),
      dbGetAll("silosBolsa"),
      dbGetAll("corredores"),
      dbGetAll("campanias"),
      getStockGranosPorCultivo(),
    ]);

    if (lotes.length === 0 && silos.length === 0) {
      container.innerHTML = `
        <h2>Carga de Granos de Campo</h2>
        <div class="card empty-state">
          Todavía no cargaste ningún <strong>Lote</strong> ni <strong>Silo Bolsa</strong>.<br/>
          Andá a la sección Maestros para cargarlos antes de registrar una carga.
        </div>`;
      return;
    }
    if (corredores.length === 0) {
      container.innerHTML = `
        <h2>Carga de Granos de Campo</h2>
        <div class="card empty-state">
          Todavía no cargaste ningún <strong>Corredor</strong> (destino).<br/>
          Andá a la sección Maestros para cargarlo antes de registrar una carga.
        </div>`;
      return;
    }
    if (campanias.length === 0) {
      container.innerHTML = `
        <h2>Carga de Granos de Campo</h2>
        <div class="card empty-state">
          Todavía no cargaste ninguna <strong>Campaña</strong> (ej: 2025/26).<br/>
          Andá a Maestros → Campañas para cargarla antes de registrar una carga.
        </div>`;
      return;
    }

    const campaniaActiva = campanias.find((c) => c.activa) || null;
    if (this.state.campaniaFiltro === null) {
      this.state.campaniaFiltro = campaniaActiva ? campaniaActiva.id : "";
    }

    container.innerHTML = `
      <h2>Carga de Granos de Campo</h2>
      ${silos.length > 0 ? '<div class="card" id="stockGranosCard"></div>' : ""}
      <div class="card">
        <form id="formCarga">
          <div class="field">
            <label>Campaña</label>
            <select id="fCampania" required>
              ${campanias
                .slice()
                .sort((a, b) => b.nombre.localeCompare(a.nombre))
                .map((c) => `<option value="${c.id}" ${campaniaActiva && c.id === campaniaActiva.id ? "selected" : ""}>${c.nombre}${c.activa ? " (activa)" : ""}</option>`)
                .join("")}
            </select>
          </div>

          <div class="field">
            <label>Fecha y hora</label>
            <input type="datetime-local" id="fFecha" value="${nowLocalDatetime()}" required />
          </div>

          <div class="field">
            <label>Origen</label>
            <div class="row">
              <select id="fOrigenTipo">
                <option value="lote">Lote</option>
                <option value="silo">Silo Bolsa</option>
              </select>
              <select id="fOrigenId" required></select>
            </div>
            <div class="field hidden" id="bloqueFinalizarOrigen1" style="margin-top:6px;">
              <label class="checkbox-field"><input type="checkbox" id="fFinalizarOrigen1" /> Este es el último camión de este silo bolsa — finalizarlo</label>
            </div>
            <button type="button" class="secondary" id="btnToggleOrigen2" style="margin-top:8px;">+ Agregar 2do origen</button>
          </div>

          <div class="field hidden" id="bloqueOrigen2">
            <label>Segundo origen</label>
            <div class="row">
              <select id="fOrigen2Tipo">
                <option value="lote">Lote</option>
                <option value="silo">Silo Bolsa</option>
              </select>
              <select id="fOrigen2Id"></select>
            </div>
            <label style="margin-top:8px;">Kg netos que vinieron del segundo origen</label>
            <input type="number" step="1" id="fKgOrigen2" placeholder="Ej: 8000" />
            <div class="field hidden" id="bloqueFinalizarOrigen2" style="margin-top:6px;">
              <label class="checkbox-field"><input type="checkbox" id="fFinalizarOrigen2" /> Este es el último camión de este silo bolsa — finalizarlo</label>
            </div>
            <button type="button" class="secondary" id="btnQuitarOrigen2" style="margin-top:8px;">Quitar segundo origen</button>
          </div>

          <div class="row">
            <div class="field">
              <label style="font-size:0.8rem;">Cultivo</label>
              <input type="text" id="fCultivo" placeholder="Soja, Maíz..." required style="padding:6px 8px; font-size:0.9rem;" />
            </div>
            <div class="field">
              <label>N° de CTG</label>
              <input type="text" id="fCtg" />
            </div>
          </div>

          <div class="row">
            <div class="field">
              <label>Chofer</label>
              <input type="text" id="fChofer" />
            </div>
            <div class="field">
              <label>Patente camión/acoplado</label>
              <input type="text" id="fPatente" />
            </div>
          </div>

          <div class="field">
            <label>Destino (Corredor)</label>
            <select id="fCorredorId" required></select>
          </div>

          <div class="field">
            <label>Kg netos</label>
            <input type="number" step="1" id="fNeto" required />
          </div>

          <div class="field">
            <label>Humedad (%)</label>
            <input type="number" step="0.1" id="fHumedad" />
          </div>

          <div class="field">
            <label>Ubicación GPS</label>
            <div class="row">
              <button type="button" class="secondary" id="btnGps">Capturar ubicación</button>
            </div>
            <div class="muted" id="gpsResultado">Sin capturar</div>
          </div>

          <div class="field">
            <label>Foto (opcional)</label>
            <input type="file" accept="image/*" capture="environment" id="fFoto" />
          </div>

          <div class="field">
            <label>Observaciones</label>
            <textarea id="fObs"></textarea>
          </div>

          <div id="stockWarning" class="muted"></div>

          <button type="submit">Guardar carga</button>
        </form>
      </div>

      <div class="card" id="listaCargas"></div>
    `;

    if (silos.length > 0) renderStockGranosCard(container, stockGranos);

    let gps = null;

    const origenTipoSel = container.querySelector("#fOrigenTipo");
    const origenIdSel = container.querySelector("#fOrigenId");
    const bloqueFinalizarOrigen1 = container.querySelector("#bloqueFinalizarOrigen1");
    const fFinalizarOrigen1 = container.querySelector("#fFinalizarOrigen1");
    const fCultivo = container.querySelector("#fCultivo");

    async function actualizarOrigen1() {
      await poblarOrigenSelect(origenIdSel, origenTipoSel.value);
      bloqueFinalizarOrigen1.classList.toggle("hidden", origenTipoSel.value !== "silo");
      fFinalizarOrigen1.checked = false;
    }
    await actualizarOrigen1();
    origenTipoSel.addEventListener("change", actualizarOrigen1);

    async function autocompletarCultivo(tipo, id) {
      if (!id) return;
      let cultivo = "";
      if (tipo === "lote") {
        const lote = await dbGet("lotes", id);
        cultivo = lote?.cultivo || "";
      } else {
        const silosStock = await getSilosBolsaConStock();
        cultivo = silosStock.find((s) => s.id === id)?.cultivo || "";
      }
      if (cultivo) fCultivo.value = cultivo;
    }
    origenIdSel.addEventListener("change", () => autocompletarCultivo(origenTipoSel.value, origenIdSel.value));

    const bloqueOrigen2 = container.querySelector("#bloqueOrigen2");
    const btnToggleOrigen2 = container.querySelector("#btnToggleOrigen2");
    const btnQuitarOrigen2 = container.querySelector("#btnQuitarOrigen2");
    const origen2TipoSel = container.querySelector("#fOrigen2Tipo");
    const origen2IdSel = container.querySelector("#fOrigen2Id");
    const fKgOrigen2 = container.querySelector("#fKgOrigen2");
    const bloqueFinalizarOrigen2 = container.querySelector("#bloqueFinalizarOrigen2");
    const fFinalizarOrigen2 = container.querySelector("#fFinalizarOrigen2");
    let origen2Activo = false;

    async function actualizarOrigen2() {
      await poblarOrigenSelect(origen2IdSel, origen2TipoSel.value);
      bloqueFinalizarOrigen2.classList.toggle("hidden", origen2TipoSel.value !== "silo");
      fFinalizarOrigen2.checked = false;
    }
    async function activarOrigen2() {
      origen2Activo = true;
      bloqueOrigen2.classList.remove("hidden");
      btnToggleOrigen2.classList.add("hidden");
      await actualizarOrigen2();
    }
    function desactivarOrigen2() {
      origen2Activo = false;
      bloqueOrigen2.classList.add("hidden");
      btnToggleOrigen2.classList.remove("hidden");
      origen2IdSel.value = "";
      fKgOrigen2.value = "";
      fFinalizarOrigen2.checked = false;
    }
    btnToggleOrigen2.addEventListener("click", activarOrigen2);
    btnQuitarOrigen2.addEventListener("click", desactivarOrigen2);
    origen2TipoSel.addEventListener("change", actualizarOrigen2);

    await poblarCorredorSelect(container.querySelector("#fCorredorId"));

    container.querySelector("#btnGps").addEventListener("click", () => {
      const resultado = container.querySelector("#gpsResultado");
      if (!navigator.geolocation) {
        resultado.textContent = "GPS no disponible en este dispositivo/navegador.";
        return;
      }
      resultado.textContent = "Obteniendo ubicación...";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resultado.textContent = `Lat ${gps.lat.toFixed(5)}, Lng ${gps.lng.toFixed(5)}`;
        },
        (err) => {
          resultado.textContent = "No se pudo obtener ubicación: " + err.message;
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    container.querySelector("#formCarga").addEventListener("submit", async (e) => {
      e.preventDefault();
      const origenId = origenIdSel.value;
      if (!origenId) {
        alert("Elegí el origen (lote o silo bolsa).");
        return;
      }
      const neto = parseFloat(container.querySelector("#fNeto").value) || 0;

      let kgOrigen2 = 0;
      let origen2Id = "";
      if (origen2Activo) {
        origen2Id = origen2IdSel.value;
        if (!origen2Id) {
          alert("Elegí el segundo origen o tocá \"Quitar segundo origen\" si no corresponde.");
          return;
        }
        if (origenTipoSel.value === origen2TipoSel.value && origenId === origen2Id) {
          alert("Elegiste el mismo origen dos veces. Si es un solo origen, quitá el segundo.");
          return;
        }
        kgOrigen2 = parseFloat(fKgOrigen2.value) || 0;
        if (kgOrigen2 <= 0) {
          alert("Ingresá los kg que vinieron del segundo origen.");
          return;
        }
        if (kgOrigen2 >= neto) {
          alert(`Los kg del segundo origen (${kgOrigen2}) tienen que ser menores a los kg netos totales (${neto}).`);
          return;
        }
      }
      const kgOrigen1 = neto - kgOrigen2;

      let origenNombre = "";
      let silo1KgResidual = null;
      if (origenTipoSel.value === "silo") {
        const silosStock = await getSilosBolsaConStock();
        const silo = silosStock.find((s) => s.id === origenId);
        origenNombre = silo ? silo.nombre : "";
        silo1KgResidual = silo ? silo.kgResidual : 0;
        if (silo && kgOrigen1 > silo.kgResidual) {
          const continuar = confirm(
            `El silo bolsa "${silo.nombre}" tiene ${silo.kgResidual} kg residuales y estás cargando ${kgOrigen1} kg.\n¿Confirmás igual? (puede deberse a una merma no registrada)`
          );
          if (!continuar) return;
        }
      } else {
        const lote = await dbGet("lotes", origenId);
        origenNombre = lote ? lote.nombre : "";
      }

      let origen2Nombre = "";
      let origen2Tipo = "";
      let silo2KgResidual = null;
      if (origen2Activo) {
        origen2Tipo = origen2TipoSel.value;
        if (origen2Tipo === "silo") {
          const silosStock2 = await getSilosBolsaConStock();
          const silo2 = silosStock2.find((s) => s.id === origen2Id);
          origen2Nombre = silo2 ? silo2.nombre : "";
          silo2KgResidual = silo2 ? silo2.kgResidual : 0;
          if (silo2 && kgOrigen2 > silo2.kgResidual) {
            const continuar2 = confirm(
              `El silo bolsa "${silo2.nombre}" tiene ${silo2.kgResidual} kg residuales y estás cargando ${kgOrigen2} kg desde ahí.\n¿Confirmás igual? (puede deberse a una merma no registrada)`
            );
            if (!continuar2) return;
          }
        } else {
          const lote2 = await dbGet("lotes", origen2Id);
          origen2Nombre = lote2 ? lote2.nombre : "";
        }
      }

      const corredorId = container.querySelector("#fCorredorId").value;
      const corredor = await dbGet("corredores", corredorId);

      const campaniaId = container.querySelector("#fCampania").value;
      const campania = campanias.find((c) => c.id === campaniaId);

      let fotoBlob = null;
      const fotoInput = container.querySelector("#fFoto");
      if (fotoInput.files && fotoInput.files[0]) {
        fotoBlob = fotoInput.files[0];
      }

      const fecha = container.querySelector("#fFecha").value;

      const registro = {
        id: uid(),
        fecha,
        campaniaId,
        campaniaNombre: campania ? campania.nombre : "",
        origenTipo: origenTipoSel.value,
        origenId,
        origenNombre,
        origen2Tipo,
        origen2Id: origen2Activo ? origen2Id : "",
        origen2Nombre,
        kgOrigen2,
        cultivo: fCultivo.value.trim(),
        ctg: container.querySelector("#fCtg").value.trim(),
        chofer: container.querySelector("#fChofer").value.trim(),
        patente: container.querySelector("#fPatente").value.trim(),
        corredorId,
        corredorNombre: corredor ? corredor.nombre : "",
        kgBrutos: 0,
        tara: 0,
        kgNeto: neto,
        humedad: parseFloat(container.querySelector("#fHumedad").value) || null,
        observaciones: container.querySelector("#fObs").value.trim(),
        gps,
        foto: fotoBlob,
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };

      await dbPut(STORE, registro);

      const mensajesAjuste = [];
      if (origenTipoSel.value === "silo" && fFinalizarOrigen1.checked) {
        const ajuste = await finalizarSiloBolsa(origenId, silo1KgResidual || 0, kgOrigen1, fecha);
        mensajesAjuste.push(mensajeAjuste(ajuste));
      }
      if (origen2Activo && origen2TipoSel.value === "silo" && fFinalizarOrigen2.checked) {
        const ajuste2 = await finalizarSiloBolsa(origen2Id, silo2KgResidual || 0, kgOrigen2, fecha);
        mensajesAjuste.push(mensajeAjuste(ajuste2));
      }

      window.dispatchEvent(new Event("appcampo-sync-now"));

      if (mensajesAjuste.length > 0) {
        alert(mensajesAjuste.join("\n\n"));
      }

      this.render(container);
    });

    await renderListadoCargas(container, campanias, this.state, campaniaActiva);
  },
};

async function renderListadoCargas(container, campanias, state, campaniaActiva) {
  const lista = container.querySelector("#listaCargas");
  const todasLasCargas = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  // Las cargas viejas, de antes de que existiera el concepto de Campaña, no
  // tienen campaniaId — se las trata como pertenecientes a la campaña activa,
  // así no "desaparecen" del filtro por defecto en ningún dispositivo.
  const campaniaDe = (c) => c.campaniaId || (campaniaActiva ? campaniaActiva.id : "");
  const cargas = state.campaniaFiltro
    ? todasLasCargas.filter((c) => campaniaDe(c) === state.campaniaFiltro)
    : todasLasCargas;

  const filtroHtml = `
    <div class="field" style="margin-bottom:10px;">
      <label style="font-size:0.8rem;">Ver campaña</label>
      <select id="fFiltroCampania" style="padding:6px 8px; font-size:0.9rem;">
        <option value="">Todas</option>
        ${campanias
          .slice()
          .sort((a, b) => b.nombre.localeCompare(a.nombre))
          .map((c) => `<option value="${c.id}" ${state.campaniaFiltro === c.id ? "selected" : ""}>${c.nombre}${c.activa ? " (activa)" : ""}</option>`)
          .join("")}
      </select>
    </div>
  `;

  if (todasLasCargas.length === 0) {
    lista.innerHTML = `<h2 style="margin-top:0;">Últimas cargas</h2><div class="empty-state">Todavía no registraste cargas.</div>`;
    return;
  }

  lista.innerHTML = `<h2 style="margin-top:0;">Últimas cargas</h2>${filtroHtml}`;
  lista.querySelector("#fFiltroCampania").addEventListener("change", (e) => {
    state.campaniaFiltro = e.target.value;
    renderListadoCargas(container, campanias, state, campaniaActiva);
  });

  if (cargas.length === 0) {
    lista.innerHTML += '<div class="empty-state">No hay cargas registradas en esta campaña.</div>';
    return;
  }
  for (const c of cargas) {
    const row = document.createElement("div");
    row.className = "list-item";
    const kgOrigen2 = c.kgOrigen2 || 0;
    const kgOrigen1 = (c.kgNeto || 0) - kgOrigen2;
    const origenTxt = c.origen2Nombre
      ? `<strong>${c.origenNombre}</strong> (${c.origenTipo === "silo" ? "Silo Bolsa" : "Lote"}) + <strong>${c.origen2Nombre}</strong> (${c.origen2Tipo === "silo" ? "Silo Bolsa" : "Lote"})`
      : `<strong>${c.origenNombre}</strong> (${c.origenTipo === "silo" ? "Silo Bolsa" : "Lote"})`;
    const kgTxt = c.origen2Nombre ? `${c.kgNeto} kg netos (${kgOrigen1} + ${kgOrigen2})` : `${c.kgNeto} kg netos`;
    row.innerHTML = `
      <div>
        <div>${origenTxt} → ${c.corredorNombre}</div>
        <div class="muted">${c.fecha?.replace("T", " ")} · ${c.cultivo} · ${kgTxt}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${c.sincronizado ? "sincronizado" : "pendiente"}">${c.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="danger" data-id="${c.id}">Borrar</button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      if (confirm("¿Borrar este registro?")) {
        await dbDelete(STORE, c.id);
        renderListadoCargas(container, campanias, state, campaniaActiva);
      }
    });
    lista.appendChild(row);
  }
}

export { cargaGranosView };
