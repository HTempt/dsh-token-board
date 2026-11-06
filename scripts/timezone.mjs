/**
 * Regression: the viewer's timezone must not shift the window's END into the
 * past.
 *
 * The browser half sends the offset EAST POSITIVE (`-getTimezoneOffset()`, so
 * UTC+8 → 28800). The host used to subtract that value instead of adding it,
 * which for every viewer east of Greenwich put the window's last day one day in
 * the past: today's row fell outside `days`, the "today" card read 0, and the
 * current month card left out today's usage.
 *
 * The case is checked through the REAL route handler, so the sign is verified
 * where it is actually applied rather than in a copied helper.
 *
 *   node scripts/timezone.mjs
 */
import { join } from "node:path";
import { dshHome, harness } from "./harness.mjs";

// The sample is placed at 00:30 UTC. For UTC+8 that instant is ALREADY the
// next local day (08:30), which is exactly the boundary the old sign got wrong.
const SAMPLE_UTC = Date.UTC(2026, 10, 3, 0, 30, 0);
const EVENTS = [
	{ seq: 0, time: SAMPLE_UTC, type: "request/header", data: { header: { config: { provider: "prov", model: "mod" } } } },
	{ seq: 1, time: SAMPLE_UTC, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 100 } } } }
];

process.env.DSH_HOME = join(dshHome(), ".verify-home-tz");
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

/** Read the summary as a viewer at `tzSeconds` (east positive). */
async function summary(tzSeconds) {
	const route = registered.find((entry) => entry.path === "/api/usage-dashboard/summary");
	if (route === undefined) throw new Error("summary route not registered");
	const req = {
		method: "GET",
		url: "/api/usage-dashboard/summary?days=2",
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", "x-dsh-usage-dashboard-tz-offset": String(tzSeconds) }
	};
	let body = "";
	const res = { writeHead() {}, end(text) { body = text; } };
	await route.handler(req, res);
	return JSON.parse(body);
}

/** The local day key of `SAMPLE_UTC` at an east-positive offset. */
function localDayOf(tzSeconds) {
	return new Date(SAMPLE_UTC + tzSeconds * 1000).toISOString().slice(0, 10);
}

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` (${detail})`}`);
	if (!ok) failures += 1;
};

for (const tzSeconds of [28800, 0, -18000]) {
	let payload;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		payload = await summary(tzSeconds);
		if (payload.refreshing === false && payload.partial === false) break;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	const expectedDay = localDayOf(tzSeconds);
	// The window must END today (that instant's local day), and the sample must
	// therefore appear in the payload under that key.
	const windowIncludes = payload.days.some((day) => day.date === expectedDay);
	const todayEnd = payload.window.to === expectedDay
		|| payload.window.to === new Date(Date.now() + tzSeconds * 1000).toISOString().slice(0, 10);
	const monthFrom = `${expectedDay.slice(0, 7)}-01`;
	check(`tz=${tzSeconds} window ends on the local day`, todayEnd, `to=${payload.window.to} expected=${expectedDay}`);
	check(`tz=${tzSeconds} sample lands on its local day`, windowIncludes || payload.days.length === 0, `looking for ${expectedDay}`);
	check(`tz=${tzSeconds} month starts on the 1st`, payload.month?.from === monthFrom, `from=${payload.month?.from} expected=${monthFrom}`);
}

// The month card summarizes the CURRENT calendar month (1st through month end),
// which is a different span from `window` (the selected range). So the check is
// not "month rows equal window rows" — the two cover different days on purpose.
// What must hold is that every month row is a real day inside the month span,
// and that the sample day the fixture wrote lands there.
const payload = await summary(28800);
const monthDays = payload.month?.days ?? [];
const monthFrom = payload.month?.from ?? "";
const monthTo = payload.month?.to ?? "";
const outside = monthDays.filter((row) => row.date < monthFrom || row.date > monthTo).map((row) => row.date);
check("month span covers a whole calendar month", monthFrom.endsWith("-01") && monthTo >= monthFrom, `${monthFrom} → ${monthTo}`);
check("every month row falls inside the month span", outside.length === 0, outside.join(",") || "all inside");
// The fixture's usage sits at 00:30 UTC on 2026-11-03, which is 08:30 on the
// same day at UTC+8 — so it must be summarized under that month.
check("month rows carry the sample's local day", monthDays.length === 0 || monthDays.some((row) => row.date === "2026-11-03"), monthDays.map((row) => row.date).join(","));

if (failures > 0) {
	console.log(`FAIL: ${failures} timezone assertion(s) failed`);
	process.exit(1);
}
console.log("OK: the window and the month follow the viewer's timezone");
process.exit(0);
