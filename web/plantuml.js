// PlantUML en el navegador: el motor de @plantuml/core (PlantUML compilado a JavaScript con TeaVM).
// El build lo incrusta comprimido en window.DIBU.plantuml y acá se descomprime y se carga recién
// con el primer bloque PlantUML. Corre en el hilo principal: el motor necesita el DOM para armar
// el SVG, así que no puede ir al Web Worker de dibu.
"use strict";

const PUML = (() => {
  const datos = window.DIBU && window.DIBU.plantuml;
  const LIMITE_MS = 20000;
  let carga = null;

  async function descomprimir(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(flujo).text();
  }

  /** Ejecuta `codigo` como script clásico (los UMD de viz y los temas se cuelgan de globalThis). */
  function script(codigo) {
    return new Promise((ok, mal) => {
      const url = URL.createObjectURL(new Blob([codigo], { type: "text/javascript" }));
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => { URL.revokeObjectURL(url); s.remove(); ok(); };
      s.onerror = () => { URL.revokeObjectURL(url); s.remove(); mal(new Error("no se pudo cargar un script de PlantUML")); };
      document.head.appendChild(s);
    });
  }

  /** El módulo del motor ({ render, renderToString }), cargado una sola vez. */
  function motor() {
    if (!datos) return Promise.reject(new Error("este build de dibu-web no incluye PlantUML"));
    if (!carga) {
      carga = (async () => {
        for (const extra of datos.extras) await script(await descomprimir(extra));
        await script(await descomprimir(datos.viz));
        if (typeof Viz !== "undefined") globalThis.PLANTUML_VIZ = Viz; // eslint-disable-line no-undef
        const url = URL.createObjectURL(new Blob([await descomprimir(datos.motor)], { type: "text/javascript" }));
        try { return await import(url); } finally { URL.revokeObjectURL(url); }
      })();
      carga.catch(() => { carga = null; }); // un fallo de carga se reintenta en el próximo render
    }
    return carga;
  }

  /**
   * Las líneas para el motor y cuántas se agregaron arriba. Saca las opciones de alucarD/voight
   * (`// [ancho, 60%] [alt, …]` al principio del bloque, que PlantUML no entiende) y, si el bloque
   * no trae `@startuml`/`@startmindmap`/…, lo envuelve en `@startuml … @enduml`.
   */
  function preparar(cuerpo) {
    const lineas = cuerpo.split(/\r\n|\r|\n/);
    let i = 0;
    while (i < lineas.length && /^\s*(\/\/\s*\[.*)?$/.test(lineas[i])) i++;
    // Las líneas sacadas se cambian por vacías: así los números de línea de los errores coinciden.
    const resto = [...lineas.slice(0, i).map(() => ""), ...lineas.slice(i)];
    if (resto.some((l) => /^\s*@start\w+/.test(l))) return { lineas: resto, extra: 0 };
    return { lineas: ["@startuml", ...resto, "@enduml"], extra: 1 };
  }

  /** Un SVG de error de PlantUML ("[From … (line N)]", "Syntax Error?") como { error, linea }. */
  function errorEn(svg) {
    if (!/\(line \d+\)/.test(svg) || !/<text\b/.test(svg)) return null;
    const textos = [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text")]
      .map((t) => t.textContent.trim()).filter(Boolean);
    const origen = textos.findIndex((t) => /^\[From .*\(line \d+\)\s*\]$/.test(t));
    if (origen < 0) return null;
    const linea = Number(/\(line (\d+)\)/.exec(textos[origen])[1]);
    const msj = textos.slice(origen + 1).reverse().find((t) => /error|cannot|not |unknown|invalid/i.test(t));
    return { error: msj || "error de sintaxis de PlantUML", linea };
  }

  /** El SVG listo para el editor: sin declaración XML y con ancho/alto numéricos. */
  function normalizar(svg) {
    return svg.replace(/^\s*<\?xml[^>]*\?>\s*/, "").replace(/<svg\b[^>]*>/, (tag) =>
      tag.replace(/\s(width|height)="([\d.]+)px"/g, ' $1="$2"'));
  }

  /**
   * Dibuja un bloque PlantUML. Devuelve { svg } o { error, linea } con `linea` relativa al
   * cuerpo (0 = primera línea), o null si el error no trae línea.
   */
  async function dibujar(cuerpo, oscuro) {
    const m = await motor();
    const { lineas, extra } = preparar(cuerpo);
    const svg = await new Promise((ok, mal) => {
      const t = setTimeout(() => mal(new Error(`tiempo agotado (${LIMITE_MS / 1000} s) al dibujar el diagrama PlantUML`)), LIMITE_MS);
      m.renderToString(lineas, (s) => { clearTimeout(t); ok(s); }, (e) => { clearTimeout(t); mal(new Error(String(e))); },
        { dark: !!oscuro });
    });
    const e = errorEn(svg);
    if (e) return { error: e.error, linea: Math.max(0, e.linea - 1 - extra) };
    return { svg: normalizar(svg) };
  }

  /** SHA-1 en JavaScript: abierto desde el disco (file://) no hay `crypto.subtle`. */
  function sha1(bytes) {
    const n = bytes.length;
    const palabras = new Uint32Array((((n + 8) >> 6) + 1) * 16);
    for (let i = 0; i < n; i++) palabras[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    palabras[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
    palabras[palabras.length - 1] = n * 8;
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    const w = new Uint32Array(80);
    const rot = (x, k) => (x << k) | (x >>> (32 - k));
    for (let j = 0; j < palabras.length; j += 16) {
      for (let t = 0; t < 80; t++) w[t] = t < 16 ? palabras[j + t] : rot(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      let [a, b, c, d, e] = h;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const x = (rot(a, 5) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = rot(b, 30) >>> 0; b = a; a = x;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  /** `plantuml-<sha1>.svg`: el nombre de descarga, con el prefijo que usa voight al incrustarlo. */
  function nombre(cuerpo) {
    return `plantuml-${sha1(new TextEncoder().encode(cuerpo)).slice(0, 12)}.svg`;
  }

  return { disponible: !!datos, version: datos ? datos.version : null, dibujar, nombre, preparar, errorEn, sha1 };
})();
