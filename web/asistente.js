// Asistente del editor de código: autocompletado guiado por el esquema, ayuda del campo bajo
// el cursor y operaciones de línea. Sólo declaraciones: se concatena antes de app.js.
"use strict";

// ======================================================================
// Análisis del contexto YAML (función pura, sin DOM)
// ======================================================================
const RE_LINEA = /^(\s*)((?:-[ \t]+|-$)*)(.*)$/;
const RE_CLAVE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_$][\w$.-]*)[ \t]*:(?=\s|$)[ \t]*(.*)$/;

function quitarComillas(k) {
  return /^["'].*["']$/.test(k) ? k.slice(1, -1) : k;
}
function sinComentario(v) {
  if (/^["']/.test(v)) return v;
  const i = v.search(/(^|\s)#/);
  return (i < 0 ? v : v.slice(0, i)).trim();
}

/** Descompone una línea: sangría, columnas de cada guion de lista, columna del contenido, clave y valor. */
function partirLinea(l) {
  const m = RE_LINEA.exec(l);
  const base = m[1].length;
  const guiones = [];
  let p = base;
  for (const g of m[2].matchAll(/-[ \t]*/g)) {
    if (!g[0]) break;
    guiones.push({ col: p, contenido: p + g[0].length });
    p += g[0].length;
  }
  const resto = m[3];
  const c = RE_CLAVE.exec(resto);
  return {
    base, guiones, col: p, resto,
    clave: c ? quitarComillas(c[1]) : null,
    valor: c ? sinComentario(c[2]) : null,
    vacia: resto.trim() === "" && !guiones.length,
    comentario: /^\s*#/.test(l),
  };
}

function rutaTexto(segs) {
  let s = "";
  for (const g of segs) s = g === "[]" ? s + "[]" : s ? `${s}.${g}` : g;
  return s;
}

/** Región YAML que contiene la línea: todo el documento, o el cuerpo del fence en Markdown. */
function regionDe(lineas, linea, modo) {
  if (modo === "puml") return null;
  if (modo !== "md") return { ini: 0, fin: lineas.length };
  let abierta = null;
  let ini = -1;
  for (let i = 0; i < lineas.length; i++) {
    if (abierta === null) {
      const m = RE_VALLA.exec(lineas[i]);
      if (m && RE_PUML.test(m[2])) { // un fence PlantUML no es YAML: el asistente no lo toca
        let j = i + 1;
        while (j < lineas.length && lineas[j].trimEnd() !== m[1]) j++;
        if (linea >= i && linea <= j) return null;
        i = j;
        continue;
      }
      if (m) { abierta = m[1]; ini = i + 1; }
      if (i >= linea) return null;
    } else if (lineas[i].trimEnd() === abierta) {
      if (linea >= ini && linea < i) return { ini, fin: i };
      abierta = null;
    }
  }
  return abierta !== null && linea >= ini ? { ini, fin: lineas.length } : null;
}

/**
 * Contexto de edición en (linea, col): ruta del objeto donde se escribe, tipo del bloque,
 * claves hermanas ya presentes y qué se está escribiendo (clave o valor).
 * Devuelve null en JSON, dentro de `[…]`/`{…}` o fuera de un fence en Markdown.
 */
function analizarContexto(lineas, linea, col, modo) {
  const reg = regionDe(lineas, linea, modo);
  if (!reg) return null;
  const primera = lineas.slice(reg.ini, reg.fin).find((l) => l.trim() && !/^\s*#/.test(l));
  if (primera && /^\s*[[{]/.test(primera)) return null;

  const pila = []; // { col, seg, contenido?, linea }
  const apilarGuiones = (p, i) => {
    for (const g of p.guiones) {
      while (pila.length && pila[pila.length - 1].col >= g.col) pila.pop();
      pila.push({ col: g.col, seg: "[]", contenido: g.contenido, linea: i });
    }
  };
  let literal = -1; // columna de una clave con escalar de bloque (| o >): se saltan sus líneas
  for (let i = reg.ini; i < linea; i++) {
    const l = lineas[i];
    const p = partirLinea(l);
    if (p.vacia || p.comentario) continue;
    if (literal >= 0) {
      if (p.base > literal) continue;
      literal = -1;
    }
    apilarGuiones(p, i);
    if (p.clave !== null) {
      while (pila.length && pila[pila.length - 1].col >= p.col) pila.pop();
      if (p.valor === "") pila.push({ col: p.col, seg: p.clave, linea: i });
      else if (/^[|>][-+0-9]*$/.test(p.valor)) literal = p.col;
    }
  }

  const texto = lineas[linea] ?? "";
  const antes = texto.slice(0, col);
  if (/^\s*#/.test(antes)) return null;
  // ¿Dentro de una colección en flujo abierta en esta línea?
  let prof = 0;
  for (const ch of antes.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "")) {
    if (ch === "[" || ch === "{") prof++;
    else if ((ch === "]" || ch === "}") && prof > 0) prof--;
  }
  if (prof > 0) return null;

  const actual = partirLinea(antes);
  apilarGuiones(actual, linea);
  const colClave = actual.col;
  while (pila.length && pila[pila.length - 1].col >= colClave) pila.pop();

  // Raíz del bloque: el ítem de la lista raíz, o `blocks: [ … ]`, o el documento entero.
  let segs = pila.map((x) => x.seg);
  let bloque = { linea: reg.ini, col: 0 };
  if (segs[0] === "[]") {
    bloque = { linea: pila[0].linea, col: pila[0].contenido };
    segs = segs.slice(1);
  } else if (segs[0] === "blocks" && segs[1] === "[]") {
    bloque = { linea: pila[1].linea, col: pila[1].contenido };
    segs = segs.slice(2);
  } else if (segs.length === 0 && actual.guiones.length && actual.guiones[0].col === 0) {
    bloque = { linea, col: actual.guiones[0].contenido };
  }
  const enRaizDeLista = !pila.length && !actual.guiones.length && lineas.slice(reg.ini, reg.fin).some((l) => /^-(\s|$)/.test(l));

  // Tipo del bloque: `type:` a la columna de las claves del bloque.
  let tipo = null;
  for (let i = bloque.linea; i < reg.fin; i++) {
    const p = partirLinea(i === linea ? texto : lineas[i]);
    if (p.vacia || p.comentario) continue;
    if (i > bloque.linea && p.base < bloque.col) break;
    if (p.col === bloque.col && p.clave === "type" && p.valor) { tipo = quitarComillas(p.valor); break; }
  }

  // Claves hermanas (mismo objeto, misma columna).
  const hermanas = new Set();
  const nuevoItem = actual.guiones.length > 0;
  if (!nuevoItem) {
    for (let i = linea - 1; i >= reg.ini; i--) {
      const p = partirLinea(lineas[i]);
      if (p.vacia || p.comentario) continue;
      if (p.col === colClave && p.clave !== null) hermanas.add(p.clave);
      if (p.base < colClave) break;
    }
  }
  for (let i = linea + 1; i < reg.fin; i++) {
    const p = partirLinea(lineas[i]);
    if (p.vacia || p.comentario) continue;
    if (p.base < colClave) break;
    if (p.base === colClave && p.guiones.length) break;
    if (p.col === colClave && p.clave !== null) hermanas.add(p.clave);
  }

  const ruta = rutaTexto(segs);
  const enClave = /^[A-Za-z_][\w]*$|^$/.exec(actual.resto);
  const enValor = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_][\w]*)[ \t]*:[ \t]+(.*)$/.exec(actual.resto);
  const base = { ruta, tipo, hermanas, colClave, region: reg, bloque, enRaizDeLista, linea };
  if (enClave && !enRaizDeLista) return { ...base, modo: "clave", prefijo: enClave[0], ini: col - enClave[0].length };
  if (enValor && !/["']$/.test(enValor[2]) && !/[[{#]/.test(enValor[2])) {
    const pref = enValor[2].replace(/^["']/, "");
    return { ...base, modo: "valor", clave: quitarComillas(enValor[1]), prefijo: pref, ini: col - enValor[2].length };
  }
  // Clave completa en la línea (para mostrar su ayuda) aunque el cursor esté en otro lado.
  const completa = partirLinea(texto);
  return { ...base, modo: null, clave: completa.col === colClave ? completa.clave : null };
}

// ======================================================================
// Sugerencias
// ======================================================================
function unirRuta(ruta, k) {
  return ruta ? `${ruta}.${k}` : k;
}

function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function esListaDeObjetos(tipo, ruta) {
  if (clavesSugeridas(tipo, ruta + "[]").length) return true;
  const info = infoCampo(tipo, ruta);
  return !!(info && info.ej && info.ej.some((x) => Array.isArray(x) && x.some((y) => y && typeof y === "object")));
}

function sugerenciasClave(ctx) {
  const out = [];
  if (!ctx.ruta && !ctx.hermanas.has("type")) {
    out.push({ etiqueta: "type", detalle: "tipo de diagrama", texto: "type: ", luego: "valor" });
  }
  if (!ctx.tipo) return out;
  for (const k of clavesSugeridas(ctx.tipo, ctx.ruta)) {
    if (ctx.hermanas.has(k) || k === "type") continue;
    const r = unirRuta(ctx.ruta, k);
    const info = infoCampo(ctx.tipo, r);
    const clases = (info && info.k) || [];
    const sang = " ".repeat(ctx.colClave + 2);
    let texto = `${claveYaml(k)}: `;
    let luego = null;
    let cursorAtras = 0;
    if (clases.length === 1 && clases[0] === "object") texto = `${claveYaml(k)}:\n${sang}`;
    else if (clases.length === 1 && clases[0] === "array") {
      if (esListaDeObjetos(ctx.tipo, r)) texto = `${claveYaml(k)}:\n${sang}- `;
      else { texto = `${claveYaml(k)}: []`; cursorAtras = 1; }
    } else if (info && (info.en || clases.includes("boolean") || (info.ej && info.ej.length > 1))) luego = "valor";
    out.push({ etiqueta: k, detalle: describirInfo(info), texto, luego, cursorAtras, clases });
  }
  return out;
}

function sugerenciasValor(ctx, forzar) {
  if (ctx.clave === "type" && !ctx.ruta) {
    return estado.tipos.map((t) => {
      const ej = ejemploPorTipo.get(t);
      return { etiqueta: t, detalle: ej ? ej.titulo || "ejemplo disponible" : "", texto: t, tipo: t, conEjemplo: !!ej };
    });
  }
  if (!ctx.tipo) return [];
  const info = infoCampo(ctx.tipo, unirRuta(ctx.ruta, ctx.clave));
  if (!info) return [];
  // Sin Ctrl+Espacio sólo se sugiere solo cuando el conjunto es cerrado (enumerados, sí/no).
  if (!forzar && !info.en && !(info.k || []).includes("boolean")) return [];
  const vistos = new Set();
  const out = [];
  const agregar = (v, detalle) => {
    if (v === null || typeof v === "object") return;
    const t = escalarYaml(v, false);
    if (vistos.has(t)) return;
    vistos.add(t);
    out.push({ etiqueta: String(v), detalle, texto: t });
  };
  for (const v of info.en || []) agregar(v, info.def === v ? "por defecto" : "valor admitido");
  if ((info.k || []).includes("boolean")) { agregar(true, ""); agregar(false, ""); }
  if (!info.en) for (const v of info.ej || []) agregar(v, "ejemplo");
  return out;
}

function filtrar(lista, prefijo) {
  if (!prefijo) return lista;
  const p = prefijo.toLowerCase();
  const empiezan = lista.filter((s) => s.etiqueta.toLowerCase().startsWith(p));
  const contienen = lista.filter((s) => !s.etiqueta.toLowerCase().startsWith(p) && s.etiqueta.toLowerCase().includes(p));
  return [...empiezan, ...contienen];
}

/** Texto del ejemplo del catálogo para `tipo`, sin la línea `type:`, sangrado a `col`. */
function cuerpoEjemplo(tipo, col) {
  const ej = ejemploPorTipo.get(tipo);
  if (!ej) return "";
  const lineas = ej.texto.split("\n");
  const i = lineas.findIndex((l) => /^(-\s+|\s+)type:\s/.test(l));
  if (i < 0) return "";
  lineas.splice(i, 1);
  return lineas
    .map((l, k) => (k === 0 && l.startsWith("- ") ? "  " + l.slice(2) : l))
    .filter((l) => l.trim())
    .map((l) => " ".repeat(col) + l.replace(/^ {2}/, ""))
    .join("\n");
}

// ======================================================================
// Ventana de autocompletado
// ======================================================================
const AC = { abierto: false, items: [], sel: 0, ctx: null, el: null, ignorarInput: false, temporizador: 0 };

function medirCaracter() {
  const c = document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(ui.texto);
  c.font = `${cs.fontSize} ${cs.fontFamily}`;
  return c.measureText("MMMMMMMMMM").width / 10;
}

function posicionCursor(linea, col) {
  const cs = getComputedStyle(ui.texto);
  const lh = alturaLinea();
  const cw = AC.anchoCar || (AC.anchoCar = medirCaracter());
  // Con el ajuste de línea, la columna cae en el renglón col / (caracteres por renglón).
  const porRenglon = prefs.ajuste
    ? Math.max(1, Math.floor((ui.texto.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / cw))
    : Infinity;
  const renglon = Math.floor(col / porRenglon);
  return {
    x: parseFloat(cs.paddingLeft) + (col - renglon * (porRenglon === Infinity ? 0 : porRenglon)) * cw - ui.texto.scrollLeft,
    y: parseFloat(cs.paddingTop) + yLinea(linea) + renglon * lh - ui.texto.scrollTop,
    lh,
  };
}

function cerrarAutocompletado() {
  if (!AC.abierto) return;
  AC.abierto = false;
  AC.el.hidden = true;
  ui.texto.removeAttribute("aria-activedescendant");
}

function abrirAutocompletado(forzar) {
  const t = ui.texto;
  if (t.selectionStart !== t.selectionEnd) return cerrarAutocompletado();
  const v = t.value;
  const pos = t.selectionStart;
  const iniLinea = v.lastIndexOf("\n", pos - 1) + 1;
  const lineas = v.split("\n");
  const linea = v.slice(0, iniLinea).split("\n").length - 1;
  const ctx = analizarContexto(lineas, linea, pos - iniLinea, modoEfectivo(v));
  if (!ctx || !ctx.modo) return cerrarAutocompletado();
  const todas = ctx.modo === "clave" ? sugerenciasClave(ctx) : sugerenciasValor(ctx, forzar || AC.abierto);
  const items = filtrar(todas, ctx.prefijo).slice(0, 60);
  const exacta = items.length === 1 && items[0].etiqueta === ctx.prefijo && ctx.modo === "valor";
  if (!items.length || exacta || (!forzar && ctx.modo === "clave" && !ctx.prefijo && !AC.abierto)) return cerrarAutocompletado();
  AC.ctx = { ...ctx, iniAbs: iniLinea + ctx.ini, finAbs: pos };
  AC.items = items;
  AC.sel = 0;
  AC.abierto = true;
  pintarAutocompletado(linea, ctx.ini);
}

function pintarAutocompletado(linea, col) {
  const el = AC.el;
  el.innerHTML = "";
  const lista = document.createElement("ul");
  lista.setAttribute("role", "listbox");
  AC.items.forEach((s, i) => {
    const li = document.createElement("li");
    li.id = `ac-${i}`;
    li.setAttribute("role", "option");
    li.className = i === AC.sel ? "sel" : "";
    li.innerHTML = `<span class="ac-et">${esc(s.etiqueta)}</span><span class="ac-de">${esc(s.detalle || "")}</span>`;
    li.onmousedown = (e) => { e.preventDefault(); AC.sel = i; aceptarSugerencia(false); };
    lista.appendChild(li);
  });
  el.appendChild(lista);
  const pie = document.createElement("div");
  pie.className = "ac-pie";
  pie.textContent = AC.ctx.modo === "valor" && AC.ctx.clave === "type"
    ? "Enter: tipo + campos de ejemplo · Shift+Enter: sólo el tipo · Esc: cerrar"
    : "Enter/Tab: insertar · Esc: cerrar · Ctrl+Espacio: sugerir";
  el.appendChild(pie);
  el.hidden = false;
  const { x, y, lh } = posicionCursor(linea, col);
  const zona = el.parentElement.getBoundingClientRect();
  const alto = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(x - 6, zona.width - el.offsetWidth - 6))}px`;
  el.style.top = `${y + lh + alto > zona.height && y > alto ? y - alto - 2 : y + lh + 2}px`;
  ui.texto.setAttribute("aria-activedescendant", `ac-${AC.sel}`);
}

function moverSeleccionAC(d) {
  AC.sel = (AC.sel + d + AC.items.length) % AC.items.length;
  [...AC.el.querySelectorAll("li")].forEach((li, i) => li.classList.toggle("sel", i === AC.sel));
  AC.el.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
  ui.texto.setAttribute("aria-activedescendant", `ac-${AC.sel}`);
}

function aceptarSugerencia(sinEjemplo) {
  const s = AC.items[AC.sel];
  const ctx = AC.ctx;
  cerrarAutocompletado();
  if (!s) return;
  const t = ui.texto;
  const v = t.value;
  let texto = s.texto;
  let fin = ctx.finAbs;
  // Reemplazar también el resto de la palabra a la derecha del cursor.
  while (fin < v.length && /[\w-]/.test(v[fin])) fin++;
  if (ctx.modo === "valor" && /^["']/.test(v.slice(ctx.iniAbs, fin)) && v[fin] === v[ctx.iniAbs]) fin++;
  const restoLinea = v.slice(fin, (v.indexOf("\n", fin) + 1 || v.length + 1) - 1);
  if (s.tipo && s.conEjemplo && !sinEjemplo && !restoLinea.trim()) {
    const soloTipo = [...ctx.hermanas].every((k) => k === "type");
    const cuerpo = soloTipo ? cuerpoEjemplo(s.tipo, ctx.bloque.col) : "";
    if (cuerpo) texto += "\n" + cuerpo;
  }
  AC.ignorarInput = true;
  const cursor = ctx.iniAbs + (s.tipo ? s.texto.length : texto.length - (s.cursorAtras || 0));
  reemplazarSeleccion(ctx.iniAbs, fin, texto, cursor);
  AC.ignorarInput = false;
  if (s.luego === "valor") abrirAutocompletado(true);
  if (s.tipo) programarRender(true);
}

/** Teclas mientras la ventana está abierta. Devuelve true si la consumió. */
function teclaAutocompletado(ev) {
  if (!AC.abierto) return false;
  switch (ev.key) {
    case "ArrowDown": moverSeleccionAC(1); break;
    case "ArrowUp": moverSeleccionAC(-1); break;
    case "PageDown": moverSeleccionAC(Math.min(8, AC.items.length - 1 - AC.sel) || 1); break;
    case "PageUp": moverSeleccionAC(-Math.min(8, AC.sel) || -1); break;
    case "Enter": case "Tab": aceptarSugerencia(ev.shiftKey); break;
    case "Escape": cerrarAutocompletado(); break;
    default: return false;
  }
  ev.preventDefault();
  return true;
}

function alEscribirAsistente(ev) {
  if (AC.ignorarInput) return;
  const dato = ev.data || "";
  const escribe = ev.inputType === "insertText" && /^[\w :-]$/.test(dato);
  const borra = ev.inputType && ev.inputType.startsWith("delete");
  if (escribe || (borra && AC.abierto)) {
    cancelAnimationFrame(AC.temporizador);
    AC.temporizador = requestAnimationFrame(() => abrirAutocompletado(false));
  } else cerrarAutocompletado();
}

// ======================================================================
// Ayuda del campo bajo el cursor (barra de estado)
// ======================================================================
let rafAyuda = 0;
function actualizarAyudaCampo() {
  cancelAnimationFrame(rafAyuda);
  rafAyuda = requestAnimationFrame(() => {
    const out = $("#e-campo");
    if (!out) return;
    const t = ui.texto;
    const v = t.value;
    const pos = t.selectionStart;
    const iniLinea = v.lastIndexOf("\n", pos - 1) + 1;
    const finLinea = v.indexOf("\n", pos);
    const linea = v.slice(0, iniLinea).split("\n").length - 1;
    const lineas = v.split("\n");
    // Analizamos con el cursor al final de la línea para conocer la clave completa.
    const ctx = analizarContexto(lineas, linea, (finLinea < 0 ? v.length : finLinea) - iniLinea, modoEfectivo(v));
    out.className = "";
    out.textContent = "";
    out.title = "";
    if (!ctx) return;
    const clave = ctx.clave ?? partirLinea(lineas[linea]).clave;
    if (!ctx.tipo || !clave) { if (ctx.tipo) out.textContent = ctx.tipo + (ctx.ruta ? ` › ${ctx.ruta}` : ""); return; }
    const ruta = unirRuta(ctx.ruta, clave);
    const etiqueta = `${ctx.tipo} › ${ruta}`;
    if (clave === "type") { out.textContent = `${etiqueta}: tipo de diagrama`; return; }
    const info = infoCampo(ctx.tipo, ruta);
    if (info) {
      out.textContent = `${etiqueta}: ${describirInfo(info)}`;
      out.title = out.textContent;
      return;
    }
    const conocidas = clavesSugeridas(ctx.tipo, ctx.ruta);
    if (!conocidas.length) { out.textContent = etiqueta; return; }
    const cerca = conocidas.map((k) => [k, distancia(k.toLowerCase(), clave.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
    out.className = "aviso";
    out.textContent = `${etiqueta}: campo desconocido para ${ctx.tipo}` + (cerca && cerca[1] <= 2 ? ` — ¿quisiste decir «${cerca[0]}»?` : "");
    out.title = "Campos conocidos: " + conocidas.join(", ");
  });
}

// ======================================================================
// Operaciones de línea y edición inteligente
// ======================================================================
function lineasSeleccionadas() {
  const t = ui.texto, v = t.value;
  const s = t.selectionStart;
  let e = t.selectionEnd;
  if (e > s && v[e - 1] === "\n") e--;
  const ini = v.lastIndexOf("\n", s - 1) + 1;
  let fin = v.indexOf("\n", e);
  if (fin < 0) fin = v.length;
  return { ini, fin, texto: v.slice(ini, fin), s: t.selectionStart, e: t.selectionEnd };
}

function moverLineas(dir) {
  const v = ui.texto.value;
  const r = lineasSeleccionadas();
  if (dir < 0) {
    if (r.ini === 0) return;
    const ini = v.lastIndexOf("\n", r.ini - 2) + 1;
    const anterior = v.slice(ini, r.ini - 1);
    const d = -(anterior.length + 1);
    reemplazarSeleccion(ini, r.fin, r.texto + "\n" + anterior, r.s + d, r.e + d);
  } else {
    if (r.fin >= v.length) return;
    let fin = v.indexOf("\n", r.fin + 1);
    if (fin < 0) fin = v.length;
    const siguiente = v.slice(r.fin + 1, fin);
    const d = siguiente.length + 1;
    reemplazarSeleccion(r.ini, fin, siguiente + "\n" + r.texto, r.s + d, r.e + d);
  }
}

function duplicarLineas(dir) {
  const r = lineasSeleccionadas();
  const d = dir > 0 ? r.texto.length + 1 : 0;
  reemplazarSeleccion(r.ini, r.fin, r.texto + "\n" + r.texto, r.s + d, r.e + d);
}

function borrarLineas() {
  const v = ui.texto.value;
  const r = lineasSeleccionadas();
  const ini = r.fin >= v.length && r.ini > 0 ? r.ini - 1 : r.ini;
  const fin = r.fin >= v.length ? r.fin : r.fin + 1;
  reemplazarSeleccion(ini, fin, "", Math.min(ini === r.ini ? r.ini : r.ini - 1, v.length - (fin - ini)));
  if (ini !== r.ini) {
    const x = ui.texto.value.lastIndexOf("\n", ini - 1) + 1;
    ui.texto.setSelectionRange(x, x);
  }
}

function alternarComentario() {
  const r = lineasSeleccionadas();
  const lineas = r.texto.split("\n");
  const llenas = lineas.filter((l) => l.trim());
  if (!llenas.length) return;
  const comentadas = llenas.every((l) => /^\s*#/.test(l));
  const min = Math.min(...llenas.map((l) => /^\s*/.exec(l)[0].length));
  let delta0 = 0, total = 0;
  const nuevas = lineas.map((l, k) => {
    if (!l.trim()) return l;
    if (comentadas) {
      const m = /^(\s*)# ?/.exec(l);
      const q = m[0].length - m[1].length;
      if (k === 0) delta0 = -q;
      total -= q;
      return m[1] + l.slice(m[0].length);
    }
    if (k === 0) delta0 = 2;
    total += 2;
    return l.slice(0, min) + "# " + l.slice(min);
  });
  const s = Math.max(r.ini, r.s + (r.s > r.ini ? delta0 : 0));
  reemplazarSeleccion(r.ini, r.fin, nuevas.join("\n"), s, Math.max(s, r.e + total));
}

/** Enter: conserva la sangría, entra en objetos (`clave:`), continúa listas y cierra un `- ` vacío. */
function enterInteligente() {
  const t = ui.texto, v = t.value, s = t.selectionStart;
  const ini = v.lastIndexOf("\n", s - 1) + 1;
  const antes = v.slice(ini, s);
  const finLinea = v.indexOf("\n", s);
  const despues = v.slice(s, finLinea < 0 ? v.length : finLinea);
  const p = partirLinea(antes);
  if (p.guiones.length && !p.resto.trim() && !despues.trim()) {
    // `- ` vacío: termina la lista.
    const col = p.guiones[p.guiones.length - 1].col;
    reemplazarSeleccion(ini, s, " ".repeat(col), ini + col);
    return;
  }
  let sangria = " ".repeat(p.col);
  const sinCom = sinComentario(p.resto);
  if (/:$/.test(sinCom) || /[[{]$/.test(sinCom)) sangria += "  ";
  else if (p.guiones.length && p.clave === null && sinCom) sangria = " ".repeat(p.guiones[p.guiones.length - 1].col) + "- ";
  // Entre corchetes vacíos: `[|]` → bloque sangrado con el cierre en su propia línea.
  if (/[[{]$/.test(antes) && /^[\]}]/.test(despues)) {
    const cierre = " ".repeat(p.col);
    reemplazarSeleccion(s, t.selectionEnd, "\n" + sangria + "\n" + cierre, s + 1 + sangria.length);
    return;
  }
  reemplazarSeleccion(s, t.selectionEnd, "\n" + sangria, s + 1 + sangria.length);
}

const PARES = { "[": "]", "{": "}", '"': '"' };

/** Teclas de edición del asistente. Devuelve true si la consumió. */
function teclaAsistente(ev) {
  if (teclaAutocompletado(ev)) return true;
  const t = ui.texto, v = t.value, s = t.selectionStart, e = t.selectionEnd;
  const mod = ev.ctrlKey || ev.metaKey;
  const hecho = () => { ev.preventDefault(); cerrarAutocompletado(); return true; };

  if (mod && (ev.code === "Space" || ev.key === " ")) { ev.preventDefault(); abrirAutocompletado(true); return true; }
  if (ev.altKey && !mod && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
    const dir = ev.key === "ArrowUp" ? -1 : 1;
    if (ev.shiftKey) duplicarLineas(dir); else moverLineas(dir);
    return hecho();
  }
  if (mod && !ev.altKey && (ev.key === "/" || ev.code === "Slash")) { alternarComentario(); return hecho(); }
  if (mod && ev.shiftKey && ev.key.toLowerCase() === "k") { borrarLineas(); return hecho(); }
  if (mod || ev.altKey) return false;

  if (ev.key === "Enter" && !ev.shiftKey) { enterInteligente(); return hecho(); }
  if (PARES[ev.key] && s !== e) {
    // Envolver la selección.
    reemplazarSeleccion(s, e, ev.key + v.slice(s, e) + PARES[ev.key], s + 1, e + 1);
    return hecho();
  }
  if ((ev.key === "]" || ev.key === "}" || ev.key === '"') && s === e && v[s] === ev.key) {
    t.setSelectionRange(s + 1, s + 1);
    ev.preventDefault();
    return true;
  }
  if (PARES[ev.key] && s === e && (s >= v.length || /[\s\]},]/.test(v[s]))) {
    if (ev.key === '"' && /[\w"]/.test(v[s - 1] || "")) return false;
    reemplazarSeleccion(s, e, ev.key + PARES[ev.key], s + 1);
    ev.preventDefault();
    return true;
  }
  if (ev.key === "Backspace" && s === e && s > 0) {
    if (PARES[v[s - 1]] && v[s] === PARES[v[s - 1]]) {
      reemplazarSeleccion(s - 1, s + 1, "", s - 1);
      ev.preventDefault();
      return true;
    }
    const ini = v.lastIndexOf("\n", s - 1) + 1;
    const antes = v.slice(ini, s);
    if (antes.length >= 2 && /^ +$/.test(antes)) {
      const q = antes.length % 2 === 0 ? 2 : 1;
      reemplazarSeleccion(s - q, s, "", s - q);
      ev.preventDefault();
      return true;
    }
  }
  return false;
}

function iniciarAsistente() {
  const zona = ui.texto.parentElement;
  AC.el = document.createElement("div");
  AC.el.id = "autocompletar";
  AC.el.hidden = true;
  zona.appendChild(AC.el);
  ui.texto.setAttribute("aria-autocomplete", "list");
  ui.texto.setAttribute("aria-controls", "autocompletar");
  ui.texto.addEventListener("input", alEscribirAsistente);
  ui.texto.addEventListener("blur", () => setTimeout(cerrarAutocompletado, 120));
  ui.texto.addEventListener("scroll", cerrarAutocompletado);
  ui.texto.addEventListener("mousedown", cerrarAutocompletado);
  ["keyup", "click", "focus"].forEach((e) => ui.texto.addEventListener(e, actualizarAyudaCampo));
  document.addEventListener("selectionchange", () => { if (document.activeElement === ui.texto) actualizarAyudaCampo(); });
}
