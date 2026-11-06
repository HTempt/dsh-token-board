// One-off: sync the preview harness dictionaries with the plugin's own zh/en
// vocabularies, so `preview.html` shows real copy for every key the page uses.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync("lib/client.js", "utf8");

/** Pull one `const <name> = { ... };` block out of the bundle and evaluate it. */
function extractDict(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`no dict ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  let inString = false;
  let quote = "";
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inString) {
      if (ch === quote && prev !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error(`unterminated dict ${name}`);
  const literal = src.slice(open, end + 1);
  return vm.runInNewContext(`(${literal})`);
}

const zh = extractDict("zh");
const en = extractDict("en");

const loader = readFileSync("preview/loader.js", "utf8").replace(/\r\n/g, "\n");
const block = (dict) => `{\n${Object.entries(dict).map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n};`;

function replaceBlock(source, marker, dict) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`no marker ${marker}`);
  const open = source.indexOf("{", start);
  const after = source.indexOf("\n};", open);
  if (after < 0) throw new Error(`no end for ${marker}`);
  return `${source.slice(0, start)}${marker.slice(0, marker.length)}${block(dict)}${source.slice(after + 3)}`;
}

let next = replaceBlock(loader, "window.__PREVIEW_ZH__ =", zh);
next = replaceBlock(next, "window.__PREVIEW_EN__ =", en);
writeFileSync("preview/loader.js", next);
console.log(`zh keys ${Object.keys(zh).length}, en keys ${Object.keys(en).length}; loader.js rewritten`);
