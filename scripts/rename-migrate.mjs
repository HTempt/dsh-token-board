/**
 * Regression: files written under the PRE-rename names must be MIGRATED.
 *
 * The package was published as `dsh-usage-dashboard` before 0.1.0 settled on
 * `dsh-token-board`. Installs from that era keep the absorbed history in
 * `<DSH_HOME>/dsh-usage-dashboard/` and the digests + fold cache in
 * `<DSH_HOME>/storages/usage-dashboard-*.json`. The first start after the
 * upgrade moves all three; a second start (both names present) must keep the
 * NEW file and leave the old one untouched.
 *
 *   node scripts/rename-migrate.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

// Two scratch homes: one for the fresh migration, one for the both-exist case.
const homeA = join(dshHome(), ".verify-home-rename-a");
const homeB = join(dshHome(), ".verify-home-rename-b");
for (const home of [homeA, homeB]) rmSync(home, { recursive: true, force: true });

/** The absorbed history: one day whose session log no longer exists. */
const statistics = {
	version: 1,
	history: {
		days: [["2026-09-01", [["deepseek-official", [["deepseek-v4", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 2, failedCalls: 0, retries: 0 }]]]]]]
	}
};

function seedLegacy(home) {
	mkdirSync(join(home, "dsh-usage-dashboard"), { recursive: true });
	mkdirSync(join(home, "storages"), { recursive: true });
	writeFileSync(join(home, "dsh-usage-dashboard", "statistics.json"), JSON.stringify(statistics));
	writeFileSync(join(home, "storages", "usage-dashboard-digests.json"), JSON.stringify({ version: 1, digests: {} }));
	writeFileSync(join(home, "storages", "usage-dashboard-cache.json"), JSON.stringify({ version: 4, enumeratedAt: 0, sessions: {}, hours: {} }));
}

process.env.DSH_HOME = homeA;
seedLegacy(homeA);
const { Context } = await harness("@deepseek-ai/cordis");

async function makePlugin() {
	const ctx = new Context();
	const registered = [];
	ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
	ctx.provide("sessions", { list: () => [], get: () => undefined });
	// The log is gone: only the migrated statistics can answer for that day.
	ctx.provide("sessionPersistence", { async list() { return []; }, async open() { throw new Error("not found"); } });
	const plugin = await import("../lib/index.js");
	ctx.plugin(plugin, {});
	await new Promise((resolve) => setTimeout(resolve, 200));
	return { ctx, registered };
}

async function summary(registered) {
	const route = registered.find((entry) => entry.path === "/api/dsh-token-board/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const req = {
		method: "GET",
		url: "/api/dsh-token-board/summary?days=all",
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-token-board-tz-offset": "28800" }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

let failed = false;

// --- Case A: fresh migration ---------------------------------------------
{
	const { registered } = await makePlugin();
	// The migration runs on the first read (restore()).
	await summary(registered);
	await new Promise((resolve) => setTimeout(resolve, 300));

	const newStats = join(homeA, "dsh-token-board", "statistics.json");
	const oldStats = join(homeA, "dsh-usage-dashboard", "statistics.json");
	const newDigests = join(homeA, "storages", "dsh-token-board-digests.json");
	const newCache = join(homeA, "storages", "dsh-token-board-cache.json");
	const moved = existsSync(newStats) && existsSync(newDigests) && existsSync(newCache);
	const oldGone = !existsSync(oldStats)
		&& !existsSync(join(homeA, "storages", "usage-dashboard-digests.json"))
		&& !existsSync(join(homeA, "storages", "usage-dashboard-cache.json"));
	console.log("case A — files moved:", moved, "| old names gone:", oldGone);
	if (!moved) { console.log("FAIL: legacy files were not migrated"); failed = true; }
	if (!oldGone) { console.log("FAIL: legacy files were copied but not moved"); failed = true; }

	// The history must answer through the new names.
	let payload = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		payload = await summary(registered);
		if (payload.refreshing === false) break;
	}
	const day = payload.days.find((entry) => entry.date === "2026-09-01");
	const ok = day !== undefined && day.tokens === 1100;
	console.log("case A — migrated day present:", day !== undefined, "tokens", day?.tokens, "(expected 1100)");
	if (!ok) { console.log("FAIL: the migrated statistics were not served"); failed = true; }
}

// --- Case B: both names exist (re-run after an earlier migration) --------
{
	process.env.DSH_HOME = homeB;
	seedLegacy(homeB);
	// The NEW statistics file is already present and wins.
	mkdirSync(join(homeB, "dsh-token-board"), { recursive: true });
	writeFileSync(join(homeB, "dsh-token-board", "statistics.json"), JSON.stringify({
		version: 1,
		history: { days: [["2026-09-02", [["deepseek-official", [["new-name-day", { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, failedCalls: 0, retries: 0 }]]]]]] }
	}));
	const { registered } = await makePlugin();
	await summary(registered);
	await new Promise((resolve) => setTimeout(resolve, 300));

	const oldStill = existsSync(join(homeB, "dsh-usage-dashboard", "statistics.json"));
	const newStill = existsSync(join(homeB, "dsh-token-board", "statistics.json"));
	console.log("case B — both existed: new kept:", newStill, "| old untouched:", oldStill);
	if (!newStill || !oldStill) { console.log("FAIL: the both-exist case must keep BOTH files"); failed = true; }

	let payload = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		payload = await summary(registered);
		if (payload.refreshing === false) break;
	}
	const servedNew = payload.days.some((entry) => entry.date === "2026-09-02");
	const servedOld = payload.days.some((entry) => entry.date === "2026-09-01");
	console.log("case B — served the NEW file's day:", servedNew, "| did NOT serve the old file's day:", !servedOld);
	if (!servedNew || servedOld) { console.log("FAIL: the new file must win when both exist"); failed = true; }
}

// The digests must still verify after the move: read the moved statistics back.
{
	const raw = readFileSync(join(homeA, "dsh-token-board", "statistics.json"), "utf8");
	const parsed = JSON.parse(raw);
	console.log("case A — moved statistics parse and carry history:", Array.isArray(parsed.history?.days) && parsed.history.days.length > 0);
	if (!(Array.isArray(parsed.history?.days) && parsed.history.days.length > 0)) failed = true;
}

for (const home of [homeA, homeB]) rmSync(home, { recursive: true, force: true });
console.log(failed ? "FAIL" : "OK: legacy-named files migrate on first start; both-exist keeps the new file");
process.exit(failed ? 1 : 0);
