import { dbGetAll, dbPut, dbDelete, uid } from "./db.js";
import { getSilosBolsaConStock } from "./stockUtils.js";

function renderMaestroSimple({ store, titulo, campoLabel, extraFields }) {
  return {
    async render(container) {
      const items = (await dbGetAll(store)).sort((a, b) => a.nombre.localeCompare(b.nombre));
      container.innerHTML = `
        <h2>${titulo}</h2>
        <div class="card">
          <form id="formNuevo">
            <div class="field">
              <label>${campoLabel}</label>
              <input type="text" id="fNombre" required />
            </div>
            ${(extraFields || []).map((f) => `
              <div class="field">
                <label>${f.label}</label>
                <input type="${f.type || "text"}" id="f_${f.key}" ${f.step ? `step="${f.step}"` : ""} ${f.required ? "required" : ""} />
              </div>
            `).join("")}
            <button type="submit">Agregar</button>
          </form>
        </div>
        <div class="card" id="listaContainer">
          ${items.length === 0 ? '<div class="empty-state">Todavía no cargaste ninguno.</div>' : ""}
        </div>
      `;

      const listaContainer = container.querySelector("#listaContainer");
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "list-item";
        const extraTxt = (extraFields || [])
          .map((f) => `${f.label}: ${item[f.key] ?? "-"}`)
          .join(" · ");
        row.innerHTML = `
          <div>
            <div><strong>${item.nombre}</strong></div>
            ${extraTxt ? `<div class="muted">${extraTxt}</div>` : ""}
          </div>
          <button class="secondary" data-id="${item.id}">Borrar</button>
        `;
        row.querySelector("button").addEventListener("click", async () => {
          if (confirm(`¿Borrar "${item.nombre}"?`)) {
            await dbDelete(store, item.id);
            this.render(container);
          }
        });
        listaContainer.appendChild(row);
      }

      container.querySelector("#formNuevo").addEventListener("submit", async (e) => {
        e.preventDefault();
        const nombre = container.querySelector("#fNombre").value.trim();
        if (!nombre) return;
        const record = { id: uid(), nombre };
        for (const f of extraFields || []) {
          const el = container.querySelector(`#f_${f.key}`);
          let val = el.value;
          if (f.type === "number") val = val === "" ? 0 : parseFloat(val);
          record[f.key] = val;
        }
        await dbPut(store, record);
        this.render(container);
      });
    },
  };
}

const lotesView = renderMaestroSimple({
  store: "lotes",
  titulo: "Lotes",
  campoLabel: "Nombre del lote",
  extraFields: [{ key: "cultivo", label: "Cultivo actual (opcional)", type: "text" }],
});

const corredoresView = renderMaestroSimple({
  store: "corredores",
  titulo: "Corredores (destino de granos)",
  campoLabel: "Nombre del corredor",
});

const proveedoresView = renderMaestroSimple({
  store: "proveedores",
  titulo: "Proveedores (ingreso de insumos)",
  campoLabel: "Nombre del proveedor",
});

const contratistasView = renderMaestroSimple({
  store: "contratistas",
  titulo: "Contratistas (salida a orden de trabajo)",
  campoLabel: "Nombre del contratista",
});

const insumosView = renderMaestroSimple({
  store: "insumos",
  titulo: "Insumos",
  campoLabel: "Nombre del insumo",
  extraFields: [{ key: "unidad", label: "Unidad (kg, L, bolsas...)", type: "text", required: true }],
});

const silosBolsaView = {
  async render(container) {
    const silos = (await getSilosBolsaConStock()).sort((a, b) => a.nombre.localeCompare(b.nombre));
    container.innerHTML = `
      <h2>Silos Bolsa</h2>
      <div class="card">
        <form id="formNuevo">
          <div class="field">
            <label>Identificador del silo bolsa</label>
            <input type="text" id="fNombre" required />
          </div>
          <div class="field">
            <label>Cultivo</label>
            <input type="text" id="fCultivo" />
          </div>
          <div class="field">
            <label>Kg totales embolsados</label>
            <input type="number" step="1" id="fKgTotal" required />
          </div>
          <button type="submit">Agregar</button>
        </form>
      </div>
      <div class="card" id="listaContainer">
        ${silos.length === 0 ? '<div class="empty-state">Todavía no cargaste ninguno.</div>' : ""}
      </div>
    `;

    const listaContainer = container.querySelector("#listaContainer");
    for (const s of silos) {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <div>
          <div><strong>${s.nombre}</strong> ${s.finalizado ? '<span class="pill sincronizado">Finalizado</span>' : ""}</div>
          <div class="muted">${s.cultivo ? s.cultivo + " · " : ""}${s.kgResidual} kg restantes de ${s.kgTotalInicial} kg</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          ${s.finalizado ? '<button class="secondary" data-accion="reactivar" data-id="' + s.id + '">Reactivar</button>' : ""}
          <button class="secondary" data-accion="borrar" data-id="${s.id}">Borrar</button>
        </div>
      `;
      row.querySelector('[data-accion="borrar"]').addEventListener("click", async () => {
        if (confirm(`¿Borrar "${s.nombre}"? Esto no borra las cargas ya registradas desde este silo.`)) {
          await dbDelete("silosBolsa", s.id);
          this.render(container);
        }
      });
      const btnReactivar = row.querySelector('[data-accion="reactivar"]');
      if (btnReactivar) {
        btnReactivar.addEventListener("click", async () => {
          if (confirm(`¿Reactivar "${s.nombre}"? Va a volver a aparecer como origen disponible en Carga de Granos.`)) {
            const { finalizado, fechaFinalizacion, kgUsado, kgResidual, ...base } = s;
            await dbPut("silosBolsa", base);
            this.render(container);
          }
        });
      }
      listaContainer.appendChild(row);
    }

    container.querySelector("#formNuevo").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nombre = container.querySelector("#fNombre").value.trim();
      if (!nombre) return;
      await dbPut("silosBolsa", {
        id: uid(),
        nombre,
        cultivo: container.querySelector("#fCultivo").value.trim(),
        kgTotalInicial: parseFloat(container.querySelector("#fKgTotal").value) || 0,
      });
      this.render(container);
    });
  },
};

// Campañas es de SOLO LECTURA en la app (a diferencia de los demás maestros,
// que también se pueden crear localmente): la campaña "activa" tiene que ser
// la misma para todo el equipo, y si se creara/activara desde un celular
// quedaría solo en ESE dispositivo (los maestros sincronizan Sheet → App,
// nunca App → Sheet). Se carga y se marca activa en la pestaña "Maestros -
// Campañas" de la Sheet (columna `activa` en TRUE para una sola fila), y cada
// celular la trae con el botón "Actualizar desde Sheets" de arriba.
const campaniasView = {
  async render(container) {
    const campanias = (await dbGetAll("campanias")).sort((a, b) => b.nombre.localeCompare(a.nombre));
    container.innerHTML = `
      <h2>Campañas</h2>
      <div class="card empty-state">
        Las campañas se cargan y se marcan activas en la planilla (pestaña "Maestros - Campañas"), no desde acá — así todo el equipo ve la misma campaña activa. Tocá "Actualizar desde Sheets" arriba para traer los cambios.
      </div>
      <div class="card" id="listaContainer">
        ${campanias.length === 0 ? '<div class="empty-state">Todavía no se trajo ninguna campaña de la planilla.</div>' : ""}
      </div>
    `;

    const listaContainer = container.querySelector("#listaContainer");
    for (const c of campanias) {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <div>
          <div><strong>${c.nombre}</strong> ${c.activa ? '<span class="pill sincronizado">Activa</span>' : ""}</div>
        </div>
      `;
      listaContainer.appendChild(row);
    }
  },
};

export { lotesView, corredoresView, silosBolsaView, proveedoresView, contratistasView, insumosView, campaniasView };
