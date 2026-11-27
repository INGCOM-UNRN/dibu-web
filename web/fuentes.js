// Tipografías de Google Fonts: a partir de una URL (o del nombre de la familia) se descargan la
// hoja de estilos y los archivos de letra, y las reglas @font-face quedan con las letras
// incrustadas como data: URL. Así sirven en la página y dentro de cada SVG, que se muestra como
// <img> y no puede pedir nada a la red. Lo único que sale a la red son esos pedidos a Google.
"use strict";

const FUENTES = (() => {
  // Los subconjuntos de Unicode que se incrustan: latín y griego (para α, ω, θ, …).
  const SUBCONJUNTOS = new Set(["latin", "latin-ext", "greek", "greek-ext", "math", "symbols"]);
  const cache = new Map(); // URL normalizada -> Promise<{ familia, css, bytes }>
  // Tope por familia: las letras van incrustadas en cada SVG (y cada <img> las decodifica), así que
  // una familia de varios MB multiplica la memoria y puede colgar el navegador.
  const opciones = { limite: 1024 * 1024 };
  const mb = (n) => n < 1048576 ? `${Math.round(n / 1024)} KiB` : `${+(n / 1048576).toFixed(1)} MB`;

  /** ¿El rango (`U+0000-00FF, U+0131, U+4??`) incluye la A o la α? Sin rango, cubre todo. */
  function cubreLatinoOGriego(rango) {
    if (!rango) return true;
    return rango.split(",").some((parte) => {
      const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(parte.trim());
      if (!m) return false;
      const ini = parseInt(m[1].replace(/\?/g, "0"), 16);
      const fin = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "f"), 16);
      return [0x41, 0x3b1].some((c) => c >= ini && c <= fin);
    });
  }

  /**
   * La URL de la hoja de estilos de Google Fonts para lo que escribió la persona: una URL de
   * fonts.googleapis.com (css o css2), la de la página de la familia en fonts.google.com
   * (/specimen/Roboto+Slab) o sólo el nombre ("Roboto Slab"). Error si es otro sitio.
   */
  function normalizar(entrada) {
    const s = (entrada || "").trim();
    if (!s) return null;
    const conPesos = (familia) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(familia).replace(/%20/g, "+")}:wght@400;700&display=swap`;
    if (!/^[a-z]+:\/\//i.test(s) && !s.startsWith("fonts.")) {
      if (!/^[\p{L}\p{N} _-]{1,80}$/u.test(s)) throw new Error(`«${s}» no es el nombre de una familia de Google Fonts`);
      return conPesos(s);
    }
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : "https://" + s); } catch { throw new Error(`«${s}» no es una URL válida`); }
    if (u.hostname === "fonts.google.com") {
      const m = /^\/specimen\/([^/]+)/.exec(u.pathname);
      if (!m) throw new Error("de fonts.google.com, usá la página de una familia (…/specimen/Nombre)");
      return conPesos(decodeURIComponent(m[1].replace(/\+/g, " ")));
    }
    if (u.hostname !== "fonts.googleapis.com" || !/^\/css2?$/.test(u.pathname) || !u.searchParams.get("family")) {
      throw new Error("la URL tiene que ser de Google Fonts (fonts.googleapis.com/css2?family=…)");
    }
    u.protocol = "https:";
    return u.toString();
  }

  async function texto(url) {
    const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) throw new Error(`Google Fonts respondió ${r.status}`);
    return r.text();
  }

  // Una letra variable aparece en varias @font-face (400 y 700): se descarga una vez.
  const archivos = new Map();
  function dataURL(url, maximo) {
    if (!archivos.has(url)) {
      const p = bajarArchivo(url, maximo);
      p.catch(() => archivos.delete(url));
      archivos.set(url, p);
    }
    return archivos.get(url);
  }

  /** Baja un archivo de letra; corta (sin terminar de bajarlo) si pasa de `maximo` bytes. */
  async function bajarArchivo(url, maximo) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "fonts.gstatic.com") throw new Error(`letra fuera de Google Fonts: ${u.hostname}`);
    const r = await fetch(u, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) throw new Error(`no se pudo descargar una letra (${r.status})`);
    const demasiado = () => Object.assign(new Error("grande"), { grande: true });
    if (Number(r.headers.get("content-length")) > maximo) { r.body?.cancel(); throw demasiado(); }
    const partes = [];
    let n = 0;
    const lector = r.body.getReader();
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      n += value.length;
      if (n > maximo) { lector.cancel(); throw demasiado(); }
      partes.push(value);
    }
    const bytes = new Uint8Array(n);
    let p = 0;
    for (const x of partes) { bytes.set(x, p); p += x.length; }
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const tipo = /\.woff2(\?|$)/.test(u.pathname) ? "font/woff2" : /\.woff(\?|$)/.test(u.pathname) ? "font/woff" : "font/ttf";
    return { url: `data:${tipo};base64,${btoa(bin)}`, n: bytes.length };
  }

  /** Las reglas @font-face de la hoja, con las letras incrustadas. */
  async function descargar(url) {
    let hoja;
    try { hoja = await texto(url); } catch (e) {
      // Una familia sin negrita rechaza «:wght@400;700»: se pide sólo la normal.
      const sinPesos = url.replace(/:wght@400;700/, "");
      if (sinPesos === url) throw e;
      hoja = await texto(sinPesos);
    }
    // Una letra variable trae una regla por peso con el mismo archivo: se juntan en una sola
    // (font-weight: 400 700) para no incrustar el archivo dos veces.
    const reglas = new Map(); // archivo + estilo + rango -> { cuerpo, pesos }
    let familia = null;
    for (const m of hoja.matchAll(/(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
      const cuerpo = m[2];
      const f = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(cuerpo);
      if (!f) continue;
      familia = familia || f[1].trim();
      const campo = (k) => (new RegExp(`${k}:\\s*([^;]+);`).exec(cuerpo) || [, ""])[1].trim();
      // Con nombre de subconjunto, sólo los de SUBCONJUNTOS. Sin nombre (las familias japonesas o
      // chinas traen cientos de tramos numerados), sólo los que tienen la A o la α.
      if (m[1] && !/^\[\d+\]$/.test(m[1]) ? !SUBCONJUNTOS.has(m[1]) : !cubreLatinoOGriego(campo("unicode-range"))) continue;
      const clave = [campo("src"), campo("font-style"), campo("unicode-range")].join("|");
      const peso = Number(campo("font-weight")) || 400;
      const r = reglas.get(clave);
      if (r) r.pesos.push(peso);
      else reglas.set(clave, { cuerpo, pesos: [peso] });
    }
    if (!familia || !reglas.size) throw new Error("la hoja de Google Fonts no trae ninguna letra");
    if (/['"<>&\\]/.test(familia)) throw new Error(`nombre de familia inválido: ${familia}`);
    let bytes = 0;
    const salida = [];
    for (const { cuerpo: original, pesos } of reglas.values()) {
      let cuerpo = original;
      if (pesos.length > 1) {
        cuerpo = cuerpo.replace(/font-weight:\s*[^;]+;/, `font-weight: ${Math.min(...pesos)} ${Math.max(...pesos)};`);
      }
      for (const src of [...cuerpo.matchAll(/url\(([^)]+)\)/g)]) {
        let d;
        try { d = await dataURL(src[1].replace(/^['"]|['"]$/g, ""), opciones.limite - bytes); } catch (e) {
          if (!e.grande) throw e;
          d = { n: opciones.limite + 1 };
        }
        bytes += d.n;
        if (bytes > opciones.limite) {
          throw new Error(`${familia} pesa más de ${mb(opciones.limite)} y no se usa: va incrustada en cada SVG y puede agotar la memoria del navegador. Probá otra familia.`);
        }
        cuerpo = cuerpo.replace(src[0], `url(${d.url})`);
      }
      salida.push(`@font-face {${cuerpo}}`);
    }
    return { familia, css: salida.join("\n"), bytes };
  }

  /** { familia, css, bytes } para la entrada (URL o nombre); se descarga una sola vez. */
  function cargar(entrada) {
    const url = normalizar(entrada);
    if (!url) return Promise.resolve(null);
    if (!cache.has(url)) {
      const p = descargar(url);
      p.catch(() => cache.delete(url));
      cache.set(url, p);
    }
    return cache.get(url);
  }

  /** Agrega las @font-face al SVG si usa alguna de las familias (para el <img> y la descarga). */
  function incrustar(svg, fuentes) {
    const usadas = fuentes.filter((f) => f && svg.includes(f.familia));
    if (!usadas.length) return svg;
    const estilo = `<style>${usadas.map((f) => f.css).join("\n")}</style>`;
    return svg.replace(/<svg\b[^>]*>/, (tag) => tag + estilo);
  }

  return { normalizar, cargar, incrustar, opciones, cubreLatinoOGriego };
})();
