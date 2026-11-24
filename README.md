# dibu-web

Editor en el navegador para escribir diagramas de [`dibu`](../dibu) y ver la vista previa
sincronizada mientras escribís. Es una SPA **sin servidor**: el motor Rust de `dibu`
se compila a WebAssembly y se incrusta, junto con el HTML, el CSS, el JS y los ejemplos,
en un único `dist/index.html` que funciona abierto directo desde el disco (`file://`)
o subido a cualquier hosting estático (GitHub Pages, un bucket, Moodle, etc.).

## Funciones

- Soporta los 70 tipos de `dibu` (control de procesos, química, estructuras de datos, sistemas
  digitales, arquitectura, sistemas operativos, redes, bases de datos, señales, probabilidad y
  circuitos). Usa el mismo motor que la CLI, así que la salida es la misma.
- Formatos: YAML/JSON (lista de bloques, bloque suelto o `{blocks: [...]}`) y **Markdown** con
  fences ` ```estructura ` / ` ```statics ` / `~~~…`. En Markdown, cada fence genera el SVG
  apilado con el mismo nombre `estructura-<hash>.svg` que produce `dibu sync-md`.
- **Sincronización editor ↔ vista previa**: el bloque bajo el cursor resalta su diagrama. Al
  desplazar el editor, la vista previa lo acompaña. Un clic en un diagrama lleva a su bloque.
- Cada bloque se renderiza por separado y se guarda en caché. Un error afecta solo a su bloque,
  aparece marcado en la línea correcta y la tarjeta sigue mostrando atenuado el último SVG válido.
- **Editor visual** (pestaña *Visual*, <kbd>Ctrl</kbd>+<kbd>E</kbd>): formulario para el bloque
  seleccionado, con un widget según el tipo de cada campo: interruptores para sí/no, números que
  se ajustan arrastrando la etiqueta (Shift ×10, Alt ÷10), listas desplegables para los valores
  enumerados y sugerencias de valores de ejemplo. Las listas y los objetos anidados se pueden
  plegar, y se pueden agregar, quitar y reordenar elementos y campos. Se puede cambiar el tipo
  del bloque, y crear, duplicar, mover o eliminar bloques con deshacer/rehacer. Cada cambio
  reescribe sólo las líneas de ese bloque en el código (en YAML, o en JSON si el documento era
  JSON) y la vista previa se actualiza al instante. Al hacer clic en una tarjeta, se selecciona
  su bloque en el formulario.
- **Asistente del editor de código**:
  - Autocompletado según el contexto: al escribir una clave sugiere los campos del tipo y del
    objeto donde está el cursor (por ejemplo `system.` en un Bode o `forward[]` en un
    diagrama de bloques), sin repetir los que ya están. Después de `clave: ` sugiere los
    valores admitidos y `true`/`false`; <kbd>Ctrl</kbd>+<kbd>Espacio</kbd> fuerza las
    sugerencias y agrega los valores de ejemplo.
  - Elegir el `type` de un bloque vacío lo completa con los campos del ejemplo del catálogo
    (<kbd>Shift</kbd>+<kbd>Enter</kbd> inserta sólo el tipo).
  - La barra de estado describe el campo bajo el cursor (tipo, valores, valor por defecto) y
    avisa si el tipo no lo reconoce, con la clave más parecida.
  - Enter mantiene la sangría, entra en `clave:`, continúa listas y termina un `- ` vacío.
    Cierra `[`, `{` y `"`, y Retroceso borra un nivel de sangría.
  - <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> mueve líneas, <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>
    las duplica, <kbd>Ctrl</kbd>+<kbd>/</kbd> comenta y <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> borra.
- Los campos sugeridos salen de un esquema por tipo que se genera en el build
  (`scripts/esquema.mjs`) a partir de dos fuentes: los fixtures de dibu, parseados con el propio
  motor (tipos de valor, ejemplos y estructura anidada), y el código Rust de los renderizadores
  (claves leídas, valores de `matches!`/`match` y valores por defecto de `unwrap_or`).
- **Themes** de `dibu`: *Tinta*, *Color*, *Contraste* y *Oscuro* desde la barra (los presets `ink`,
  `color`, `high-contrast` y `dark`). Cada bloque puede elegir el suyo con `theme:`, sea un preset
  o un objeto `{extends, colors, typography}`, y el asistente sugiere los presets.
- Zoom, exportación por diagrama (SVG, PNG 2×, copiar) y
  "Exportar todo" (un único SVG apilado).
- Catálogo de ejemplos (el *kitchen sink* de `dibu`) insertable por tipo.
- Abrir y guardar archivos (también arrastrándolos a la ventana). El documento se guarda en
  `localStorage`, y "Compartir" copia un enlace con el texto comprimido en el `#hash`
  (no pasa por ningún servidor).
- El motor corre en un Web Worker con un límite de 8 s por bloque, así la interfaz no se
  congela. Si un bloque supera el límite o el motor entra en pánico, el worker se recrea.

## Construir

Requisitos: Rust con el target `wasm32-unknown-unknown` y Node ≥ 18. El repositorio `dibu`
tiene que estar al lado (`../dibu`), porque el crate puente lo usa por ruta.

```bash
# Fedora: sudo dnf install rust-std-static-wasm32-unknown-unknown
# rustup: rustup target add wasm32-unknown-unknown
npm run build        # compila el motor y genera dist/index.html
npm test             # smoke test del motor, round-trip del serializador YAML y contexto del asistente
npm run test:navegador  # prueba de extremo a extremo de dist/index.html en Chrome headless
npm run build:web    # sólo reempaqueta HTML/CSS/JS (sin recompilar Rust)
```

Si `wasm-opt` (binaryen) está instalado, el build lo usa para achicar el `.wasm`. Los ejemplos
se toman de `$DIBU_DIR/fixtures/kitchen_sink/` (por defecto `../dibu`).

## Estructura

```
wasm/            crate puente (cdylib, ABI C sin wasm-bindgen) sobre dibu-core/cs/control/chem/comp/math
  src/lib.rs     dibu_types · dibu_themes · dibu_render(_theme) · dibu_render_md(_theme) · dibu_stack · dibu_parse
web/
  index.html     plantilla (el build inserta estilos, datos y script)
  app.js         editor, resaltado, troceo en bloques, sincronización, exportación
  visual.js      editor visual: inspector de formularios y serializador YAML/JSON
  asistente.js   autocompletado, ayuda del campo y operaciones de línea del editor de código
  worker.js      Web Worker que instancia el WASM
  style.css      tema claro/oscuro
scripts/
  build.mjs      genera dist/index.html autocontenido
  esquema.mjs    extrae el esquema de campos por tipo (fixtures + código fuente)
  asistente.test.mjs  análisis de contexto del asistente (ruta, tipo, claves, Markdown)
  yaml-roundtrip.mjs  verifica que parsear → serializar → parsear conserve cada bloque
  smoke.mjs      prueba del motor contra los fixtures de dibu
  navegador.mjs  prueba del editor en Chrome/Chromium headless (protocolo DevTools, sin dependencias)
```

## Integración continua y publicación

Workflows en `.github/workflows/`. Todos clonan `INGCOM-UNRN/dibu` junto a este repositorio
y comparten `construir.yml`: compila el motor, genera `dist/index.html` y corre `npm test` y
la prueba de navegador.

- `ci.yml`: en cada pull request y en las ramas distintas de `main`.
- `pages.yml`: publica el editor en GitHub Pages en cada push a `main`, cuando `dibu` publica
  un release (evento `dibu-release`, que trae el tag a compilar), o a mano eligiendo la rama o
  el tag de `dibu`. Junto al editor se publica `version.json` con los commits usados.
- `release.yml`: al empujar un tag `vX.Y.Z` igual a la versión de `package.json`, adjunta al
  release el HTML autocontenido `dibu-web-vX.Y.Z.html`.
- `mantenimiento.yml`: los lunes compila contra `dibu` `main`, para detectar enseguida
  cambios del motor que rompan el editor, y audita `wasm/Cargo.lock` con `cargo audit`.

El editor publicado está en <https://ingcom-unrn.github.io/dibu-web/>.

Para que cada release de `dibu` republique el editor automáticamente, hace falta el secreto
**`DIBU_WEB_DISPATCH_TOKEN`** en el repositorio `dibu`: un token fine-grained con
*Contents: read and write* sobre `INGCOM-UNRN/dibu-web`. Sin ese secreto, el editor se
republica igual en cada push a `main` o a mano desde Actions.

## Nota sobre precisión numérica

La libm de WebAssembly y la de glibc pueden diferir en el último bit de `log10`/`powf`. Por eso,
en casos aislados, una coordenada del SVG puede redondearse a 0,1 px de diferencia respecto
de la CLI nativa: hoy pasa en 1 de los 23 fences del kitchen sink (un Bode). Visualmente es idéntico
y el nombre del archivo (hash de la fuente) coincide siempre.
