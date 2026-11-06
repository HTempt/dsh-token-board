/**
 * Regression: a cache written under the PREVIOUS schema must be MIGRATED.
 *
 * After a session log is compacted, the cached fold is the only surviving record
 * of that usage, so dropping the cache on a schema change would silently delete
 * history. The v3 → v4 migration therefore keeps the folded hours, converts its
 * event COUNT into the last folded SEQ (`seq = count - 1`), and exempts the
 * migrated session from pruning until the log itself confirms it.
 *
 *   node scripts/migrate.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

const home = join(dshHome(), ".verify-home-migrate");
mkdirSync(join(home, "storages"), { recursive: true });

/** A v3 cache holding one day of usage whose log no longer exists. */
const buckets = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, failedCalls: 0, retries: 0 };
const legacy = {
	version: 3,
	enumeratedAt: 0,
	sessions: {
		"gone-session": {
			hours: { "2026-10-01T02": { totals: buckets, models: [["prov/mod", { ...buckets }]] } },
			lastSample: null,
			compactionSamples: [],
			currentRoute: null,
			// v3 counted events, so this log held 42 events (last seq 41).
			consumed: 42,
			inheritedEventCount: 0,
			revision: "old-revision",
			sizeBytes: 10
		}
	},
	hours: {}
};
writeFileSync(join(home, "storages", "usage-dashboard-cache.json"), JSON.stringify(legacy));

process.env.DSH_HOME = home;
const { Context } = await harness("@deepseek-ai/cordis");

const ctx = new Context();
const registered = [];
ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
ctx.provide("sessions", { list: () => [], get: () => undefined });
// The artifact is gone: nothing in the store can reproduce this usage.
ctx.provide("sessionPersistence", { async list() { return []; }, async open() { throw new Error("not found"); } });

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

async function summary() {
	const route = registered.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const req = {
		method: "GET",
		url: "/api/usage-dashboard/summary?days=all",
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": "28800" }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

let payload;
for (let attempt = 0; attempt < 60; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 300));
	payload = await summary();
	if (payload.refreshing === false && payload.partial === false) break;
}
const day = payload.days.find((entry) => entry.date === "2026-10-01");
const ok = day !== undefined && day.tokens === 550;
console.log(`migrated day present: ${day !== undefined} tokens ${day?.tokens} (expected 550)`);
if (!ok) {
	console.log("FAIL: a migrated fold was dropped instead of carried over");
	process.exit(1);
}
console.log("OK: the previous schema's folded history survived the migration");
process.exit(0);
