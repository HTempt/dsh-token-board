/**
 * Regression: usage recorded while the plugin was NOT running must still be
 * counted once it starts.
 *
 * The plugin owns no recorder. Every figure is read from the durable session
 * store, and a walk enumerates that store by LISTING it (`list()`), not by
 * observing events in real time. So a session written while the Host (or this
 * plugin) was stopped is simply a stored log the first walk has never folded —
 * it gets folded then, however old it is.
 *
 * This script proves it end to end: it writes a session to a scratch store,
 * starts the plugin AFTERWARDS with an EMPTY cache, and asserts the usage shows
 * up. It then proves the incremental path too: a session that grows while the
 * plugin is idle is re-read because its revision moved.
 *
 *   node scripts/offline-backfill.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

const HOME = join(dshHome(), ".verify-home-offline");
process.env.DSH_HOME = HOME;
rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, "sessions"), { recursive: true });

// Two sessions written BEFORE the plugin ever runs.
const EARLY = Date.UTC(2026, 9, 20, 8, 0, 0);   // 2026-10-20
const LATE = Date.UTC(2026, 10, 2, 8, 0, 0);    // 2026-11-02

const mkEvents = (at, tokens) => [
	{ seq: 0, time: at, type: "request/header", data: { header: { config: { provider: "prov", model: "mod" } } } },
	{ seq: 1, time: at, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: tokens, outputTokens: 0 } } } }
];

/** A store the plugin can enumerate, seeded with the given sessions. */
function storeWith(sessions) {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	return {
		async list() {
			return [...byId.values()].map((s) => ({
				header: { id: s.id, createdAt: s.events[0].time, isSeeded: false },
				revision: `r${s.events.length}`,
				sizeBytes: 100
			}));
		},
		async open(id) {
			const session = byId.get(id);
			return {
				inheritedEventCount: 0,
				async read(from = 0) { return { events: session.events.slice(from) }; },
				async close() {}
			};
		}
	};
}

const { Context } = await harness("@deepseek-ai/cordis");

/** Boot one plugin instance over `persistence` and return its summary route. */
async function boot(persistence, homeLabel) {
	// Each scenario needs its OWN home: the fold cache lives under storages/, so
	// reusing one home would let scenario 2 read scenario 1's cache and hide the
	// very re-fold it is meant to prove.
	process.env.DSH_HOME = join(HOME, homeLabel);
	mkdirSync(process.env.DSH_HOME, { recursive: true });
	const ctx = new Context();
	const routes = [];
	ctx.provide("webServer", { register(route) { routes.push(route); return () => {}; } });
	ctx.provide("sessions", { list: () => [], get: () => undefined });
	ctx.provide("sessionPersistence", persistence);
	const plugin = await import("../lib/index.js");
	ctx.plugin(plugin, {});
	await new Promise((resolve) => setTimeout(resolve, 200));
	const route = routes.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	return {
		async summary(query) {
			const req = {
				method: "GET",
				url: `/api/usage-dashboard/summary?${query}`,
				socket: { remoteAddress: "127.0.0.1" },
				headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": "0", "x-dsh-usage-dashboard-tz-name": "UTC" }
			};
			let body = "";
			await route.handler(req, { writeHead() {}, end(text) { body = text; } });
			return JSON.parse(body);
		},
		dispose() { return ctx.fiber?.dispose?.(); }
	};
}

async function settled(instance, query) {
	let payload;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		payload = await instance.summary(query);
		if (payload.refreshing !== true && payload.partial !== true) return payload;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return payload;
}

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` (${detail})`}`);
	if (!ok) failures += 1;
};

// ---------------------------------------------------------------- scenario 1
// Sessions exist BEFORE the plugin ever starts, and there is no cache at all.
const early = { id: "early", events: mkEvents(EARLY, 3000) };
const late = { id: "late", events: mkEvents(LATE, 5000) };
const persistence = storeWith([early, late]);

const first = await boot(persistence, "s1");
const firstPayload = await settled(first, "days=all&refresh=1");
const totalTokens = firstPayload.allTime?.totals?.tokens ?? 0;
check("usage recorded before the plugin ran is counted", totalTokens === 8000, `allTime tokens ${totalTokens}, expected 8000`);
const dates = (firstPayload.days ?? []).map((d) => d.date);
check("both pre-existing sessions appear on their own days", dates.includes("2026-10-20") && dates.includes("2026-11-02"), dates.join(","));

// ---------------------------------------------------------------- scenario 2
// A session GROWS while nothing is running; the next walk must re-read it
// because its revision moved, and the total must go up, not double.
late.events.push(
	{ seq: 2, time: LATE + 60_000, type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 2000, outputTokens: 0 } } } }
);
const second = await boot(persistence, "s2");
const secondPayload = await settled(second, "days=all&refresh=1");
const grew = secondPayload.allTime?.totals?.tokens ?? 0;
check("a session that grew while idle is re-folded", grew === 10000, `allTime tokens ${grew}, expected 10000 (not 13000: no double count)`);

// ---------------------------------------------------------------- scenario 3
// A session that DISAPPEARS must stop contributing.
const shrinking = storeWith([early]);
const third = await boot(shrinking, "s3");
const thirdPayload = await settled(third, "days=all&refresh=1");
const afterDelete = thirdPayload.allTime?.totals?.tokens ?? 0;
check("a deleted session stops counting", afterDelete === 3000, `allTime tokens ${afterDelete}, expected 3000`);

rmSync(HOME, { recursive: true, force: true });

if (failures > 0) {
	console.log(`FAIL: ${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("OK: usage from while the plugin was off is counted once it starts");
process.exit(0);
