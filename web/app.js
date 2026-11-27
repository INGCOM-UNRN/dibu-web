// dibu-web: editor con vista previa sincronizada para los diagramas de `dibu`.
// SPA sin servidor: el motor Rust corre como WebAssembly dentro de un Web Worker, y los bloques
// PlantUML los dibuja PlantUML compilado a JavaScript con TeaVM (plantuml.js).
"use strict";

const DATOS = window.DIBU; // { wasm (base64), worker (fuente), catalogo (YAML), markdown (MD) }
const $ = (s) => document.querySelector(s);
const CLAVE_TEXTO = "dibu-web:texto";
const CLAVE_PREFS = "dibu-web:prefs";
// Fences de diagramas en Markdown: los de dibu (dibu, y los heredados estructura y statics) y los de
// PlantUML (plantuml, puml).
const RE_VALLA = /^(`{3,}|~{3,})[ \t]*(dibu|estructura|statics|plantuml|puml)[ \t]*$/;
const RE_PUML = /^(plantuml|puml)$/i;
/** Comienzo de un diagrama PlantUML (`@startuml`, `@startmindmap`, …). */
const RE_START = /^\s*@start(\w+)/;
const TIEMPO_MAX_MS = 8000;

const ui = {
  texto: $("#texto"),
  resaltado: $("#resaltado"),
  numeros: $("#numeros"),
  tarjetas: $("#tarjetas"),
  modo: $("#s-modo"),
  ejemplo: $("#s-ejemplo"),
  seguir: $("#c-seguir"),
  zoom: $("#z-valor"),
  documento: $("#documento"),
};

const prefs = Object.assign(
  { paleta: "tinta", modo: "auto", zoom: 0, seguir: true, izq: 46, texto: false, ajuste: false, fuentes: { sans: "", mono: "", titulos: "" } },
  leerJSON(localStorage.getItem(CLAVE_PREFS)) || {}
);

const estado = {
  motor: null,
  tipos: [],
  trozos: [],      // bloques de texto detectados en el editor
  tarjetas: [],    // resultados planos (uno por diagrama)
  version: 0,
  activo: -1,      // índice del trozo bajo el cursor
  cache: new Map(),
  fuentes: { sans: null, mono: null, titulos: null }, // tipografías de Google Fonts ya descargadas
  nombreArchivo: "diagramas.yaml",
};

function leerJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function guardarPrefs() { localStorage.setItem(CLAVE_PREFS, JSON.stringify(prefs)); }
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

let temporizadorAviso;
function avisar(msg) {
  const el = $("#aviso");
  el.textContent = msg;
  el.classList.add("ver");
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => el.classList.remove("ver"), 2200);
}

// ======================================================================
// Motor (WebAssembly en un Worker, con corte por tiempo)
// ======================================================================
class Motor {
  constructor(modulo, fuente) {
    this.modulo = modulo;
    this.url = URL.createObjectURL(new Blob([fuente], { type: "text/javascript" }));
    this.seq = 0;
    this.cola = Promise.resolve();
    this.iniciar();
  }
  iniciar() {
    if (this.worker) this.worker.terminate();
    this.pendientes = new Map();
    this.worker = new Worker(this.url);
    this.worker.onmessage = (e) => {
      const p = this.pendientes.get(e.data.id);
      if (!p) return;
      this.pendientes.delete(e.data.id);
      clearTimeout(p.t);
      p.resolve(e.data);
    };
    this.listo = this.enviar({ module: this.modulo }, 20000);
  }
  enviar(msg, limite) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendientes.delete(id);
        resolve({ ok: false, error: `tiempo agotado (${limite / 1000} s): el diagrama es demasiado costoso de calcular` });
        this.iniciar(); // el worker quedó colgado: lo reemplazamos
      }, limite);
      this.pendientes.set(id, { resolve, t });
      this.worker.postMessage({ id, ...msg });
    });
  }
  /** Llamadas serializadas: el worker procesa de a una. */
  llamar(op, texto, bandera) {
    const r = this.cola.then(async () => {
      await this.listo;
      return this.enviar({ op, texto, bandera }, TIEMPO_MAX_MS);
    });
    this.cola = r.catch(() => {});
    return r;
  }
}

function base64ABytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ======================================================================
// Troceo del texto en bloques (con su rango de líneas)
// ======================================================================
function modoEfectivo(texto) {
  if (prefs.modo !== "auto") return prefs.modo;
  const lineas = texto.split("\n");
  if (lineas.some((l) => RE_VALLA.test(l))) return "md";
  // Un archivo PlantUML (.puml): la primera línea con contenido es un `@start…`.
  const primera = lineas.find((l) => l.trim() && !/^\s*'/.test(l));
  return primera && RE_START.test(primera) ? "puml" : "yaml";
}

/** PlantUML: un trozo por cada `@start…`/`@end…`; sin ninguno cerrado, el texto entero. */
function troceoPuml(lineas) {
  const trozos = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = RE_START.exec(lineas[i]);
    if (!m) continue;
    const fin = new RegExp(`^\\s*@end${m[1]}\\b`);
    let j = i + 1;
    while (j < lineas.length && !fin.test(lineas[j])) j++;
    const hasta = Math.min(j + 1, lineas.length);
    trozos.push({ ini: i, fin: hasta, cuerpoIni: i, rIni: i, rFin: hasta, lenguaje: "plantuml", texto: lineas.slice(i, hasta).join("\n") });
    i = j;
  }
  return trozos;
}

/** Devuelve [{ini, fin, texto, sinCerrar?}] con `ini`/`fin` como líneas (fin exclusivo). */
function trocear(texto, modo) {
  const lineas = texto.split("\n");
  const trozos = [];
  if (modo === "puml") return troceoPuml(lineas);
  if (modo === "md") {
    for (let i = 0; i < lineas.length; i++) {
      const m = RE_VALLA.exec(lineas[i]);
      if (!m) continue;
      const valla = m[1];
      let j = i + 1;
      while (j < lineas.length && lineas[j].trimEnd() !== valla) j++;
      trozos.push({
        ini: i, fin: Math.min(j + 1, lineas.length), cuerpoIni: i + 1, rIni: i + 1, rFin: j,
        texto: lineas.slice(i + 1, j).join("\n"),
        sinCerrar: j >= lineas.length,
        lenguaje: RE_PUML.test(m[2]) ? "plantuml" : "dibu",
      });
      i = j;
    }
    return trozos;
  }
  const significativa = (l) => l.trim() !== "" && !l.trimStart().startsWith("#");
  const primera = lineas.findIndex(significativa);
  if (primera < 0) return trozos;
  const inicios = [];
  lineas.forEach((l, i) => { if (/^-(\s|$)/.test(l)) inicios.push(i); });
  if (inicios.length && inicios[0] === primera) {
    inicios.forEach((ini, k) => {
      let fin = k + 1 < inicios.length ? inicios[k + 1] : lineas.length;
      while (fin > ini + 1 && !significativa(lineas[fin - 1])) fin--;
      trozos.push({ ini, fin, cuerpoIni: ini, rIni: ini, rFin: fin, texto: lineas.slice(ini, fin).join("\n") });
    });
  } else {
    // Bloque único, JSON o {blocks: [...]}: se procesa entero.
    let fin = lineas.length;
    while (fin > primera + 1 && !significativa(lineas[fin - 1])) fin--;
    trozos.push({ ini: primera, fin, cuerpoIni: 0, rIni: primera, rFin: fin, texto, entero: true });
  }
  return trozos;
}

/** Traduce "at line N column M" de serde_yaml a líneas del documento completo. */
function ajustarError(msg, desplazamiento) {
  let linea = null;
  const texto = msg.replace(/at line (\d+) column (\d+)/g, (_, l, c) => {
    const real = Number(l) + desplazamiento;
    if (linea === null) linea = real - 1;
    return `en la línea ${real}, columna ${c}`;
  });
  return { texto, linea };
}

// ======================================================================
// Renderizado
// ======================================================================
/** Theme de dibu para la paleta elegida en la barra (los bloques pueden pisarlo con `theme:`). */
const THEMES = { tinta: "ink", color: "color", contraste: "high-contrast", oscuro: "dark" };
// Las familias por defecto de dibu: quedan de respaldo detrás de las de Google Fonts.
const SANS_DIBU = "DejaVu Sans, Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const MONO_DIBU = "DejaVu Sans Mono, Menlo, Consolas, Courier New, monospace";
function sobre(texto) {
  const base = THEMES[prefs.paleta] || "ink";
  const { sans, mono } = estado.fuentes;
  if (!sans && !mono) return JSON.stringify({ text: texto, theme: base });
  const typography = {};
  if (sans) typography.sans = `'${sans.familia}', ${SANS_DIBU}`;
  if (mono) typography.mono = `'${mono.familia}', ${MONO_DIBU}`;
  return JSON.stringify({ text: texto, theme: { extends: base, typography } });
}
/** Las tipografías en uso, para la clave de la caché. */
function claveFuentes() {
  return [estado.fuentes.sans?.familia || "", estado.fuentes.mono?.familia || ""].join("/");
}

/** Un bloque PlantUML, con el motor TeaVM: una tarjeta, con el error en su línea si lo hay. */
async function calcularPlantUML(tr) {
  try {
    const r = await PUML.dibujar(tr.texto, prefs.paleta === "oscuro");
    if (r.error) return { items: [{ error: r.error, linea: tr.cuerpoIni + r.linea, tipo: "plantuml" }], guardar: true };
    return { items: [{ svg: r.svg, tipo: "plantuml", nombre: PUML.nombre(tr.texto) }], guardar: true };
  } catch (e) {
    // Un fallo del motor (o que el build no lo traiga) no se guarda en caché: se reintenta.
    return { items: [{ error: String(e.message || e), linea: tr.ini, tipo: "plantuml" }], guardar: false };
  }
}

async function calcularTrozo(tr, modo) {
  if (tr.sinCerrar) {
    return { items: [{ error: "el fence no está cerrado", linea: tr.ini }], guardar: false };
  }
  if (tr.lenguaje === "plantuml") return calcularPlantUML(tr);
  if (modo === "md") {
    const r = await estado.motor.llamar("dibu_render_md_theme", sobre(tr.texto));
    if (!r.ok) return { items: [{ error: r.error, linea: tr.ini }], guardar: false };
    const x = r.resultado;
    const e = x.error ? ajustarError(x.error, tr.cuerpoIni) : null;
    return {
      items: [{ svg: x.svg, tipo: x.types.join(" + ") || "?", titulo: (x.titles || []).filter(Boolean).join(" · "), subtipos: x.types, subtitulos: x.titles, nombre: x.name, error: e && e.texto, linea: e && e.linea }],
      guardar: true,
    };
  }
  const r = await estado.motor.llamar("dibu_render_theme", sobre(tr.texto));
  if (!r.ok) return { items: [{ error: r.error, linea: tr.ini }], guardar: false };
  const x = r.resultado;
  if (x.error) {
    const e = ajustarError(x.error, tr.cuerpoIni);
    return { items: [{ error: e.texto, linea: e.linea ?? tr.ini, tipo: tipoDeTexto(tr.texto) }], guardar: true };
  }
  if (!x.blocks.length) return { items: [{ error: "no hay bloques", linea: tr.ini }], guardar: true };
  return {
    items: x.blocks.map((b) => ({ svg: b.svg, tipo: b.type || "?", id: b.id, titulo: b.title, error: b.error, linea: b.error ? tr.ini : null })),
    guardar: true,
  };
}

function tipoDeTexto(t, tr) {
  if (tr && tr.lenguaje === "plantuml") return "plantuml";
  const m = /^[ \t-]*type:\s*["']?([\w-]+)/m.exec(t);
  return m ? m[1] : "?";
}

let temporizadorRender;
function programarRender(inmediato) {
  clearTimeout(temporizadorRender);
  temporizadorRender = setTimeout(renderizar, inmediato ? 0 : 220);
}

async function renderizar() {
  if (!estado.motor) return;
  const v = ++estado.version;
  const texto = ui.texto.value;
  const modo = modoEfectivo(texto);
  const trozos = trocear(texto, modo);
  const cambioModo = estado.modo !== modo;
  estado.trozos = trozos;
  estado.modo = modo;
  if (cambioModo) resaltarTodo();
  ui.modo.title = `Interpretando como ${NOMBRE_MODO[modo]}`;
  document.body.classList.toggle("modo-md", modo === "md");
  if (modo !== "md" && document.body.classList.contains("impresion")) vistaImpresion(false);

  // Primera pasada: lo que ya está en caché se muestra al instante.
  const pendientes = [];
  trozos.forEach((tr, i) => {
    tr.clave = `${modo}|${prefs.paleta}|${claveFuentes()}|${tr.sinCerrar ? "!" : ""}${tr.texto}`;
    tr.res = estado.cache.get(tr.clave) || null;
    if (!tr.res) pendientes.push(i);
  });
  pintar();
  if (V.abierto) { estado.activo = V.sel.trozo; resaltarTodo(); sincronizarVisual(); }
  else actualizarCursor();

  const t0 = performance.now();
  for (const i of pendientes) {
    if (v !== estado.version) return; // el texto cambió: abandonamos esta pasada
    const tr = trozos[i];
    const res = await calcularTrozo(tr, modo);
    // Las letras de Google Fonts van dentro de cada SVG: el <img> no puede pedirlas a la red.
    if (tr.lenguaje !== "plantuml" && (estado.fuentes.sans || estado.fuentes.mono)) {
      const fs = [estado.fuentes.sans, estado.fuentes.mono];
      for (const it of res.items) if (it.svg) it.svg = FUENTES.incrustar(it.svg, fs);
    }
    if (res.guardar) {
      estado.cache.set(tr.clave, res);
      if (estado.cache.size > 400) estado.cache.delete(estado.cache.keys().next().value);
    }
    if (v !== estado.version) return;
    tr.res = res;
    pintar();
  }
  if (pendientes.length) $("#e-tiempo").textContent = `render ${Math.round(performance.now() - t0)} ms`;
  marcarErroresEnEditor();
  if (V.abierto) actualizarNavegador();
}

// ---------- tarjetas de la vista previa ----------
const ultimoBueno = new Map(); // índice de tarjeta -> último SVG válido (para no parpadear)

function pintar() {
  const lista = [];
  estado.trozos.forEach((tr, ti) => {
    if (!tr.res) {
      lista.push({ trozo: ti, cargando: true, tipo: tipoDeTexto(tr.texto, tr) });
      return;
    }
    tr.res.items.forEach((it, k) => lista.push({ ...it, trozo: ti, sub: k, multi: tr.res.items.length > 1 }));
  });
  estado.tarjetas = lista;
  pintarDocumento();

  const cont = ui.tarjetas;
  if (!lista.length) {
    cont.innerHTML = `<div class="vacio">No hay diagramas todavía.<br>Escribí un bloque como <code>- type: array</code> o insertá un ejemplo desde el menú <b>Insertar</b>.</div>`;
    resumen();
    return;
  }
  const vacio = cont.querySelector(".vacio");
  if (vacio) vacio.remove();
  while (cont.children.length > lista.length) cont.lastElementChild.remove();
  while (cont.children.length < lista.length) cont.appendChild(crearTarjeta());
  lista.forEach((d, i) => actualizarTarjeta(cont.children[i], d, i));
  resaltarActivo(false);
  resumen();
}

// ---------- vista de documento (Markdown con su texto) ----------
/** En Markdown con «texto», la vista previa es el documento: el texto entre los diagramas. */
function enDocumento() {
  return estado.modo === "md" && prefs.texto;
}

const urlsDocumento = new Map(); // svg -> object URL, reutilizadas entre repintadas
function urlDe(svg) {
  let u = urlsDocumento.get(svg);
  if (!u) {
    u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    urlsDocumento.set(svg, u);
    if (urlsDocumento.size > 300) {
      const [viejo, url] = urlsDocumento.entries().next().value;
      URL.revokeObjectURL(url);
      urlsDocumento.delete(viejo);
    }
  }
  return u;
}

function pintarDocumento() {
  const doc = enDocumento();
  ui.tarjetas.hidden = doc;
  ui.documento.hidden = !doc;
  if (!doc) return;
  const lineas = ui.texto.value.split("\n");
  const partes = [];
  let desde = 0;
  const prosa = (a, b) => {
    const md = lineas.slice(a, b).join("\n");
    if (md.trim()) partes.push(`<section class="prosa" data-linea="${a}">${MD.html(md)}</section>`);
  };
  estado.trozos.forEach((tr, ti) => {
    prosa(desde, tr.ini);
    desde = tr.fin;
    if (!tr.res) {
      partes.push(`<figure class="diagrama cargando" data-trozo="${ti}">…</figure>`);
      return;
    }
    tr.res.items.forEach((it, k) => {
      const svg = it.svg || (it.error ? null : ultimoBueno.get(ti));
      const figura = svg
        ? `<img alt="${esc(`Diagrama ${it.tipo || ""}`)}" src="${urlDe(svg)}" data-ancho="${anchoSVG(svg)}">`
        : "";
      const error = it.error ? `<pre class="msg-error">${esc(/en la línea \d+/.test(it.error) ? it.error : `Línea ${(it.linea ?? tr.ini) + 1}: ${it.error}`)}</pre>` : "";
      partes.push(`<figure class="diagrama${it.error ? " error" : ""}" data-trozo="${ti}" data-sub="${k}">${figura}${error}</figure>`);
    });
  });
  prosa(desde, lineas.length);
  const html = partes.join("\n") || `<div class="vacio">El documento está vacío.</div>`;
  if (ui.documento._html !== html) {
    ui.documento._html = html;
    ui.documento.innerHTML = html;
  }
}

function crearTarjeta() {
  const el = document.createElement("article");
  el.className = "tarjeta";
  el.innerHTML = `<header><span class="num"></span><span class="tipo"></span><span class="ident"></span><span class="flex"></span>
    <button data-acc="editar" title="Editar este diagrama con el editor visual">Editar</button>
    <button data-acc="copiar" title="Copiar el código SVG">Copiar</button>
    <button data-acc="svg" title="Descargar SVG">SVG</button>
    <button data-acc="png" title="Descargar PNG (2×)">PNG</button></header>
    <div class="lienzo"><img alt=""></div><pre class="msg-error" hidden></pre>`;
  el.addEventListener("click", (e) => {
    const i = [...ui.tarjetas.children].indexOf(el);
    const d = estado.tarjetas[i];
    if (!d) return;
    const acc = e.target.closest("button")?.dataset.acc;
    if (acc === "editar") { if (!V.abierto) abrirVisual(true); seleccionarVisual(d.trozo, d.sub || 0); return; }
    if (acc) { accionTarjeta(acc, d, i); return; }
    if (V.abierto) seleccionarVisual(d.trozo, d.sub || 0);
    else irAlBloque(d.trozo, d.linea);
  });
  return el;
}

function anchoSVG(svg) {
  const m = /<svg[^>]*\swidth="(\d+)"/.exec(svg);
  return m ? Number(m[1]) : 0;
}

function actualizarTarjeta(el, d, i) {
  const firma = `${d.trozo}|${d.cargando ? "…" : ""}|${d.svg ? d.svg.length + d.svg.slice(-64) + d.svg.slice(0, 400) : ""}|${d.error || ""}|${d.tipo}|${d.id || d.nombre || ""}`;
  el.dataset.trozo = d.trozo;
  el.dataset.sub = d.sub || 0;
  if (el._firma === firma) return;
  el._firma = firma;
  el.querySelector(".num").textContent = `#${i + 1}`;
  el.querySelector(".tipo").textContent = d.tipo || "?";
  const ident = el.querySelector(".ident");
  ident.textContent = d.nombre || d.id || "";
  ident.title = ident.textContent;
  const err = el.querySelector(".msg-error");
  const lienzo = el.querySelector(".lienzo");
  const img = lienzo.querySelector("img");
  el.classList.toggle("error", !!d.error);
  el.classList.toggle("viejo", false);
  el.querySelectorAll("header button").forEach((b) => (b.disabled = b.dataset.acc !== "editar" && !d.svg));
  err.hidden = !d.error;
  err.textContent = !d.error ? "" : /en la línea \d+/.test(d.error) ? d.error
    : `Línea ${(d.linea ?? estado.trozos[d.trozo].ini) + 1}: ${d.error}`;

  const svg = d.svg || (d.cargando || d.error ? ultimoBueno.get(i) : null);
  if (d.svg) ultimoBueno.set(i, d.svg);
  if (svg) {
    lienzo.hidden = false;
    lienzo.classList.remove("cargando");
    if (img._svg !== svg) {
      if (img._url) URL.revokeObjectURL(img._url);
      img._url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      img._svg = svg;
      img.src = img._url;
      img.dataset.ancho = anchoSVG(svg);
    }
    img.alt = `Diagrama ${d.tipo}`;
    aplicarZoomImg(img);
    el.classList.toggle("viejo", !d.svg);
  } else if (d.cargando) {
    lienzo.hidden = false;
    lienzo.classList.add("cargando");
    img.removeAttribute("src");
    img._svg = null;
  } else {
    lienzo.hidden = true;
  }
}

const NOMBRE_MODO = { md: "Markdown", yaml: "YAML / JSON", puml: "PlantUML" };

function resumen() {
  const n = estado.tarjetas.filter((d) => d.svg).length;
  const errores = estado.tarjetas.filter((d) => d.error).length;
  const eb = $("#e-bloques");
  eb.textContent = `${estado.trozos.length} bloque${estado.trozos.length === 1 ? "" : "s"} · ${n} diagrama${n === 1 ? "" : "s"}` +
    (errores ? ` · ${errores} con error` : "");
  eb.classList.toggle("err", errores > 0);
  $("#v-resumen").textContent = estado.modo === "md" ? "Markdown · fences dibu/estructura/plantuml"
    : estado.modo === "puml" ? "PlantUML · @start…/@end…" : "YAML / JSON";
}

// ---------- acciones por tarjeta ----------
function nombreDescarga(d, i, ext) {
  if (d.nombre) return d.nombre.replace(/\.svg$/, "." + ext);
  const base = (d.id || `bloque_${i + 1}`).replace(/[^\w.\-]+/g, "_");
  return `${base}.${ext}`;
}

function descargar(nombre, contenido, tipo) {
  const blob = contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const t = document.createElement("textarea");
    t.value = texto;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

function svgAPng(svg, escala = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(img.naturalWidth * escala);
      c.height = Math.ceil(img.naturalHeight * escala);
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("no se pudo generar el PNG"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG inválido")); };
    img.src = url;
  });
}

async function accionTarjeta(acc, d, i) {
  if (!d.svg) return;
  if (acc === "copiar") { await copiar(d.svg); avisar("SVG copiado al portapapeles"); }
  if (acc === "svg") descargar(nombreDescarga(d, i, "svg"), d.svg, "image/svg+xml");
  if (acc === "png") {
    try { descargar(nombreDescarga(d, i, "png"), await svgAPng(d.svg)); }
    catch (e) { avisar(e.message); }
  }
}

async function exportarTodo() {
  const svgs = estado.tarjetas.filter((d) => d.svg).map((d) => d.svg);
  if (!svgs.length) { avisar("No hay diagramas para exportar"); return; }
  const r = await estado.motor.llamar("dibu_stack", JSON.stringify(svgs));
  if (!r.ok || r.resultado.error) { avisar("Error al apilar: " + (r.error || r.resultado.error)); return; }
  descargar(estado.nombreArchivo.replace(/\.[^.]+$/, "") + ".svg", r.resultado.svg, "image/svg+xml");
}

// ======================================================================
// Zoom
// ======================================================================
const NIVELES = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function aplicarZoomImg(img) {
  const w = Number(img.dataset.ancho) || 0;
  img.style.width = prefs.zoom && w ? `${Math.round(w * prefs.zoom)}px` : "";
}
function aplicarZoom() {
  document.body.classList.toggle("ajustar", !prefs.zoom);
  ui.zoom.textContent = prefs.zoom ? `${Math.round(prefs.zoom * 100)}%` : "Ajustar";
  ui.tarjetas.querySelectorAll(".lienzo img").forEach(aplicarZoomImg);
  guardarPrefs();
}
function cambiarZoom(dir) {
  const actual = prefs.zoom || 1;
  let i = NIVELES.findIndex((z) => z >= actual - 1e-6);
  if (i < 0) i = NIVELES.length - 1;
  if (dir > 0) i = NIVELES[i] > actual + 1e-6 ? i : Math.min(i + 1, NIVELES.length - 1);
  else i = Math.max(i - 1, 0);
  prefs.zoom = NIVELES[i];
  aplicarZoom();
}

// ======================================================================
// Resaltado de sintaxis (YAML/JSON + Markdown liviano)
// ======================================================================
function resaltarYaml(linea) {
  let out = "";
  let i = 0;
  const n = linea.length;
  const m = /^(\s*)((?:-\s+)*)/.exec(linea);
  out += m[1];
  if (m[2]) out += `<span class="p">${m[2]}</span>`;
  i = m[0].length;
  while (i < n) {
    const ch = linea[i];
    if (ch === "#" && (i === 0 || /\s/.test(linea[i - 1]))) {
      out += `<span class="c">${esc(linea.slice(i))}</span>`;
      break;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && linea[j] !== ch) j += linea[j] === "\\" && ch === '"' ? 2 : 1;
      const tok = linea.slice(i, Math.min(j + 1, n));
      const resto = linea.slice(j + 1);
      out += `<span class="${/^\s*:(\s|$)/.test(resto) ? "k" : "s"}">${esc(tok)}</span>`;
      i = j + 1;
      continue;
    }
    if ("[]{},".includes(ch) || (ch === ":" && (i + 1 >= n || /\s/.test(linea[i + 1])))) {
      out += `<span class="p">${ch}</span>`;
      i++;
      continue;
    }
    if (/\s/.test(ch)) { out += ch; i++; continue; }
    let j = i;
    while (j < n && !/[\s[\]{},#]/.test(linea[j]) && !(linea[j] === ":" && (j + 1 >= n || /[\s,}\]]/.test(linea[j + 1])))) j++;
    if (j === i) j = i + 1;
    const tok = linea.slice(i, j);
    let cls = "";
    if (linea[j] === ":" && (j + 1 >= n || /\s/.test(linea[j + 1]))) cls = "k";
    else if (/^[-+]?(\d[\d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(tok)) cls = "n";
    else if (/^(true|false|null|~|yes|no)$/i.test(tok)) cls = "b";
    out += cls ? `<span class="${cls}">${esc(tok)}</span>` : esc(tok);
    i = j;
  }
  return out;
}

/** PlantUML: comentarios ('), directivas (@start…, !theme, skinparam) y el resto como texto. */
function resaltarPuml(linea) {
  if (/^\s*'/.test(linea)) return `<span class="c">${esc(linea)}</span>`;
  if (/^\s*\/\/\s*\[/.test(linea)) return `<span class="c">${esc(linea)}</span>`;
  if (/^\s*(@\w+|!\w+|skinparam\b|title\b)/.test(linea)) return `<span class="k">${esc(linea)}</span>`;
  return esc(linea);
}

function resaltarTodo() {
  const lineas = ui.texto.value.split("\n");
  const md = estado.modo === "md";
  const act = estado.trozos[estado.activo];
  const errores = estado.lineasError || new Set();
  let enValla = null;
  let pumlValla = false;
  let html = "";
  let nums = "";
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    let cuerpo;
    if (md) {
      if (enValla === null) {
        const m = RE_VALLA.exec(l);
        if (m) { enValla = m[1]; pumlValla = RE_PUML.test(m[2]); cuerpo = `<span class="v">${esc(l)}</span>`; }
        else if (/^#{1,6}\s/.test(l)) cuerpo = `<span class="h">${esc(l)}</span>`;
        else cuerpo = `<span class="md">${esc(l)}</span>`;
      } else if (l.trimEnd() === enValla) {
        enValla = null;
        cuerpo = `<span class="v">${esc(l)}</span>`;
      } else cuerpo = pumlValla ? resaltarPuml(l) : resaltarYaml(l);
    } else cuerpo = estado.modo === "puml" ? resaltarPuml(l) : resaltarYaml(l);
    const clases = (act && i >= act.ini && i < act.fin ? " act" : "") + (errores.has(i) ? " err" : "");
    html += `<div class="l${clases}">${cuerpo || "​"}</div>`;
    nums += `<div${clases ? ` class="${clases.trim()}"` : ""}>${i + 1}</div>`;
  }
  ui.resaltado.innerHTML = html;
  ui.numeros.innerHTML = nums;
  alturasNumeros();
  sincronizarScrollCapas();
}

// ---------- ajuste de línea ----------
/** Con el ajuste, cada número toma la altura de su línea (que puede ocupar varios renglones). */
function alturasNumeros() {
  const nums = ui.numeros.children;
  if (!prefs.ajuste) {
    if (nums[0] && nums[0].style.height) for (const n of nums) n.style.height = "";
    return;
  }
  const alturas = [...ui.resaltado.children].map((l) => l.offsetHeight);
  alturas.forEach((h, i) => { if (nums[i]) nums[i].style.height = h + "px"; });
}

function aplicarAjuste() {
  document.body.classList.toggle("ajuste", prefs.ajuste);
  ui.texto.wrap = prefs.ajuste ? "soft" : "off";
  $("#c-ajuste").checked = prefs.ajuste;
  AC.anchoCar = 0;
  resaltarTodo();
}

function alternarAjuste(on = !prefs.ajuste) {
  prefs.ajuste = on;
  guardarPrefs();
  aplicarAjuste();
}

/** La altura (en px, desde la primera línea) donde empieza la línea `i` del documento. */
function yLinea(i) {
  const ls = ui.resaltado.children;
  if (!prefs.ajuste || !ls.length) return i * alturaLinea();
  const k = Math.max(0, Math.min(i, ls.length - 1));
  return ls[k].offsetTop - ls[0].offsetTop + (i > k ? (i - k) * alturaLinea() : 0);
}

/** La línea del documento que está a la altura `y` (la inversa de yLinea). */
function lineaEnY(y) {
  const ls = ui.resaltado.children;
  if (!prefs.ajuste || !ls.length) return Math.floor(y / alturaLinea());
  const base = ls[0].offsetTop;
  let a = 0, b = ls.length - 1;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (ls[m].offsetTop - base <= y) a = m; else b = m - 1;
  }
  return a;
}

function marcarErroresEnEditor() {
  const s = new Set();
  for (const d of estado.tarjetas) if (d.error && d.linea != null) s.add(d.linea);
  const antes = [...(estado.lineasError || [])].join();
  estado.lineasError = s;
  if ([...s].join() !== antes) resaltarTodo();
}

function sincronizarScrollCapas() {
  ui.resaltado.scrollTop = ui.texto.scrollTop;
  ui.resaltado.scrollLeft = ui.texto.scrollLeft;
  ui.numeros.style.transform = `translateY(${-ui.texto.scrollTop}px)`;
}

// ======================================================================
// Sincronización editor ↔ vista previa
// ======================================================================
function alturaLinea() {
  return parseFloat(getComputedStyle(ui.texto).lineHeight) || 20;
}

function lineaDelCursor() {
  return ui.texto.value.slice(0, ui.texto.selectionStart).split("\n").length - 1;
}

function trozoEnLinea(linea, haciaAdelante) {
  const t = estado.trozos;
  for (let i = 0; i < t.length; i++) {
    if (linea >= t[i].ini && linea < t[i].fin) return i;
    if (haciaAdelante && t[i].ini > linea) return i;
  }
  return haciaAdelante ? t.length - 1 : -1;
}

function actualizarCursor() {
  const linea = lineaDelCursor();
  const col = ui.texto.selectionStart - ui.texto.value.lastIndexOf("\n", ui.texto.selectionStart - 1);
  $("#e-cursor").textContent = `Ln ${linea + 1}, Col ${col}`;
  activar(trozoEnLinea(linea, false), true);
}

function activar(i, desplazar) {
  const cambio = i !== estado.activo;
  estado.activo = i;
  if (cambio) resaltarTodo();
  resaltarActivo(desplazar && cambio && prefs.seguir);
}

function resaltarActivo(desplazar) {
  let primera = null;
  for (const el of ui.tarjetas.children) {
    const on = Number(el.dataset.trozo) === estado.activo && (!V.abierto || estado.modo === "md" || Number(el.dataset.sub) === V.sel.sub);
    el.classList.toggle("act", on);
    if (on && !primera) primera = el;
  }
  if (desplazar && primera) primera.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function irAlBloque(ti, linea) {
  const tr = estado.trozos[ti];
  if (!tr) return;
  const objetivo = linea ?? tr.cuerpoIni ?? tr.ini;
  const lineas = ui.texto.value.split("\n");
  let pos = 0;
  for (let i = 0; i < objetivo && i < lineas.length; i++) pos += lineas[i].length + 1;
  ui.texto.focus({ preventScroll: true });
  ui.texto.setSelectionRange(pos, pos);
  const lh = alturaLinea();
  const arriba = yLinea(tr.ini);
  const vista = ui.texto.clientHeight;
  if (arriba < ui.texto.scrollTop || arriba > ui.texto.scrollTop + vista - 3 * lh) {
    ignorarScroll = true;
    ui.texto.scrollTop = Math.max(0, arriba - vista * 0.2);
  }
  actualizarCursor();
}

let ignorarScroll = false;
let rafScroll = 0;
function alDesplazarEditor() {
  sincronizarScrollCapas();
  if (ignorarScroll) { ignorarScroll = false; return; }
  if (!prefs.seguir || document.activeElement !== ui.texto && !estado.trozos.length) return;
  cancelAnimationFrame(rafScroll);
  rafScroll = requestAnimationFrame(() => {
    const linea = lineaEnY(ui.texto.scrollTop + alturaLinea() * 2);
    const i = trozoEnLinea(linea, true);
    const el = [...ui.tarjetas.children].find((c) => Number(c.dataset.trozo) === i);
    if (el) ui.tarjetas.scrollTo({ top: el.offsetTop - ui.tarjetas.offsetTop - 14, behavior: "smooth" });
  });
}

// ======================================================================
// Edición: tabulación, atajos, archivos
// ======================================================================
function reemplazarSeleccion(ini, fin, texto, selIni, selFin) {
  ui.texto.setSelectionRange(ini, fin);
  // execCommand mantiene el historial de deshacer del navegador.
  if (!document.execCommand("insertText", false, texto)) {
    ui.texto.setRangeText(texto, ini, fin, "end");
    alEditar({ retardo: 0 });
  }
  ui.texto.setSelectionRange(selIni, selFin ?? selIni);
}

function indentar(menos) {
  const t = ui.texto;
  const v = t.value;
  const s = t.selectionStart, e = t.selectionEnd;
  if (s === e && !menos) { reemplazarSeleccion(s, e, "  ", s + 2); return; }
  const ini = v.lastIndexOf("\n", s - 1) + 1;
  const finLinea = v.indexOf("\n", e - (e > s && v[e - 1] === "\n" ? 1 : 0));
  const fin = finLinea < 0 ? v.length : finLinea;
  const lineas = v.slice(ini, fin).split("\n");
  let delta0 = 0, total = 0;
  const nuevas = lineas.map((l, k) => {
    if (menos) {
      const q = l.startsWith("  ") ? 2 : l.startsWith(" ") ? 1 : 0;
      if (k === 0) delta0 = -q;
      total -= q;
      return l.slice(q);
    }
    if (k === 0) delta0 = 2;
    total += 2;
    return "  " + l;
  });
  reemplazarSeleccion(ini, fin, nuevas.join("\n"), Math.max(ini, s + delta0), e + total);
}

function alTeclear(ev) {
  // Autocompletado, Enter inteligente, pares, operaciones de línea: ver asistente.js.
  if (teclaAsistente(ev)) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === "Tab" && !mod && !ev.altKey) { ev.preventDefault(); indentar(ev.shiftKey); }
}

function atajosGlobales(ev) {
  if (ev.key === "Escape" && document.body.classList.contains("impresion")) {
    ev.preventDefault();
    if (!$("#i-panel").hidden) { $("#i-panel").hidden = true; $("#i-pagina").setAttribute("aria-expanded", "false"); $("#i-pagina").focus(); }
    else vistaImpresion(false);
    return;
  }
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === "KeyZ") { ev.preventDefault(); alternarAjuste(); return; }
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod) return;
  const k = ev.key.toLowerCase();
  if (k === "s") { ev.preventDefault(); guardarArchivo(); }
  else if (k === "o") { ev.preventDefault(); $("#archivo").click(); }
  else if (ev.key === "Enter") { ev.preventDefault(); programarRender(true); }
  else if (k === "e") { ev.preventDefault(); abrirVisual(!V.abierto); }
}

let temporizadorGuardado;
function alEditar(op) {
  resaltarTodo();
  if (op && typeof op.retardo === "number") {
    clearTimeout(temporizadorRender);
    temporizadorRender = setTimeout(renderizar, op.retardo);
  } else programarRender(false);
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(() => {
    try { localStorage.setItem(CLAVE_TEXTO, ui.texto.value); } catch { /* cuota llena */ }
  }, 400);
}

function cargarTexto(texto, nombre) {
  texto = texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  ui.texto.value = texto;
  ui.texto.setSelectionRange(0, 0);
  ui.texto.scrollTop = 0;
  if (nombre) estado.nombreArchivo = nombre;
  estado.activo = -1;
  V.sel = { trozo: 0, sub: 0 };
  V.raiz = null;
  V.fuente = null;
  ultimoBueno.clear();
  alEditar();
  programarRender(true);
}

function guardarArchivo() {
  let nombre = estado.nombreArchivo;
  const modo = modoEfectivo(ui.texto.value);
  if (modo === "md" && !/\.(md|markdown)$/i.test(nombre)) nombre = nombre.replace(/\.[^.]+$/, "") + ".md";
  if (modo === "puml" && !/\.(puml|plantuml|pu)$/i.test(nombre)) nombre = nombre.replace(/\.[^.]+$/, "") + ".puml";
  descargar(nombre, ui.texto.value, "text/plain;charset=utf-8");
}

async function abrirArchivo(f) {
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { avisar("El archivo es demasiado grande (máx. 5 MB)"); return; }
  cargarTexto(await f.text(), f.name);
  avisar(`Abierto: ${f.name}`);
}

// ---------- compartir por URL ----------
function bytesABase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlABytes(s) {
  return base64ABytes(s.replace(/-/g, "+").replace(/_/g, "/"));
}
async function flujo(bytes, transformador) {
  const r = new Blob([bytes]).stream().pipeThrough(transformador);
  return new Uint8Array(await new Response(r).arrayBuffer());
}
async function compartir() {
  const bytes = new TextEncoder().encode(ui.texto.value);
  let hash;
  if ("CompressionStream" in window) hash = "z=" + bytesABase64Url(await flujo(bytes, new CompressionStream("deflate-raw")));
  else hash = "t=" + bytesABase64Url(bytes);
  const url = location.href.split("#")[0] + "#" + hash;
  history.replaceState(null, "", "#" + hash);
  await copiar(url);
  avisar(url.length > 8000 ? "Enlace copiado (es largo: algunos servicios pueden cortarlo)" : "Enlace copiado al portapapeles");
}
async function leerHash() {
  const h = location.hash.slice(1);
  try {
    if (h.startsWith("z=")) return new TextDecoder().decode(await flujo(base64UrlABytes(h.slice(2)), new DecompressionStream("deflate-raw")));
    if (h.startsWith("t=")) return new TextDecoder().decode(base64UrlABytes(h.slice(2)));
  } catch { avisar("El enlace compartido está dañado"); }
  return null;
}

// ======================================================================
// Catálogo de ejemplos (kitchen sink de dibu)
// ======================================================================
function leerCatalogo(yaml) {
  const secciones = [];
  let actual = { nombre: "Ejemplos", items: [] };
  const lineas = yaml.replace(/\r\n?/g, "\n").split("\n");
  let bloque = null;
  const cerrar = () => {
    if (!bloque) return;
    while (bloque.length && !bloque[bloque.length - 1].trim()) bloque.pop();
    // Quitamos el `id:` del catálogo (ks_…): al insertar, el usuario pone el suyo.
    if (/^-\s+id:\s/.test(bloque[0]) && bloque.length > 1) bloque = ["- " + bloque[1].trimStart(), ...bloque.slice(2)];
    else bloque = bloque.filter((l) => !/^ {2}id:\s/.test(l));
    const texto = bloque.join("\n");
    const tipo = tipoDeTexto(texto);
    const tit = /^\s+title:\s*["']?(.*?)["']?\s*$/m.exec(texto);
    actual.items.push({ tipo, titulo: tit ? tit[1] : "", texto });
    bloque = null;
  };
  for (const l of lineas) {
    const sec = /^#\s*===\s*(?:[A-Z]\.\s*)?(.+?)\s*(?:\(\d+[^)]*\))?\s*===/.exec(l);
    if (sec) {
      cerrar();
      if (actual.items.length) secciones.push(actual);
      const nom = sec[1].toLowerCase();
      actual = { nombre: nom.charAt(0).toUpperCase() + nom.slice(1), items: [] };
      continue;
    }
    if (/^-(\s|$)/.test(l)) { cerrar(); bloque = [l]; continue; }
    if (bloque && !/^#/.test(l)) bloque.push(l);
  }
  cerrar();
  if (actual.items.length) secciones.push(actual);
  return secciones;
}

const catalogo = leerCatalogo(DATOS.catalogo || "");
const ejemploPorTipo = new Map();
for (const s of catalogo) for (const it of s.items) if (!ejemploPorTipo.has(it.tipo)) ejemploPorTipo.set(it.tipo, it);

function poblarEjemplos() {
  const sel = ui.ejemplo;
  const extra = document.createElement("optgroup");
  extra.label = "Documentos completos";
  extra.innerHTML = `<option value="@catalogo">Catálogo completo (YAML)</option><option value="@md">Documento Markdown de ejemplo</option>` +
    (PUML.disponible ? `<option value="@puml">Markdown con PlantUML y dibu</option>` : "");
  sel.appendChild(extra);
  catalogo.forEach((s, si) => {
    const g = document.createElement("optgroup");
    g.label = s.nombre;
    s.items.forEach((it, ii) => {
      const o = document.createElement("option");
      o.value = `${si}:${ii}`;
      o.textContent = it.titulo ? `${it.tipo} — ${it.titulo}` : it.tipo;
      g.appendChild(o);
    });
    sel.appendChild(g);
  });
}

function insertarEjemplo(it) {
  const t = ui.texto;
  const modo = modoEfectivo(t.value);
  let bloque = it.texto;
  if (modo === "puml") {
    avisar("El documento es PlantUML: los ejemplos de dibu van en YAML o en un fence ```estructura de Markdown");
    return;
  }
  if (modo === "md") bloque = "```estructura\n" + bloque + "\n```";
  else if (estado.trozos.length === 1 && estado.trozos[0].entero) {
    avisar("El documento no es una lista de bloques: el ejemplo se agrega igual al final");
  }
  const v = t.value;
  const prefijo = !v.trim() ? "" : v.endsWith("\n\n") ? "" : v.endsWith("\n") ? "\n" : "\n\n";
  const pos = v.length;
  t.focus({ preventScroll: true });
  reemplazarSeleccion(pos, pos, prefijo + bloque + "\n", pos + prefijo.length);
  const linea = v.slice(0, pos + prefijo.length).split("\n").length - 1;
  ignorarScroll = true;
  t.scrollTop = Math.max(0, yLinea(linea) - t.clientHeight * 0.2);
  programarRender(true);
}

const EJEMPLO_PUML = `# PlantUML y dibu en el mismo apunte

Los fences \`\`\`plantuml (o \`\`\`puml) los dibuja PlantUML, dentro del navegador; los \`\`\`dibu, dibu.

\`\`\`plantuml
@startuml
actor Usuario
participant "Programa" as P
Usuario -> P : ingresa n
P -> P : calcula n!
P --> Usuario : resultado
@enduml
\`\`\`

Sin \`@startuml\`, el bloque se envuelve solo, y las opciones de alucarD (\`// [ancho, 60%]\`) se ignoran:

\`\`\`puml
// [centrado] [alt, Jerarquía de figuras]
abstract class Figura {
  + area() : double
}
class Circulo
class Rectangulo
Figura <|-- Circulo
Figura <|-- Rectangulo
\`\`\`

\`\`\`dibu
- type: array
  title: Los mismos datos, con dibu
  values: [3, 1, 4, 1, 5]
\`\`\`
`;

function textoInicial() {
  // Un ejemplo por área: control, química, digital, sistemas operativos y probabilidad.
  const elegidos = ["block_diagram", "titration", "karnaugh", "cpu_scheduling", "distribution"]
    .map((k) => ejemploPorTipo.get(k)).filter(Boolean);
  const base = elegidos.length ? elegidos : catalogo.flatMap((s) => s.items).slice(0, 3);
  return "# Bienvenido a dibu. Cada elemento de la lista es un diagrama.\n" +
    "# Hay más ejemplos en el menú «Insertar» (uno por tipo, agrupados por área) y en\n" +
    "# «Catálogo completo». También podés abrir un .yaml / .md o arrastrarlo a la ventana.\n\n" +
    base.map((b) => b.texto).join("\n\n") + "\n";
}

function poblarAyuda() {
  $("#a-cuenta").textContent = `(${estado.tipos.length})`;
  const cont = $("#a-tipos");
  cont.innerHTML = "";
  const vistos = new Set();
  const grupo = (nombre, tipos) => {
    if (!tipos.length) return;
    const h = document.createElement("h4");
    h.textContent = nombre;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const t of tipos) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t;
      b.disabled = !ejemploPorTipo.has(t);
      b.title = ejemploPorTipo.get(t)?.titulo || "sin ejemplo";
      b.onclick = () => { $("#ayuda").close(); insertarEjemplo(ejemploPorTipo.get(t)); };
      chips.appendChild(b);
      vistos.add(t);
    }
    cont.append(h, chips);
  };
  for (const s of catalogo) grupo(s.nombre, [...new Set(s.items.map((i) => i.tipo))].filter((t) => estado.tipos.includes(t)));
  grupo("Otros", estado.tipos.filter((t) => !vistos.has(t)));
}

// ======================================================================
// Paneles, preferencias y arranque
// ======================================================================
function aplicarPaleta() {
  if (!THEMES[prefs.paleta]) prefs.paleta = "tinta";
  document.querySelectorAll("[data-paleta]").forEach((b) => b.classList.toggle("activo", b.dataset.paleta === prefs.paleta));
  guardarPrefs();
}

function configurarDivisor() {
  const div = $("#divisor");
  const panel = $("#panel");
  const fijar = (pct) => {
    prefs.izq = Math.min(80, Math.max(18, pct));
    panel.style.setProperty("--izq", prefs.izq + "%");
  };
  fijar(prefs.izq);
  div.addEventListener("pointerdown", (e) => {
    if (matchMedia("(max-width: 820px)").matches) return;
    div.setPointerCapture(e.pointerId);
    div.classList.add("arrastrando");
    const mover = (ev) => {
      const r = panel.getBoundingClientRect();
      fijar(((ev.clientX - r.left) / r.width) * 100);
    };
    const soltar = () => {
      div.classList.remove("arrastrando");
      div.removeEventListener("pointermove", mover);
      div.removeEventListener("pointerup", soltar);
      guardarPrefs();
    };
    div.addEventListener("pointermove", mover);
    div.addEventListener("pointerup", soltar);
  });
  div.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") fijar(prefs.izq - 2);
    else if (e.key === "ArrowRight") fijar(prefs.izq + 2);
    else return;
    e.preventDefault();
    guardarPrefs();
  });
}

function conectarEventos() {
  const t = ui.texto;
  t.addEventListener("input", () => alEditar());
  t.addEventListener("keydown", alTeclear);
  t.addEventListener("scroll", alDesplazarEditor);
  $("#c-ajuste").onchange = (e) => alternarAjuste(e.target.checked);
  // Con el ajuste, un cambio de ancho cambia cuántos renglones ocupa cada línea.
  let anchoPrevio = 0;
  new ResizeObserver(() => {
    if (!prefs.ajuste || t.clientWidth === anchoPrevio) return;
    anchoPrevio = t.clientWidth;
    alturasNumeros();
    sincronizarScrollCapas();
  }).observe(t);
  ["keyup", "click", "select", "focus"].forEach((ev) => t.addEventListener(ev, actualizarCursor));
  document.addEventListener("selectionchange", () => { if (document.activeElement === t) actualizarCursor(); });
  document.addEventListener("keydown", atajosGlobales);

  $("#b-nuevo").onclick = () => {
    if (ui.texto.value.trim() && !confirm("¿Descartar el documento actual?")) return;
    cargarTexto("", "diagramas.yaml");
    history.replaceState(null, "", location.pathname + location.search);
    ui.texto.focus();
  };
  $("#b-abrir").onclick = () => $("#archivo").click();
  $("#archivo").onchange = (e) => { abrirArchivo(e.target.files[0]); e.target.value = ""; };
  $("#b-guardar").onclick = guardarArchivo;
  $("#b-compartir").onclick = compartir;
  $("#b-todo").onclick = exportarTodo;
  $("#b-ayuda").onclick = () => $("#ayuda").showModal();
  document.querySelectorAll("[data-paleta]").forEach((b) => (b.onclick = () => {
    prefs.paleta = b.dataset.paleta;
    aplicarPaleta();
    programarRender(true);
  }));
  ui.modo.value = prefs.modo;
  ui.modo.onchange = () => { prefs.modo = ui.modo.value; guardarPrefs(); estado.activo = -1; programarRender(true); };
  ui.seguir.checked = prefs.seguir;
  ui.seguir.onchange = () => { prefs.seguir = ui.seguir.checked; guardarPrefs(); };
  ui.ejemplo.onchange = () => {
    const v = ui.ejemplo.value;
    ui.ejemplo.value = "";
    if (!v) return;
    if (v.startsWith("@")) {
      if (ui.texto.value.trim() && !confirm("Esto reemplaza el documento actual. ¿Continuar?")) return;
      if (v === "@catalogo") cargarTexto(DATOS.catalogo, "kitchen_sink.yaml");
      else if (v === "@puml") cargarTexto(EJEMPLO_PUML, "plantuml.md");
      else cargarTexto(DATOS.markdown, "kitchen_sink.md");
      return;
    }
    const [si, ii] = v.split(":").map(Number);
    insertarEjemplo(catalogo[si].items[ii]);
  };
  const texto = [$("#c-texto"), $("#i-texto")];
  const ponerTexto = (v) => {
    prefs.texto = v;
    texto.forEach((c) => (c.checked = v));
    guardarPrefs();
    pintar();
  };
  texto.forEach((c) => { c.checked = prefs.texto; c.onchange = () => ponerTexto(c.checked); });
  $("#b-impresion").onclick = () => vistaImpresion(true);
  $("#i-imprimir").onclick = async () => {
    // Si quedan diagramas por dibujar, se esperan (hasta 10 s) para que el PDF salga completo.
    for (let k = 0; k < 100 && document.querySelector("#documento figure.cargando, .lienzo.cargando"); k++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    window.print();
  };
  $("#i-salir").onclick = () => vistaImpresion(false);
  conectarPagina();
  conectarFuentes();
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("impresion")) vistaImpresion(false);
  });
  ui.documento.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const fig = e.target.closest("figure[data-trozo]");
    if (fig && !document.body.classList.contains("impresion")) irAlBloque(Number(fig.dataset.trozo), null);
  });
  $("#z-mas").onclick = () => cambiarZoom(1);
  $("#z-menos").onclick = () => cambiarZoom(-1);
  ui.zoom.onclick = () => { prefs.zoom = prefs.zoom ? 0 : 1; aplicarZoom(); };

  // Arrastrar y soltar archivos sobre la ventana.
  let profundidad = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { profundidad++; document.body.classList.add("soltar"); } });
  window.addEventListener("dragleave", () => { if (--profundidad <= 0) { profundidad = 0; document.body.classList.remove("soltar"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    profundidad = 0;
    document.body.classList.remove("soltar");
    abrirArchivo(e.dataTransfer?.files?.[0]);
  });
  window.addEventListener("hashchange", async () => {
    const t = await leerHash();
    if (t !== null && t !== ui.texto.value) cargarTexto(t);
  });
}

// ---------- tipografías de Google Fonts ----------
/** Descarga las tipografías de prefs.fuentes y las aplica al documento y a los diagramas. */
async function aplicarFuentes() {
  const ROLES = ["sans", "mono", "titulos"];
  const estadoCampo = Object.fromEntries(ROLES.map((r) => [r, $(`#f-${r}-estado`)]));
  const nuevas = { sans: null, mono: null, titulos: null };
  await Promise.all(ROLES.map(async (rol) => {
    const entrada = (prefs.fuentes || {})[rol] || "";
    if (!entrada.trim()) { estadoCampo[rol].textContent = "la de dibu"; estadoCampo[rol].className = "nota"; return; }
    estadoCampo[rol].textContent = "descargando…";
    estadoCampo[rol].className = "nota";
    try {
      nuevas[rol] = await FUENTES.cargar(entrada);
      estadoCampo[rol].textContent = `${nuevas[rol].familia} · ${Math.round(nuevas[rol].bytes / 1024)} KiB`;
    } catch (e) {
      estadoCampo[rol].textContent = String(e.message || e);
      estadoCampo[rol].className = "nota error";
    }
  }));
  // Si mientras se descargaba se cambió otra vez, gana la última llamada.
  if (JSON.stringify(prefs.fuentes) !== JSON.stringify(aplicarFuentes.pedido)) return;
  estado.fuentes = nuevas;
  let st = document.getElementById("estilo-fuentes");
  if (!st) { st = document.createElement("style"); st.id = "estilo-fuentes"; document.head.append(st); }
  // Los títulos del documento (#, ##, …) y los de la vista de impresión: sólo en la página, no en
  // los SVG (dibu dibuja los títulos de los diagramas con la letra del texto).
  st.textContent = [nuevas.sans?.css, nuevas.mono?.css, nuevas.titulos?.css,
    nuevas.sans ? `#documento { font-family: '${nuevas.sans.familia}', var(--sans); }` : "",
    nuevas.mono ? `#documento code, #documento pre { font-family: '${nuevas.mono.familia}', var(--mono); }` : "",
    nuevas.titulos ? `#documento :is(h1, h2, h3, h4, h5, h6) { font-family: '${nuevas.titulos.familia}', var(--sans); }` : "",
  ].filter(Boolean).join("\n");
  programarRender(true);
}

function pedirFuentes() {
  aplicarFuentes.pedido = JSON.parse(JSON.stringify(prefs.fuentes || {}));
  return aplicarFuentes();
}

function conectarFuentes() {
  const dlg = $("#fuentes");
  const campos = { sans: $("#f-sans"), mono: $("#f-mono"), titulos: $("#f-titulos") };
  $("#b-fuentes").onclick = () => {
    for (const rol in campos) campos[rol].value = (prefs.fuentes || {})[rol] || "";
    dlg.showModal();
  };
  $("#f-aplicar").onclick = (e) => {
    e.preventDefault();
    prefs.fuentes = Object.fromEntries(Object.entries(campos).map(([rol, c]) => [rol, c.value.trim()]));
    guardarPrefs();
    pedirFuentes();
  };
  $("#f-quitar").onclick = (e) => {
    e.preventDefault();
    for (const c of Object.values(campos)) c.value = "";
    prefs.fuentes = { sans: "", mono: "", titulos: "" };
    guardarPrefs();
    pedirFuentes();
  };
  if (prefs.fuentes && Object.values(prefs.fuentes).some(Boolean)) pedirFuentes();
}

// ---------- encabezado y pie de página (márgenes de @page) ----------
const PAGINA_DEFECTO = {
  encabezado: { izquierda: "", centro: "{titulo}", derecha: "" },
  pie: { izquierda: "{fecha}", centro: "", derecha: "Página {pagina} de {paginas}" },
};
function configPagina() {
  const p = prefs.pagina || {};
  return {
    encabezado: { ...PAGINA_DEFECTO.encabezado, ...(p.encabezado || {}) },
    pie: { ...PAGINA_DEFECTO.pie, ...(p.pie || {}) },
  };
}

/** El título del documento: `title:` del front matter o el primer encabezado `#`. */
function tituloDocumento(texto) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(texto);
  const t = fm && /^title:\s*["']?(.*?)["']?\s*$/m.exec(fm[1]);
  if (t && t[1]) return t[1];
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(texto.replace(/^```[\s\S]*?^```/gm, ""));
  return h ? h[1] : "";
}

/** Una plantilla ("Página {pagina} de {paginas}") como valor de `content` de CSS. */
function contenidoCSS(plantilla, datos) {
  const cadena = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ")}"`;
  const partes = [];
  let texto = "";
  for (const trozo of plantilla.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(trozo);
    const clave = m && m[1];
    if (clave === "pagina" || clave === "paginas") {
      if (texto) partes.push(cadena(texto));
      texto = "";
      partes.push(clave === "pagina" ? "counter(page)" : "counter(pages)");
    } else texto += clave && clave in datos ? datos[clave] : trozo;
  }
  if (texto) partes.push(cadena(texto));
  return partes.join(" ");
}

/** Escribe las reglas @page con el encabezado y el pie configurados. */
function aplicarPagina() {
  let st = document.getElementById("estilo-pagina");
  if (!st) { st = document.createElement("style"); st.id = "estilo-pagina"; document.head.append(st); }
  const c = configPagina();
  const datos = {
    titulo: tituloDocumento(ui.texto.value),
    archivo: estado.nombreArchivo,
    fecha: new Date().toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" }),
  };
  const cajas = { encabezado: "top", pie: "bottom" };
  const lados = { izquierda: "left", centro: "center", derecha: "right" };
  let reglas = "";
  for (const [zona, css] of Object.entries(cajas)) {
    for (const [lado, l] of Object.entries(lados)) {
      const v = (c[zona][lado] || "").trim();
      if (v) reglas += `@${css}-${l} { content: ${contenidoCSS(v, datos)}; font: 9pt/1.2 Inter, "Segoe UI", Roboto, "DejaVu Sans", sans-serif; color: #555; }\n`;
    }
  }
  st.textContent = `@media print { @page { margin: 18mm 14mm; ${reglas} } }`;
}

function conectarPagina() {
  const panel = $("#i-panel");
  const boton = $("#i-pagina");
  const llenar = () => {
    const c = configPagina();
    panel.querySelectorAll("[data-pagina]").forEach((i) => {
      const [zona, lado] = i.dataset.pagina.split(".");
      i.value = c[zona][lado];
    });
  };
  boton.onclick = () => {
    panel.hidden = !panel.hidden;
    boton.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { llenar(); panel.querySelector("input").focus(); }
  };
  panel.addEventListener("input", (e) => {
    const [zona, lado] = (e.target.dataset.pagina || "").split(".");
    if (!lado) return;
    const c = configPagina();
    c[zona][lado] = e.target.value;
    prefs.pagina = c;
    guardarPrefs();
    aplicarPagina();
  });
  panel.addEventListener("submit", (e) => e.preventDefault());
  $("#i-pagina-defecto").onclick = () => { delete prefs.pagina; guardarPrefs(); llenar(); aplicarPagina(); };
  window.addEventListener("beforeprint", aplicarPagina);
  aplicarPagina();
}

/** La vista de impresión: sólo el documento, a pantalla completa; Esc (o Salir) vuelve. */
function vistaImpresion(on) {
  const b = document.body;
  if (on === b.classList.contains("impresion")) return;
  b.classList.toggle("impresion", on);
  if (!on) { $("#i-panel").hidden = true; $("#i-pagina").setAttribute("aria-expanded", "false"); }
  if (on) {
    aplicarPagina();
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { /* sin pantalla completa: la vista sirve igual */ });
    }
    $("#i-imprimir").focus();
  } else {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ui.texto.focus();
  }
  pintar();
}

async function arrancar() {
  configurarDivisor();
  conectarEventos();
  iniciarAsistente();
  iniciarVisual();
  poblarEjemplos();
  aplicarPaleta();
  aplicarZoom();
  aplicarAjuste();

  const compartido = await leerHash();
  const guardado = localStorage.getItem(CLAVE_TEXTO);
  cargarTexto(compartido ?? (guardado !== null ? guardado : textoInicial()));

  try {
    const modulo = await WebAssembly.compile(base64ABytes(DATOS.wasm));
    estado.motor = new Motor(modulo, DATOS.worker);
    const r = await estado.motor.listo;
    if (!r.ok) throw new Error(r.error);
    estado.tipos = r.resultado;
    $("#e-motor").textContent = `Motor dibu (WebAssembly) · ${estado.tipos.length} tipos` +
      (PUML.disponible ? ` · PlantUML ${PUML.version}` : "");
    poblarAyuda();
    poblarNuevoBloque();
    if (prefs.vista === "visual") abrirVisual(true);
    programarRender(true);
  } catch (e) {
    $("#e-motor").textContent = "No se pudo iniciar el motor: " + e.message;
    ui.tarjetas.innerHTML = `<div class="vacio">El navegador no pudo cargar el motor WebAssembly.<br><code>${esc(String(e.message || e))}</code></div>`;
  }
}

arrancar();
