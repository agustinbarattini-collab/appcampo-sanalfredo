// Detección del lote según la ubicación del celular (GPS), con los polígonos
// de js/lotesGeo.js (generado desde el shapefile de la empresa). Funciona sin
// internet: el GPS del celular no la necesita y los polígonos viajan con la app.
// Solo se usa si config.js tiene lotesGeo: true.

function normalizar(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "");
}

async function cargarGeoLotes() {
  try {
    const mod = await import("./lotesGeo.js");
    return mod.LOTES_GEO || null;
  } catch (err) {
    console.warn("No se pudo cargar el mapa de lotes:", err);
    return null;
  }
}

// Regla par/impar sobre todos los anillos del polígono: resuelve agujeros y
// también contornos que se cruzan a sí mismos.
function puntoEnAnillo(lng, lat, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const xi = anillo[i][0];
    const yi = anillo[i][1];
    const xj = anillo[j][0];
    const yj = anillo[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function puntoEnFeature(f, lng, lat) {
  const [minX, minY, maxX, maxY] = f.bbox;
  if (lng < minX || lng > maxX || lat < minY || lat > maxY) return false;
  let cantidad = 0;
  for (const anillo of f.anillos) if (puntoEnAnillo(lng, lat, anillo)) cantidad++;
  return cantidad % 2 === 1;
}

// Distancia en metros del punto al borde del polígono (aprox. plana, de sobra
// para distancias de decenas o cientos de metros).
function distanciaAFeature(f, lng, lat) {
  const kx = Math.cos((lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  let mejor = Infinity;
  for (const anillo of f.anillos) {
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      const ax = (anillo[j][0] - lng) * kx;
      const ay = (anillo[j][1] - lat) * ky;
      const bx = (anillo[i][0] - lng) * kx;
      const by = (anillo[i][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const largo2 = dx * dx + dy * dy;
      let t = largo2 === 0 ? 0 : -(ax * dx + ay * dy) / largo2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < mejor) mejor = d;
    }
  }
  return mejor;
}

// Devuelve { dentro: feature|null, cercano: { feature, metros }|null }.
function detectar(features, lat, lng) {
  const dentro = features.find((f) => puntoEnFeature(f, lng, lat)) || null;
  let cercano = null;
  if (!dentro) {
    for (const f of features) {
      const metros = distanciaAFeature(f, lng, lat);
      if (!cercano || metros < cercano.metros) cercano = { feature: f, metros };
    }
  }
  return { dentro, cercano };
}

function ubicacionActual() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Este celular no permite obtener la ubicación."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, precision: pos.coords.accuracy }),
      (err) => {
        const msgs = {
          1: "Tenés que permitir la ubicación en el celular para usar esto.",
          2: "No se pudo obtener la ubicación. Probá en un lugar abierto.",
          3: "Tardó demasiado en encontrar la ubicación. Probá de nuevo.",
        };
        reject(new Error(msgs[err.code] || "No se pudo obtener la ubicación."));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

export { normalizar, cargarGeoLotes, detectar, ubicacionActual };
