#!/usr/bin/env node
// Pruebas de web/plantuml.js que no necesitan el navegador: el preparado del bloque (opciones de
// alucarD, envoltura en @startuml) y el SHA-1 de los nombres. El render se prueba en navegador.mjs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ window: { DIBU: {} }, TextEncoder });
const PUML = vm.runInContext(readFileSync(join(raiz, "web/plantuml.js"), "utf8") + "\n;PUML", ctx);

let fallas = 0;
function caso(nombre, obtenido, esperado) {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallas++;
  console.log(`${ok ? "✓" : "✗"} ${nombre}${ok ? "" : `\n    esperado ${JSON.stringify(esperado)}\n    obtenido ${JSON.stringify(obtenido)}`}`);
}

caso("sin @startuml se envuelve", PUML.preparar("A -> B"), { lineas: ["@startuml", "A -> B", "@enduml"], extra: 1 });
caso("con @startmindmap queda igual", PUML.preparar("@startmindmap\n* x\n@endmindmap"), { lineas: ["@startmindmap", "* x", "@endmindmap"], extra: 0 });
caso("las opciones de alucarD se vacían (las líneas no se corren)",
  PUML.preparar("// [centrado] [ancho, 60%]\n// [alt, Un texto]\nA -> B"),
  { lineas: ["@startuml", "", "", "A -> B", "@enduml"], extra: 1 });
caso("un // que no es opción queda", PUML.preparar("A -> B\n// [no es opción acá]").lineas.slice(1, 3), ["A -> B", "// [no es opción acá]"]);
caso("sin build de PlantUML no está disponible", PUML.disponible, false);
for (const t of ["", "abc", "ñandú\n@startuml\n", "x".repeat(200)]) {
  caso(`sha1 ${JSON.stringify(t.slice(0, 12))}`, PUML.sha1(new TextEncoder().encode(t)), createHash("sha1").update(t).digest("hex"));
}
caso("nombre", PUML.nombre("A -> B"), `plantuml-${createHash("sha1").update("A -> B").digest("hex").slice(0, 12)}.svg`);

console.log(fallas ? `✗ plantuml: ${fallas} falla(s)` : "✓ plantuml: todo bien");
process.exit(fallas ? 1 : 0);
