/**
 * Regression: a viewer in a DST-observing zone must have each hour bucketed by
 * the offset in force AT THAT HOUR, not by whatever offset their machine
 * reports today.
 *
 * Before the zone-name path, the host folded the whole window with one offset
 * sampled at page open. For a New York viewer reading summer history in winter
 * that is off by an hour, which moves every usage sample in that hour onto the
 * neighbouring calendar day.
 *
 *   node scripts/dst.mjs
 */
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

// 2026-07-15T04:30Z is 00:30 local in New York (EDT, UTC-4) — correct day is
// 07-15. Applying the winter offset (EST, UTC-5) puts it at 23:30 on 07-14.
const SAMPLE_UTC = Date.UTC(2026, 6, 15, 4, 30, 0);
const EVENTS = [
	{ seq: 0, time: SAMPLE_UTC, type: "request/header", data: { header: { config: { provider: "prov", model: "mod" } } } },
	{ seq: 1, time: SAMPLE_UTC, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } } } }
];

process.env.DSH_HOME = join(dshHome(), ".verify-home-dst");
const { Context } = await harness("@deepseek-ai/cordis");

const ctx = new Context();
const registered = [];
ctx.provide("webServer", { register(route) { registered.push(route); return () => {}; } });
ctx.provide("sessions", {
	list: () => [{ id: "s1", seq: EVENTS.length, inheritedEventCount: 0, snapshotEvents: (from = 0) => EVENTS.slice(from) }],
	get: () => undefined
});
ctx.provide("sessionPersistence", {
	async list() { return [{ header: { id: "s1", createdAt: SAMPLE_UTC, isSeeded: false }, revision: "r1", sizeBytes: 50 }]; },
	async open() { return { inheritedEventCount: 0, async read(from = 0) { return { events: EVENTS.slice(from) }; }, async close() {} }; }
});

const plugin = await import("../lib/index.js");
ctx.plugin(plugin, {});
await new Promise((resolve) => setTimeout(resolve, 200));

/** Read the summary as a viewer identified by an IANA zone. */
async function summary({ zone, offsetSeconds }) {
	const route = registered.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const headers = { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": String(offsetSeconds) };
	if (zone !== undefined) headers["x-dsh-usage-dashboard-tz-name"] = zone;
	const req = { method: "GET", url: "/api/usage-dashboard/summary?days=400&from=2026-07-14&to=2026-07-16", socket: { remoteAddress: "127.0.0.1" }, headers };
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` (${detail})`}`);
	if (!ok) failures += 1;
};

/** The calendar day the sample was folded onto. */
function sampleDay(payload) {
	const row = payload.days.find((day) => day.tokens > 0);
	return row === undefined ? undefined : row.date;
}

async function settled(options) {
	let payload;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		payload = await summary(options);
		if (payload.refreshing !== true && payload.partial !== true) break;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return payload;
}

// 1. Zone name wins: summer instant must land on the day its zone says.
const withZone = await settled({ zone: "America/New_York", offsetSeconds: -14400 });
check("America/New_York + summer instant folds onto 2026-07-15", sampleDay(withZone) === "2026-07-15", `got ${sampleDay(withZone)}`);

// 2. The wrong offset alone must NOT be able to pull it a day back, because the
//    zone name overrides it. This is the bug the zone name exists to prevent.
const zoneOverridesOffset = await settled({ zone: "America/New_York", offsetSeconds: -18000 });
check("zone name overrides a stale (winter) offset", sampleDay(zoneOverridesOffset) === "2026-07-15", `got ${sampleDay(zoneOverridesOffset)}`);

// 3. Without a zone the offset still decides, which keeps old clients working.
const offsetOnly = await settled({ offsetSeconds: -18000 });
check("without a zone the offset decides (back-compat)", sampleDay(offsetOnly) === "2026-07-14", `got ${sampleDay(offsetOnly)}`);

// 4. A zone with no DST must be unaffected either way.
for (const [zone, offset] of [["Asia/Shanghai", 28800], ["Asia/Kolkata", 19800]]) {
	const payload = await settled({ zone, offsetSeconds: offset });
	const local = new Date(SAMPLE_UTC + offset * 1000).toISOString().slice(0, 10);
	check(`${zone} folds onto ${local}`, sampleDay(payload) === local, `got ${sampleDay(payload)}`);
}

// 5. A bogus zone name must fall back to the offset instead of failing.
const bogus = await settled({ zone: "Not/AZone", offsetSeconds: -18000 });
check("unknown zone falls back to the offset", bogus.ok === true && sampleDay(bogus) === "2026-07-14", `ok=${bogus.ok} got ${sampleDay(bogus)}`);

if (failures > 0) {
	console.log(`FAIL: ${failures} DST assertion(s) failed`);
	process.exit(1);
}
console.log("OK: DST-observing viewers keep each hour on its own local day");
process.exit(0);
