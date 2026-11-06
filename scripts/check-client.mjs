// Load the browser half exactly as the GUI's __ModuleLoader__ would, with the
// host packages stubbed, to surface factory-scope errors and the declared id.
//
//   node scripts/check-client.mjs      (works from any cwd)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve against this file, not the caller's cwd: the script ships inside the
// npm package and may be run from anywhere after `npm i`.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const src = readFileSync(join(packageRoot, "lib/client.js"), "utf8");
let entry = null;
const el = () => ({ style: { setProperty() {} }, dataset: {}, setAttribute() {}, appendChild() {}, querySelector: () => null });
const sandbox = {
  window: {
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    innerHeight: 900, requestAnimationFrame: (f) => { if (typeof f === "function") f(); return 0; },
    addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} })
  },
  document: { querySelector: () => null, addEventListener: () => {}, createElement: el, head: { appendChild() {} }, body: { appendChild() {} } },
  console,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  fetch: () => Promise.reject(new Error("offline check")),
  AbortController, URLSearchParams, Date, Math, JSON, Map, Set, String, Number, Object, Array, Promise, Error, Intl
};
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = { load: (e) => { entry = e; }, require: () => ({}) };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "client.js" });

console.log("declared id:", JSON.stringify(entry.id));
// The loader keys every entry by the id the bundle declares and looks the
// plugin up by its PACKAGE name, so a rename that misses this line leaves the
// entry with no module at all: the GUI reports a bare "import failed" with no
// error message, because nothing was ever thrown.
const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;
if (entry.id !== packageName) {
  console.log(`FAIL: bundle id ${JSON.stringify(entry.id)} != package name ${JSON.stringify(packageName)} — the GUI will fail to activate this entry`);
  process.exit(1);
}
// The bundle patch inserts the row that carries this name. A rename that fixes
// package.json and the bundle but misses the patch mounts a row whose specifier
// no one can resolve, which fails at Host boot instead of at browser load.
const patchName = (readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8").match(/name:\s*'([^']+)'/) ?? [])[1];
if (patchName !== packageName) {
  console.log(`FAIL: cordis.patch.yml name ${JSON.stringify(patchName)} != package name ${JSON.stringify(packageName)} — the Host cannot resolve this row`);
  process.exit(1);
}
console.log("patch name:", JSON.stringify(patchName), "— matches package name");
const react = { useCallback: (f) => f, useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), Fragment: "Fragment" };
const jsx = { jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }), Fragment: "Fragment" };
let mod;
try {
  mod = entry.factory((name) => (name === "react" ? react : jsx));
} catch (error) {
  console.log("FACTORY THREW:", error && error.message);
  process.exit(1);
}
console.log("exports:", Object.keys(mod).join(", "));
const seats = [];
try {
  mod.apply({
    effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
    logger: { warn: () => {}, info: () => {} },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: {
      inject: (name, cb) => { const d = cb(); return typeof d === "function" ? d : () => {}; },
      register: (seat, Comp) => { seats.push([seat.name, seat.id ?? seat.key, typeof Comp]); return () => {}; }
    }
  });
} catch (error) {
  console.log("APPLY THREW:", error && error.message);
  process.exit(1);
}
console.log("seats:", JSON.stringify(seats));
console.log("OK");
