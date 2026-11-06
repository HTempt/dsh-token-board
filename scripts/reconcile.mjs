/**
 * Reconcile this plugin's fold against the sibling plugin's daily CSV export.
 *
 * The dashboard and `@ychris12138/dsh-usage-stats` read the SAME session logs, so
 * their per-day token totals must agree exactly. This script mounts the real
 * persistence backend over the real store with an EMPTY live session list, asks
 * the plugin's own route for its payload, and diffs it against
 * `GET /api/usage-stats/export/daily.csv`.
 *
 * This is the acceptance check for the "today is inaccurate" bug: before the
 * single-ledger fix, today read roughly DOUBLE the CSV figure.
 *
 *   node scripts/reconcile.mjs
 *
 * Requires the host to be running (the CSV comes from its HTTP API). The ONLY
 * day allowed to differ is today, because a session may still be appending:
 * that difference is reported as `DRIFT-TODAY` rather than as a failure.
 *
 * Environment:
 *   DSH_HOME               default ~/.dsh
 *   DSH_WEB_BASE           default http://127.0.0.1:3080
 *   DSH_RECONCILE_DAYS     window to compare, default 92
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

const home = dshHome();
const base = process.env.DSH_WEB_BASE ?? "http://127.0.0.1:3080";
const days = Number(process.env.DSH_RECONCILE_DAYS ?? 92);

// This run must not share the running host's cache: it builds its own fold and
// would otherwise overwrite the file the host serves from. A scratch DSH_HOME
// keeps both sides independent, so the comparison is honest. It mirrors the
// real home's INPUTS (the shared usage ledger) so imported history is present,
// and differs only in where this run writes its own cache.
const scratch = join(home, ".reconcile-home");
mkdirSync(join(scratch, "storages"), { recursive: true });
mkdirSync(join(scratch, "dsh-usage"), { recursive: true });
const realLedger = join(home, "dsh-usage", "usage-ledger.json");
if (existsSync(realLedger)) copyFileSync(realLedger, join(scratch, "dsh-usage", "usage-ledger.json"));
process.env.DSH_HOME = scratch;

const { Context } = await harness("@deepseek-ai/cordis");
const persistenceModule = await harness("@deepseek-ai/dsh-session-persistence-jsonl");

const ctx = new Context();
const registered = [];
ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
// An EMPTY live store: both sides then see exactly the persisted logs.
ctx.provide("sessions", { list: () => [], get: () => undefined });
ctx.plugin(persistenceModule, { root: join(home, "sessions"), compression: "zstd" });
let persistence;
for (let attempt = 0; attempt < 300; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	persistence = ctx.get("sessionPersistence");
	if (persistence !== undefined) break;
}
if (persistence === undefined) throw new Error("persistence backend did not start");

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

/** Call the plugin's summary route the way the browser half does. */
async function summary(query, tzSeconds = -new Date().getTimezoneOffset() * 60) {
	const route = registered.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const req = {
		method: "GET",
		url: `/api/usage-dashboard/summary?${query}`,
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": String(tzSeconds) }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

// A cold scan runs in the background by design, so wait for it to settle.
let payload;
for (let attempt = 0; attempt < 400; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 500));
	payload = await summary(`days=${days}`);
	if (payload.refreshing === false && payload.partial === false) break;
}

/** Fetch the sibling plugin's daily CSV and group it by date and model. */
const response = await fetch(`${base}/api/usage-stats/export/daily.csv`);
if (!response.ok) throw new Error(`daily CSV unavailable: HTTP ${response.status}`);
const lines = (await response.text()).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
const header = lines[0].slice(1, -1).split("\",\"");
const iDate = header.indexOf("date");
const iProvider = header.indexOf("provider");
const iModel = header.indexOf("model");
const iTotal = header.indexOf("total_tokens");
if ([iDate, iProvider, iModel, iTotal].some((index) => index < 0)) throw new Error("unexpected CSV header");

const official = new Map();
for (const line of lines.slice(1)) {
	const cells = line.slice(1, -1).split("\",\"");
	const date = cells[iDate];
	const key = `${cells[iProvider]}/${cells[iModel]}`;
	const total = Number(cells[iTotal]) || 0;
	let day = official.get(date);
	if (day === undefined) {
		day = { tokens: 0, models: new Map() };
		official.set(date, day);
	}
	day.tokens += total;
	day.models.set(key, (day.models.get(key) ?? 0) + total);
}

const mine = new Map(payload.days.map((day) => [day.date, day]));
const today = payload.days.at(-1)?.date ?? "";
let compared = 0;
let exact = 0;
const mismatches = [];
for (const [date, expected] of official) {
	const actual = mine.get(date);
	if (actual === undefined) continue;
	compared += 1;
	if (actual.tokens === expected.tokens) {
		exact += 1;
		continue;
	}
	const byModel = new Map(actual.byModel.map((row) => [row.model, row.tokens]));
	const modelDiffs = [];
	for (const key of new Set([...byModel.keys(), ...expected.models.keys()])) {
		const a = byModel.get(key) ?? 0;
		const b = expected.models.get(key) ?? 0;
		if (a !== b) modelDiffs.push({ key, actual: a, expected: b });
	}
	mismatches.push({
		date,
		actual: actual.tokens,
		expected: expected.tokens,
		drift: actual.tokens - expected.tokens,
		modelDiffs,
		isToday: date === today
	});
}

console.log(`days compared ${compared} (official ${official.size}, payload ${mine.size})`);
console.log(`exact ${exact} / ${compared}`);
for (const entry of mismatches) {
	console.log(`${entry.isToday ? "DRIFT-TODAY" : "MISMATCH"} ${entry.date} dashboard=${entry.actual} official=${entry.expected} diff=${entry.drift}`);
	for (const diff of entry.modelDiffs) console.log(`    ${diff.key} dashboard=${diff.actual} official=${diff.expected}`);
}
// Today may legitimately drift (a session is still appending); anything else is
// a real accounting disagreement and fails the run.
const failures = mismatches.filter((entry) => !entry.isToday);
if (failures.length > 0) {
	console.log(`FAIL: ${failures.length} day(s) disagree outside today`);
	process.exit(1);
}
console.log("OK: every settled day matches the sibling plugin exactly");
process.exit(0);
