#!/usr/bin/env node
// Pruebas del análisis de contexto del asistente (web/asistente.js): ruta, tipo del bloque,
// claves hermanas y modo (clave/valor) en YAML de lista, `blocks:`, bloque suelto y Markdown.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ RE_VALLA: /^(`{3,}|~{3,})[ \t]*(?:estructura|statics)[ \t]*$/ });
vm.runInContext(
  readFileSync(join(raiz, "web/visual.js"), "utf8") + "\n" + readFileSync(join(raiz, "web/asistente.js"), "utf8") +
    "\n;globalThis.analizarContexto = analizarContexto; globalThis.cuerpoEjemplo = cuerpoEjemplo;",
  ctx
);

let fallas = 0, total = 0;
/** `doc` marca el cursor con «‸». */
function caso(nombre, doc, esperado, modo = "yaml") {
  total++;
  const lineas = doc.split("\n");
  const linea = lineas.findIndex((l) => l.includes("‸"));
  const col = lineas[linea].indexOf("‸");
  lineas[linea] = lineas[linea].replace("‸", "");
  const r = ctx.analizarContexto(lineas, linea, col, modo);
  const obtenido = r && Object.fromEntries(Object.keys(esperado).map((k) => [k, k === "hermanas" ? [...r.hermanas].sort() : r[k]]));
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado === null ? null : esperado);
  if (!ok) fallas++;
  console.log(`${ok ? "✓" : "✗"} ${nombre}${ok ? "" : `\n    esperado ${JSON.stringify(esperado)}\n    obtenido ${JSON.stringify(obtenido)}`}`);
}

const doc = `# comentario
- type: bode
  title: Uno
  system:
    k: 10
    ze‸
  show: both

- type: array
  values: [3, 1]
  ‸`;
caso("clave anidada en objeto", doc, { modo: "clave", ruta: "system", tipo: "bode", prefijo: "ze", hermanas: ["k"] });
caso("clave en la raíz del segundo bloque", doc.replace("ze‸", "zeta: 1").replace("  ‸", "  ti‸").replace("    k: 10", "    k: 10"), { modo: "clave", ruta: "", tipo: "array", prefijo: "ti", hermanas: ["type", "values"] });

caso("valor de type", "- type: bo‸\n  title: x", { modo: "valor", clave: "type", prefijo: "bo", ruta: "" });
caso("valor entre comillas", '- type: bode\n  show: "ma‸', { modo: "valor", clave: "show", prefijo: "ma", tipo: "bode" });
caso("ítem nuevo en lista de objetos", `- type: block_diagram
  forward:
    - label: G
      tf: "1/s"
    - ‸`, { modo: "clave", ruta: "forward[]", tipo: "block_diagram", hermanas: [] });
caso("segunda clave de un ítem de lista", `- type: block_diagram
  forward:
    - label: G
      t‸`, { modo: "clave", ruta: "forward[]", prefijo: "t", hermanas: ["label"] });
caso("bloque nuevo vacío", "- type: bode\n\n- ‸", { modo: "clave", ruta: "", tipo: null, prefijo: "" });
caso("raíz de lista sin guion: sin sugerencias", "- type: bode\nti‸", { modo: null });
caso("después de escalar de bloque", `- type: flowchart
  code: |
    a: 1
    b: 2
  sh‸`, { modo: "clave", ruta: "", tipo: "flowchart", hermanas: ["code", "type"] });
caso("blocks:", `blocks:
  - type: stack
    it‸`, { modo: "clave", ruta: "", tipo: "stack" });
caso("bloque suelto (mapeo raíz)", "type: queue\nti‸", { modo: "clave", ruta: "", tipo: "queue", hermanas: ["type"] });
caso("dentro de [ ]: nada", "- type: array\n  values: [1, ‸", null);
caso("JSON: nada", '[{"type": "array", ‸}]', null);
caso("Markdown dentro del fence", "# Título\n\n```estructura\n- type: lewis\n  mo‸\n```\n", { modo: "clave", tipo: "lewis", prefijo: "mo" }, "md");
caso("Markdown fuera del fence", "Texto ‸\n```estructura\n- type: lewis\n```", null, "md");
caso("Markdown segundo fence", "```estructura\n- type: a\n```\n\n```estructura\ntype: queue\nti‸\n```", { modo: "clave", tipo: "queue" }, "md");

// Valores de un campo anidado, desde un `match` sobre `.get("clave")` del renderizador.
{
  const { enumsAnidados } = await import("./esquema.mjs");
  const src = `let lado = match obj.get("from").filter(|v| !v.is_null()).map(valor_str).as_deref() {
        None if camino == Camino::Realimentacion => Lado::Abajo,
        None | Some("top") => Lado::Arriba,
        Some("bottom") => Lado::Abajo,
        Some(otro) => return Err(e),
    };`;
  total++;
  const r = enumsAnidados(src);
  const ok = JSON.stringify(r) === JSON.stringify({ from: { en: ["top", "bottom"], def: "top" } });
  if (!ok) fallas++;
  console.log(`${ok ? "✓" : "✗"} valores de un campo anidado${ok ? "" : ` ${JSON.stringify(r)}`}`);
}

console.log(`${fallas ? "✗" : "✓"} asistente: ${total - fallas}/${total}`);
process.exit(fallas ? 1 : 0);
