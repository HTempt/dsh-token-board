/**
 * Generate a realistic summary payload for the preview harness from the real
 * host half, so the preview renders the same numbers the GUI shows.
 *
 * Two files are written:
 *   fixture.js   — `window.__FIXTURE__ = <payload>`, what `preview.html` loads;
 *   payload.json — the same payload, for ad-hoc inspection.
 *
 * A throwaway DSH_HOME keeps this run from rewriting the cache of a live host.
 *
 * ## PRIVATE DATA — do not commit the output
 *
 * This script folds your REAL session store, so its output contains absolute
 * workspace paths, your provider and model routes, and your actual token
 * totals. Fine for a local screenshot; never for a public repository.
 *
 * The committed fixture is the SYNTHETIC one from `make-fixture-sample.mjs`,
 * which invents every path, route and number. Overwriting it therefore needs an
 * explicit opt-in:
 *
 *   node preview/make-fixture.mjs                              # refuses
 *   DSH_FIXTURE_ALLOW_PRIVATE=1 node preview/make-fixture.mjs  # local only
 *
 * @module dsh-usage-dashboard/preview/make-fixture
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "../scripts/harness.mjs";

if (process.env.DSH_FIXTURE_ALLOW_PRIVATE !== "1") {
	console.error(
		[
			"make-fixture.mjs folds your REAL session logs and writes your own",
			"workspace paths, provider routes and token totals into preview/.",
			"Those files are meant to stay out of the repository.",
			"",
			"  committed fixture : node preview/make-fixture-sample.mjs   (synthetic, safe)",
			"  local preview     : DSH_FIXTURE_ALLOW_PRIVATE=1 node preview/make-fixture.mjs"
		].join("\n")
	);
	process.exit(2);
}

const home = dshHome();
const scratch = join(home, ".preview-home");
mkdirSync(join(scratch, "storages"), { recursive: true });
mkdirSync(join(scratch, "dsh-usage"), { recursive: true });
const ledger = join(home, "dsh-usage", "usage-ledger.json");
if (existsSync(ledger)) copyFileSync(ledger, join(scratch, "dsh-usage", "usage-ledger.json"));
process.env.DSH_HOME = scratch;

const { Context } = await harness("@deepseek-ai/cordis");
const persistenceModule = await harness("@deepseek-ai/dsh-session-persistence-jsonl");

const ctx = new Context();
const routes = [];
ctx.provide("webServer", {
	register(route) {
		routes.push(route);
		return () => {};
	}
});
// No live sessions: the fixture is a snapshot of the persisted store.
ctx.provide("sessions", { list: () => [], get: () => undefined });
ctx.plugin(persistenceModule, { root: join(home, "sessions"), compression: "zstd" });
let persistence;
for (let attempt = 0; attempt < 300 && !persistence; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	persistence = ctx.get("sessionPersistence");
}
if (!persistence) throw new Error("persistence did not start");

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

/** The viewer's own offset in seconds, the way the browser half computes it. */
const tzSeconds = -new Date().getTimezoneOffset() * 60;

async function call(path, query) {
	const route = routes.find((entry) => entry.path === path);
	if (route === undefined) throw new Error(`no route ${path}`);
	const req = {
		method: "GET",
		url: `${path}?${query}`,
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": String(tzSeconds) }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

// A cold fold runs in the background by design, so poll until it settles.
let payload;
for (let attempt = 0; attempt < 400; attempt += 1) {
	payload = await call("/api/usage-dashboard/summary", "days=92");
	if (payload.ok !== true) throw new Error(`summary failed: ${payload.message}`);
	if (payload.refreshing !== true && payload.partial !== true) break;
	await new Promise((resolve) => setTimeout(resolve, 500));
}

writeFileSync(new URL("./fixture.js", import.meta.url), `window.__FIXTURE__=${JSON.stringify(payload)};`, "utf8");
writeFileSync(new URL("./payload.json", import.meta.url), JSON.stringify(payload), "utf8");
console.log("days", payload.days.length, "sessions", payload.sessions, "month", payload.month?.from, "→", payload.month?.to);
process.exit(0);
