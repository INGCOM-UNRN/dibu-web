// Markdown mínimo para la vista de documento: el texto que rodea a los fences de dibu.
// Sin HTML crudo: todo se escapa y sólo se generan las etiquetas de la sintaxis de Markdown.
"use strict";

const MD = (() => {
  const escapar = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /** Un enlace o una imagen sólo con esquemas seguros (o relativos). */
  function urlSegura(u) {
    const t = u.trim();
    if (/^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+(\/|$|\.|#))/i.test(t) && !/^\s*(javascript|data|vbscript):/i.test(t)) return t;
    return "#";
  }

  /** Lo de una línea: código, imágenes, enlaces, negrita, cursiva y tachado. */
  function enLinea(texto) {
    const codigos = [];
    let s = texto.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => {
      codigos.push(`<code>${escapar(c.trim() === "" ? c : c.replace(/^ (.*) $/, "$1"))}</code>`);
      return `\u0000${codigos.length - 1}\u0000`;
    });
    s = escapar(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, u, t) =>
      `<img alt="${alt}" src="${escapar(urlSegura(u.replace(/&amp;/g, "&")))}"${t ? ` title="${t}"` : ""}>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, txt, u, t) =>
      `<a href="${escapar(urlSegura(u.replace(/&amp;/g, "&")))}"${t ? ` title="${t}"` : ""}>${txt}</a>`);
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
    s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(/ {2,}\n|\\\n/g, "<br>\n");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codigos[Number(i)]);
  }

  const RE_LISTA = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_VALLA = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
  const RE_TABLA_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

  function celdas(l) {
    return l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  /** Convierte un fragmento de Markdown a HTML. */
  function html(md) {
    const lineas = md.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const parrafo = [];
    const cerrarParrafo = () => {
      if (parrafo.length) out.push(`<p>${enLinea(parrafo.join("\n"))}</p>`);
      parrafo.length = 0;
    };
    while (i < lineas.length) {
      const l = lineas[i];
      if (/^\s*$/.test(l)) { cerrarParrafo(); i++; continue; }
      // Front matter de MyST o Jekyll al comienzo: no se muestra.
      if (i === 0 && l.trim() === "---") {
        const fin = lineas.indexOf("---", 1);
        if (fin > 0) { i = fin + 1; continue; }
      }
      const valla = RE_VALLA.exec(l);
      if (valla) {
        cerrarParrafo();
        const cierre = valla[1];
        const cuerpo = [];
        i++;
        while (i < lineas.length && !lineas[i].trim().startsWith(cierre)) cuerpo.push(lineas[i++]);
        i++;
        const lenguaje = valla[2] ? ` data-lenguaje="${escapar(valla[2])}"` : "";
        out.push(`<pre${lenguaje}><code>${escapar(cuerpo.join("\n"))}</code></pre>`);
        continue;
      }
      const titulo = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (titulo) {
        cerrarParrafo();
        out.push(`<h${titulo[1].length}>${enLinea(titulo[2])}</h${titulo[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { cerrarParrafo(); out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(l)) {
        cerrarParrafo();
        const cita = [];
        while (i < lineas.length && /^\s*>/.test(lineas[i])) cita.push(lineas[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${html(cita.join("\n"))}</blockquote>`);
        continue;
      }
      if (l.includes("|") && i + 1 < lineas.length && RE_TABLA_SEP.test(lineas[i + 1])) {
        cerrarParrafo();
        const cab = celdas(l);
        const alin = celdas(lineas[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
        const estilo = (k) => (alin[k] ? ` style="text-align:${alin[k]}"` : "");
        i += 2;
        const filas = [];
        while (i < lineas.length && lineas[i].includes("|") && lineas[i].trim()) filas.push(celdas(lineas[i++]));
        out.push(`<table><thead><tr>${cab.map((c, k) => `<th${estilo(k)}>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>` +
          filas.map((f) => `<tr>${cab.map((_, k) => `<td${estilo(k)}>${enLinea(f[k] || "")}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
        continue;
      }
      const item = RE_LISTA.exec(l);
      if (item) {
        cerrarParrafo();
        const ordenada = /\d/.test(item[2]);
        const sangria = item[1].length;
        const items = [];
        while (i < lineas.length) {
          const m = RE_LISTA.exec(lineas[i]);
          if (m && m[1].length === sangria && /\d/.test(m[2]) === ordenada) {
            items.push([m[3]]);
            i++;
          } else if (items.length && (/^\s+\S/.test(lineas[i]) && (lineas[i].match(/^\s*/)[0].length > sangria))) {
            items[items.length - 1].push(lineas[i].slice(Math.min(sangria + 2, lineas[i].match(/^\s*/)[0].length)));
            i++;
          } else break;
        }
        const inicio = ordenada && parseInt(item[2], 10) !== 1 ? ` start="${parseInt(item[2], 10)}"` : "";
        const etiqueta = ordenada ? "ol" : "ul";
        out.push(`<${etiqueta}${inicio}>${items.map((partes) => {
          const [primera, ...resto] = partes;
          const tarea = /^\[([ xX])\]\s+/.exec(primera);
          const cabeza = tarea ? `<input type="checkbox" disabled${tarea[1] !== " " ? " checked" : ""}> ${enLinea(primera.slice(tarea[0].length))}` : enLinea(primera);
          return `<li>${cabeza}${resto.length ? html(resto.join("\n")) : ""}</li>`;
        }).join("")}</${etiqueta}>`);
        continue;
      }
      // Directivas de MyST (`:::{nota}`) y etiquetas `(etiqueta)=`: el contenido se muestra igual.
      if (/^\s*:{3,}/.test(l) || /^\s*\([\w:-]+\)=\s*$/.test(l)) { cerrarParrafo(); i++; continue; }
      parrafo.push(l);
      i++;
    }
    cerrarParrafo();
    return out.join("\n");
  }

  return { html, enLinea };
})();

if (typeof module !== "undefined") module.exports = MD;
