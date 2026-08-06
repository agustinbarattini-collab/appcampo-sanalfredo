import { dbGetAll, dbGet, dbPut, dbDelete, uid } from "./db.js";
import { getSilosBolsaConStock } from "./stockUtils.js";

const STORE = "cargasGranos";

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
    const silos = (await getSilosBolsaConStock()).sort((a, b) => a.nombre.localeCompare(b.nombre));
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

const cargaGranosView = {
  async render(container) {
    const [lotes, silos, corredores] = await Promise.all([
      dbGetAll("lotes"),
      dbGetAll("silosBolsa"),
      dbGetAll("corredores"),
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

    container.innerHTML = `
      <h2>Carga de Granos de Campo</h2>
      <div class="card">
        <form id="formCarga">
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
            <button type="button" class="secondary" id="btnQuitarOrigen2" style="margin-top:8px;">Quitar segundo origen</button>
          </div>

          <div class="field">
            <label>Cultivo</label>
            <input type="text" id="fCultivo" placeholder="Soja, Maíz, Trigo..." required />
          </div>

          <div class="field">
            <label>N° de CTG</label>
            <input type="text" id="fCtg" />
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

    let gps = null;

    const origenTipoSel = container.querySelector("#fOrigenTipo");
    const origenIdSel = container.querySelector("#fOrigenId");
    await poblarOrigenSelect(origenIdSel, origenTipoSel.value);
    origenTipoSel.addEventListener("change", () => poblarOrigenSelect(origenIdSel, origenTipoSel.value));

    const bloqueOrigen2 = container.querySelector("#bloqueOrigen2");
    const btnToggleOrigen2 = container.querySelector("#btnToggleOrigen2");
    const btnQuitarOrigen2 = container.querySelector("#btnQuitarOrigen2");
    const origen2TipoSel = container.querySelector("#fOrigen2Tipo");
    const origen2IdSel = container.querySelector("#fOrigen2Id");
    const fKgOrigen2 = container.querySelector("#fKgOrigen2");
    let origen2Activo = false;

    async function activarOrigen2() {
      origen2Activo = true;
      bloqueOrigen2.classList.remove("hidden");
      btnToggleOrigen2.classList.add("hidden");
      await poblarOrigenSelect(origen2IdSel, origen2TipoSel.value);
    }
    function desactivarOrigen2() {
      origen2Activo = false;
      bloqueOrigen2.classList.add("hidden");
      btnToggleOrigen2.classList.remove("hidden");
      origen2IdSel.value = "";
      fKgOrigen2.value = "";
    }
    btnToggleOrigen2.addEventListener("click", activarOrigen2);
    btnQuitarOrigen2.addEventListener("click", desactivarOrigen2);
    origen2TipoSel.addEventListener("change", () => poblarOrigenSelect(origen2IdSel, origen2TipoSel.value));

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
      if (origenTipoSel.value === "silo") {
        const silosStock = await getSilosBolsaConStock();
        const silo = silosStock.find((s) => s.id === origenId);
        origenNombre = silo ? silo.nombre : "";
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
      if (origen2Activo) {
        origen2Tipo = origen2TipoSel.value;
        if (origen2Tipo === "silo") {
          const silosStock2 = await getSilosBolsaConStock();
          const silo2 = silosStock2.find((s) => s.id === origen2Id);
          origen2Nombre = silo2 ? silo2.nombre : "";
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

      let fotoBlob = null;
      const fotoInput = container.querySelector("#fFoto");
      if (fotoInput.files && fotoInput.files[0]) {
        fotoBlob = fotoInput.files[0];
      }

      const registro = {
        id: uid(),
        fecha: container.querySelector("#fFecha").value,
        origenTipo: origenTipoSel.value,
        origenId,
        origenNombre,
        origen2Tipo,
        origen2Id: origen2Activo ? origen2Id : "",
        origen2Nombre,
        kgOrigen2,
        cultivo: container.querySelector("#fCultivo").value.trim(),
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
      window.dispatchEvent(new Event("appcampo-sync-now"));

      this.render(container);
    });

    await renderListadoCargas(container);
  },
};

async function renderListadoCargas(container) {
  const lista = container.querySelector("#listaCargas");
  const cargas = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  if (cargas.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no registraste cargas.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Últimas cargas</h2>`;
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
        renderListadoCargas(container);
      }
    });
    lista.appendChild(row);
  }
}

export { cargaGranosView };
