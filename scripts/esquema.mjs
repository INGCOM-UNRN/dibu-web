// Extrae un "esquema" aproximado de cada tipo de diagrama para el editor visual.
//
// Fuentes:
//  1. Los fixtures YAML de dibu, parseados con el propio motor (dibu_parse): campos
//     observados por ruta (`system.zeta`, `forward[].label`), su clase de valor y ejemplos.
//  2. El código Rust de los renderizadores: claves leídas con `(b, "clave")` / `b.get("clave")`
//     (siguiendo llamadas a funciones auxiliares) y valores enumerados en `matches!`/`match`.
//     En los campos anidados (`disturbance[].from`), los `match` sobre `.get("clave")` de los
//     archivos del renderizador: sus brazos `Some("a")`, y el que comparte brazo con `None` es el
//     valor por defecto.
//
// Resultado: { tipo: { campos: { ruta: { k: [clases], ej: [valores], en?: [enum], def? } }, orden: [claves] } }
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_EJ = 14;

export function clase(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

function registrar(campos, ruta, v) {
  const c = (campos[ruta] ||= { k: [], ej: [] });
  const k = clase(v);
  if (!c.k.includes(k)) c.k.push(k);
  if (k !== "array" && k !== "object" && k !== "null") {
    if (!c.ej.some((x) => x === v) && c.ej.length < MAX_EJ && !(typeof v === "string" && v.length > 60)) c.ej.push(v);
  } else if (c.ej.length < 3 && !c.ej.some((x) => JSON.stringify(x) === JSON.stringify(v)) && JSON.stringify(v).length < 200) {
    c.ej.push(v);
  }
}

function recorrer(campos, ruta, v) {
  registrar(campos, ruta, v);
  if (Array.isArray(v)) for (const x of v) recorrer(campos, ruta + "[]", x);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) recorrer(campos, `${ruta}.${k}`, x);
}

/** Campos observados en los bloques de ejemplo. `parsear(texto)` devuelve la raíz JSON. */
export function desdeFixtures(textos, parsear) {
  const tipos = {};
  for (const texto of textos) {
    let raiz;
    try { raiz = parsear(texto); } catch { continue; }
    const lista = Array.isArray(raiz) ? raiz : raiz && Array.isArray(raiz.blocks) ? raiz.blocks : [raiz];
    for (const b of lista) {
      if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
      const t = (tipos[b.type] ||= { campos: {}, orden: [] });
      for (const [k, v] of Object.entries(b)) {
        if (k === "type") continue;
        if (!t.orden.includes(k)) t.orden.push(k);
        recorrer(t.campos, k, v);
      }
    }
  }
  return tipos;
}

// ---------------------------------------------------------------- código fuente
function archivosRs(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) archivosRs(p, out);
    else if (n.endsWith(".rs")) out.push(p);
  }
  return out;
}

function cuerpoDesde(src, i) {
  const ini = src.indexOf("{", i);
  if (ini < 0) return "";
  let prof = 0;
  for (let j = ini; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"') { // saltar literales de cadena
      j++;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "{") prof++;
    else if (ch === "}" && --prof === 0) return src.slice(ini, j + 1);
  }
  return src.slice(ini);
}

const VAR_BLOQUE = "(?:b|bloque|blk|item|it)";
const RE_CLAVE = new RegExp(`\\(\\s*&?${VAR_BLOQUE}\\s*,\\s*"([A-Za-z][A-Za-z0-9_]*)"`, "g");
const RE_GET = new RegExp(`${VAR_BLOQUE}\\.get\\(\\s*"([A-Za-z][A-Za-z0-9_]*)"`, "g");
const RE_LLAMADA = new RegExp(`\\b([a-z_][a-z0-9_]*)\\s*\\(\\s*(?:&?\\s*(?:mut\\s+)?c\\s*,\\s*)?&?${VAR_BLOQUE}\\b`, "g");

/** Los `match` sobre `….get("clave")…` de `src`: { clave: { en: [valores], def? } }. */
export function enumsAnidados(src) {
  const out = {};
  for (const m of src.matchAll(/\bmatch\s+([^{;]*?\.get\(\s*"([A-Za-z][A-Za-z0-9_]*)"\s*\)[^{;]*)\{/g)) {
    const clave = m[2];
    const cuerpo = cuerpoDesde(src, m.index + m[0].length - 1);
    const valores = [];
    let def;
    // Cada brazo: el patrón hasta `=>` (con guarda opcional), al principio de un renglón.
    for (const brazo of cuerpo.matchAll(/(?:^|\n)\s*([^\n=]*?)\s*(?:\bif\b[^\n]*?)?=>/g)) {
      const patron = brazo[1];
      const literales = [...patron.matchAll(/Some\(\s*"([^"]*)"\s*\)/g)].map((x) => x[1]);
      for (const v of literales) if (!valores.includes(v)) valores.push(v);
      if (/\bNone\b/.test(patron) && literales.length && !/\bif\b/.test(brazo[0])) def ??= literales[0];
    }
    if (valores.length > 1) {
      const e = (out[clave] ||= { en: [] });
      for (const v of valores) if (!e.en.includes(v)) e.en.push(v);
      if (def !== undefined) e.def ??= def;
    }
  }
  return out;
}

export function desdeFuente(dirCrates) {
  if (!existsSync(dirCrates)) return {};
  const fns = new Map();
  const archivoDe = new Map();
  const fuentes = new Map();
  const registros = [];
  for (const f of archivosRs(dirCrates)) {
    if (f.includes("/tests/") || f.includes("dibu-cli")) continue;
    let src = readFileSync(f, "utf8");
    const corte = src.search(/#\[cfg\(test\)\]/);
    if (corte >= 0) src = src.slice(0, corte);
    fuentes.set(f, src);
    for (const m of src.matchAll(/\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g)) {
      if (!fns.has(m[1])) {
        fns.set(m[1], cuerpoDesde(src, m.index));
        archivoDe.set(m[1], f);
      }
    }
    for (const m of src.matchAll(/registrar\(\s*"([a-z_]+)"\s*,\s*((?:[a-z_][a-z0-9_]*::)*[a-z_][a-z0-9_]*)\s*\)/g)) {
      registros.push([m[1], m[2].split("::").pop()]);
    }
    // Macro de dibu-comp/dibu-math: registrar_tipos!(reg, "heap" => estructuras::render_heap, …)
    for (const inv of src.matchAll(/registrar_tipos!\(\s*reg\s*,([^;]*?)\);/g)) {
      for (const m of inv[1].matchAll(/"([a-z_0-9]+)"\s*=>\s*((?:[a-z_][a-z0-9_]*::)*[a-z_][a-z0-9_]*)/g)) {
        registros.push([m[1], m[2].split("::").pop()]);
      }
    }
    // Registros con closure: reg.registrar("tree", |c, b| envolver_tipo("tree", arbol(c, b)));
    for (const m of src.matchAll(/registrar\(\s*"([a-z_]+)"\s*,\s*\|/g)) {
      const fin = src.indexOf("reg.registrar", m.index + 10);
      const nombre = `__closure_${m[1]}`;
      fns.set(nombre, src.slice(m.index, fin < 0 ? src.indexOf("\n}", m.index) : fin));
      archivoDe.set(nombre, f);
      registros.push([m[1], nombre]);
    }
  }

  const tipos = {};
  for (const [tipo, fn] of registros) {
    const claves = new Set();
    const enums = {};
    const defs = {};
    const vistos = new Set();
    const archivos = new Set();
    const visitar = (nombre, prof) => {
      if (vistos.has(nombre) || prof > 3 || !fns.has(nombre)) return;
      vistos.add(nombre);
      archivos.add(archivoDe.get(nombre));
      const cuerpo = fns.get(nombre);
      for (const re of [RE_CLAVE, RE_GET]) for (const m of cuerpo.matchAll(re)) claves.add(m[1]);
      // let var = …(b, "clave")…;  + matches!(var, "a" | "b") / match var { "a" => … }
      for (const m of cuerpo.matchAll(new RegExp(`let\\s+(?:mut\\s+)?([a-z_][a-z0-9_]*)\\s*(?::[^=]+)?=\\s*([^;]*?\\(\\s*&?${VAR_BLOQUE}\\s*,\\s*"([A-Za-z0-9_]+)"[^;]*);`, "g"))) {
        const [, v, expr, clave] = m;
        const d = /unwrap_or\(\s*"([^"]*)"\s*\)/.exec(expr);
        if (d) defs[clave] = d[1];
        const resto = cuerpo.slice(m.index, m.index + 4000);
        const valores = new Set();
        const mm = new RegExp(`matches!\\(\\s*${v}\\s*,\\s*((?:"[^"]*"\\s*\\|?\\s*)+)`).exec(resto);
        if (mm) for (const x of mm[1].matchAll(/"([^"]*)"/g)) valores.add(x[1]);
        const mt = new RegExp(`match\\s+${v}\\s*\\{`).exec(resto);
        if (mt) {
          const bloque = cuerpoDesde(resto, mt.index);
          for (const x of bloque.matchAll(/(?:^|[\n{,])\s*((?:"[^"]*"\s*\|?\s*)+)=>/g)) for (const y of x[1].matchAll(/"([^"]*)"/g)) valores.add(y[1]);
        }
        if (d) valores.add(d[1]);
        if (valores.size > 1) enums[clave] = [...valores];
      }
      // opcion(b, "clave", &["a", "b"], "defecto")
      for (const m of cuerpo.matchAll(new RegExp(`opcion\\(\\s*&?${VAR_BLOQUE}\\s*,\\s*"([A-Za-z0-9_]+)"\\s*,\\s*&\\[([^\\]]*)\\]\\s*,\\s*"([^"]*)"`, "g"))) {
        claves.add(m[1]);
        enums[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
        defs[m[1]] = m[3];
      }
      for (const m of cuerpo.matchAll(RE_LLAMADA)) visitar(m[1], prof + 1);
    };
    visitar(fn, 0);
    claves.delete("type");
    const anidados = {};
    for (const a of archivos) {
      for (const [k, e] of Object.entries(enumsAnidados(fuentes.get(a) || ""))) {
        const x = (anidados[k] ||= { en: [] });
        for (const v of e.en) if (!x.en.includes(v)) x.en.push(v);
        if (e.def !== undefined) x.def ??= e.def;
      }
    }
    tipos[tipo] = { claves: [...claves], enums, defs, anidados };
  }
  return tipos;
}

/** Combina ambas fuentes en el esquema final. */
export function construirEsquema(fixtures, fuente) {
  const out = {};
  for (const tipo of new Set([...Object.keys(fixtures), ...Object.keys(fuente)])) {
    const f = fixtures[tipo] || { campos: {}, orden: [] };
    const s = fuente[tipo] || { claves: [], enums: {}, defs: {} };
    const campos = f.campos;
    for (const k of s.claves) campos[k] ||= { k: [], ej: [] };
    for (const [k, en] of Object.entries(s.enums)) campos[k].en = en;
    for (const [k, d] of Object.entries(s.defs)) campos[k].def = d;
    // Un campo que es un objeto o una lista de objetos (`disturbance`) comparte las subclaves de
    // las dos formas: `disturbance.from` sale de `disturbance[].from` y al revés.
    for (const [ruta, c] of Object.entries({ ...campos })) {
      if (!(c.k.includes("object") && c.k.includes("array"))) continue;
      for (const [otra, x] of Object.entries({ ...campos })) {
        for (const [de, a] of [[`${ruta}[].`, `${ruta}.`], [`${ruta}.`, `${ruta}[].`]]) {
          if (otra.startsWith(de) && !otra.slice(de.length).includes(".") && !otra.slice(de.length).includes("[")) {
            const destino = a + otra.slice(de.length);
            campos[destino] ||= { k: [...x.k], ej: [...x.ej] };
          }
        }
      }
    }
    // Un campo anidado (`disturbance[].from`) toma los valores del `match` sobre su clave, y
    // también uno de primer nivel que el código no lee del bloque con un nombre conocido (el
    // `sign` de un lazo de `block_diagram`): si lo lee del bloque, un `match` de otro tipo del
    // mismo archivo no le corresponde.
    for (const [ruta, c] of Object.entries(campos)) {
      const k = /(?:^|[.\]])([A-Za-z0-9_]+)$/.exec(ruta)?.[1];
      const a = k && (s.anidados || {})[k];
      if (!a || c.en || (ruta === k && s.claves.includes(k))) continue;
      c.en = a.en;
      if (a.def !== undefined && c.def === undefined) c.def = a.def;
    }
    const orden = [...f.orden, ...s.claves.filter((k) => !f.orden.includes(k))];
    if (!orden.includes("title")) orden.unshift("title");
    campos.title ||= { k: ["string"], ej: [] };
    out[tipo] = { campos, orden };
  }
  return out;
}
