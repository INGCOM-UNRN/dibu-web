#!/usr/bin/env node
// Verifica el serializador YAML del editor visual: para cada bloque de los fixtures de dibu,
// parsear → serializar → parsear debe dar el mismo valor y el mismo SVG.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dibu = resolve(process.env.DIBU_DIR || join(raiz, "..", "dibu"));
const ex = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(raiz, "wasm/target/wasm32-unknown-unknown/release/dibu_wasm.wasm"))), {}).exports;
function llamar(op, t, f) {
  const b = new TextEncoder().encode(t);
  const p = ex.dibu_alloc(b.length);
  new Uint8Array(ex.memory.buffer, p, b.length).set(b);
  const n = ex[op](p, b.length, f ?? 1);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.dibu_out_ptr(), n)));
}
const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(raiz, "web/visual.js"), "utf8") + "\n;globalThis.serializarRaiz = serializarRaiz;", ctx);

let ok = 0, malos = 0;
const extra = [
  { type: "array", title: "dos: puntos # y numeral", values: ["1", "true", "-x", "", " a", "0x1F", "a,b", "[x]", "null", "línea1\nlínea2"] },
  { type: "array", values: [], nested: { a: {}, b: [[1, 2], [3, { c: "d" }]] }, "clave rara": 1, "123": "n" },
];
const bloques = [];
for (const f of ["diagramas_control.yaml", "diagramas_cs.yaml", "diagramas_quimica.yaml", "diagramas_comp.yaml", "diagramas_math.yaml", "kitchen_sink/kitchen_sink.yaml"]) {
  bloques.push(...llamar("dibu_parse", readFileSync(join(dibu, "fixtures", f), "utf8")).root);
}
for (const b of [...bloques, ...extra]) {
  for (const esJSON of [false, true]) {
    const texto = ctx.serializarRaiz([b], esJSON);
    const r = llamar("dibu_parse", texto);
    const igual = !r.error && JSON.stringify(r.root[0]) === JSON.stringify(b);
    const svgA = llamar("dibu_render", JSON.stringify(b)), svgB = llamar("dibu_render", texto);
    const mismoSvg = JSON.stringify(svgA) === JSON.stringify(svgB);
    if (igual && (mismoSvg || extra.includes(b))) ok++;
    else { malos++; if (malos < 6) console.log(`✗ ${b.id || b.type} (json=${esJSON}) ${r.error || ""}\n${texto}\n`); }
  }
}
console.log(`${malos ? "✗" : "✓"} round-trip YAML/JSON: ${ok}/${ok + malos}`);
process.exit(malos ? 1 : 0);
