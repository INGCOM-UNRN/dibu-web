#!/usr/bin/env node
// Prueba de extremo a extremo de dist/index.html en Chrome/Chromium headless (sin dependencias:
// habla el protocolo DevTools por WebSocket). Abre la página como file://, igual que un usuario
// que descarga el archivo, y recorre el flujo principal: motor, render, error, catálogo,
// Markdown y editor visual.
//
// Uso: node scripts/navegador.mjs [ruta/al/index.html]
//   CHROME_BIN  ejecutable de Chrome/Chromium (por defecto se busca en el PATH).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagina = resolve(process.argv[2] || join(raiz, "dist", "index.html"));
if (!existsSync(pagina)) {
  console.error(`No existe ${pagina}: ejecutar antes npm run build`);
  process.exit(1);
}

function buscarChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    try {
      execFileSync("which", [c], { stdio: "ignore" });
      return c;
    } catch { /* siguiente */ }
  }
  console.error("No se encontró Chrome/Chromium (definir CHROME_BIN)");
  process.exit(1);
}

const perfil = mkdtempSync(join(tmpdir(), "dibu-web-chrome-"));
const puerto = 9300 + Math.floor(Math.random() * 500);
const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${perfil}`, `--remote-debugging-port=${puerto}`, "--window-size=1400,900", "about:blank"];
if (process.env.CI) args.unshift("--no-sandbox");
const chrome = spawn(buscarChrome(), args, { stdio: "ignore" });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let fallas = 0;
const excepciones = [];
function terminar(codigo) {
  const salir = () => {
    try { rmSync(perfil, { recursive: true, force: true, maxRetries: 5 }); } catch { /* perfil en uso */ }
    process.exit(codigo);
  };
  if (chrome.exitCode !== null) return salir();
  chrome.once("exit", salir);
  chrome.kill();
  setTimeout(salir, 3000).unref();
}
process.on("uncaughtException", (e) => { console.error("✗", e.message); terminar(1); });
process.on("unhandledRejection", (e) => { console.error("✗", e?.message || e); terminar(1); });
setTimeout(() => { console.error("✗ tiempo agotado"); terminar(1); }, 120000).unref();

let pestanas;
for (let i = 0; i < 100 && !pestanas; i++) {
  try { pestanas = await (await fetch(`http://127.0.0.1:${puerto}/json`)).json(); } catch { await esperar(150); }
}
if (!pestanas) { console.error("✗ Chrome no expuso DevTools"); terminar(1); }
const ws = new WebSocket(pestanas.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
let sec = 0;
const pendientes = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pendientes.has(d.id)) { pendientes.get(d.id)(d); pendientes.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") excepciones.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const cmd = (method, params = {}) => new Promise((r) => { const i = ++sec; pendientes.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "error al evaluar");
  return r.result?.result?.value;
};
/** Espera hasta que `expr` sea verdadera (o se agote el plazo) y devuelve su último valor. */
async function hasta(expr, ms = 15000) {
  const fin = Date.now() + ms;
  let v;
  while (Date.now() < fin) {
    v = await ev(expr).catch(() => undefined);
    if (v) return v;
    await esperar(100);
  }
  return v;
}
function comprobar(nombre, ok, detalle = "") {
  console.log(`${ok ? "✓" : "✗"} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  if (!ok) fallas++;
}

const $ = (s) => `document.querySelector(${JSON.stringify(s)})`;
const tarjetasOk = `[...document.querySelectorAll('.tarjeta')].filter(t => !t.classList.contains('error') && t.querySelector('.lienzo img')?.src).length`;
const fijarTexto = (js) => ev(`(() => { const x = ${$("#texto")}; x.value = ${js}; x.dispatchEvent(new Event('input')); })()`);

await cmd("Runtime.enable");
await cmd("Page.enable");
await cmd("Page.navigate", { url: pathToFileURL(pagina).href });

// 1. El motor WASM arranca dentro del worker.
const motor = await hasta(`/tipos/.test(${$("#e-motor")}.textContent) && ${$("#e-motor")}.textContent`, 30000);
comprobar("motor iniciado", !!motor, motor || (await ev(`${$("#e-motor")}.textContent`)));

// 2. Documento inicial renderizado.
await ev("localStorage.clear()");
const iniciales = await hasta(`${tarjetasOk} > 0 && ${tarjetasOk}`);
comprobar("documento inicial renderizado", iniciales > 0, `${iniciales} tarjetas`);

// 3. Un bloque válido y uno con error de sintaxis.
await fijarTexto(JSON.stringify("- type: array\n  title: Prueba CI\n  values: [3, 1, 4]\n"));
const svgTitulo = await hasta(`${tarjetasOk} === 1 && (${$(".tarjeta .lienzo img")}._svg || "").includes('Prueba CI')`);
comprobar("render de un bloque editado", !!svgTitulo);
await fijarTexto(JSON.stringify("- type: array\n  values: [3, 1, 4\n"));
const error = await hasta(`${$(".tarjeta.error .msg-error")}?.textContent`);
comprobar("error de sintaxis visible", !!error, (error || "").split("\n")[0].slice(0, 80));

// 4. Catálogo completo (todos los tipos) sin bloques con error.
const elegir = (v) => ev(`{ const s = ${$("#s-ejemplo")}; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); }`);
await ev("window.confirm = () => true");
await elegir("@catalogo");
await hasta(`document.querySelectorAll('.tarjeta').length > 40 && ${tarjetasOk} === document.querySelectorAll('.tarjeta').length`, 30000);
const total = await ev(`${$("#e-bloques")}.textContent`);
const [okCat, totCat] = await ev(`[${tarjetasOk}, document.querySelectorAll('.tarjeta').length]`);
comprobar("catálogo sin errores", okCat === totCat && totCat > 40, `${okCat}/${totCat} · ${total}`);

// 5. Markdown: los fences generan tarjetas con el nombre estructura-<hash>.svg.
await elegir("@md");
const ident = await hasta(`/estructura-[0-9a-f]+/.test(${$(".tarjeta .ident")}?.textContent) && ${$(".tarjeta .ident")}.textContent`, 30000);
comprobar("Markdown con nombres de sync-md", !!ident, ident || "");

// 6. Editor visual: editar el título desde el formulario actualiza código y SVG.
await fijarTexto(JSON.stringify("- type: array\n  title: Antes\n  values: [1, 2]\n"));
await hasta(`${tarjetasOk} === 1`);
await ev(`${$("#t-visual")}.click()`);
const campo = await hasta(`!!${$('#v-form [data-ruta="title"]')}`);
comprobar("pestaña Visual con formulario", !!campo);
if (campo) {
  await ev(`(() => { const i = ${$('#v-form [data-ruta="title"]')}; i.value = 'Después'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const codigo = await hasta(`${$("#texto")}.value.includes('title: Después') && ${$("#texto")}.value`);
  comprobar("el formulario reescribe el código", !!codigo);
  const svg = await hasta(`(${$(".tarjeta .lienzo img")}._svg || "").includes('Después')`);
  comprobar("el formulario actualiza la vista previa", !!svg);
  const lista = await ev(`document.querySelectorAll('#v-lista li').length`);
  comprobar("lista de bloques", lista === 1, `${lista} elemento(s)`);
}

comprobar("sin excepciones de JavaScript", excepciones.length === 0, excepciones.slice(0, 3).join(" | "));
console.log(fallas ? `✗ ${fallas} comprobación(es) fallida(s)` : "✓ prueba de navegador completa");
terminar(fallas ? 1 : 0);
