// dibu-web · editor visual: inspector de formularios para el bloque activo.
//
// El modelo es la raíz parseada (por el motor, con el orden de claves original) del trozo
// seleccionado. Cada cambio en el formulario se serializa de nuevo a YAML (o JSON, si el
// documento era JSON) y reemplaza sólo las líneas de ese trozo en el editor de código.
// Este archivo sólo declara funciones; `iniciarVisual()` se llama desde app.js.
"use strict";

const V = {
  abierto: false,
  sel: { trozo: -1, sub: 0 },
  pendienteUltimo: false, // seleccionar el último bloque tras insertar uno nuevo
  raiz: null,             // raíz parseada del trozo seleccionado
  fuente: null,           // texto (rango de líneas) del que salió `raiz`
  esJSON: false,
  error: null,
  historial: [],
  rehacer: [],
  ultimoCambio: { clave: "", t: 0 },
  version: 0,
};

// ======================================================================
// Serialización YAML (estilo de los fixtures de dibu: flujo para lo corto)
// ======================================================================
const ANCHO_FLUJO = 76;

function claseValor(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

/** ¿Se puede escribir `s` sin comillas? Fuera de flujo (`[…]`, `{…}`) se admiten comas y corchetes internos. */
function planoSeguro(s, enFlujo = true) {
  if (!s || s !== s.trim()) return false;
  if (/^(true|false|yes|no|on|off|null|y|n|~)$/i.test(s)) return false;
  if (/^[-+]?(\.?\d|\.(inf|nan))/i.test(s) && /^[-+]?(0x[\da-f_]+|0o[0-7_]+|0b[01_]+|[\d_]*\.?[\d_]*([eE][-+]?\d+)?|\.(inf|nan))$/i.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #|[\t\n\r]/.test(s)) return false;
  if (enFlujo && /[[\]{},]/.test(s)) return false;
  return true;
}

function escalarYaml(v, enFlujo = true) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  const s = String(v);
  return planoSeguro(s, enFlujo) ? s : JSON.stringify(s);
}

function claveYaml(k) {
  return planoSeguro(k) ? k : JSON.stringify(k);
}

/** Representación en flujo (`[1, 2]`, `{a: 1}`) o null si no conviene. */
function aFlujo(v, prof = 0) {
  const c = claseValor(v);
  if (c === "string" && /\n/.test(v)) return null;
  if (c !== "array" && c !== "object") return escalarYaml(v);
  if (prof > 2) return null;
  const partes = [];
  if (c === "array") {
    for (const x of v) { const f = aFlujo(x, prof + 1); if (f === null) return null; partes.push(f); }
    return `[${partes.join(", ")}]`;
  }
  for (const [k, x] of Object.entries(v)) { const f = aFlujo(x, prof + 1); if (f === null) return null; partes.push(`${claveYaml(k)}: ${f}`); }
  return `{${partes.join(", ")}}`;
}

function textoBloque(s, ind) {
  const pad = " ".repeat(ind);
  const ind1 = /^\s/.test(s) ? String(2) : "";
  const fin = s.endsWith("\n") ? "" : "-";
  return [`|${ind1}${fin}`, ...s.replace(/\n$/, "").split("\n").map((l) => (l ? pad + l : ""))];
}

/** Líneas de un mapeo en estilo bloque, con indentación `ind`. */
function mapeoYaml(obj, ind) {
  const pad = " ".repeat(ind);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const clave = `${pad}${claveYaml(k)}:`;
    const c = claseValor(v);
    if (c === "string" && v.includes("\n")) {
      const [cab, ...resto] = textoBloque(v, ind + 2);
      out.push(`${clave} ${cab}`, ...resto);
      continue;
    }
    if (c !== "array" && c !== "object") { out.push(`${clave} ${escalarYaml(v, false)}`); continue; }
    const f = aFlujo(v);
    const corto = (c === "array" && v.length === 0) || (c === "object" && !Object.keys(v).length);
    if (f !== null && (corto || c !== "array" && c !== "object" || clave.length + 1 + f.length <= ANCHO_FLUJO)) {
      out.push(`${clave} ${f}`);
    } else if (c === "array") {
      out.push(clave, ...v.flatMap((x) => itemYaml(x, ind + 2)));
    } else {
      out.push(clave, ...mapeoYaml(v, ind + 2));
    }
  }
  return out;
}

/** Líneas de un elemento de secuencia (`- …`) con indentación `ind`. */
function itemYaml(v, ind) {
  const pad = " ".repeat(ind);
  const c = claseValor(v);
  const f = aFlujo(v);
  if (f !== null && (c !== "object" && c !== "array" || pad.length + 2 + f.length <= ANCHO_FLUJO)) {
    if (c !== "object" || ind > 0) return [`${pad}- ${f}`];
  }
  if (c === "object" && Object.keys(v).length) {
    const lineas = mapeoYaml(v, ind + 2);
    lineas[0] = `${pad}- ${lineas[0].slice(ind + 2)}`;
    return lineas;
  }
  if (c === "array" && v.length) {
    const lineas = v.flatMap((x) => itemYaml(x, ind + 2));
    lineas[0] = `${pad}- ${lineas[0].slice(ind + 2)}`;
    return lineas;
  }
  return [`${pad}- ${f ?? escalarYaml(v)}`];
}

/** JSON con indentación, pero con listas/objetos cortos en una sola línea. */
function jsonCompacto(v, ind = 0) {
  const plano = JSON.stringify(v);
  const vacio = v === null || typeof v !== "object" || !Object.keys(v).length;
  if (vacio || (ind > 0 && plano.length + ind <= ANCHO_FLUJO)) return plano;
  const pad = " ".repeat(ind + 2);
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + jsonCompacto(x, ind + 2)).join(",\n")}\n${" ".repeat(ind)}]`;
  const partes = Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${jsonCompacto(x, ind + 2 + k.length + 4)}`);
  return `{\n${partes.join(",\n")}\n${" ".repeat(ind)}}`;
}

/** Serializa la raíz de un trozo respetando su forma original. */
function serializarRaiz(raiz, esJSON) {
  if (esJSON) return jsonCompacto(raiz);
  const c = claseValor(raiz);
  if (c === "array") return raiz.flatMap((x) => itemYaml(x, 0)).join("\n");
  if (c === "object") return mapeoYaml(raiz, 0).join("\n");
  return escalarYaml(raiz);
}

function bloquesDe(raiz) {
  if (Array.isArray(raiz)) return raiz;
  if (raiz && typeof raiz === "object" && Array.isArray(raiz.blocks)) return raiz.blocks;
  return raiz && typeof raiz === "object" ? [raiz] : [];
}

const clonar = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ======================================================================
// Esquema (campos conocidos por tipo, extraídos en el build)
// ======================================================================
const CAMPOS_COMUNES = {
  title: { k: ["string"], ej: [], nota: "título" },
  subtitle: { k: ["string"], ej: [], nota: "subtítulo" },
  id: { k: ["string"], ej: [], nota: "nombre del archivo al exportar" },
  inkSaver: { k: ["boolean"], ej: [true, false], nota: "paleta ahorro de tinta (pisa la global)" },
};

function esquemaTipo(tipo) {
  return (DATOS.esquema && DATOS.esquema[tipo]) || { campos: {}, orden: [] };
}

function infoCampo(tipo, ruta) {
  return esquemaTipo(tipo).campos[ruta] || (ruta in CAMPOS_COMUNES ? CAMPOS_COMUNES[ruta] : null);
}

/** Claves sugeridas para el objeto en `ruta` ("" = raíz del bloque). */
function clavesSugeridas(tipo, ruta) {
  const esq = esquemaTipo(tipo);
  if (!ruta) {
    const claves = [...esq.orden, ...Object.keys(CAMPOS_COMUNES)];
    return [...new Set(claves)].filter((k) => k !== "type");
  }
  const pref = ruta + ".";
  const out = [];
  for (const r of Object.keys(esq.campos)) {
    if (!r.startsWith(pref)) continue;
    const resto = r.slice(pref.length);
    if (/^[^.[\]]+$/.test(resto)) out.push(resto);
  }
  return out;
}

function valorPorDefecto(info) {
  if (!info) return "";
  if (info.def !== undefined) return info.def;
  if (info.en && info.en.length) return info.en[0];
  if (info.ej && info.ej.length) return clonar(info.ej[0]);
  switch ((info.k || [])[0]) {
    case "number": return 0;
    case "boolean": return true;
    case "array": return [];
    case "object": return {};
    default: return "";
  }
}

function describirInfo(info) {
  if (!info) return "campo sin datos de ejemplo";
  const partes = [];
  if (info.nota) partes.push(info.nota);
  if (info.k && info.k.length) partes.push("tipo: " + info.k.map(nombreClase).join(" o "));
  if (info.en) partes.push("valores: " + info.en.join(", "));
  else if (info.ej && info.ej.length && typeof info.ej[0] !== "object") partes.push("ej.: " + info.ej.slice(0, 5).map((x) => JSON.stringify(x)).join(", "));
  if (info.def !== undefined) partes.push(`por defecto: ${info.def}`);
  return partes.join(" · ") || "campo leído por el motor (sin ejemplos)";
}

function nombreClase(k) {
  return { number: "número", string: "texto", boolean: "sí/no", array: "lista", object: "objeto", null: "vacío" }[k] || k;
}

function parsearEscalar(s) {
  const t = s.trim();
  if (t === "") return "";
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (/^null$/i.test(t)) return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return s;
}

// ======================================================================
// Sincronización con el editor de código
// ======================================================================
function rangoTrozo(tr) {
  return [tr.rIni, tr.rFin];
}

function lineasDocumento() {
  return ui.texto.value.split("\n");
}

function textoRango(tr) {
  const [a, b] = rangoTrozo(tr);
  return lineasDocumento().slice(a, b).join("\n");
}

function guardarHistorial(clave) {
  const ahora = Date.now();
  const mismo = clave && V.ultimoCambio.clave === clave && ahora - V.ultimoCambio.t < 900;
  V.ultimoCambio = { clave, t: ahora };
  if (mismo) return;
  V.historial.push({ texto: ui.texto.value, sel: { ...V.sel } });
  if (V.historial.length > 200) V.historial.shift();
  V.rehacer.length = 0;
  actualizarBotonesHistorial();
}

function offsetLinea(lineas, i) {
  let p = 0;
  for (let k = 0; k < i && k < lineas.length; k++) p += lineas[k].length + 1;
  return Math.min(p, ui.texto.value.length);
}

/** Reemplaza las líneas [a, b) del documento por `nuevo` (si a === b, inserta antes de la línea a). */
function reemplazarLineas(a, b, nuevo) {
  const L = lineasDocumento();
  const ini = offsetLinea(L, a);
  if (b <= a) {
    const alFinal = a >= L.length;
    ui.texto.setRangeText(alFinal ? "\n" + nuevo : nuevo + "\n", ini, ini, "preserve");
    return;
  }
  const fin = offsetLinea(L, b - 1) + L[Math.min(b, L.length) - 1].length;
  ui.texto.setRangeText(nuevo, ini, fin, "preserve");
}

/** Escribe el modelo en el editor de código (sólo las líneas del trozo). */
function confirmarCambio({ clave = "", reconstruir = false, rapido = false } = {}) {
  const tr = estado.trozos[V.sel.trozo];
  if (!tr || V.raiz === null) return;
  guardarHistorial(clave);
  const nuevo = serializarRaiz(V.raiz, V.esJSON);
  const [a, b] = rangoTrozo(tr);
  reemplazarLineas(a, b, nuevo);
  V.fuente = nuevo;
  // Recalcular el troceo ya, para que el rango de líneas siga siendo válido.
  estado.trozos = trocear(ui.texto.value, estado.modo);
  alEditar({ retardo: rapido ? 40 : 160 });
  if (reconstruir) pintarInspector();
  else actualizarNavegador();
}

/** Llamado por app.js tras cada troceo: reparsea si el texto del trozo cambió desde afuera. */
async function sincronizarVisual() {
  if (!V.abierto) return;
  const n = estado.trozos.length;
  if (V.pendienteUltimo && n) {
    V.pendienteUltimo = false;
    V.sel = { trozo: n - 1, sub: 0 };
  }
  if (V.sel.trozo >= n) V.sel = { trozo: n - 1, sub: 0 };
  if (V.sel.trozo < 0 && n) V.sel = { trozo: 0, sub: 0 };
  estado.activo = V.sel.trozo;
  actualizarNavegador();
  const claveSel = `${V.sel.trozo}:${V.sel.sub}`;
  if (claveSel !== V.ultimaSel) {
    V.ultimaSel = claveSel;
    requestAnimationFrame(() => resaltarActivo(prefs.seguir));
  }
  const tr = estado.trozos[V.sel.trozo];
  if (!tr) { V.raiz = null; V.fuente = null; V.error = null; pintarInspector(); return; }
  const texto = textoRango(tr);
  if (texto === V.fuente && V.raiz !== null) return;
  const v = ++V.version;
  const r = await estado.motor.llamar("dibu_parse", texto);
  if (v !== V.version) return;
  V.fuente = texto;
  V.esJSON = /^\s*[[{]/.test(texto);
  if (!r.ok || r.resultado.error) {
    V.raiz = null;
    V.error = ajustarError(r.error || r.resultado.error, tr.rIni).texto;
  } else {
    V.raiz = r.resultado.root ?? null;
    V.error = null;
    const bs = bloquesDe(V.raiz);
    if (V.sel.sub >= bs.length) V.sel.sub = Math.max(0, bs.length - 1);
  }
  pintarInspector();
}

function seleccionarVisual(trozo, sub = 0) {
  if (trozo === V.sel.trozo && sub === V.sel.sub && V.raiz !== null) return;
  const mismoTrozo = trozo === V.sel.trozo;
  V.sel = { trozo, sub };
  estado.activo = trozo;
  resaltarTodo();
  resaltarActivo(prefs.seguir);
  if (mismoTrozo && V.raiz !== null) { pintarInspector(); return; }
  V.fuente = null;
  V.raiz = null;
  sincronizarVisual();
}

function abrirVisual(abrir) {
  V.abierto = abrir;
  prefs.vista = abrir ? "visual" : "codigo";
  guardarPrefs();
  $("#t-codigo").classList.toggle("activo", !abrir);
  $("#t-visual").classList.toggle("activo", abrir);
  $("#t-codigo").setAttribute("aria-selected", String(!abrir));
  $("#t-visual").setAttribute("aria-selected", String(abrir));
  $(".codigo").hidden = abrir;
  $("#visual").hidden = !abrir;
  if (abrir) {
    if (V.sel.trozo < 0 || V.sel.trozo !== estado.activo) V.sel = { trozo: Math.max(0, estado.activo), sub: 0 };
    V.fuente = null;
    V.raiz = null;
    sincronizarVisual();
  } else {
    // Volver al código con el cursor en el bloque que se estaba editando.
    const tr = estado.trozos[V.sel.trozo];
    setTimeout(() => { if (tr) irAlBloque(V.sel.trozo); else ui.texto.focus(); }, 0);
  }
}

// ---------- deshacer / rehacer ----------
function restaurar(desde, hacia) {
  const e = desde.pop();
  if (!e) return;
  hacia.push({ texto: ui.texto.value, sel: { ...V.sel } });
  ui.texto.value = e.texto;
  V.sel = e.sel;
  V.fuente = null;
  V.raiz = null;
  V.ultimoCambio = { clave: "", t: 0 };
  alEditar({ retardo: 0 });
  actualizarBotonesHistorial();
}
function deshacerVisual() { restaurar(V.historial, V.rehacer); }
function rehacerVisual() { restaurar(V.rehacer, V.historial); }
function actualizarBotonesHistorial() {
  const d = $("#v-deshacer"), r = $("#v-rehacer");
  if (d) d.disabled = !V.historial.length;
  if (r) r.disabled = !V.rehacer.length;
}

// ======================================================================
// Operaciones sobre bloques
// ======================================================================
function bloquesDelTrozo() {
  return V.raiz === null ? [] : bloquesDe(V.raiz);
}

function trozoMovible() {
  return estado.trozos.length > 1 && !estado.trozos.some((t) => t.entero);
}

function moverBloque(dir) {
  const bs = bloquesDelTrozo();
  const j = V.sel.sub + dir;
  if (bs.length > 1 && j >= 0 && j < bs.length && Array.isArray(bs)) {
    [bs[V.sel.sub], bs[j]] = [bs[j], bs[V.sel.sub]];
    V.sel.sub = j;
    confirmarCambio({ reconstruir: true });
    return;
  }
  const t = V.sel.trozo, u = t + dir;
  if (!trozoMovible() || u < 0 || u >= estado.trozos.length) return;
  const [a, b] = dir < 0 ? [estado.trozos[u], estado.trozos[t]] : [estado.trozos[t], estado.trozos[u]];
  const lineas = lineasDocumento();
  const A = lineas.slice(a.ini, a.fin), medio = lineas.slice(a.fin, b.ini), B = lineas.slice(b.ini, b.fin);
  guardarHistorial("");
  reemplazarLineas(a.ini, b.fin, [...B, ...medio, ...A].join("\n"));
  V.sel = { trozo: u, sub: 0 };
  V.fuente = null;
  V.raiz = null;
  alEditar({ retardo: 0 });
}

function duplicarBloque() {
  const bs = bloquesDelTrozo();
  if (bs.length > 1 || (estado.modo === "md" && Array.isArray(V.raiz))) {
    bs.splice(V.sel.sub + 1, 0, clonar(bs[V.sel.sub]));
    V.sel.sub++;
    confirmarCambio({ reconstruir: true });
    return;
  }
  const tr = estado.trozos[V.sel.trozo];
  if (!tr || tr.entero) { avisar("Este documento no es una lista de bloques"); return; }
  const original = lineasDocumento().slice(tr.ini, tr.fin).join("\n");
  guardarHistorial("");
  reemplazarLineas(tr.ini, tr.fin, original + "\n\n" + original);
  V.sel = { trozo: V.sel.trozo + 1, sub: 0 };
  V.fuente = null;
  V.raiz = null;
  alEditar({ retardo: 0 });
}

function eliminarBloque() {
  const bs = bloquesDelTrozo();
  if (bs.length > 1 && Array.isArray(bs)) {
    bs.splice(V.sel.sub, 1);
    V.sel.sub = Math.min(V.sel.sub, bs.length - 1);
    confirmarCambio({ reconstruir: true });
    return;
  }
  const tr = estado.trozos[V.sel.trozo];
  if (!tr) return;
  const lineas = lineasDocumento();
  let fin = tr.fin;
  while (fin < lineas.length && !lineas[fin].trim()) fin++; // también las líneas en blanco que siguen
  guardarHistorial("");
  const a = tr.ini, b = Math.min(fin, lineas.length);
  // Borrado de líneas completas (incluido el salto final).
  let ini = 0;
  for (let i = 0; i < a; i++) ini += lineas[i].length + 1;
  let f = ini;
  for (let i = a; i < b; i++) f += lineas[i].length + 1;
  ui.texto.setRangeText("", ini, Math.min(f, ui.texto.value.length), "preserve");
  V.sel = { trozo: Math.max(0, Math.min(V.sel.trozo, estado.trozos.length - 2)), sub: 0 };
  V.fuente = null;
  V.raiz = null;
  alEditar({ retardo: 0 });
}

function nuevoBloque(tipo) {
  const ej = ejemploPorTipo.get(tipo);
  guardarHistorial("");
  V.pendienteUltimo = true;
  if (ej) insertarEjemplo(ej);
  else insertarEjemplo({ tipo, texto: `- type: ${tipo}` });
}

// ======================================================================
// Interfaz del inspector
// ======================================================================
function el(etiqueta, props = {}, ...hijos) {
  const e = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h instanceof Node ? h : String(h));
  return e;
}

function actualizarNavegador() {
  const lista = $("#v-lista");
  if (!lista) return;
  const items = estado.tarjetas;
  lista.innerHTML = "";
  items.forEach((d, i) => {
    // Un fence Markdown con varios bloques se lista bloque por bloque.
    const subs = d.subtipos && d.subtipos.length > 1
      ? d.subtipos.map((t, k) => ({ sub: k, num: `#${i + 1}.${k + 1}`, tipo: t, titulo: (d.subtitulos || [])[k] || "" }))
      : [{ sub: d.sub || 0, num: `#${i + 1}`, tipo: d.tipo, titulo: d.titulo || d.id || d.nombre || "" }];
    for (const x of subs) {
      const sel = d.trozo === V.sel.trozo && x.sub === V.sel.sub;
      lista.append(el("li", {
        class: (sel ? "sel" : "") + (d.error ? " err" : ""),
        title: d.error || x.titulo,
        onclick: () => seleccionarVisual(d.trozo, x.sub),
      }, el("span", { class: "num" }, x.num), el("span", { class: "tipo" }, x.tipo || "?"), el("span", { class: "tit" }, x.titulo)));
    }
  });
  if (!items.length) lista.append(el("li", { class: "vacio-lista" }, "Sin bloques: agregá uno con «+ Nuevo»."));
  const selEl = lista.querySelector(".sel");
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
  const multi = bloquesDelTrozo().length > 1;
  $("#v-arriba").disabled = !(multi ? V.sel.sub > 0 : trozoMovible() && V.sel.trozo > 0);
  $("#v-abajo").disabled = !(multi ? V.sel.sub < bloquesDelTrozo().length - 1 : trozoMovible() && V.sel.trozo < estado.trozos.length - 1);
  $("#v-duplicar").disabled = !estado.trozos[V.sel.trozo];
  $("#v-eliminar").disabled = !estado.trozos[V.sel.trozo];
}

function pintarInspector() {
  const cont = $("#v-form");
  if (!cont) return;
  const scroll = cont.scrollTop;
  const foco = document.activeElement && cont.contains(document.activeElement) ? document.activeElement.dataset.ruta : null;
  cont.innerHTML = "";
  actualizarNavegador();
  const tr = estado.trozos[V.sel.trozo];
  if (!tr) {
    cont.append(el("div", { class: "vacio" }, "No hay bloques todavía. Usá «+ Nuevo» para agregar un diagrama."));
    return;
  }
  if (V.error) {
    cont.append(el("div", { class: "v-error" },
      el("b", {}, "Este bloque tiene un error de sintaxis y no se puede editar visualmente."),
      el("pre", {}, V.error),
      el("button", { type: "button", onclick: () => abrirVisual(false) }, "Corregir en Código")));
    return;
  }
  if (V.raiz === null) { cont.append(el("div", { class: "vacio" }, "Cargando…")); return; }
  const bs = bloquesDe(V.raiz);
  const b = bs[V.sel.sub];
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    cont.append(el("div", { class: "v-error" }, "El bloque no es un diccionario con «type»."));
    return;
  }
  const tipo = typeof b.type === "string" ? b.type : "";
  const conocido = estado.tipos.includes(tipo);

  cont.append(el("div", { class: "v-cabecera" },
    el("label", { class: "v-tipo" }, "Tipo ",
      el("select", {
        title: "Cambiar el tipo conserva los campos existentes",
        onchange: (e) => { b.type = e.target.value; confirmarCambio({ reconstruir: true }); },
      }, ...(conocido ? [] : [el("option", { value: tipo, selected: true }, tipo || "(sin tipo)")]),
        ...estado.tipos.map((t) => el("option", { value: t, selected: t === tipo }, t)))),
    el("span", { class: "flex" }),
    el("span", { class: "nota" }, V.esJSON ? "JSON" : "YAML", tr.rFin - tr.rIni > 0 ? ` · líneas ${tr.rIni + 1}–${tr.rFin}` : "")));

  if (/(^|\n)\s*#/.test(V.fuente || "")) {
    cont.append(el("p", { class: "nota aviso-com" }, "Nota: este bloque tiene comentarios; al editarlo acá se reescribe y los comentarios se pierden."));
  }

  const campos = el("div", { class: "v-campos" });
  for (const k of Object.keys(b)) {
    if (k === "type") continue;
    campos.append(campo({
      tipo, ruta: k, etiqueta: k, valor: b[k],
      poner: (v, op) => { b[k] = v; confirmarCambio(op); },
      quitar: () => { delete b[k]; confirmarCambio({ reconstruir: true }); },
    }));
  }
  cont.append(campos);
  cont.append(agregarCampo(tipo, "", b));
  cont.scrollTop = scroll;
  if (foco) cont.querySelector(`[data-ruta="${CSS.escape(foco)}"]`)?.focus();
}

/** Selector "+ campo" con las claves conocidas que faltan. */
function agregarCampo(tipo, ruta, obj) {
  const faltan = clavesSugeridas(tipo, ruta).filter((k) => !(k in obj));
  const sel = el("select", {
    class: "v-agregar",
    onchange: (e) => {
      let k = e.target.value;
      e.target.value = "";
      if (!k) return;
      if (k === "@otro") {
        k = (prompt("Nombre del campo nuevo:") || "").trim();
        if (!k || k in obj) return;
      }
      const r = ruta ? `${ruta}.${k}` : k;
      obj[k] = valorPorDefecto(infoCampo(tipo, r));
      confirmarCambio({ reconstruir: true });
      setTimeout(() => $(`#v-form [data-ruta="${CSS.escape(r)}"]`)?.focus(), 0);
    },
  }, el("option", { value: "" }, ruta ? "+ campo…" : "+ agregar campo…"),
    ...faltan.map((k) => {
      const info = infoCampo(tipo, ruta ? `${ruta}.${k}` : k);
      return el("option", { value: k, title: describirInfo(info) }, info && info.k && info.k.length ? `${k}  (${info.k.map(nombreClase).join("/")})` : k);
    }),
    el("option", { value: "@otro" }, "otro…"));
  return el("div", { class: "v-fila-agregar" }, sel);
}

let contadorIds = 0;

/** Un campo del formulario (recursivo para listas y objetos). */
function campo({ tipo, ruta, etiqueta, valor, poner, quitar, mover }) {
  const info = infoCampo(tipo, ruta);
  const c = claseValor(valor);
  const fila = el("div", { class: `v-campo v-${c}` });
  const lab = el("label", { class: "v-etiqueta", title: `${ruta}\n${describirInfo(info)}` }, etiqueta);
  const acciones = el("span", { class: "v-acc" });
  if (mover) {
    acciones.append(el("button", { type: "button", title: "Subir", onclick: () => mover(-1) }, "↑"),
      el("button", { type: "button", title: "Bajar", onclick: () => mover(1) }, "↓"));
  }
  if (quitar) acciones.append(el("button", { type: "button", class: "quitar", title: "Quitar", onclick: quitar }, "×"));

  if (c === "array" || c === "object") {
    const det = el("details", { open: estaAbierto(ruta, valor), ontoggle: (e) => recordarAbierto(ruta, e.target.open) });
    const resumen = c === "array" ? `lista · ${valor.length}` : `${Object.keys(valor).length} campo${Object.keys(valor).length === 1 ? "" : "s"}`;
    det.append(el("summary", {}, lab, el("span", { class: "v-resumen" }, resumen), acciones));
    const cuerpo = el("div", { class: "v-hijos" });
    if (c === "array") {
      valor.forEach((x, i) => {
        cuerpo.append(campo({
          tipo, ruta: ruta + "[]", etiqueta: String(i + 1), valor: x,
          poner: (v, op) => { valor[i] = v; poner(valor, op); },
          quitar: () => { valor.splice(i, 1); poner(valor, { reconstruir: true }); },
          mover: (d) => {
            const j = i + d;
            if (j < 0 || j >= valor.length) return;
            [valor[i], valor[j]] = [valor[j], valor[i]];
            poner(valor, { reconstruir: true });
          },
        }));
      });
      cuerpo.append(el("div", { class: "v-fila-agregar" }, el("button", {
        type: "button",
        onclick: () => {
          const nuevo = valor.length ? clonar(valor[valor.length - 1]) : valorPorDefecto(infoCampo(tipo, ruta + "[]"));
          valor.push(nuevo);
          recordarAbierto(ruta, true);
          poner(valor, { reconstruir: true });
        },
      }, "+ elemento")));
    } else {
      for (const k of Object.keys(valor)) {
        cuerpo.append(campo({
          tipo, ruta: `${ruta}.${k}`, etiqueta: k, valor: valor[k],
          poner: (v, op) => { valor[k] = v; poner(valor, op); },
          quitar: () => { delete valor[k]; poner(valor, { reconstruir: true }); },
        }));
      }
      const agr = agregarCampo(tipo, ruta, valor);
      // agregarCampo confirma por su cuenta sobre el objeto mutado; propagamos para el padre.
      cuerpo.append(agr);
    }
    det.append(cuerpo);
    fila.append(det);
    return fila;
  }

  const id = `v-in-${++contadorIds}`;
  lab.htmlFor = id;
  const clave = `${V.sel.trozo}:${V.sel.sub}:${ruta}:${etiqueta}`;
  let control;
  if (c === "boolean") {
    control = el("label", { class: "interruptor" },
      el("input", { id, type: "checkbox", checked: valor, "data-ruta": ruta, onchange: (e) => poner(e.target.checked, { clave }) }),
      el("span", {}));
  } else if (c === "number") {
    control = el("input", {
      id, type: "number", value: String(valor), step: "any", "data-ruta": ruta,
      oninput: (e) => { if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) poner(e.target.valueAsNumber, { clave, rapido: true }); },
    });
    hacerArrastrable(lab, control, (v) => poner(v, { clave, rapido: true }));
    lab.classList.add("arrastrable");
    lab.title += "\nArrastrá la etiqueta para cambiar el valor (Shift ×10, Alt ÷10)";
  } else if (info && info.en && (c === "string" || c === "null")) {
    const opciones = [...new Set([...(info.en || []), ...(valor != null && valor !== "" ? [String(valor)] : [])])];
    control = el("select", { id, "data-ruta": ruta, onchange: (e) => poner(e.target.value, { clave }) },
      ...opciones.map((o) => el("option", { value: o, selected: o === valor }, o)));
  } else {
    const texto = valor === null ? "" : String(valor);
    const ejemplos = (info && info.ej || []).filter((x) => typeof x === "string" && x !== texto).slice(0, 12);
    const lista = ejemplos.length ? `${id}-l` : null;
    const alCambiar = (e) => {
      const s = e.target.value;
      poner(c === "null" ? parsearEscalar(s) : s, { clave });
    };
    if (texto.includes("\n") || texto.length > 70) {
      control = el("textarea", { id, rows: Math.min(8, texto.split("\n").length + 1), "data-ruta": ruta, oninput: alCambiar });
      control.value = texto;
    } else {
      control = el("input", { id, type: "text", value: texto, list: lista, "data-ruta": ruta, placeholder: c === "null" ? "(vacío)" : "", oninput: alCambiar });
    }
    if (lista) fila.append(el("datalist", { id: lista }, ...ejemplos.map((x) => el("option", { value: x }))));
  }
  fila.append(lab, el("div", { class: "v-control" }, control), acciones);
  return fila;
}

// Estado abierto/cerrado de los grupos, por ruta.
const abiertos = new Map();
function estaAbierto(ruta, valor) {
  if (abiertos.has(ruta)) return abiertos.get(ruta);
  const n = Array.isArray(valor) ? valor.length : Object.keys(valor).length;
  return n <= 6 && !ruta.includes("[]");
}
function recordarAbierto(ruta, abierto) { abiertos.set(ruta, abierto); }

/** Arrastrar horizontalmente la etiqueta de un número para variarlo. */
function hacerArrastrable(etiqueta, input, poner) {
  etiqueta.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const inicio = Number(input.value) || 0;
    const decimales = Math.min(4, (String(input.value).split(".")[1] || "").length);
    const base = decimales ? 10 ** -decimales : Math.abs(inicio) >= 100 ? 5 : 1;
    const x0 = e.clientX;
    etiqueta.setPointerCapture(e.pointerId);
    document.body.classList.add("arrastrando-num");
    let raf = 0;
    const mover = (ev) => {
      const paso = base * (ev.shiftKey ? 10 : 1) / (ev.altKey ? 10 : 1);
      const dec = Math.max(0, -Math.floor(Math.log10(paso) + 1e-9));
      const v = Number((inicio + Math.round((ev.clientX - x0) / 4) * paso).toFixed(Math.min(dec, 6)));
      if (String(v) === input.value) return;
      input.value = String(v);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => poner(v));
    };
    const soltar = () => {
      document.body.classList.remove("arrastrando-num");
      etiqueta.removeEventListener("pointermove", mover);
      etiqueta.removeEventListener("pointerup", soltar);
      etiqueta.removeEventListener("pointercancel", soltar);
    };
    etiqueta.addEventListener("pointermove", mover);
    etiqueta.addEventListener("pointerup", soltar);
    etiqueta.addEventListener("pointercancel", soltar);
  });
}

function iniciarVisual() {
  $("#t-codigo").onclick = () => abrirVisual(false);
  $("#t-visual").onclick = () => abrirVisual(true);
  $("#v-arriba").onclick = () => moverBloque(-1);
  $("#v-abajo").onclick = () => moverBloque(1);
  $("#v-duplicar").onclick = duplicarBloque;
  $("#v-eliminar").onclick = eliminarBloque;
  $("#v-deshacer").onclick = deshacerVisual;
  $("#v-rehacer").onclick = rehacerVisual;
  const nuevo = $("#v-nuevo");
  nuevo.onchange = () => { const t = nuevo.value; nuevo.value = ""; if (t) nuevoBloque(t); };
  $("#visual").addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const enTexto = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== "checkbox";
    if (!mod || enTexto) return;
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); deshacerVisual(); }
    else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) { e.preventDefault(); rehacerVisual(); }
  });
  actualizarBotonesHistorial();
}

function poblarNuevoBloque() {
  const sel = $("#v-nuevo");
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, "+ Nuevo…"));
  const vistos = new Set();
  for (const s of catalogo) {
    const tipos = [...new Set(s.items.map((i) => i.tipo))].filter((t) => estado.tipos.includes(t));
    if (!tipos.length) continue;
    sel.append(el("optgroup", { label: s.nombre }, ...tipos.map((t) => { vistos.add(t); return el("option", { value: t }, t); })));
  }
  const resto = estado.tipos.filter((t) => !vistos.has(t));
  if (resto.length) sel.append(el("optgroup", { label: "Otros" }, ...resto.map((t) => el("option", { value: t }, t))));
}
