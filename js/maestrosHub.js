import {
  lotesView,
  corredoresView,
  silosBolsaView,
  proveedoresView,
  contratistasView,
  insumosView,
  campaniasView,
} from "./maestros.js";
import { APP_CONFIG } from "./config.js";
import { importarMaestros } from "./sync.js";

const subViews = {
  campanias: { view: campaniasView, label: "Campañas" },
  lotes: { view: lotesView, label: "Lotes" },
  silos: { view: silosBolsaView, label: "Silos Bolsa" },
  corredores: { view: corredoresView, label: "Corredores" },
  insumos: { view: insumosView, label: "Insumos" },
  proveedores: { view: proveedoresView, label: "Proveedores" },
  contratistas: { view: contratistasView, label: "Contratistas" },
};

const maestrosHubView = {
  async render(container, sub) {
    const activeKey = sub && subViews[sub] ? sub : "lotes";
    container.innerHTML = `
      ${APP_CONFIG.sheetsWebAppUrl ? '<div class="card" id="importCard"></div>' : ""}
      <div class="subtabs" id="subtabs"></div>
      <div id="subContent"></div>
    `;

    if (APP_CONFIG.sheetsWebAppUrl) {
      const importCard = container.querySelector("#importCard");
      importCard.innerHTML = `
        <button type="button" id="btnImportar">Actualizar desde Sheets</button>
        <div class="muted" id="importResultado" style="margin-top:8px;"></div>
      `;
      importCard.querySelector("#btnImportar").addEventListener("click", async () => {
        const btn = importCard.querySelector("#btnImportar");
        const resultado = importCard.querySelector("#importResultado");
        btn.disabled = true;
        btn.textContent = "Actualizando...";
        resultado.textContent = "";
        const res = await importarMaestros();
        btn.disabled = false;
        btn.textContent = "Actualizar desde Sheets";
        if (!res.ok) {
          resultado.textContent = `No se pudo actualizar: ${res.error}`;
          return;
        }
        const partes = Object.entries(res.resumen)
          .filter(([, r]) => r.nuevos > 0 || r.actualizados > 0)
          .map(([nombre, r]) => `${nombre}: ${r.nuevos} nuevo(s), ${r.actualizados} actualizado(s)`);
        resultado.textContent = partes.length ? partes.join(" · ") : "No había nada nuevo para traer.";
        await subViews[activeKey].view.render(container.querySelector("#subContent"));
      });
    }

    const subtabs = container.querySelector("#subtabs");
    subtabs.innerHTML = Object.entries(subViews)
      .map(
        ([key, v]) =>
          `<a href="#maestros/${key}" class="subtab ${key === activeKey ? "active" : ""}">${v.label}</a>`
      )
      .join("");
    const subContent = container.querySelector("#subContent");
    await subViews[activeKey].view.render(subContent);
  },
};

export { maestrosHubView };
