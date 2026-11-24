#!/usr/bin/env node
// Construye dist/index.html: un único archivo autocontenido (HTML + CSS + JS + WASM)
// que funciona abierto directamente desde el disco (file://) o en cualquier hosting estático.
//
// Uso: node scripts/build.mjs [--sin-cargo]
//   DIBU_DIR  ruta al repositorio dibu (por defecto ../dibu), de donde se toman los ejemplos.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { construirEsquema, desdeFixtures, desdeFuente } from "./esquema.mjs";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dibu = resolve(process.env.DIBU_DIR || join(raiz, "..", "dibu"));
const web = join(raiz, "web");
const dist = join(raiz, "dist");
const objetivo = "wasm32-unknown-unknown";
const wasmRuta = join(raiz, "wasm", "target", objetivo, "release", "dibu_wasm.wasm");

if (!process.argv.includes("--sin-cargo")) {
  console.log("· compilando motor dibu → WebAssembly");
  execFileSync("cargo", ["build", "--release", "--target", objetivo, "--manifest-path", join(raiz, "wasm", "Cargo.toml")], {
    stdio: "inherit",
  });
}
if (!existsSync(wasmRuta)) {
  console.error(`No existe ${wasmRuta}. ¿Está instalado el target ${objetivo}?`);
  process.exit(1);
}

let wasm = readFileSync(wasmRuta);
try {
  // wasm-opt (binaryen) es opcional: si está, reduce el tamaño.
  const tmp = join(dist, "dibu.opt.wasm");
  mkdirSync(dist, { recursive: true });
  execFileSync("wasm-opt", ["-Os", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", wasmRuta, "-o", tmp], { stdio: "ignore" });
  wasm = readFileSync(tmp);
  console.log("· wasm-opt aplicado");
} catch {
  /* sin wasm-opt */
}

const leer = (p) => readFileSync(p, "utf8");

// Esquema de campos por tipo (fixtures parseados con el propio motor + código fuente de dibu).
function esquema() {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports;
  const parsear = (t) => {
    const b = new TextEncoder().encode(t);
    const p = ex.dibu_alloc(b.length);
    new Uint8Array(ex.memory.buffer, p, b.length).set(b);
    const n = ex.dibu_parse(p, b.length);
    const r = JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.dibu_out_ptr(), n)));
    if (r.error) throw new Error(r.error);
    return r.root;
  };
  const textos = ["diagramas_control.yaml", "diagramas_cs.yaml", "diagramas_quimica.yaml", "kitchen_sink/kitchen_sink.yaml"]
    .map((f) => join(dibu, "fixtures", f))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"));
  const e = construirEsquema(desdeFixtures(textos, parsear), desdeFuente(join(dibu, "crates")));
  console.log(`· esquema: ${Object.keys(e).length} tipos`);
  return e;
}
const fixture = (rel) => {
  const p = join(dibu, "fixtures", rel);
  if (!existsSync(p)) {
    console.warn(`! no se encontró ${p}: el catálogo de ejemplos quedará vacío`);
    return "";
  }
  return leer(p);
};

// JSON seguro para incrustar dentro de <script>.
const js = (v) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
const datos = `window.DIBU = {
  wasm: ${js(wasm.toString("base64"))},
  worker: ${js(leer(join(web, "worker.js")))},
  catalogo: ${js(fixture("kitchen_sink/kitchen_sink.yaml"))},
  markdown: ${js(fixture("kitchen_sink/kitchen_sink.md"))},
  esquema: ${js(esquema())}
};`;

const sinCierre = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");
const html = leer(join(web, "index.html"))
  .replace("/*@ESTILO@*/", () => sinCierre(leer(join(web, "style.css"))))
  .replace("/*@DATOS@*/", () => datos)
  .replace("/*@APP@*/", () => sinCierre(["visual.js", "asistente.js", "app.js"].map((f) => leer(join(web, f))).join("\n")));

mkdirSync(dist, { recursive: true });
const salida = join(dist, "index.html");
writeFileSync(salida, html);
const kb = (n) => (n / 1024).toFixed(0) + " KiB";
console.log(`✓ ${salida} (${kb(statSync(salida).size)}, motor ${kb(wasm.length)})`);
