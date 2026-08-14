import { dbGetAll, dbPut, dbDelete } from "./db.js";
import { getSilosBolsaConStock, agruparSilosPorNombreCultivo } from "./stockUtils.js";

// Solo lectura: se carga y se borra en la planilla, nunca desde acá (a
// pedido del cliente, para que los maestros no diverjan entre celulares —
// mismo criterio que Campañas, pero acá ni siquiera "Borrar" queda local).
function renderMaestroSimple({ store, titulo, campoLabel, extraFields }) {
  return {
    async render(container) {
      const items = (await dbGetAll(store)).sort((a, b) => a.nombre.localeCompare(b.nombre));
      container.innerHTML = `
        <h2>${titulo}</h2>
        <div class="card empty-state">
          Esto se carga y se corrige en la planilla, no desde acá. Tocá "Actualizar desde Sheets" arriba para traer los cambios.
        </div>
        <div class="card" id="listaContainer">
          ${items.length === 0 ? '<div class="empty-state">Todavía no se trajo ninguno de la planilla.</div>' : ""}
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
        `;
        listaContainer.appendChild(row);
      }
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

// El alta/borrado de silos es solo desde la planilla, igual que los demás
// maestros. "Finalizar" (desde Carga de Granos, al último camión) y
// "Reactivar" (acá) SÍ quedan disponibles: no son "dar de alta" un maestro
// nuevo, son parte del flujo operativo diario y no tienen forma de hacerse
// desde la Sheet (el stock/residual es siempre calculado, nunca una columna).
const silosBolsaView = {
  async render(container) {
    const silos = (await getSilosBolsaConStock()).sort((a, b) => a.nombre.localeCompare(b.nombre));
    container.innerHTML = `
      <h2>Silos Bolsa</h2>
      <div class="card empty-state">
        Esto se carga y se corrige en la planilla, no desde acá. Tocá "Actualizar desde Sheets" arriba para traer los cambios. "Reactivar" es la única acción que queda disponible acá (deshace un "Finalizar" hecho por error).
      </div>
      <div class="card" id="listaContainer">
        ${silos.length === 0 ? '<div class="empty-state">Todavía no se trajo ninguno de la planilla.</div>' : ""}
      </div>
    `;

    const listaContainer = container.querySelector("#listaContainer");
    for (const s of silos) {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <div>
          <div><strong>${s.nombre}</strong> ${s.finalizado ? '<span class="pill sincronizado">Finalizado</span>' : ""}</div>
          <div class="muted">${s.cultivo ? s.cultivo + " · " : ""}${s.kgResidual} kg restantes de ${s.kgTotalInicial} kg${s.cantidadMiembros > 1 ? ` (suma de ${s.cantidadMiembros} filas con este nombre)` : ""}</div>
        </div>
        ${s.finalizado ? '<button class="secondary" data-accion="reactivar" data-id="' + s.id + '">Reactivar</button>' : ""}
      `;
      const btnReactivar = row.querySelector('[data-accion="reactivar"]');
      if (btnReactivar) {
        btnReactivar.addEventListener("click", async () => {
          if (confirm(`¿Reactivar "${s.nombre}"? Va a volver a aparecer como origen disponible en Carga de Granos.`)) {
            // s puede representar varios maestros agrupados por nombre+cultivo
            // (ver getSilosBolsaConStock) — hay que reactivar cada uno con sus
            // propios datos, no pisarlos con los valores agregados del grupo.
            const todosLosSilos = await dbGetAll("silosBolsa");
            const grupo = agruparSilosPorNombreCultivo(todosLosSilos).find((miembros) =>
              miembros.some((m) => m.id === s.id)
            ) || [];
            for (const m of grupo) {
              const { finalizado, fechaFinalizacion, ...base } = m;
              await dbPut("silosBolsa", base);
            }
            this.render(container);
          }
        });
      }
      listaContainer.appendChild(row);
    }
  },
};

// Campañas se CREA y se ACTIVA solo desde la planilla (a diferencia de los
// demás maestros, que también se pueden crear localmente): la campaña
// "activa" tiene que ser la misma para todo el equipo, y si se creara/
// activara desde un celular quedaría solo en ESE dispositivo (los maestros
// sincronizan Sheet → App, nunca App → Sheet). Se carga y se marca activa en
// la pestaña "Maestros - Campañas" de la Sheet (columna `activa` en TRUE
// para una sola fila), y cada celular la trae con "Actualizar desde Sheets".
// "Borrar" sí queda disponible acá: es una limpieza local (ej. una campaña
// mal tipeada) que no afecta cuál es la activa para los demás dispositivos.
const campaniasView = {
  async render(container) {
    const campanias = (await dbGetAll("campanias")).sort((a, b) => b.nombre.localeCompare(a.nombre));
    container.innerHTML = `
      <h2>Campañas</h2>
      <div class="card empty-state">
        Las campañas se cargan y se marcan activas en la planilla (pestaña "Maestros - Campañas"), no desde acá — así todo el equipo ve la misma campaña activa. Tocá "Actualizar desde Sheets" arriba para traer los cambios. "Borrar" es solo una limpieza local (ej. si se trajo una campaña mal tipeada): si la fila sigue en la planilla, va a volver a aparecer la próxima vez que actualices desde Sheets — borrala ahí también.
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
        <button class="secondary" data-accion="borrar" data-id="${c.id}">Borrar</button>
      `;
      row.querySelector('[data-accion="borrar"]').addEventListener("click", async () => {
        if (confirm(`¿Borrar la campaña "${c.nombre}" de este celular? Las cargas y planes ya registrados bajo esta campaña no se borran, pero quedan sin campaña asociada visible acá. Si esta fila sigue en la planilla, va a volver a aparecer al tocar "Actualizar desde Sheets".`)) {
          await dbDelete("campanias", c.id);
          this.render(container);
        }
      });
      listaContainer.appendChild(row);
    }
  },
};

export { lotesView, corredoresView, silosBolsaView, proveedoresView, contratistasView, insumosView, campaniasView };
