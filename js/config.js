const APP_CONFIG = {
  empresaId: "sanalfredo",
  empresaNombre: "San Alfredo",
  colorPrimario: "#3d4a30",
  colorSecundario: "#a9865a",
  // URL del Web App de Google Apps Script (ver DUPLICAR.md). Vacío = sin sincronización.
  sheetsWebAppUrl: "https://script.google.com/macros/s/AKfycbzFS14tMD4lMaGy5xr1QGdkSywixekxMecBV0ck-bYybIz2kcdEeJwPzBvYHUUL1poz/exec",
  // Mismo token que SHARED_SECRET en google-apps-script/Code.gs.
  sheetsSyncToken: "SAA2026",
  // Subir este número fuerza, en cada teléfono, un borrado del caché local
  // (IndexedDB) y una resincronización completa desde cero contra la Sheet
  // — sin que haya que tocar nada a mano en el celular. Se usa cuando se
  // borra o reordena algo grande directo en la Sheet (ej. "arrancar de 0"
  // el stock de Insumos) y hace falta que la app deje de mostrar lo viejo.
  // Ver verificarResetRemoto() en app.js.
  // Subido a 1 el 2026-08-20 para forzar el reset después de borrar a mano
  // el stock de Insumos y las Aplicaciones de Fitosanitarios en la Sheet.
  resetVersion: 1,
};

export { APP_CONFIG };
