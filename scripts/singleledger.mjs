/**
 * Regression for the "today is doubled" bug.
 *
 * A session that is BOTH live and stored must contribute ONE copy of its usage.
 * The old aggregator kept a second `liveFolds` accumulator and added it to the
 * persisted fold, so a flushed session counted twice (exactly 2.00x on real data).
 *
 * The harness is faked — one live session and a persistence backend returning
 * the SAME events — so the production aggregator is exercised through its real
 * route handler with no real store involved.
 *
 *   node scripts/singleledger.mjs
 */
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

// Anchor to TODAY: the route only folds the `days=2` window, so a fixed instant
// falls out of range and the day row disappears — a failure that looks like
// double counting but is really an expired fixture.
// 10:30 UTC is 18:30 at UTC+8, the same local day either way.
const NOW = (() => {
	const at = new Date();
	at.setUTCHours(10, 30, 0, 0);
	return at.getTime();
})();
/** Two used calls, each exactly one usage sample. */
const events = [
	{ seq: 0, time: NOW, type: "request/header", data: { header: { config: { provider: "prov", model: "mod" } } } },
	{ seq: 1, time: NOW, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } } } },
	{ seq: 2, time: NOW, type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 2000, outputTokens: 200 } } } }
];
const EXPECTED_TOKENS = 3300; // 1000 + 100 + 2000 + 200, counted ONCE
const EXPECTED_CALLS = 2;

process.env.DSH_HOME = join(dshHome(), ".verify-home-single");
const { Context } = await harness("@deepseek-ai/cordis");

const ctx = new Context();
const registered = [];
ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
ctx.provide("sessions", {
	list: () => [{ id: "s1", seq: events.length, inheritedEventCount: 0, snapshotEvents: (from = 0) => events.slice(from) }],
	get: () => undefined
});
ctx.provide("sessionPersistence", {
	async list() { return [{ header: { id: "s1", createdAt: NOW, isSeeded: false }, revision: "r1", sizeBytes: 100 }]; },
	async open() {
		return { inheritedEventCount: 0, async read(from = 0) { return { events: events.slice(from) }; }, async close() {} };
	}
});

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

/** Call the summary route with a UTC+8 viewer offset. */
async function summary(query) {
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

let payload;
for (let attempt = 0; attempt < 60; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 300));
	payload = await summary("days=2");
	if (payload.partial === false && payload.refreshing === false) break;
}

const today = payload.days.at(-1);
const tokensOk = today.tokens === EXPECTED_TOKENS;
const callsOk = today.calls === EXPECTED_CALLS;
console.log(`today tokens ${today.tokens} (expected ${EXPECTED_TOKENS}, one copy) ${tokensOk ? "OK" : "DOUBLED OR WRONG"}`);
console.log(`today calls  ${today.calls} (expected ${EXPECTED_CALLS}) ${callsOk ? "OK" : "WRONG"}`);
console.log(`allTime tokens ${payload.allTime.totals.tokens} (expected ${EXPECTED_TOKENS})`);
if (!tokensOk || !callsOk || payload.allTime.totals.tokens !== EXPECTED_TOKENS) {
	console.log("FAIL: a live+stored session was not counted exactly once");
	process.exit(1);
}
console.log("OK: live and persisted describe one ledger");
process.exit(0);
