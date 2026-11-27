#!/usr/bin/env node
// Prueba de extremo a extremo de dist/index.html en Chrome/Chromium headless (sin dependencias:
// habla el protocolo DevTools por WebSocket). Abre la página como file://, igual que un usuario
// que descarga el archivo, y recorre el flujo principal: motor, render, error, catálogo,
// Markdown y editor visual.
//
// Uso: node scripts/navegador.mjs [ruta/al/index.html]
//   CHROME_BIN     ejecutable de Chrome/Chromium (por defecto se busca en el PATH).
//   PDF_IMPRESION  si se define, guarda ahí el PDF de la vista de impresión de un documento Markdown.
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

// 5b. Documento: con «texto», el Markdown se ve entre los diagramas; la vista de impresión deja sólo eso.
await fijarTexto(JSON.stringify("# Título del apunte\n\nUn párrafo con **negrita** y <script>x</script>.\n\n```estructura\n- type: array\n  values: [1, 2]\n```\n\n- uno\n- dos\n"));
await hasta(`${$(".tarjeta .lienzo img")}?.src`);
comprobar("los controles de Markdown se ven", await ev(`getComputedStyle(${$("#c-texto")}.closest('label')).display !== 'none'`));
await ev(`(() => { const c = ${$("#c-texto")}; c.checked = true; c.dispatchEvent(new Event('change')); })()`);
const doc = await hasta(`!${$("#documento")}.hidden && ${$("#documento h1")}?.textContent === 'Título del apunte' && ${$("#documento figure img")} && ${$("#documento")}.innerHTML`);
comprobar("documento con texto y diagrama", !!doc && doc.includes("<strong>negrita</strong>") && doc.includes("<li>dos</li>"));
comprobar("el HTML del texto se escapa", !!doc && !doc.includes("<script>") && doc.includes("&lt;script&gt;"));
await ev(`${$("#b-impresion")}.click()`);
const imp = await hasta(`document.body.classList.contains('impresion') && getComputedStyle(${$(".editor")}).display === 'none' && getComputedStyle(${$("#impresion-barra")}).display === 'flex'`);
comprobar("vista de impresión sin el editor", !!imp);
await cmd("Emulation.setEmulatedMedia", { media: "print" });
const impreso = await ev(`[getComputedStyle(${$("#impresion-barra")}).display, getComputedStyle(${$("#documento figure")}).breakInside]`);
comprobar("al imprimir sólo queda el documento", impreso[0] === "none" && impreso[1] === "avoid", impreso.join(" · "));
await cmd("Emulation.setEmulatedMedia", { media: "" });
comprobar("el documento terminó de dibujarse", !!(await hasta(`!document.querySelector('#documento figure.cargando') && !!${$("#documento figure img")}`)));
if (process.env.PDF_IMPRESION) {
  // Para revisar a ojo cómo sale el PDF: PDF_IMPRESION=salida.pdf npm run test:navegador
  const { data } = await cmd("Page.printToPDF", { printBackground: true }).then((r) => r.result);
  (await import("node:fs")).writeFileSync(process.env.PDF_IMPRESION, Buffer.from(data, "base64"));
}
await ev(`${$("#i-salir")}.click()`);
comprobar("Salir vuelve al editor", await hasta(`!document.body.classList.contains('impresion')`));
await ev(`(() => { const c = ${$("#c-texto")}; c.checked = false; c.dispatchEvent(new Event('change')); })()`);

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

// 7. Asistente del editor de código: autocompletado, ejemplo al elegir el tipo y líneas.
await ev(`${$("#t-codigo")}.click()`);
const MODS = { alt: 1, ctrl: 2, shift: 8 };
const CODIGOS = { Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27, Tab: 9, "/": 191 };
async function tecla(key, ...mods) {
  const modifiers = mods.reduce((a, m) => a | MODS[m], 0);
  const code = key === "/" ? "Slash" : key;
  const base = { key, code, windowsVirtualKeyCode: CODIGOS[key], modifiers };
  await cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await esperar(60);
}
async function escribir(texto) {
  for (const ch of texto) { await cmd("Input.insertText", { text: ch }); await esperar(25); }
  await esperar(80);
}
/** Tecla con texto: pasa por keydown (como un usuario) y, si nadie la cancela, inserta el carácter. */
async function teclear(texto) {
  for (const ch of texto) {
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await esperar(25);
  }
  await esperar(80);
}
const cursorAlFinal = () => ev(`(() => { const x = ${$("#texto")}; x.focus(); x.setSelectionRange(x.value.length, x.value.length); })()`);
const opciones = () => ev(`[...document.querySelectorAll('#autocompletar:not([hidden]) li .ac-et')].map(e => e.textContent)`);
await fijarTexto(JSON.stringify(""));
await cursorAlFinal();
await escribir("- t");
const op1 = await opciones();
comprobar("sugiere «type» en un bloque nuevo", op1[0] === "type", op1.slice(0, 3).join(", "));
await tecla("Enter");
await escribir("bod");
const op2 = await opciones();
comprobar("sugiere tipos al escribir el valor", op2[0] === "bode", op2.slice(0, 3).join(", "));
await tecla("Enter");
const conEjemplo = await ev(`${$("#texto")}.value`);
comprobar("elegir el tipo completa los campos de ejemplo", /^- type: bode\n  \w+:/.test(conEjemplo) && conEjemplo.split("\n").length > 3, JSON.stringify(conEjemplo.slice(0, 40)));
const renderBode = await hasta(`${tarjetasOk} === 1 && ${$(".tarjeta .tipo")}.textContent`);
comprobar("el bloque completado renderiza", renderBode === "bode", renderBode);
await ev(`(() => { const x = ${$("#texto")}; const p = x.value.indexOf("\\n") + 3; x.setSelectionRange(p, p); x.dispatchEvent(new Event("keyup")); })()`);
const ayuda = await hasta(`${$("#e-campo")}.textContent.startsWith("bode ›") && ${$("#e-campo")}.textContent`);
comprobar("ayuda del campo bajo el cursor", !!ayuda, ayuda);
await fijarTexto(JSON.stringify("- type: bode\n  sistem: 1"));
await cursorAlFinal();
await ev(`${$("#texto")}.dispatchEvent(new Event("keyup"))`);
const aviso = await hasta(`${$("#e-campo")}.classList.contains("aviso") && ${$("#e-campo")}.textContent`);
comprobar("avisa de un campo desconocido", /desconocido/.test(aviso || ""), aviso);

await fijarTexto(JSON.stringify("a\nb\nc"));
await cursorAlFinal();
await tecla("ArrowUp", "alt");
comprobar("Alt+↑ mueve la línea", (await ev(`${$("#texto")}.value`)) === "a\nc\nb");
await tecla("ArrowDown", "alt", "shift");
comprobar("Shift+Alt+↓ duplica la línea", (await ev(`${$("#texto")}.value`)) === "a\nc\nc\nb");
await tecla("/", "ctrl");
const comentado = await ev(`${$("#texto")}.value`);
comprobar("Ctrl+/ comenta la línea", comentado === "a\nc\n# c\nb", JSON.stringify(comentado));
await fijarTexto(JSON.stringify("- type: array\n  values: "));
await cursorAlFinal();
await teclear("[");
comprobar("cierra corchetes", (await ev(`${$("#texto")}.value`)).endsWith("values: []"));
await teclear("1, 2]");
const sinDoble = await ev(`${$("#texto")}.value`);
comprobar("saltea el cierre ya escrito", sinDoble.endsWith("values: [1, 2]"), JSON.stringify(sinDoble.slice(-16)));
await tecla("Enter");
await escribir("ti");
await tecla("Enter");
const enter = await ev(`${$("#texto")}.value`);
comprobar("Enter mantiene la sangría y completa la clave", enter.endsWith("\n  title: "), JSON.stringify(enter.slice(-14)));

// 7b. PlantUML (motor TeaVM, cargado con el primer bloque) junto a un fence ```dibu: error en su línea,
//     documento .puml con varios diagramas, theme oscuro y apilado junto a los de dibu.
await ev(`${$("#t-codigo")}.click()`);
await fijarTexto(JSON.stringify("# Apunte\n\n```plantuml\nAlicia -> Roberto : hola\n```\n\n```dibu\n- type: array\n  values: [1, 2]\n```\n"));
const listas = `!document.querySelector('.tarjeta.viejo, .lienzo.cargando')`; // sin el SVG anterior de relleno
const puml = await hasta(`${tarjetasOk} === 2 && ${listas} && [...document.querySelectorAll('.tarjeta')].map(t => t.querySelector('.tipo').textContent + '|' + t.querySelector('.ident').textContent).join(' ')`, 60000);
comprobar("fence plantuml dibujado con TeaVM", /^plantuml\|plantuml-[0-9a-f]{12}\.svg array\|estructura-/.test(puml || ""), puml || "");
const svgPuml = await ev(`${$(".tarjeta .lienzo img")}._svg || ""`);
comprobar("el SVG de PlantUML trae el texto del diagrama", svgPuml.startsWith("<svg") && svgPuml.includes("Roberto"), svgPuml.slice(0, 200));
comprobar("Editar no aplica a PlantUML", await ev(`${$('.tarjeta button[data-acc="editar"]')}.disabled`));
const apilado = await ev(`estado.motor.llamar("dibu_stack", JSON.stringify(estado.tarjetas.filter(d => d.svg).map(d => d.svg))).then(r => r.ok && !r.resultado.error && r.resultado.svg.includes("Roberto") || JSON.stringify(r).slice(0, 300))`);
comprobar("Exportar todo apila PlantUML y dibu", apilado === true, String(apilado));
await fijarTexto(JSON.stringify("```puml\n// [ancho, 60%]\nA -> B\nesto no es plantuml ((\n```\n"));
const errPuml = await hasta(`${$(".tarjeta.error .msg-error")}?.textContent`, 30000);
comprobar("error de PlantUML en su línea", /^Línea 4: .*Syntax Error/.test(errPuml || ""), errPuml || "");
await fijarTexto(JSON.stringify("@startuml\nA -> B\n@enduml\n\n@startmindmap\n* raíz\n** hoja\n@endmindmap\n"));
const docPuml = await hasta(`${tarjetasOk} === 2 && ${listas} && ${$("#v-resumen")}.textContent`, 30000);
comprobar("documento PlantUML: un diagrama por @start…", /PlantUML/.test(docPuml || ""), docPuml || "");
const claro = await ev(`${$(".tarjeta .lienzo img")}._svg`);
await ev(`${$("#b-oscuro")}.click()`);
const oscuroPuml = await hasta(`${tarjetasOk} === 2 && ${listas} && ${$(".tarjeta .lienzo img")}._svg !== ${JSON.stringify(claro)}`, 30000);
comprobar("Oscuro usa el modo oscuro de PlantUML", !!oscuroPuml);
await ev(`${$("#b-tinta")}.click()`);

// 8. Theme oscuro desde la barra.
await fijarTexto(JSON.stringify("- type: array\n  values: [1, 2]\n"));
await ev(`${$("#b-oscuro")}.click()`);
const oscuro = await hasta(`(${$(".tarjeta .lienzo img")}._svg || "").includes('fill="#0f172a"')`);
comprobar("botón Oscuro aplica el theme dark", !!oscuro);
await ev(`${$("#b-tinta")}.click()`);

comprobar("sin excepciones de JavaScript", excepciones.length === 0, excepciones.slice(0, 3).join(" | "));
console.log(fallas ? `✗ ${fallas} comprobación(es) fallida(s)` : "✓ prueba de navegador completa");
terminar(fallas ? 1 : 0);
