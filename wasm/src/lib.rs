//! Puente WebAssembly mínimo (ABI C, sin wasm-bindgen) entre el motor `dibu` y la SPA.
//!
//! Protocolo: JS reserva memoria con `dibu_alloc`, copia el texto UTF-8, llama a una
//! operación (que devuelve la longitud de la respuesta) y lee la respuesta JSON desde
//! `dibu_out_ptr()`. La memoria de entrada se libera dentro de cada operación.

use dibu_core::{apilar_svgs, leer_bloques, nombre_svg, Registro};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::OnceLock;

fn registro() -> &'static Registro {
    static REG: OnceLock<Registro> = OnceLock::new();
    REG.get_or_init(|| {
        let mut reg = Registro::new();
        dibu_cs::registrar(&mut reg);
        dibu_control::registrar(&mut reg);
        dibu_chem::registrar(&mut reg);
        reg
    })
}

thread_local! {
    static SALIDA: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn responder(v: Value) -> usize {
    let bytes = serde_json::to_vec(&v).unwrap_or_else(|_| b"{\"error\":\"serializacion\"}".to_vec());
    SALIDA.with(|s| {
        let mut s = s.borrow_mut();
        *s = bytes;
        s.len()
    })
}

/// Toma posesión del buffer reservado con `dibu_alloc` y lo convierte en String.
unsafe fn tomar_texto(ptr: *mut u8, len: usize) -> Result<String, String> {
    if ptr.is_null() || len == 0 {
        return Ok(String::new());
    }
    let caja: Box<[u8]> = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
    String::from_utf8(caja.into_vec()).map_err(|e| format!("UTF-8 inválido: {e}"))
}

#[no_mangle]
pub extern "C" fn dibu_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub extern "C" fn dibu_out_ptr() -> *const u8 {
    SALIDA.with(|s| s.borrow().as_ptr())
}

/// `["array", "bode", ...]`
#[no_mangle]
pub extern "C" fn dibu_types() -> usize {
    responder(json!(registro().tipos()))
}

/// Renderiza un texto YAML/JSON con uno o varios bloques, cada uno por separado.
/// Respuesta: `{"blocks":[{"type","id","svg"}|{"type","id","error"}]}` o `{"error"}`.
#[no_mangle]
pub unsafe extern "C" fn dibu_render(ptr: *mut u8, len: usize, tinta: u32) -> usize {
    let texto = match tomar_texto(ptr, len) {
        Ok(t) => t,
        Err(e) => return responder(json!({ "error": e })),
    };
    let bloques = match leer_bloques(&texto) {
        Ok(b) => b,
        Err(e) => return responder(json!({ "error": e.to_string() })),
    };
    let reg = registro();
    let salida: Vec<Value> = bloques
        .iter()
        .map(|b| {
            let tipo = b.get("type").and_then(Value::as_str).unwrap_or("");
            let id = b.get("id").and_then(Value::as_str).unwrap_or("");
            let titulo = b.get("title").and_then(Value::as_str).unwrap_or("");
            match reg.renderizar(b, tinta != 0) {
                Ok(svg) => json!({ "type": tipo, "id": id, "title": titulo, "svg": svg }),
                Err(e) => json!({ "type": tipo, "id": id, "title": titulo, "error": e.to_string() }),
            }
        })
        .collect();
    responder(json!({ "blocks": salida }))
}

/// Renderiza el cuerpo de un fence ```estructura``` tal como lo hace `dibu sync-md`
/// (bloques apilados) y devuelve además el nombre de archivo `estructura-<hash>.svg`.
#[no_mangle]
pub unsafe extern "C" fn dibu_render_md(ptr: *mut u8, len: usize, tinta: u32) -> usize {
    let cuerpo = match tomar_texto(ptr, len) {
        Ok(t) => t,
        Err(e) => return responder(json!({ "error": e })),
    };
    let nombre = nombre_svg(&cuerpo);
    let bloques = leer_bloques(&cuerpo).unwrap_or_default();
    let campo = |k: &str| -> Vec<String> {
        bloques
            .iter()
            .map(|b| b.get(k).and_then(Value::as_str).unwrap_or("").to_string())
            .collect()
    };
    let (tipos, titulos) = (campo("type"), campo("title"));
    match registro().renderizar_bloque_markdown(&cuerpo, tinta != 0) {
        Ok(svg) => responder(json!({ "name": nombre, "types": tipos, "titles": titulos, "svg": svg })),
        Err(e) => responder(json!({ "name": nombre, "types": tipos, "titles": titulos, "error": e.to_string() })),
    }
}

/// Apila verticalmente una lista JSON de SVGs (`["<svg…>", …]`).
#[no_mangle]
pub unsafe extern "C" fn dibu_stack(ptr: *mut u8, len: usize) -> usize {
    let texto = match tomar_texto(ptr, len) {
        Ok(t) => t,
        Err(e) => return responder(json!({ "error": e })),
    };
    let svgs: Vec<String> = match serde_json::from_str(&texto) {
        Ok(v) => v,
        Err(e) => return responder(json!({ "error": format!("JSON inválido: {e}") })),
    };
    match apilar_svgs(&svgs) {
        Ok(svg) => responder(json!({ "svg": svg })),
        Err(e) => responder(json!({ "error": e.to_string() })),
    }
}

/// Escribe un `serde_yaml::Value` como JSON conservando el orden de las claves
/// (serde_json::Map de dibu las ordena alfabéticamente; el editor visual necesita el original).
fn yaml_a_json(v: &serde_yaml::Value, out: &mut String) {
    use serde_yaml::Value as Y;
    match v {
        Y::Null => out.push_str("null"),
        Y::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                match n.as_f64() {
                    Some(f) if f.is_finite() => out.push_str(&serde_json::to_string(&f).unwrap_or_else(|_| "null".into())),
                    _ => out.push_str("null"),
                }
            }
        }
        Y::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Y::Sequence(seq) => {
            out.push('[');
            for (i, x) in seq.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                yaml_a_json(x, out);
            }
            out.push(']');
        }
        Y::Mapping(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let clave = match k {
                    Y::String(s) => s.clone(),
                    otro => serde_yaml::to_string(otro).unwrap_or_default().trim().to_string(),
                };
                out.push_str(&serde_json::to_string(&clave).unwrap_or_default());
                out.push(':');
                yaml_a_json(x, out);
            }
            out.push('}');
        }
        Y::Tagged(t) => yaml_a_json(&t.value, out),
    }
}

/// Parsea YAML/JSON y devuelve la raíz tal cual (`{"root": …}`) con el orden de claves original.
#[no_mangle]
pub unsafe extern "C" fn dibu_parse(ptr: *mut u8, len: usize) -> usize {
    let texto = match tomar_texto(ptr, len) {
        Ok(t) => t,
        Err(e) => return responder(json!({ "error": e })),
    };
    let texto = texto.strip_prefix('\u{feff}').unwrap_or(&texto);
    match serde_yaml::from_str::<serde_yaml::Value>(texto) {
        Ok(v) => {
            let mut s = String::from("{\"root\":");
            yaml_a_json(&v, &mut s);
            s.push('}');
            SALIDA.with(|o| {
                let mut o = o.borrow_mut();
                *o = s.into_bytes();
                o.len()
            })
        }
        Err(e) => responder(json!({ "error": format!("el bloque no es YAML/JSON válido: {e}") })),
    }
}
