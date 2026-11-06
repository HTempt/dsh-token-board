import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
// One level up: the harness serves `/lib/client.js` so the preview loads the
// plugin's REAL bundle instead of a byte-identical copy under preview/.
const packageRoot = resolve(root, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const target = url.pathname === "/" ? "preview.html" : normalize(url.pathname).replace(/^\\+/, "");
  // `/lib/...` is the only path allowed above the preview directory; anything
  // else that escapes it (dot-dot traversal) stays a 404.
  const above = target.startsWith("lib" + sep) || target.startsWith("lib/");
  const path = above ? join(packageRoot, target) : join(root, target);
  if (!above && !path.startsWith(root)) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(4599, "127.0.0.1", () => console.log("preview on http://127.0.0.1:4599"));
