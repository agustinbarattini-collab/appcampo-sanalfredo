# Cómo armar una nueva empresa a partir de esta plantilla

Esta carpeta (`AppCampo`) es la plantilla base. Cada empresa es una copia
independiente: su propia carpeta, su propio repositorio de GitHub, su propia
URL pública y sus propios datos (que además viven solo en el dispositivo de
cada usuario, nunca en el código ni en GitHub).

## 1. Copiar la carpeta

```bash
cp -r AppCampo AppCampo-NombreEmpresa
cd AppCampo-NombreEmpresa
```

## 2. Editar `js/config.js`

```js
const APP_CONFIG = {
  empresaId: "nombreempresa",      // minúsculas, sin espacios ni acentos
  empresaNombre: "Nombre Empresa", // se muestra en el título y el encabezado
  colorPrimario: "#2e5339",        // color principal de la app
  colorSecundario: "#4a7c59",      // usado solo en el ícono
};
```

`empresaId` define el nombre de la base de datos local (`appcampo_<empresaId>`),
así que tiene que ser único y no cambiar una vez que la empresa ya cargó datos
reales (cambiarlo después equivale a vaciar la base).

## 3. Editar `manifest.json`

Cambiar `name`, `short_name`, `theme_color` y `background_color` para que
coincidan con el nombre y los colores del paso anterior.

## 4. Generar los íconos

```bash
python generate_icons.py --iniciales XX --color-fondo "#2e5339" --color-circulo "#4a7c59"
```

Reemplazar `XX` por las iniciales de la empresa y los colores por los del
`config.js`. Esto sobrescribe `icons/icon-192.png` e `icons/icon-512.png`.

## 5. Actualizar `index.html`

El `<meta name="theme-color">` y el `<title>` se sobrescriben automáticamente
desde `config.js` al cargar la app, pero conviene dejarlos ya coherentes en el
HTML por las dudas (se ven antes de que cargue el JS).

## 6. Probar localmente

Agregar una entrada nueva en `.claude/launch.json` (o correr manualmente
`python -m http.server <puerto> --directory AppCampo-NombreEmpresa`) y abrir
`http://localhost:<puerto>` para verificar que el nombre, el color y los
íconos cambiaron antes de publicar.

## 7. Publicar en GitHub Pages

```bash
cd AppCampo-NombreEmpresa
git init
git add .
git commit -m "Primera versión para NombreEmpresa"
gh repo create appcampo-nombreempresa --public --source=. --push
gh api repos/<usuario>/appcampo-nombreempresa/pages -X POST -F build_type=legacy -F "source[branch]=main" -F "source[path]=/"
```

La URL pública queda en `https://<usuario>.github.io/appcampo-nombreempresa/`.
Puede tardar 1-2 minutos en estar disponible la primera vez.

**Importante:** GitHub Pages en el plan gratuito requiere que el repositorio
sea público — el código queda visible para cualquiera, pero los datos de
campo (lotes, cargas, insumos, etc.) de cada empresa nunca se suben a GitHub:
viven únicamente en el navegador de cada dispositivo (IndexedDB), offline.

## 8. Conectar la sincronización a Google Sheets (opcional pero recomendado)

Cada empresa sincroniza a **su propia** Google Sheet, bajo la cuenta de Google
que la vaya a administrar (la tuya o la de la empresa). Este paso requiere
login de Google, así que lo tiene que hacer la persona dueña de esa cuenta.

1. Crear una Google Sheet nueva (en blanco), nombrarla por ejemplo
   "NombreEmpresa - App de Campo".
2. Extensiones → Apps Script. Borrar el contenido de `Code.gs` y pegar el
   contenido de `google-apps-script/Code.gs` de este repo.
3. En la línea `const SHARED_SECRET = "..."`, reemplazar por un texto propio
   al azar (no hace falta que sea complejo ni recordarlo, solo copiarlo).
4. En el editor, elegir la función `setup` en el selector de funciones (arriba)
   y tocar ▶ Ejecutar. Google va a pedir autorización la primera vez — es
   normal, aceptar. Esto crea las 5 pestañas de datos (Carga de Granos,
   Movimientos Insumos, Fitosanitarios, Avance Siembra, Cierres Siembra) y
   6 pestañas de "Maestros - ..." (Lotes, Silos Bolsa, Corredores, Insumos,
   Proveedores, Contratistas) con sus columnas.
5. Implementar → Nueva implementación → tipo "Aplicación web".
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
   - Implementar, copiar la URL que da (termina en `/exec`).
6. En `js/config.js` de la carpeta de esa empresa, completar:
   ```js
   sheetsWebAppUrl: "https://script.google.com/macros/s/AKfy.../exec",
   sheetsSyncToken: "el-mismo-texto-que-pusiste-en-SHARED_SECRET",
   ```
7. `git add`, `git commit`, `git push` para publicar el cambio.

Desde ese momento, cada vez que el celular con la app instalada recupera
conexión: (1) manda los registros pendientes (Carga de Granos, Insumos,
Fitosanitarios, Siembra) a la Sheet, y (2) **trae los registros que cargaron
otros dispositivos** que todavía no tenga, para que el stock, las cuentas y
los avances se vean iguales en todos los celulares del equipo. El header
muestra "X pendientes de sincronizar" o "Todo sincronizado".

**Cómo funciona el "traer de otros dispositivos" (importante entenderlo):**
los IDs internos de cada registro (de qué lote, qué insumo, etc.) se generan
en cada celular por separado — no son compartidos. Al traer un registro de la
Sheet, la app busca localmente un Lote/Insumo/Contratista/Orden/Plan con el
**mismo nombre**; si no lo encuentra, lo crea automáticamente con ese nombre
(igual que ya pasa hoy al escribir una Orden de trabajo nueva a mano). Por
eso es buena práctica usar siempre "Actualizar desde Sheets" en Maestros
antes de que el equipo empiece a cargar en un celular nuevo — así los nombres
coinciden con los que ya existen en vez de generar duplicados con mayúsculas
o espacios distintos.

**Limitaciones a tener en cuenta:**
- Las fotos (remitos, cargas) no se sincronizan por ahora — quedan solo en el
  dispositivo. La Sheet es para los datos, no para las fotos.
- Editar/borrar un registro en la app *después* de haberse sincronizado (por
  ejemplo "Deshacer cierre" en Siembra) no actualiza ni borra la fila ya
  escrita en la Sheet, y otros dispositivos que ya la trajeron tampoco se
  enteran del cambio. Para corregir un dato ya sincronizado hay que hacerlo
  a mano en la Sheet.
- Cada sincronización trae **todas** las filas de las 5 pestañas de datos
  (no solo las nuevas). Con volúmenes de una campaña normal no es un
  problema, pero si con los años la planilla crece mucho, en algún momento
  convendría optimizar esto (traer solo lo posterior a la última sincronización).

## 9. Cargar maestros en lote desde la Sheet (en vez de tipearlos a mano)

Las pestañas "Maestros - Lotes", "Maestros - Silos Bolsa", "Maestros -
Corredores", "Maestros - Insumos", "Maestros - Proveedores" y "Maestros -
Contratistas" (creadas por `setup`) se editan directamente en la Sheet:

- Pestañas de una sola columna (Lotes, Corredores, Proveedores, Contratistas):
  una fila por nombre.
- "Maestros - Insumos": columnas `nombre` y `unidad`.
- "Maestros - Silos Bolsa": columnas `nombre`, `cultivo`, `kgTotalInicial`.

Se puede pegar una lista copiada de otra planilla directamente ahí. Después,
en la app → **Maestros**, tocar **"Actualizar desde Sheets"**: trae todo lo
cargado en esas pestañas. Vuelve a tocarlo cada vez que agregues filas nuevas
en la Sheet — no borra nada que ya esté cargado en el celular, solo agrega lo
nuevo y actualiza lo que cambió (matchea por nombre, sin distinguir
mayúsculas/minúsculas).

## 10. Después de publicar

- Compartir la URL con la empresa. Desde el celular, abrirla en Chrome/Safari
  y usar "Agregar a pantalla de inicio" para instalarla como app.
- Cada actualización futura del código de esa empresa: repetir `git add`,
  `git commit`, `git push`. GitHub Pages se actualiza solo en 1-2 minutos.
- Si en el futuro se agrega una sección nueva a la plantilla (`AppCampo`) y
  se quiere llevar a una empresa ya publicada, hay que aplicar los mismos
  cambios de código a su carpeta y volver a hacer push (no hay sincronización
  automática entre plantilla y empresas ya duplicadas).
