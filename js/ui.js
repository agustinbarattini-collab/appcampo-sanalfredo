// Aviso rápido y no bloqueante para confirmar que algo se guardó — a
// diferencia de alert(), no interrumpe el flujo ni hay que cerrarlo:
// aparece abajo (arriba de la tabbar) y desaparece solo.
function toast(mensaje, duracionMs = 2200) {
  let contenedor = document.getElementById("toastContainer");
  if (!contenedor) {
    contenedor = document.createElement("div");
    contenedor.id = "toastContainer";
    contenedor.className = "toast-container";
    document.body.appendChild(contenedor);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = mensaje;
  contenedor.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, duracionMs);
}

// Formatea una fecha a dd/mm/aaaa para mostrar. Acepta tanto "2026-08-28"
// (input type=date) como "2026-08-28T03:00:00.000Z" (Date de Google Sheets
// serializado) — en ambos casos toma solo la parte de fecha, ignorando la
// hora (que para estos usos no aporta nada y ensucia la lectura).
function formatearFechaCorta(fecha) {
  if (!fecha) return "sin definir";
  const soloFecha = String(fecha).slice(0, 10);
  const [anio, mes, dia] = soloFecha.split("-");
  if (!anio || !mes || !dia) return String(fecha);
  return `${dia}/${mes}/${anio}`;
}

// Convierte lo que haya en un campo numérico a número real, aceptando tanto
// "." como "," como separador decimal. Los inputs type="number" nativos
// SOLO aceptan "." — en un teclado en español (celulares sobre todo) la
// tecla decimal suele insertar "," y el navegador la descarta en silencio,
// dejando el valor mal armado (ej. "1,3" termina guardado como "13", diez
// veces más grande, sin ningún aviso). Por eso los campos numéricos de la
// app pasan a ser type="text" + inputmode="decimal" (para que el teclado
// numérico siga apareciendo en el celular) y se leen siempre con esta
// función en vez de parseFloat() directo. Devuelve 0 si no hay nada válido.
function parseNumero(valor) {
  const texto = String(valor ?? "").trim().replace(",", ".");
  const n = parseFloat(texto);
  return Number.isNaN(n) ? 0 : n;
}

export { toast, formatearFechaCorta, parseNumero };
