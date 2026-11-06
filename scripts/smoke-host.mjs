/**
 * Standalone smoke test for the host half: mounts the real JSONL persistence
 * backend over the real session store, fakes the small slice of `ctx.webServer`
 * and `ctx.sessions` the plugin uses, calls the route handlers in-process, and
 * asserts the payload is self-consistent.
 *
 * This is the broad real-data check; the focused regressions live beside it
 * (`singleledger`, `transition`, `migrate`, `unit`) and the exact comparison
 * against an external CSV is `reconcile.mjs`.
 *
 *   node scripts/smoke-host.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

const { Context } = await harness("@deepseek-ai/cordis");
// The path comes from `import.meta.url`, which is already a valid `file://` URL;
// only an explicit override is used as given.
const pluginPath = process.env.DSH_USAGE_DASHBOARD_ENTRY
	?? new URL("../lib/index.js", import.meta.url).href;

// This run must not write into the running host's home: it builds its own fold
// and would otherwise overwrite the cache the host serves from. It reads the
// real session store but writes only to a scratch home, and it mirrors the real
// home's INPUTS (the shared usage ledger) so imported history is included.
const home = dshHome();
const scratch = join(home, ".smoke-home");
mkdirSync(join(scratch, "storages"), { recursive: true });
mkdirSync(join(scratch, "dsh-usage"), { recursive: true });
const realLedger = join(home, "dsh-usage", "usage-ledger.json");
if (existsSync(realLedger)) copyFileSync(realLedger, join(scratch, "dsh-usage", "usage-ledger.json"));
process.env.DSH_HOME = scratch;

const ctx = new Context();
const registered = [];
ctx.provide("webServer", {
	register(route) {
		registered.push(route);
		return () => {};
	}
});
// No live sessions: this run measures the persisted store only.
ctx.provide("sessions", { list: () => [], get: () => undefined });

// Real persistence backend over the real session store.
const persistenceModule = await harness("@deepseek-ai/dsh-session-persistence-jsonl");
ctx.plugin(persistenceModule, { root: `${home}/sessions`, compression: "zstd" });
let persistence;
for (let attempt = 0; attempt < 300; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	persistence = ctx.get("sessionPersistence");
	if (persistence !== undefined) break;
}
if (persistence === undefined) throw new Error("persistence backend did not start");

const plugin = await import(pluginPath);
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));
if (registered.length === 0) throw new Error("no routes registered");

/** Call one registered route with a synthetic loopback request. */
async function call(path, query = "", tzOffsetSeconds = -28800) {
	const route = registered.find((entry) => entry.path === path);
	if (route === undefined) throw new Error(`no route ${path}`);
	const req = {
		method: "GET",
		url: `${path}${query === "" ? "" : `?${query}`}`,
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": String(tzOffsetSeconds) }
	};
	let status = 0;
	let body = "";
	const res = {
		writeHead(code) { status = code; },
		end(text) { body = text; }
	};
	await route.handler(req, res);
	return { status, body: body === "" ? null : JSON.parse(body) };
}

const t0 = Date.now();
let summary = await call("/api/usage-dashboard/summary", "days=92");
console.log("first summary ms", Date.now() - t0, "status", summary.status);
// A cold fold runs in the background by design, so wait for it to settle.
for (let attempt = 0; attempt < 400; attempt += 1) {
	if (summary.body.refreshing !== true && summary.body.partial !== true) break;
	await new Promise((resolve) => setTimeout(resolve, 500));
	summary = await call("/api/usage-dashboard/summary", "days=92");
}
const payload = summary.body;
console.log("settled ms", Date.now() - t0, "ok", payload.ok, "sessions", payload.sessions, "days", payload.days.length);
console.log("window", JSON.stringify(payload.window));
console.log("windowTotals", JSON.stringify(payload.windowTotals));
console.log("allTime.totals", JSON.stringify(payload.allTime.totals));
console.log("providers", payload.allTime.providers.slice(0, 5).map((row) => `${row.provider} ${row.tokens}/${row.calls} sr=${row.successRate}`).join(" | "));
console.log("models", payload.allTime.models.slice(0, 4).map((row) => `${row.model} ${row.tokens}/${row.calls}`).join(" | "));

let failures = 0;
const check = (label, ok) => {
	console.log(label, ok);
	if (!ok) failures += 1;
};

const lastDay = payload.days.at(-1);
if (lastDay !== undefined) {
	const detail = await call("/api/usage-dashboard/day", `date=${lastDay.date}`);
	const day = detail.body?.day;
	console.log("day route", detail.status, day?.date, "providerRows", day?.byProvider?.length);
	const providerSum = day.byProvider.reduce((sum, row) => sum + row.tokens, 0);
	const modelSum = day.byModel.reduce((sum, row) => sum + row.tokens, 0);
	const callSum = day.byProvider.reduce((sum, row) => sum + row.calls, 0);
	check("provider rows sum to day tokens", providerSum === day.tokens);
	check("model rows sum to day tokens", modelSum === day.tokens);
	check("provider rows sum to day calls", callSum === day.calls);
	const windowSum = payload.days.reduce((sum, entry) => sum + entry.tokens, 0);
	check("day rows sum to window tokens", windowSum === payload.windowTotals.tokens);
}

const t1 = Date.now();
const second = await call("/api/usage-dashboard/summary", "days=92");
console.log("repeat read ms", Date.now() - t1, "days", second.body.days.length);
check("repeat read returns the same days", JSON.stringify(second.body.days) === JSON.stringify(payload.days));

const bad = await call("/api/usage-dashboard/day", "date=oops");
console.log("invalid date", bad.status, JSON.stringify(bad.body));
check("invalid date rejected", bad.status === 400);

if (failures > 0) {
	console.log(`FAIL: ${failures} consistency check(s) failed`);
	process.exit(1);
}
console.log("OK: payload is self-consistent");
process.exit(0);
