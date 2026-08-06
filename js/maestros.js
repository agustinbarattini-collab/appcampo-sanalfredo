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
          <div><strong>${s.nombre}</strong></div>
          <div class="muted">${s.cultivo ? s.cultivo + " · " : ""}${s.kgResidual} kg restantes de ${s.kgTotalInicial} kg</div>
        </div>
        <button class="secondary" data-id="${s.id}">Borrar</button>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (confirm(`¿Borrar "${s.nombre}"? Esto no borra las cargas ya registradas desde este silo.`)) {
          await dbDelete("silosBolsa", s.id);
          this.render(container);
        }
      });
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

export { lotesView, corredoresView, silosBolsaView, proveedoresView, contratistasView, insumosView };
