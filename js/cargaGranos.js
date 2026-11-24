import { dbGetAll, dbGet, dbPut, uid } from "./db.js";
import { guardarEdicion, eliminarRegistro, listarCambios, claveDe } from "./cambios.js";
import { getSilosBolsaConStock, getStockGranosPorCultivo, agruparSilosPorNombreCultivo } from "./stockUtils.js";
import { parseNumero, formatearFechaCorta, asegurarOpcion } from "./ui.js";

const STORE = "cargasGranos";
const STORE_AJUSTES = "ajustesSiloBolsa";

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Carga que se está corrigiendo (null = formulario de carga nueva). Vive acá afuera
// para que sobreviva a volver a dibujar la pantalla.
let editando = null;

// Kg que esta misma carga (si se está corrigiendo) ya descontó de un silo: sirven para
// no contarlos dos veces al avisar que se carga más de lo que queda.
function kgPreviosDe(carga, tipo, id) {
  if (!carga || !id) return 0;
  const kg2 = carga.kgOrigen2 || 0;
  const kg3 = carga.kgOrigen3 || 0;
  let total = 0;
  if (carga.origenTipo === tipo && carga.origenId === id) total += (carga.kgNeto || 0) - kg2 - kg3;
  if (carga.origen2Tipo === tipo && carga.origen2Id === id) total += kg2;
  if (carga.origen3Tipo === tipo && carga.origen3Id === id) total += kg3;
  return total;
}

async function poblarOrigenSelect(select, tipo) {
  select.innerHTML = '<option value="">Seleccionar...</option>';
  if (tipo === "lote") {
    const lotes = (await dbGetAll("lotes")).sort((a, b) => a.nombre.localeCompare(b.nombre));
    for (const l of lotes) {
      select.innerHTML += `<option value="${l.id}">${l.nombre}</option>`;
    }
  } else if (tipo === "silo") {
    // Solo los silos finalizados dejan de ofrecerse como origen (aunque estén en 0 o en negativo).
    const silos = (await getSilosBolsaConStock())
      .filter((s) => !s.finalizado)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    for (const s of silos) {
      select.innerHTML += `<option value="${s.id}">${s.nombre}${s.campaniaNombre ? ` (${s.campaniaNombre})` : ""} — ${s.kgResidual < 0 ? "excedido en " + Math.abs(s.kgResidual) + " kg" : s.kgResidual + " kg restantes"}${s.cultivo ? ` (${s.cultivo})` : ""}</option>`;
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
// positiva = sobrante (se sacó más de lo que decía la app calculada);
// negativa = faltante (se sacó menos de lo esperado, mermó en el camino).
// siloId es el "representante" del grupo (ver getSilosBolsaConStock): si hay
// más de un maestro con el mismo nombre+cultivo, se finalizan TODOS a la vez
// y el ajuste se calcula contra la suma de sus kg iniciales, no solo la del
// representante.
async function finalizarSiloBolsa(siloId, kgResidualAntes, kgEsteViaje, fechaCarga) {
  const silo = await dbGet("silosBolsa", siloId);
  if (!silo) return null;
  const todosLosSilos = await dbGetAll("silosBolsa");
  const grupo = agruparSilosPorNombreCultivo(todosLosSilos).find((miembros) =>
    miembros.some((m) => m.id === siloId)
  ) || [silo];
  const kgTotalInicialGrupo = grupo.reduce((sum, m) => sum + (m.kgTotalInicial || 0), 0);

  const diferenciaKg = Math.round((kgEsteViaje - kgResidualAntes) * 100) / 100;
  for (const m of grupo) {
    await dbPut("silosBolsa", { ...m, finalizado: true, fechaFinalizacion: new Date().toISOString() });
  }
  const ajuste = {
    id: uid(),
    fecha: fechaCarga,
    siloBolsaNombre: silo.nombre,
    cultivo: silo.cultivo || "",
    campaniaId: silo.campaniaId || null,
    campaniaNombre: silo.campaniaNombre || "",
    kgTotalInicial: kgTotalInicialGrupo,
    kgTotalRetirado: Math.round((kgTotalInicialGrupo + diferenciaKg) * 100) / 100,
    diferenciaKg,
    tipoDiferencia: diferenciaKg > 0 ? "sobrante" : diferenciaKg < 0 ? "faltante" : "exacto",
    observaciones: grupo.length > 1 ? `Suma de ${grupo.length} silos cargados con el mismo nombre y cultivo.` : "",
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
  async render(container) {
    const [lotes, silos, corredores, campanias, planesSiembra, stockGranos] = await Promise.all([
      dbGetAll("lotes"),
      dbGetAll("silosBolsa"),
      dbGetAll("corredores"),
      dbGetAll("campanias"),
      dbGetAll("planSiembra"),
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

    container.innerHTML = `
      <h2>Carga de Granos de Campo</h2>
      ${silos.length > 0 ? '<div class="card" id="stockGranosCard"></div>' : ""}
      ${
        editando
          ? `<div class="card" id="bannerEdicion" style="border:2px solid var(--color-primario);">
        <strong>Estás corrigiendo una carga ya guardada</strong>
        <div class="muted">${formatearFechaCorta(editando.fecha)} · ${editando.origenNombre || ""} · ${editando.kgNeto} kg. Cambiá lo que esté mal y tocá "Guardar cambios".</div>
        <button type="button" class="secondary" id="btnCancelarEdicion" style="margin-top:8px;">Cancelar corrección</button>
      </div>`
          : ""
      }
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
            <label>Fecha</label>
            <input type="date" id="fFecha" value="${today()}" required />
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
            <label id="fNetoLabel" style="margin-top:8px;">Kg netos</label>
            <input type="text" inputmode="decimal" id="fNeto" required />
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
            <label style="margin-top:8px;">Kg netos 2do origen</label>
            <input type="text" inputmode="decimal" id="fKgOrigen2" placeholder="Ej: 8000" />
            <div class="field hidden" id="bloqueFinalizarOrigen2" style="margin-top:6px;">
              <label class="checkbox-field"><input type="checkbox" id="fFinalizarOrigen2" /> Este es el último camión de este silo bolsa — finalizarlo</label>
            </div>
            <button type="button" class="secondary" id="btnToggleOrigen3" style="margin-top:8px;">+ Agregar 3er origen</button>
            <button type="button" class="secondary" id="btnQuitarOrigen2" style="margin-top:8px;">Quitar segundo origen</button>
          </div>

          <div class="field hidden" id="bloqueOrigen3">
            <label>Tercer origen</label>
            <div class="row">
              <select id="fOrigen3Tipo">
                <option value="lote">Lote</option>
                <option value="silo">Silo Bolsa</option>
              </select>
              <select id="fOrigen3Id"></select>
            </div>
            <label style="margin-top:8px;">Kg netos 3er origen</label>
            <input type="text" inputmode="decimal" id="fKgOrigen3" placeholder="Ej: 5000" />
            <div class="field hidden" id="bloqueFinalizarOrigen3" style="margin-top:6px;">
              <label class="checkbox-field"><input type="checkbox" id="fFinalizarOrigen3" /> Este es el último camión de este silo bolsa — finalizarlo</label>
            </div>
            <button type="button" class="secondary" id="btnQuitarOrigen3" style="margin-top:8px;">Quitar tercer origen</button>
          </div>

          <div class="field hidden" id="bloqueNetoTotal">
            <label>Kg netos total</label>
            <div class="pill" id="fNetoTotal" style="font-size:1rem;padding:8px 12px;">0</div>
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
            <select id="fCorredorId"></select>
          </div>

          <div class="field">
            <label>Humedad (%)</label>
            <input type="text" inputmode="decimal" id="fHumedad" />
          </div>

          <div class="field">
            <label>Ubicación GPS</label>
            <div class="row">
              <button type="button" class="secondary" id="btnGps">Capturar ubicación</button>
            </div>
            <div class="muted" id="gpsResultado">Sin capturar</div>
          </div>

          <div class="field" id="campoFoto">
            <label>Foto (opcional)</label>
            <input type="file" accept="image/*" capture="environment" id="fFoto" />
            <div class="muted">Se sube a Google Drive al sincronizar y queda linkeada en la planilla.</div>
          </div>

          <div class="field">
            <label>Observaciones</label>
            <textarea id="fObs"></textarea>
          </div>

          <div id="stockWarning" class="muted"></div>

          <button type="submit">${editando ? "Guardar cambios" : "Guardar carga"}</button>
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
    const fCampaniaSel = container.querySelector("#fCampania");

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
        // El cultivo de un lote depende de la campaña (puede cambiar de una a otra).
        // Se busca primero en el Plan de Siembra de la campaña elegida; si no hay
        // un plan cargado o hay más de uno activo (doble cultivo, ej. Trigo +
        // Soja 2da), no se adivina y se completa a mano.
        const planesDelLote = planesSiembra.filter((p) => p.loteId === id && p.campaniaId === fCampaniaSel.value);
        if (planesDelLote.length === 1) {
          cultivo = planesDelLote[0].cultivo;
        } else if (planesDelLote.length === 0) {
          const lote = await dbGet("lotes", id);
          cultivo = lote?.cultivo || "";
        }
      } else {
        const silosStock = await getSilosBolsaConStock();
        cultivo = silosStock.find((s) => s.id === id)?.cultivo || "";
      }
      if (cultivo) fCultivo.value = cultivo;
    }
    origenIdSel.addEventListener("change", () => autocompletarCultivo(origenTipoSel.value, origenIdSel.value));
    fCampaniaSel.addEventListener("change", () => autocompletarCultivo(origenTipoSel.value, origenIdSel.value));

    const bloqueOrigen2 = container.querySelector("#bloqueOrigen2");
    const btnToggleOrigen2 = container.querySelector("#btnToggleOrigen2");
    const btnQuitarOrigen2 = container.querySelector("#btnQuitarOrigen2");
    const origen2TipoSel = container.querySelector("#fOrigen2Tipo");
    const origen2IdSel = container.querySelector("#fOrigen2Id");
    const fKgOrigen2 = container.querySelector("#fKgOrigen2");
    const bloqueFinalizarOrigen2 = container.querySelector("#bloqueFinalizarOrigen2");
    const fFinalizarOrigen2 = container.querySelector("#fFinalizarOrigen2");
    const bloqueOrigen3 = container.querySelector("#bloqueOrigen3");
    const btnToggleOrigen3 = container.querySelector("#btnToggleOrigen3");
    const btnQuitarOrigen3 = container.querySelector("#btnQuitarOrigen3");
    const origen3TipoSel = container.querySelector("#fOrigen3Tipo");
    const origen3IdSel = container.querySelector("#fOrigen3Id");
    const fKgOrigen3 = container.querySelector("#fKgOrigen3");
    const bloqueFinalizarOrigen3 = container.querySelector("#bloqueFinalizarOrigen3");
    const fFinalizarOrigen3 = container.querySelector("#fFinalizarOrigen3");
    const fNeto = container.querySelector("#fNeto");
    const fNetoLabel = container.querySelector("#fNetoLabel");
    const bloqueNetoTotal = container.querySelector("#bloqueNetoTotal");
    const fNetoTotal = container.querySelector("#fNetoTotal");
    let origen2Activo = false;
    let origen3Activo = false;

    // Cada origen se pesa/mide por separado (no hay una sola báscula para el
    // camión entero), así que kg netos de cada uno se cargan directo y el
    // total se calcula sumando — nunca restando uno del otro.
    function actualizarNetoTotal() {
      if (!origen2Activo) return;
      const kg1 = parseNumero(fNeto.value);
      const kg2 = parseNumero(fKgOrigen2.value);
      const kg3 = origen3Activo ? parseNumero(fKgOrigen3.value) : 0;
      fNetoTotal.textContent = (kg1 + kg2 + kg3).toLocaleString("es-AR");
    }

    async function actualizarOrigen2() {
      await poblarOrigenSelect(origen2IdSel, origen2TipoSel.value);
      bloqueFinalizarOrigen2.classList.toggle("hidden", origen2TipoSel.value !== "silo");
      fFinalizarOrigen2.checked = false;
    }
    async function activarOrigen2() {
      origen2Activo = true;
      bloqueOrigen2.classList.remove("hidden");
      btnToggleOrigen2.classList.add("hidden");
      fNetoLabel.textContent = "Kg netos 1er origen";
      bloqueNetoTotal.classList.remove("hidden");
      await actualizarOrigen2();
      actualizarNetoTotal();
    }
    async function actualizarOrigen3() {
      await poblarOrigenSelect(origen3IdSel, origen3TipoSel.value);
      bloqueFinalizarOrigen3.classList.toggle("hidden", origen3TipoSel.value !== "silo");
      fFinalizarOrigen3.checked = false;
    }
    async function activarOrigen3() {
      origen3Activo = true;
      bloqueOrigen3.classList.remove("hidden");
      btnToggleOrigen3.classList.add("hidden");
      await actualizarOrigen3();
      actualizarNetoTotal();
    }
    function desactivarOrigen3() {
      origen3Activo = false;
      bloqueOrigen3.classList.add("hidden");
      btnToggleOrigen3.classList.remove("hidden");
      origen3IdSel.value = "";
      fKgOrigen3.value = "";
      fFinalizarOrigen3.checked = false;
      actualizarNetoTotal();
    }
    btnToggleOrigen3.addEventListener("click", activarOrigen3);
    btnQuitarOrigen3.addEventListener("click", desactivarOrigen3);
    origen3TipoSel.addEventListener("change", actualizarOrigen3);
    fKgOrigen3.addEventListener("input", actualizarNetoTotal);

    function desactivarOrigen2() {
      // Sin 2do origen no puede haber 3ro: se quitan los dos.
      if (origen3Activo) desactivarOrigen3();
      origen2Activo = false;
      bloqueOrigen2.classList.add("hidden");
      btnToggleOrigen2.classList.remove("hidden");
      fNetoLabel.textContent = "Kg netos";
      bloqueNetoTotal.classList.add("hidden");
      origen2IdSel.value = "";
      fKgOrigen2.value = "";
      fFinalizarOrigen2.checked = false;
    }
    btnToggleOrigen2.addEventListener("click", activarOrigen2);
    btnQuitarOrigen2.addEventListener("click", desactivarOrigen2);
    origen2TipoSel.addEventListener("change", actualizarOrigen2);
    fNeto.addEventListener("input", actualizarNetoTotal);
    fKgOrigen2.addEventListener("input", actualizarNetoTotal);

    await poblarCorredorSelect(container.querySelector("#fCorredorId"));

    // Modo corrección: se precarga el formulario con los datos de la carga elegida.
    if (editando) {
      const c = editando;
      const kg2 = c.kgOrigen2 || 0;
      const kg3 = c.kgOrigen3 || 0;
      const campaniaEdit = campanias.find((x) => x.id === c.campaniaId) || campanias.find((x) => x.nombre === c.campaniaNombre);
      if (campaniaEdit) fCampaniaSel.value = campaniaEdit.id;
      container.querySelector("#fFecha").value = String(c.fecha || today()).slice(0, 10);
      origenTipoSel.value = c.origenTipo === "silo" ? "silo" : "lote";
      await actualizarOrigen1();
      asegurarOpcion(origenIdSel, c.origenId, c.origenNombre);
      fNeto.value = String((c.kgNeto || 0) - kg2 - kg3);
      if (c.origen2Nombre) {
        await activarOrigen2();
        origen2TipoSel.value = c.origen2Tipo === "silo" ? "silo" : "lote";
        await actualizarOrigen2();
        asegurarOpcion(origen2IdSel, c.origen2Id, c.origen2Nombre);
        fKgOrigen2.value = String(kg2);
        if (c.origen3Nombre) {
          await activarOrigen3();
          origen3TipoSel.value = c.origen3Tipo === "silo" ? "silo" : "lote";
          await actualizarOrigen3();
          asegurarOpcion(origen3IdSel, c.origen3Id, c.origen3Nombre);
          fKgOrigen3.value = String(kg3);
        }
        actualizarNetoTotal();
      }
      fCultivo.value = c.cultivo || "";
      container.querySelector("#fCtg").value = c.ctg || "";
      container.querySelector("#fChofer").value = c.chofer || "";
      container.querySelector("#fPatente").value = c.patente || "";
      const corredorEdit = (await dbGetAll("corredores")).find((x) => x.id === c.corredorId || x.nombre === c.corredorNombre);
      if (corredorEdit) container.querySelector("#fCorredorId").value = corredorEdit.id;
      container.querySelector("#fHumedad").value = c.humedad === null || c.humedad === undefined ? "" : String(c.humedad);
      container.querySelector("#fObs").value = c.observaciones || "";
      if (c.gps) {
        gps = c.gps;
        container.querySelector("#gpsResultado").textContent = `Lat ${Number(c.gps.lat).toFixed(5)}, Lng ${Number(c.gps.lng).toFixed(5)} (la que ya tenía)`;
      }
      // Al corregir no se vuelve a preguntar por "finalizar silo" (eso queda como estaba) ni se
      // cambia la foto de una carga que ya subió (solo si todavía está pendiente).
      for (const idBloque of ["bloqueFinalizarOrigen1", "bloqueFinalizarOrigen2", "bloqueFinalizarOrigen3"]) {
        container.querySelector("#" + idBloque).style.display = "none";
      }
      if (c.sincronizado) container.querySelector("#campoFoto").style.display = "none";
      container.querySelector("#btnCancelarEdicion").addEventListener("click", () => {
        editando = null;
        this.render(container);
      });
      container.querySelector("#bannerEdicion").scrollIntoView({ block: "start" });
    }

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
      const kgOrigen1 = parseNumero(container.querySelector("#fNeto").value);

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
        kgOrigen2 = parseNumero(fKgOrigen2.value);
        if (kgOrigen2 <= 0) {
          alert("Ingresá los kg netos del segundo origen.");
          return;
        }
      }
      let kgOrigen3 = 0;
      let origen3Id = "";
      if (origen3Activo) {
        origen3Id = origen3IdSel.value;
        if (!origen3Id) {
          alert("Elegí el tercer origen o tocá \"Quitar tercer origen\" si no corresponde.");
          return;
        }
        if (
          (origenTipoSel.value === origen3TipoSel.value && origenId === origen3Id) ||
          (origen2TipoSel.value === origen3TipoSel.value && origen2Id === origen3Id)
        ) {
          alert("Elegiste el mismo origen más de una vez. Si no corresponde, quitá el tercer origen.");
          return;
        }
        kgOrigen3 = parseNumero(fKgOrigen3.value);
        if (kgOrigen3 <= 0) {
          alert("Ingresá los kg netos del tercer origen.");
          return;
        }
      }
      const neto = kgOrigen1 + kgOrigen2 + kgOrigen3;

      let origenNombre = "";
      let silo1KgResidual = null;
      if (origenTipoSel.value === "silo") {
        const silosStock = await getSilosBolsaConStock();
        const silo = silosStock.find((s) => s.id === origenId);
        origenNombre = silo ? silo.nombre : "";
        silo1KgResidual = silo ? silo.kgResidual : 0;
        const residual1 = silo ? silo.kgResidual + kgPreviosDe(editando, "silo", origenId) : 0;
        if (silo && kgOrigen1 > residual1) {
          const continuar = confirm(
            `El silo bolsa "${silo.nombre}" tiene ${residual1} kg residuales y estás cargando ${kgOrigen1} kg.\n¿Confirmás igual? (puede deberse a una merma no registrada)`
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
          const residual2 = silo2 ? silo2.kgResidual + kgPreviosDe(editando, "silo", origen2Id) : 0;
          if (silo2 && kgOrigen2 > residual2) {
            const continuar2 = confirm(
              `El silo bolsa "${silo2.nombre}" tiene ${residual2} kg residuales y estás cargando ${kgOrigen2} kg desde ahí.\n¿Confirmás igual? (puede deberse a una merma no registrada)`
            );
            if (!continuar2) return;
          }
        } else {
          const lote2 = await dbGet("lotes", origen2Id);
          origen2Nombre = lote2 ? lote2.nombre : "";
        }
      }

      let origen3Nombre = "";
      let origen3Tipo = "";
      let silo3KgResidual = null;
      if (origen3Activo) {
        origen3Tipo = origen3TipoSel.value;
        if (origen3Tipo === "silo") {
          const silosStock3 = await getSilosBolsaConStock();
          const silo3 = silosStock3.find((s) => s.id === origen3Id);
          origen3Nombre = silo3 ? silo3.nombre : "";
          silo3KgResidual = silo3 ? silo3.kgResidual : 0;
          const residual3 = silo3 ? silo3.kgResidual + kgPreviosDe(editando, "silo", origen3Id) : 0;
          if (silo3 && kgOrigen3 > residual3) {
            const continuar3 = confirm(
              `El silo bolsa "${silo3.nombre}" tiene ${residual3} kg residuales y estás cargando ${kgOrigen3} kg desde ahí.\n¿Confirmás igual? (puede deberse a una merma no registrada)`
            );
            if (!continuar3) return;
          }
        } else {
          const lote3 = await dbGet("lotes", origen3Id);
          origen3Nombre = lote3 ? lote3.nombre : "";
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

      const datos = {
        fecha,
        campaniaId,
        campaniaNombre: campania ? campania.nombre : "",
        origenTipo: origenTipoSel.value,
        origenId,
        origenNombre,
        origen2Tipo,
        origen2Id: origen2Activo ? origen2Id : "",
        origen2Nombre,
        kgOrigen1,
        kgOrigen2,
        origen3Tipo,
        origen3Id: origen3Activo ? origen3Id : "",
        origen3Nombre,
        kgOrigen3,
        cultivo: fCultivo.value.trim(),
        ctg: container.querySelector("#fCtg").value.trim(),
        chofer: container.querySelector("#fChofer").value.trim(),
        patente: container.querySelector("#fPatente").value.trim(),
        corredorId,
        corredorNombre: corredor ? corredor.nombre : "",
        kgBrutos: 0,
        tara: 0,
        kgNeto: neto,
        humedad: container.querySelector("#fHumedad").value.trim() ? parseNumero(container.querySelector("#fHumedad").value) : null,
        observaciones: container.querySelector("#fObs").value.trim(),
        gps,
      };

      // Corrección: se conserva el id (es la misma carga) y lo que no se puede cambiar desde acá.
      if (editando) {
        const corregida = { ...editando, ...datos, foto: fotoBlob || editando.foto || null };
        await guardarEdicion(STORE, "cargaGranos", corregida);
        editando = null;
        window.dispatchEvent(new Event("appcampo-sync-now"));
        alert("Carga corregida.");
        this.render(container);
        return;
      }

      const registro = {
        id: uid(),
        ...datos,
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
      if (origen3Activo && origen3TipoSel.value === "silo" && fFinalizarOrigen3.checked) {
        const ajuste3 = await finalizarSiloBolsa(origen3Id, silo3KgResidual || 0, kgOrigen3, fecha);
        mensajesAjuste.push(mensajeAjuste(ajuste3));
      }

      window.dispatchEvent(new Event("appcampo-sync-now"));

      alert(["Carga registrada.", ...mensajesAjuste].join("\n\n"));

      this.render(container);
    });

    await renderListadoCargas(container, campaniaActiva);
  },
};

// Aviso extra al eliminar: si en la misma fecha se finalizó uno de los silos de la carga,
// probablemente fue esta carga (finalizar el silo no se deshace solo).
async function avisoSiloFinalizado(c) {
  const nombres = [c.origenNombre, c.origen2Nombre, c.origen3Nombre].filter(Boolean);
  const ajustes = await dbGetAll(STORE_AJUSTES);
  const finalizado = ajustes.find((a) => a.fecha === c.fecha && nombres.includes(a.siloBolsaNombre));
  return finalizado
    ? `\n\nOjo: ese día se finalizó el silo bolsa "${finalizado.siloBolsaNombre}", probablemente con esta carga. Eliminar la carga NO lo reactiva (si hace falta, avisale al administrador).`
    : "";
}

async function renderListadoCargas(container, campaniaActiva) {
  const lista = container.querySelector("#listaCargas");
  const todasLasCargas = (await dbGetAll(STORE)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  const cambiosEnCola = new Map((await listarCambios()).map((x) => [x.clave, x]));

  if (todasLasCargas.length === 0) {
    lista.innerHTML = `<h2 style="margin-top:0;">Últimas cargas</h2><div class="empty-state">Todavía no registraste cargas.</div>`;
    return;
  }

  // Se muestran las 10 más recientes de todas las campañas (sin filtro) —
  // evita depender de un estado de filtro que podía apuntar a una campaña
  // ya borrada y ocultar cargas reales sin ninguna explicación.
  const cargas = todasLasCargas.slice(0, 10);
  lista.innerHTML = `<h2 style="margin-top:0;">Últimas cargas (10 más recientes)</h2>`;

  for (const c of cargas) {
    const row = document.createElement("div");
    row.className = "list-item";
    const kgOrigen2 = c.kgOrigen2 || 0;
    const kgOrigen3 = c.kgOrigen3 || 0;
    const kgOrigen1 = (c.kgNeto || 0) - kgOrigen2 - kgOrigen3;
    const tipoTxt = (t) => (t === "silo" ? "Silo Bolsa" : "Lote");
    const origenes = [{ nombre: c.origenNombre, tipo: c.origenTipo, kg: kgOrigen1 }];
    if (c.origen2Nombre) origenes.push({ nombre: c.origen2Nombre, tipo: c.origen2Tipo, kg: kgOrigen2 });
    if (c.origen3Nombre) origenes.push({ nombre: c.origen3Nombre, tipo: c.origen3Tipo, kg: kgOrigen3 });
    const origenTxt = origenes.map((o) => `<strong>${o.nombre}</strong> (${tipoTxt(o.tipo)})`).join(" + ");
    const kgTxt = origenes.length > 1 ? `${c.kgNeto} kg netos (${origenes.map((o) => o.kg).join(" + ")})` : `${c.kgNeto} kg netos`;
    const campaniaTxt = c.campaniaNombre || (campaniaActiva ? campaniaActiva.nombre : "sin campaña");
    const fotoTxt = c.fotoUrl
      ? ` · <a href="${c.fotoUrl}" target="_blank" rel="noopener">Ver foto</a>`
      : c.foto
      ? " · Foto pendiente de subir"
      : "";
    const cambio = cambiosEnCola.get(claveDe("cargaGranos", c.id));
    const correccionPendiente = c.sincronizado && cambio && cambio.accion === "editar";
    const errorTxt = cambio && cambio.error ? `<div class="muted" style="color:#c0392b;">No se pudo subir la corrección: ${cambio.error}</div>` : "";
    row.innerHTML = `
      <div>
        <div>${origenTxt} → ${c.corredorNombre}</div>
        <div class="muted">${formatearFechaCorta(c.fecha)} · Campaña ${campaniaTxt} · ${c.cultivo} · ${kgTxt}${fotoTxt}</div>
        ${errorTxt}
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <span class="pill ${c.sincronizado && !correccionPendiente ? "sincronizado" : "pendiente"}">${correccionPendiente ? "Corrección pendiente" : c.sincronizado ? "Sincronizado" : "Pendiente"}</span>
        <button class="secondary" data-accion="editar">Editar</button>
        <button class="danger" data-accion="eliminar">Eliminar</button>
      </div>
    `;
    row.querySelector('[data-accion="editar"]').addEventListener("click", () => {
      editando = c;
      cargaGranosView.render(container);
    });
    row.querySelector('[data-accion="eliminar"]').addEventListener("click", async () => {
      const resumen = `${formatearFechaCorta(c.fecha)} · ${origenes.map((o) => o.nombre).join(" + ")} · ${c.kgNeto} kg`;
      const aviso = c.sincronizado
        ? "\n\nSe elimina también de la planilla (queda una copia en la pestaña \"Historial de cambios\")."
        : "";
      if (!confirm(`¿Eliminar esta carga?\n\n${resumen}${aviso}${await avisoSiloFinalizado(c)}`)) return;
      await eliminarRegistro(STORE, "cargaGranos", c.id);
      if (editando && editando.id === c.id) editando = null;
      window.dispatchEvent(new Event("appcampo-sync-now"));
      cargaGranosView.render(container);
    });
    lista.appendChild(row);
  }
}

export { cargaGranosView };
