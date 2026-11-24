# dibu-web

Editor en el navegador para escribir diagramas de [`dibu`](../dibu) y ver la vista previa
sincronizada mientras escribís. Es una SPA **sin servidor**: el motor Rust de `dibu`
se compila a WebAssembly y se incrusta, junto con el HTML, el CSS, el JS y los ejemplos,
en un único `dist/index.html` que funciona abierto directo desde el disco (`file://`)
o subido a cualquier hosting estático (GitHub Pages, un bucket, Moodle, etc.).

## Funciones

- Soporta los 44 tipos de `dibu` (control de procesos, química, computación). Usa el mismo
  motor que la CLI, así que la salida es la misma.
- Formatos: YAML/JSON (lista de bloques, bloque suelto o `{blocks: [...]}`) y **Markdown** con
  fences ` ```estructura ` / ` ```statics ` / `~~~…`. En Markdown, cada fence genera el SVG
  apilado con el mismo nombre `estructura-<hash>.svg` que produce `dibu sync-md`.
- **Sincronización editor ↔ vista previa**: el bloque bajo el cursor resalta su diagrama. Al
  desplazar el editor, la vista previa lo acompaña. Un clic en un diagrama lleva a su bloque.
- Cada bloque se renderiza por separado y se guarda en caché. Un error afecta solo a su bloque,
  aparece marcado en la línea correcta y la tarjeta sigue mostrando atenuado el último SVG válido.
- Paletas *tinta* / *color*, zoom, exportación por diagrama (SVG, PNG 2×, copiar) y
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
npm test             # smoke test del motor contra los fixtures de dibu
npm run build:web    # sólo reempaqueta HTML/CSS/JS (sin recompilar Rust)
```

Si `wasm-opt` (binaryen) está instalado, el build lo usa para achicar el `.wasm`. Los ejemplos
se toman de `$DIBU_DIR/fixtures/kitchen_sink/` (por defecto `../dibu`).

## Estructura

```
wasm/            crate puente (cdylib, ABI C sin wasm-bindgen) sobre dibu-core/cs/control/chem
  src/lib.rs     dibu_types · dibu_render · dibu_render_md · dibu_stack
web/
  index.html     plantilla (el build inserta estilos, datos y script)
  app.js         editor, resaltado, troceo en bloques, sincronización, exportación
  worker.js      Web Worker que instancia el WASM
  style.css      tema claro/oscuro
scripts/
  build.mjs      genera dist/index.html autocontenido
  smoke.mjs      prueba del motor contra los fixtures de dibu
```

## Nota sobre precisión numérica

La libm de WebAssembly y la de glibc pueden diferir en el último bit de `log10`/`powf`. Por eso,
en casos aislados, una coordenada del SVG puede redondearse a 0,1 px de diferencia respecto
de la CLI nativa: hoy pasa en 1 de los 23 fences del kitchen sink (un Bode). Visualmente es idéntico
y el nombre del archivo (hash de la fuente) coincide siempre.
