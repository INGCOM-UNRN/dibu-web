// Worker que aloja el motor dibu compilado a WebAssembly.
// Corre fuera del hilo principal para que la interfaz no se congele y para poder
// cortarlo (terminate) si un diagrama tarda demasiado.
"use strict";

let modulo = null;
let ex = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

function arrancar() {
  ex = new WebAssembly.Instance(modulo, {}).exports;
}

function llamar(op, texto, bandera) {
  let n;
  if (texto === undefined) {
    n = ex[op]();
  } else {
    const bytes = enc.encode(texto);
    const ptr = ex.dibu_alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    n = bandera === undefined ? ex[op](ptr, bytes.length) : ex[op](ptr, bytes.length, bandera);
  }
  const salida = ex.dibu_out_ptr();
  return JSON.parse(dec.decode(new Uint8Array(ex.memory.buffer, salida, n)));
}

self.onmessage = (e) => {
  const { id, op, texto, bandera, module } = e.data;
  if (module) {
    modulo = module;
    try {
      arrancar();
      self.postMessage({ id, ok: true, resultado: llamar("dibu_types") });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err) });
    }
    return;
  }
  try {
    self.postMessage({ id, ok: true, resultado: llamar(op, texto, bandera) });
  } catch (err) {
    // Un panic de Rust se traduce en un trap: la instancia queda inservible, la recreamos.
    try { arrancar(); } catch (_) { /* se reporta abajo */ }
    self.postMessage({ id, ok: false, error: "el motor falló internamente: " + (err && err.message || err) });
  }
};
