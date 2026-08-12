import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getAvancePlanes } from "./stockUtils.js";

const STORE_AVANCE = "avanceSiembra";
const STORE_CIERRE = "cierresSiembra";
const STORE_PLAN = "planSiembra";

const CULTIVOS = ["Soja 1ra", "Soja 2da", "Maíz Temprano", "Maíz Tardío", "Girasol", "Trigo", "Cebada"];

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

function optsPlanes(list) {
  return list
    .slice()
    .sort((a, b) => a.loteNombre.localeCompare(b.loteNombre) || a.cultivo.localeCompare(b.cultivo))
    .map((l) => `<option value="${l.id}">${l.loteNombre} — ${l.cultivo}</option>`)
    .join("");
}

function pctTexto(ha, teorica) {
  if (!teorica) return "";
  const pct = Math.round((ha / teorica) * 1000) / 10;
  return ` (${pct}%)`;
}

const CULTIVOS_SEMILLA_KG = ["soja 1ra", "soja 2da", "trigo", "cebada"];
const CULTIVOS_SEMILLA_BOLSAS = ["maiz temprano", "maiz tardio", "girasol"];

function normalizar(texto) {
  return (texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function tipoSemillaPara(cultivo) {
  const c = normalizar(cultivo);
  if (CULTIVOS_SEMILLA_KG.includes(c)) return "kg";
  if (CULTIVOS_SEMILLA_BOLSAS.includes(c)) return "bolsas";
  return "ambos";
}

function resumenCierre(c) {
  const partes = [];
  if (c.semillaKg) partes.push(`Semilla: ${c.semillaKg} kg${c.semillaVariedad ? " (" + c.semillaVariedad + ")" : ""}`);
  if (c.semillaBolsas) partes.push(`Semilla: ${c.semillaBolsas} bolsas${c.semillaHibrido ? " (" + c.semillaHibrido + ")" : ""}`);
  if (c.fertilizanteKg) partes.push(`Fertilizante: ${c.fertilizanteKg} kg${c.fertilizanteTipo ? " (" + c.fertilizanteTipo + ")" : ""}`);
  return partes.join(" · ") || "Sin productos cargados";
}

function renderResumenCard(container, planes, cultivoExpandido, onToggleCultivo) {
  const el = container.querySelector("#resumenCard");
  if (planes.length === 0) {
    el.innerHTML = `
      <h2 style="margin-top:0;">Avance de Siembra</h2>
      <div class="empty-state">Todavía no armaste el plan de siembra. Andá a la solapa "Plan" para cargar los lotes a sembrar.</div>`;
    return;
  }

  const totalHa = planes.reduce((s, l) => s + l.hasSembradas, 0);
  const totalTeorica = planes.reduce((s, l) => s + (l.superficieTeorica || 0), 0);

  const porCultivo = {};
  for (const l of planes) {
    const key = l.cultivo || "Sin cultivo";
    if (!porCultivo[key]) porCultivo[key] = { cultivo: key, ha: 0, teorica: 0, lotes: [] };
    porCultivo[key].ha += l.hasSembradas;
    porCultivo[key].teorica += l.superficieTeorica || 0;
    porCultivo[key].lotes.push(l);
  }

  el.innerHTML = `
    <h2 style="margin-top:0;">Avance de Siembra</h2>
    <div class="list-item">
      <div><strong>Total</strong></div>
      <div class="pill">${totalHa} / ${totalTeorica} ha${pctTexto(totalHa, totalTeorica)}</div>
    </div>
    ${Object.values(porCultivo)
      .sort((a, b) => a.cultivo.localeCompare(b.cultivo))
      .map((c) => {
        const expandido = c.cultivo === cultivoExpandido;
        const lotesOrdenados = c.lotes.slice().sort((a, b) => a.loteNombre.localeCompare(b.loteNombre));
        return `
      <div class="cultivo-block">
        <div class="list-item cultivo-header" data-cultivo="${c.cultivo}" style="cursor:pointer;">
          <div>${expandido ? "▾" : "▸"} ${c.cultivo}</div>
          <div class="pill">${c.ha} / ${c.teorica} ha${pctTexto(c.ha, c.teorica)}</div>
        </div>
        ${
          expandido
            ? `
        <div class="cultivo-lotes" style="padding-left:14px;">
          ${lotesOrdenados
            .map((l) => {
              const estado = l.cerrado ? "Cerrado" : l.pendienteCierre ? "Pend. cierre" : "Abierto";
              const estadoClass = l.cerrado ? "sincronizado" : l.pendienteCierre ? "pendiente" : "";
              return `
            <div class="list-item">
              <div>
                <div><strong>${l.loteNombre}</strong> <span class="pill ${estadoClass}">${estado}</span></div>
                <div class="muted">${l.registros.length} registro(s)${l.cierre ? " · cierre " + l.cierre.fecha + ": " + resumenCierre(l.cierre) : ""}</div>
              </div>
              <div class="pill">${l.hasSembradas}${l.superficieTeorica ? ` / ${l.superficieTeorica}` : ""} ha${pctTexto(l.hasSembradas, l.superficieTeorica)}</div>
            </div>`;
            })
            .join("")}
        </div>`
            : ""
        }
      </div>`;
      })
      .join("")}
  `;

  el.querySelectorAll(".cultivo-header").forEach((h) => {
    h.addEventListener("click", () => onToggleCultivo(h.dataset.cultivo));
  });
}

function renderFormPlan(container, formArea, { lotesMaestro, planesConEstado, campania }, onSaved) {
  if (lotesMaestro.length === 0) {
    formArea.innerHTML = `<div class="empty-state">Todavía no cargaste ningún <strong>Lote</strong>.<br/>Andá a Maestros → Lotes para cargarlo.</div>`;
    return;
  }

  formArea.innerHTML = `
    <div class="muted" style="margin-bottom:8px;">Se agrega al plan de la campaña <strong>${campania.nombre}</strong>.</div>
    <form id="formPlan">
      <div class="field">
        <label>Lote</label>
        <select id="fLote" required><option value="">Seleccionar...</option>${opts(lotesMaestro)}</select>
      </div>
      <div class="field">
        <label>Cultivo</label>
        <select id="fCultivo" required><option value="">Elegí primero el lote...</option></select>
      </div>
      <div class="field">
        <label>Superficie teórica (ha)</label>
        <input type="number" step="0.01" id="fSuperficie" required />
      </div>
      <button type="submit">Agregar al plan</button>
    </form>
    <div id="listaPlan" style="margin-top:14px;"></div>
  `;

  const fLote = container.querySelector("#fLote");
  const fCultivo = container.querySelector("#fCultivo");

  function actualizarCultivosDisponibles() {
    const loteId = fLote.value;
    if (!loteId) {
      fCultivo.innerHTML = '<option value="">Elegí primero el lote...</option>';
      return;
    }
    const activos = new Set(planesConEstado.filter((p) => p.loteId === loteId && !p.cerrado).map((p) => p.cultivo));
    const disponibles = CULTIVOS.filter((c) => !activos.has(c));
    fCultivo.innerHTML =
      disponibles.length === 0
        ? '<option value="">Todos los cultivos ya están activos en este lote</option>'
        : '<option value="">Seleccionar...</option>' + disponibles.map((c) => `<option value="${c}">${c}</option>`).join("");
  }
  fLote.addEventListener("change", actualizarCultivosDisponibles);

  const listaPlan = container.querySelector("#listaPlan");
  if (planesConEstado.length === 0) {
    listaPlan.innerHTML = '<div class="empty-state">Todavía no armaste el plan de siembra.</div>';
  } else {
    for (const p of planesConEstado
      .slice()
      .sort((a, b) => a.loteNombre.localeCompare(b.loteNombre) || a.cultivo.localeCompare(b.cultivo))) {
      const estado = p.cerrado ? "Cerrado" : p.pendienteCierre ? "Pend. cierre" : "Abierto";
      const estadoClass = p.cerrado ? "sincronizado" : p.pendienteCierre ? "pendiente" : "";
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <div>
          <div><strong>${p.loteNombre}</strong> — ${p.cultivo} <span class="pill ${estadoClass}">${estado}</span></div>
          <div class="muted">${p.hasSembradas} / ${p.superficieTeorica} ha teóricas</div>
        </div>
        <button class="secondary" data-id="${p.id}">Quitar</button>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (
          confirm(
            `¿Quitar "${p.loteNombre} — ${p.cultivo}" del plan de siembra? El avance ya cargado deja de contarse hasta que lo vuelvas a agregar.`
          )
        ) {
          await dbDelete(STORE_PLAN, p.id);
          onSaved();
        }
      });
      listaPlan.appendChild(row);
    }
  }

  container.querySelector("#formPlan").addEventListener("submit", async (e) => {
    e.preventDefault();
    const loteId = fLote.value;
    const cultivo = fCultivo.value;
    if (!loteId || !cultivo) return;

    const yaActivo = planesConEstado.some((p) => p.loteId === loteId && p.cultivo === cultivo && !p.cerrado);
    if (yaActivo) {
      alert(`Ya hay un plan activo de "${cultivo}" para este lote.`);
      return;
    }

    const lote = lotesMaestro.find((l) => l.id === loteId);
    await dbPut(STORE_PLAN, {
      id: uid(),
      loteId,
      loteNombre: lote ? lote.nombre : "",
      cultivo,
      campaniaId: campania.id,
      campaniaNombre: campania.nombre,
      superficieTeorica: parseFloat(container.querySelector("#fSuperficie").value) || 0,
    });
    onSaved();
  });
}

function renderFormAvance(container, formArea, { planesAbiertos }, onSaved) {
  if (planesAbiertos.length === 0) {
    formArea.innerHTML = `<div class="empty-state">No hay lotes abiertos para sembrar. Revisá el Plan, o si ya están todos cerrados o pendientes de cierre.</div>`;
    return;
  }
  formArea.innerHTML = `
    <form id="formMov">
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="fFecha" value="${today()}" required />
      </div>
      <div class="field">
        <label>Lote — Cultivo</label>
        <select id="fPlan" required><option value="">Seleccionar...</option>${optsPlanes(planesAbiertos)}</select>
      </div>
      <div class="field">
        <label>Has sembradas</label>
        <input type="number" step="0.01" id="fHas" required />
      </div>
      <div class="field">
        <label>Comentarios</label>
        <textarea id="fComentarios"></textarea>
      </div>
      <div class="field">
        <label class="checkbox-field"><input type="checkbox" id="fCerrar" /> Este es el último día — marcar lote como cerrado</label>
      </div>
      <button type="submit">Guardar avance</button>
    </form>
  `;

  container.querySelector("#formMov").addEventListener("submit", async (e) => {
    e.preventDefault();
    const planId = container.querySelector("#fPlan").value;
    if (!planId) return;
    const plan = planesAbiertos.find((l) => l.id === planId);
    const cerrar = container.querySelector("#fCerrar").checked;
    const registro = {
      id: uid(),
      fecha: container.querySelector("#fFecha").value,
      planId,
      loteId: plan ? plan.loteId : "",
      loteNombre: plan ? plan.loteNombre : "",
      cultivo: plan ? plan.cultivo : "",
      campaniaId: plan ? plan.campaniaId : "",
      campaniaNombre: plan ? plan.campaniaNombre : "",
      hasSembradas: parseFloat(container.querySelector("#fHas").value) || 0,
      comentarios: container.querySelector("#fComentarios").value.trim(),
      marcaCierre: cerrar,
      sincronizado: false,
      fechaCreacionRegistro: new Date().toISOString(),
    };
    await dbPut(STORE_AVANCE, registro);
    window.dispatchEvent(new Event("appcampo-sync-now"));
    onSaved(cerrar);
  });
}

function renderFormCierre(container, formArea, { pendientes }, onSaved) {
  if (pendientes.length === 0) {
    formArea.innerHTML = `<div class="empty-state">No hay lotes pendientes de cierre.<br/>Tildá "lote cerrado" en el último avance diario de un lote para que aparezca acá.</div>`;
    return;
  }

  formArea.innerHTML = "";
  for (const plan of pendientes) {
    const tipoSemilla = tipoSemillaPara(plan.cultivo);
    const block = document.createElement("div");
    block.className = "card";
    block.style.background = "#f4f6f4";
    block.innerHTML = `
      <h2 style="margin-top:0;">${plan.loteNombre} — ${plan.cultivo}</h2>
      <div class="muted" style="margin-bottom:10px;">${plan.hasSembradas} ha sembradas${plan.superficieTeorica ? ` de ${plan.superficieTeorica} ha teóricas${pctTexto(plan.hasSembradas, plan.superficieTeorica)}` : ""}</div>
      <form>
        <div class="field">
          <label>Fecha de cierre</label>
          <input type="date" class="fFechaCierre" value="${today()}" required />
        </div>
        ${
          tipoSemilla === "kg" || tipoSemilla === "ambos"
            ? `
        <div class="row">
          <div class="field"><label>Kg de semilla</label><input type="number" step="0.01" class="fSemillaKg" /></div>
          <div class="field"><label>Variedad</label><input type="text" class="fSemillaVariedad" /></div>
        </div>`
            : ""
        }
        ${
          tipoSemilla === "bolsas" || tipoSemilla === "ambos"
            ? `
        <div class="row">
          <div class="field"><label>Bolsas de semilla</label><input type="number" step="0.01" class="fSemillaBolsas" /></div>
          <div class="field"><label>Híbrido</label><input type="text" class="fSemillaHibrido" /></div>
        </div>`
            : ""
        }
        <div class="row">
          <div class="field"><label>Kg de fertilizante</label><input type="number" step="0.01" class="fFertilizanteKg" /></div>
          <div class="field"><label>Tipo de fertilizante</label><input type="text" class="fFertilizanteTipo" /></div>
        </div>
        <div class="field">
          <label>Observaciones</label>
          <textarea class="fComentariosCierre"></textarea>
        </div>
        <div class="row">
          <button type="submit">Confirmar cierre</button>
          <button type="button" class="secondary btnCancelar">Cancelar (reabrir lote)</button>
        </div>
      </form>
    `;

    block.querySelector(".btnCancelar").addEventListener("click", async () => {
      if (!confirm(`¿Cancelar el cierre de "${plan.loteNombre} — ${plan.cultivo}"? El lote vuelve a quedar abierto para cargar avances.`)) return;
      for (const registro of plan.registros.filter((r) => r.marcaCierre)) {
        registro.marcaCierre = false;
        await dbPut(STORE_AVANCE, registro);
      }
      onSaved();
    });

    block.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const getEl = (sel) => block.querySelector(sel);
      const getVal = (sel) => {
        const el = getEl(sel);
        return el ? el.value.trim() : "";
      };
      const getNum = (sel) => parseFloat(getVal(sel)) || 0;

      const semillaKg = getNum(".fSemillaKg");
      const semillaBolsas = getNum(".fSemillaBolsas");
      const fertilizanteKg = getNum(".fFertilizanteKg");

      if (!semillaKg && !semillaBolsas && !fertilizanteKg) {
        alert("Cargá al menos la semilla o el fertilizante utilizado.");
        return;
      }

      const registro = {
        id: uid(),
        planId: plan.id,
        loteId: plan.loteId,
        loteNombre: plan.loteNombre,
        cultivo: plan.cultivo,
        campaniaId: plan.campaniaId,
        campaniaNombre: plan.campaniaNombre,
        fecha: block.querySelector(".fFechaCierre").value,
        semillaKg: semillaKg || null,
        semillaVariedad: getVal(".fSemillaVariedad") || null,
        semillaBolsas: semillaBolsas || null,
        semillaHibrido: getVal(".fSemillaHibrido") || null,
        fertilizanteKg: fertilizanteKg || null,
        fertilizanteTipo: getVal(".fFertilizanteTipo") || null,
        comentarios: getVal(".fComentariosCierre"),
        sincronizado: false,
        fechaCreacionRegistro: new Date().toISOString(),
      };
      await dbPut(STORE_CIERRE, registro);
      window.dispatchEvent(new Event("appcampo-sync-now"));
      onSaved();
    });

    formArea.appendChild(block);
  }
}

const siembraView = {
  state: { tipo: "avance", cultivoExpandido: null, campaniaId: null },

  async render(container) {
    const [lotesMaestro, planesTodas, campanias] = await Promise.all([
      dbGetAll("lotes"),
      getAvancePlanes(),
      dbGetAll("campanias"),
    ]);

    if (campanias.length === 0) {
      container.innerHTML = `
        <h2>Aplicación de Siembra</h2>
        <div class="card empty-state">
          Todavía no cargaste ninguna <strong>Campaña</strong> (ej: 2025/26).<br/>
          Andá a Maestros → Campañas para cargarla antes de armar el plan de siembra.
        </div>`;
      return;
    }

    const campaniaActiva = campanias.find((c) => c.activa) || campanias[0];
    if (!this.state.campaniaId || !campanias.some((c) => c.id === this.state.campaniaId)) {
      this.state.campaniaId = campaniaActiva.id;
    }
    const campaniaSeleccionada = campanias.find((c) => c.id === this.state.campaniaId) || campaniaActiva;
    // Los planes viejos, de antes de que existiera Campaña, no tienen
    // campaniaId — se los trata como parte de la campaña activa.
    const planesConEstado = planesTodas.filter(
      (p) => (p.campaniaId || campaniaActiva.id) === campaniaSeleccionada.id
    );

    container.innerHTML = `
      <h2>Aplicación de Siembra</h2>
      <div class="card">
        <label style="font-size:0.8rem;">Trabajando en la campaña</label>
        <select id="fCampaniaSiembra">
          ${campanias
            .slice()
            .sort((a, b) => b.nombre.localeCompare(a.nombre))
            .map((c) => `<option value="${c.id}" ${c.id === campaniaSeleccionada.id ? "selected" : ""}>${c.nombre}${c.activa ? " (activa)" : ""}</option>`)
            .join("")}
        </select>
      </div>
      <div class="card" id="resumenCard"></div>
      <div class="card">
        <div class="tipo-toggle" id="tipoToggle">
          <button type="button" data-tipo="plan">Plan</button>
          <button type="button" data-tipo="avance">Avance diario</button>
          <button type="button" data-tipo="cierre">Cierre de lotes</button>
        </div>
        <div id="formArea"></div>
      </div>
      <div class="card" id="listaSiembra"></div>
    `;

    container.querySelector("#fCampaniaSiembra").addEventListener("change", (e) => {
      this.state.campaniaId = e.target.value;
      this.render(container);
    });

    const refrescarResumen = () => {
      renderResumenCard(container, planesConEstado, this.state.cultivoExpandido, (cultivo) => {
        this.state.cultivoExpandido = this.state.cultivoExpandido === cultivo ? null : cultivo;
        refrescarResumen();
      });
    };
    refrescarResumen();

    const tipoToggle = container.querySelector("#tipoToggle");
    tipoToggle.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tipo === this.state.tipo);
      btn.addEventListener("click", () => {
        this.state.tipo = btn.dataset.tipo;
        this.render(container);
      });
    });

    const formArea = container.querySelector("#formArea");
    const planesAbiertos = planesConEstado.filter((l) => !l.cerrado && !l.pendienteCierre);
    const planesPendientes = planesConEstado.filter((l) => l.pendienteCierre);

    if (this.state.tipo === "plan") {
      renderFormPlan(container, formArea, { lotesMaestro, planesConEstado, campania: campaniaSeleccionada }, () => this.render(container));
    } else if (this.state.tipo === "avance") {
      renderFormAvance(container, formArea, { planesAbiertos }, (cerrar) => {
        if (cerrar) this.state.tipo = "cierre";
        this.render(container);
      });
    } else {
      renderFormCierre(container, formArea, { pendientes: planesPendientes }, () => this.render(container));
    }

    await renderListado(container, campaniaSeleccionada.id, campaniaActiva.id);
  },
};

async function renderListado(container, campaniaId, campaniaActivaId) {
  const lista = container.querySelector("#listaSiembra");
  const [avancesTodos, cierresTodos] = await Promise.all([dbGetAll(STORE_AVANCE), dbGetAll(STORE_CIERRE)]);
  const avances = avancesTodos.filter((a) => (a.campaniaId || campaniaActivaId) === campaniaId);
  const cierres = cierresTodos.filter((c) => (c.campaniaId || campaniaActivaId) === campaniaId);
  const items = [
    ...avances.map((a) => ({ ...a, _tipo: "avance" })),
    ...cierres.map((c) => ({ ...c, _tipo: "cierre" })),
  ].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  if (items.length === 0) {
    lista.innerHTML = '<div class="empty-state">Todavía no registraste avances.</div>';
    return;
  }
  lista.innerHTML = `<h2 style="margin-top:0;">Historial</h2>`;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    if (it._tipo === "avance") {
      row.innerHTML = `
        <div>
          <div><span class="pill">Avance</span> <strong>${it.loteNombre}</strong> — ${it.cultivo} — ${it.hasSembradas} ha${it.marcaCierre ? ' <span class="pill pendiente">marca cierre</span>' : ""}</div>
          <div class="muted">${it.fecha}${it.comentarios ? " · " + it.comentarios : ""}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <span class="pill ${it.sincronizado ? "sincronizado" : "pendiente"}">${it.sincronizado ? "Sincronizado" : "Pendiente"}</span>
          <button class="danger" data-id="${it.id}">Borrar</button>
        </div>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (confirm("¿Borrar este avance?")) {
          await dbDelete(STORE_AVANCE, it.id);
          siembraView.render(container);
        }
      });
    } else {
      row.innerHTML = `
        <div>
          <div><span class="pill sincronizado">Cierre</span> <strong>${it.loteNombre}</strong> — ${it.cultivo} — ${resumenCierre(it)}</div>
          <div class="muted">${it.fecha}${it.comentarios ? " · " + it.comentarios : ""}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <span class="pill ${it.sincronizado ? "sincronizado" : "pendiente"}">${it.sincronizado ? "Sincronizado" : "Pendiente"}</span>
          <button class="danger" data-id="${it.id}">Deshacer cierre</button>
        </div>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (confirm(`¿Deshacer el cierre de "${it.loteNombre} — ${it.cultivo}"? Vuelve a quedar pendiente de cierre para completar los productos de nuevo.`)) {
          await dbDelete(STORE_CIERRE, it.id);
          siembraView.render(container);
        }
      });
    }
    lista.appendChild(row);
  }
}

export { siembraView };
