/**
 * Regression: a live fold followed by a persisted scan must NOT double count.
 *
 * This is the exact production sequence behind the "today is inaccurate" bug:
 *
 *   phase 1 — the session is live only (no artifact yet), folded from memory;
 *   phase 2 — its artifact appears with THE SAME events and a store walk folds it.
 *
 * One session therefore has two possible sources for the same usage. The
 * single-ledger rule requires the total to stay at ONE copy.
 *
 *   node scripts/transition.mjs
 */
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

const NOW = Date.UTC(2026, 10, 2, 10, 30, 0);
const events = [
	{ seq: 0, time: NOW, type: "request/header", data: { header: { config: { provider: "prov", model: "mod" } } } },
	{ seq: 1, time: NOW, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } } } },
	{ seq: 2, time: NOW, type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 2000, outputTokens: 200 } } } }
];
const EXPECTED = 3300;

process.env.DSH_HOME = join(dshHome(), ".verify-home-transition");
const { Context } = await harness("@deepseek-ai/cordis");

const ctx = new Context();
const registered = [];
ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
ctx.provide("sessions", {
	list: () => [{ id: "s1", seq: events.length, inheritedEventCount: 0, snapshotEvents: (from = 0) => events.slice(from) }],
	get: () => undefined
});
// The artifact becomes visible only in phase 2.
let artifactVisible = false;
ctx.provide("sessionPersistence", {
	async list() {
		return artifactVisible
			? [{ header: { id: "s1", createdAt: NOW, isSeeded: false }, revision: "r1", sizeBytes: 100 }]
			: [];
	},
	async open() {
		return { inheritedEventCount: 0, async read(from = 0) { return { events: events.slice(from) }; }, async close() {} };
	}
});

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

/** Read the summary; `refresh` forces a store enumeration. */
async function summary(query = "days=2&refresh=1") {
	const route = registered.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const req = {
		method: "GET",
		url: `/api/usage-dashboard/summary?${query}`,
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": "28800" }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

/** Wait until no sync is running. */
async function settled() {
	let payload;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		payload = await summary();
		if (payload.refreshing === false) return payload;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return payload;
}

// Phase 1: live only.
const phase1 = await settled();
console.log(`phase 1 (live only)  tokens ${phase1.windowTotals.tokens} (expected ${EXPECTED})`);

// Phase 2: the artifact appears; a forced read enumerates the store.
artifactVisible = true;
await summary("days=2&refresh=1");
const phase2 = await settled();
console.log(`phase 2 (also stored) tokens ${phase2.windowTotals.tokens} (expected ${EXPECTED})`);

const ok = phase1.windowTotals.tokens === EXPECTED && phase2.windowTotals.tokens === EXPECTED;
if (!ok) {
	console.log(`FAIL: the live -> persisted transition changed the total (${phase1.windowTotals.tokens} -> ${phase2.windowTotals.tokens})`);
	process.exit(1);
}
console.log("OK: the total survived the live -> persisted transition unchanged");
process.exit(0);
