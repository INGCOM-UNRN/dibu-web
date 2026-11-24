#!/usr/bin/env node
// Prueba rápida del motor WASM: renderiza los fixtures de dibu y compara los fences
// Markdown con los SVG que generó `dibu sync-md` (mismo nombre y mismo contenido).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dibu = resolve(process.env.DIBU_DIR || join(raiz, "..", "dibu"));
const wasm = readFileSync(join(raiz, "wasm/target/wasm32-unknown-unknown/release/dibu_wasm.wasm"));
const ex = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports;
const enc = new TextEncoder(), dec = new TextDecoder();
function llamar(op, texto, bandera) {
  let n;
  if (texto === undefined) n = ex[op]();
  else {
    const b = enc.encode(texto);
    const p = ex.dibu_alloc(b.length);
    new Uint8Array(ex.memory.buffer, p, b.length).set(b);
    n = ex[op](p, b.length, bandera ?? 0);
  }
  return JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, ex.dibu_out_ptr(), n)));
}

let fallas = 0;
const tipos = llamar("dibu_types");
console.log(`tipos: ${tipos.length}`);

for (const f of ["diagramas_control.yaml", "diagramas_cs.yaml", "diagramas_quimica.yaml", "diagramas_comp.yaml", "diagramas_math.yaml", "kitchen_sink/kitchen_sink.yaml"]) {
  const r = llamar("dibu_render", readFileSync(join(dibu, "fixtures", f), "utf8"), 1);
  if (r.error) { console.log(`✗ ${f}: ${r.error}`); fallas++; continue; }
  const malos = r.blocks.filter((b) => b.error);
  malos.forEach((b) => console.log(`  ✗ ${f} ${b.id}: ${b.error}`));
  console.log(`${malos.length ? "✗" : "✓"} ${f}: ${r.blocks.length - malos.length}/${r.blocks.length} bloques`);
  fallas += malos.length;
}

// Markdown: misma extracción que la SPA y comparación con los SVG versionados.
const RE = /^(`{3,}|~{3,})[ \t]*(?:estructura|statics)[ \t]*$/;
const dirMd = join(dibu, "fixtures/kitchen_sink");
const lineas = readFileSync(join(dirMd, "kitchen_sink.md"), "utf8").split("\n");
// Diferencias de redondeo de libm (WASM vs glibc) en ±0,1 se toleran y se informan.
function casiIgual(a, b) {
  const num = /-?\d+(?:\.\d+)?/g;
  if (a.replace(num, "#") !== b.replace(num, "#")) return false;
  const x = a.match(num) || [], y = b.match(num) || [];
  return x.length === y.length && x.every((v, k) => Math.abs(Number(v) - Number(y[k])) <= 0.1 + 1e-9);
}
let iguales = 0, aprox = 0, total = 0;
for (let i = 0; i < lineas.length; i++) {
  const m = RE.exec(lineas[i]);
  if (!m) continue;
  let j = i + 1;
  while (j < lineas.length && lineas[j].trimEnd() !== m[1]) j++;
  const r = llamar("dibu_render_md", lineas.slice(i + 1, j).join("\n"), 1);
  total++;
  const ref = join(dirMd, "diagramas", r.name);
  if (r.error) { console.log(`  ✗ fence línea ${i + 1}: ${r.error}`); fallas++; }
  else if (existsSync(ref) && readFileSync(ref, "utf8") === r.svg) iguales++;
  else if (existsSync(ref) && casiIgual(readFileSync(ref, "utf8"), r.svg)) { aprox++; console.log(`  ≈ fence línea ${i + 1}: ${r.name} difiere sólo por redondeo (≤ 0,1)`); }
  else { console.log(`  ✗ fence línea ${i + 1}: ${r.name} difiere de sync-md`); fallas++; }
  i = j;
}
console.log(`${iguales + aprox === total ? "✓" : "✗"} kitchen_sink.md: ${iguales}/${total} fences idénticos a dibu sync-md, ${aprox} con redondeo`);

const err = llamar("dibu_render", "- type: array\n  values: [1, 2\n", 1);
console.log(err.error ? `✓ error YAML: ${err.error}` : "✗ se esperaba error YAML");
const st = llamar("dibu_stack", JSON.stringify([llamar("dibu_render", "type: array\nvalues: [1]", 1).blocks[0].svg, llamar("dibu_render", "type: stack\nvalues: [1]", 1).blocks[0].svg]));
console.log(st.svg ? "✓ apilado" : `✗ apilado: ${st.error}`);

// Themes: preset, theme propio, theme por bloque y error de validación.
const conTema = (texto, theme) => llamar("dibu_render_theme", JSON.stringify({ text: texto, theme }));
const comprobar = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) fallas++; };
const arr = "type: array\nvalues: [1, 2]";
comprobar(llamar("dibu_themes").join() === "ink,color,high-contrast,dark", "theme: presets");
comprobar(conTema(arr, "ink").blocks[0].svg === llamar("dibu_render", arr, 1).blocks[0].svg, "theme: ink idéntico a la paleta tinta");
comprobar(conTema(arr, "dark").blocks[0].svg.includes('fill="#0f172a"'), "theme: dark pinta el fondo oscuro");
comprobar(conTema(arr, { extends: "ink", colors: { background: "#fafaf9" } }).blocks[0].svg.includes('fill="#fafaf9"'), "theme: objeto con extends y colors");
comprobar(conTema("type: array\nvalues: [1]\ntheme: dark", "ink").blocks[0].svg.includes('fill="#0f172a"'), "theme: el bloque pisa el theme global");
comprobar(!!conTema(arr, { colors: { background: "red\" onload=\"x" } }).error, "theme: rechaza colores inválidos");
const md = llamar("dibu_render_md_theme", JSON.stringify({ text: arr, theme: "high-contrast" }));
comprobar(!!md.svg && md.name.startsWith("estructura-"), "theme: Markdown con theme");
process.exit(fallas ? 1 : 0);
