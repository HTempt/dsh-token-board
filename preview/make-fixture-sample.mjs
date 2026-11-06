/**
 * Build a SYNTHETIC summary payload for the offline preview.
 *
 * `make-fixture.mjs` reads the real session store, so its output contains the
 * author's own workspace paths, provider names and token counts. That is fine
 * on the machine it runs on and unacceptable in a public repository, so this
 * script produces a payload of the same shape from generated data instead:
 * every workspace, provider and model here is invented.
 *
 * Deterministic: the same day sequence always yields the same numbers, so a
 * screenshot taken today still matches one taken next week.
 *
 *   node preview/make-fixture-sample.mjs
 *
 * @module dsh-usage-dashboard/preview/make-fixture-sample
 */
import { writeFileSync } from "node:fs";

const TZ_OFFSET_SECONDS = 28_800; // UTC+8, the timezone the samples assume
const DAYS = 92;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

/** Provinces of the fake dataset. Nothing here corresponds to a real service. */
const PROVIDERS = [
	{ provider: "example-cloud", models: ["example-large", "example-small"], share: 0.42, cacheRate: 0.61 },
	{ provider: "demo-inference", models: ["demo-pro-1", "demo-lite-2"], share: 0.31, cacheRate: 0.18 },
	{ provider: "sample-endpoint", models: ["sample-chat"], share: 0.19, cacheRate: 0.84 },
	{ provider: "local-proxy", models: ["proxy-model-a", "proxy-model-b"], share: 0.08, cacheRate: 0 }
];

/** Fake workspaces, shaped like real ones (`name` is the directory basename). */
const WORKSPACES = [
	{ name: "example-app", cwd: "/home/dev/projects/example-app" },
	{ name: "demo-service", cwd: "/home/dev/projects/demo-service" },
	{ name: "sample-tools", cwd: "/home/dev/projects/sample-tools" },
	{ name: "docs-site", cwd: "/home/dev/work/docs-site" },
	{ name: "lab-notebook", cwd: "/home/dev/work/lab-notebook" }
];

/**
 * A small deterministic PRNG so the fixture never changes between runs.
 * @param seed - initial state.
 * @returns a function yielding values in [0, 1).
 */
function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const random = mulberry32(20261106);

/** Local day key for an instant, in the sample timezone. */
function dayKeyOf(timeMs) {
	const shifted = new Date(timeMs + TZ_OFFSET_SECONDS * 1000);
	return shifted.toISOString().slice(0, 10);
}

/** Zeroed counters with every field the payload carries. */
function zero() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		calls: 0,
		failedCalls: 0,
		retries: 0,
		attempts: 0,
		tokens: 0,
		successRate: 0,
		cacheHitRate: null
	};
}

/** Fold a row into its totals, recomputing the derived rates. */
function settle(row) {
	row.tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.reasoningTokens;
	row.attempts = row.calls + row.failedCalls;
	row.successRate = row.attempts === 0 ? 0 : Number(((row.calls / row.attempts) * 100).toFixed(1));
	const prompt = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
	row.cacheHitRate = prompt === 0 ? null : Number(((row.cacheReadTokens / prompt) * 100).toFixed(1));
	return row;
}

/** Add `source` counters into `target`. */
function addInto(target, source) {
	for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "calls", "failedCalls", "retries"]) {
		target[key] += source[key];
	}
	return target;
}

const days = [];
for (let index = DAYS - 1; index >= 0; index -= 1) {
	const date = dayKeyOf(NOW - index * 86_400_000);
	// A working week with a quiet weekend, plus one spike day for the calendar.
	const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
	const weekend = weekday === 0 || weekday === 6;
	const spike = index === 12 || index === 40;
	const scale = (weekend ? 0.18 : 1) * (spike ? 2.6 : 1) * (0.65 + random() * 0.7);
	if (scale < 0.12 && !spike) continue; // some days simply have no usage

	const byProvider = [];
	const byModel = [];
	const dayTotal = zero();
	const dayModels = new Map();

	for (const provider of PROVIDERS) {
		const calls = Math.round(provider.share * 240 * scale);
		if (calls === 0) continue;
		const failed = random() < 0.5 ? 0 : Math.round(calls * random() * 0.05);
		const row = zero();
		row.calls = calls;
		row.failedCalls = failed;
		row.retries = random() < 0.4 ? Math.round(failed * 0.6) : 0;
		row.inputTokens = Math.round(calls * 1_450 * (0.7 + random() * 0.6));
		row.outputTokens = Math.round(calls * 260 * (0.7 + random() * 0.6));
		row.cacheReadTokens = Math.round(row.inputTokens * provider.cacheRate * (0.8 + random() * 0.4));
		row.cacheWriteTokens = Math.round(row.cacheReadTokens * 0.04);
		row.reasoningTokens = Math.round(calls * 55 * random());
		settle(row);
		byProvider.push({ provider: provider.provider, ...row });
		addInto(dayTotal, row);

		for (const [modelIndex, model] of provider.models.entries()) {
			const share = modelIndex === 0 ? 0.68 : 0.32;
			const modelRow = zero();
			modelRow.calls = Math.round(calls * share);
			modelRow.failedCalls = Math.round(failed * share);
			modelRow.retries = Math.round(row.retries * share);
			modelRow.inputTokens = Math.round(row.inputTokens * share);
			modelRow.outputTokens = Math.round(row.outputTokens * share);
			modelRow.cacheReadTokens = Math.round(row.cacheReadTokens * share);
			modelRow.cacheWriteTokens = Math.round(row.cacheWriteTokens * share);
			modelRow.reasoningTokens = Math.round(row.reasoningTokens * share);
			settle(modelRow);
			const key = `${provider.provider}/${model}`;
			dayModels.set(key, dayModels.get(key) ?? { model: key, ...zero() });
			const merged = dayModels.get(key);
			addInto(merged, modelRow);
			merged.calls = (merged.calls ?? 0) + modelRow.calls;
			merged.failedCalls = (merged.failedCalls ?? 0) + modelRow.failedCalls;
			merged.retries = (merged.retries ?? 0) + modelRow.retries;
			settle(merged);
		}
	}

	settle(dayTotal);
	days.push({
		date,
		...dayTotal,
		byModel: [...dayModels.values()].sort((a, b) => b.tokens - a.tokens),
		byProvider: byProvider.sort((a, b) => b.tokens - a.tokens)
	});
}

// Totals over the window, plus a cumulative figure larger than the window.
const windowTotals = zero();
for (const day of days) addInto(windowTotals, day);
settle(windowTotals);

const allTime = { ...windowTotals };
allTime.tokens = Math.round(windowTotals.tokens * 1.9);
allTime.calls = Math.round(windowTotals.calls * 1.8);
settle(allTime);

// Provider and model rankings are independent of the daily rows.
const providerTotals = new Map();
const modelTotals = new Map();
for (const day of days) {
	for (const row of day.byProvider) {
		const key = row.provider;
		const target = providerTotals.get(key) ?? { provider: key, ...zero() };
		addInto(target, row);
		target.calls += row.calls;
		target.failedCalls += row.failedCalls;
		target.retries += row.retries;
		providerTotals.set(key, target);
	}
	for (const row of day.byModel) {
		const target = modelTotals.get(row.model) ?? { model: row.model, ...zero() };
		addInto(target, row);
		target.calls += row.calls;
		target.failedCalls += row.failedCalls;
		target.retries += row.retries;
		modelTotals.set(row.model, target);
	}
}

// Workspaces own their own sessions and days; totals are invented but stable.
const workspaces = WORKSPACES.map((workspace, index) => {
	const share = [0.38, 0.24, 0.17, 0.13, 0.08][index];
	const totals = zero();
	totals.calls = Math.round(windowTotals.calls * share);
	totals.inputTokens = Math.round(windowTotals.inputTokens * share);
	totals.outputTokens = Math.round(windowTotals.outputTokens * share);
	totals.cacheReadTokens = Math.round(windowTotals.cacheReadTokens * share);
	totals.cacheWriteTokens = Math.round(windowTotals.cacheWriteTokens * share);
	totals.reasoningTokens = Math.round(windowTotals.reasoningTokens * share);
	totals.failedCalls = Math.round(windowTotals.failedCalls * share);
	totals.retries = Math.round(windowTotals.retries * share);
	settle(totals);
	const owned = days.filter((_, dayIndex) => dayIndex % (index + 2) === 0);
	return {
		cwd: workspace.cwd,
		name: workspace.name,
		sessions: Math.max(1, Math.round(60 * share)),
		...totals,
		activeDays: owned.length,
		peakDay: owned.length === 0 ? null : owned.reduce((best, day) => (day.tokens > best.tokens ? day : best), owned[0]),
		providers: PROVIDERS.slice(0, Math.min(4, index + 2)).map((provider) => provider.provider),
		activity: {
			toolCalls: Math.round(totals.calls * 1.15),
			tools: [
				{ name: "read", calls: Math.round(totals.calls * 0.31), failedCalls: 1, totalMs: 9_400, avgMs: 20, maxMs: 145 },
				{ name: "edit", calls: Math.round(totals.calls * 0.22), failedCalls: 4, totalMs: 5_100, avgMs: 26, maxMs: 210 },
				{ name: "bash", calls: Math.round(totals.calls * 0.19), failedCalls: 0, totalMs: 288_000, avgMs: 4_100, maxMs: 120_000 },
				{ name: "grep", calls: Math.round(totals.calls * 0.12), failedCalls: 2, totalMs: 7_900, avgMs: 128, maxMs: 1_240 },
				{ name: "write", calls: Math.round(totals.calls * 0.08), failedCalls: 1, totalMs: 2_100, avgMs: 29, maxMs: 190 }
			],
			compactions: Math.max(0, Math.round(totals.calls * 0.006)),
			compactionMs: Math.max(0, Math.round(totals.calls * 0.006 * 41_000)),
			llmMs: Math.round(totals.calls * 3_900),
			llmCalls: totals.calls
		},
		days: owned.map((day) => ({ date: day.date, tokens: Math.round(day.tokens * share), calls: Math.round(day.calls * share) }))
	};
});

const unattributed = { name: "（未归属）", tokens: Math.round(windowTotals.tokens * 0.031), calls: Math.round(windowTotals.calls * 0.028) };

const monthFrom = `${days.at(-1).date.slice(0, 7)}-01`;
const monthDays = days.filter((day) => day.date >= monthFrom);

const payload = {
	ok: true,
	window: { from: days[0].date, to: days.at(-1).date, days: days.length, explicit: false },
	month: { from: monthFrom, to: days.at(-1).date, days: monthDays.map((day) => ({ date: day.date, tokens: day.tokens, calls: day.calls, failedCalls: day.failedCalls, attempts: day.attempts, successRate: day.successRate, inputTokens: day.inputTokens, outputTokens: day.outputTokens, cacheReadTokens: day.cacheReadTokens, cacheWriteTokens: day.cacheWriteTokens, reasoningTokens: day.reasoningTokens, cacheHitRate: day.cacheHitRate, byProvider: day.byProvider, byModel: day.byModel })) },
	windowTotals,
	allTime: { totals: allTime },
	providers: [...providerTotals.values()].map(settle).sort((a, b) => b.tokens - a.tokens),
	models: [...modelTotals.values()].map(settle).sort((a, b) => b.tokens - a.tokens),
	workspaces,
	unattributed,
	days: days.map((day) => ({ date: day.date, tokens: day.tokens, calls: day.calls, failedCalls: day.failedCalls, attempts: day.attempts, successRate: day.successRate, inputTokens: day.inputTokens, outputTokens: day.outputTokens, cacheReadTokens: day.cacheReadTokens, cacheWriteTokens: day.cacheWriteTokens, reasoningTokens: day.reasoningTokens, cacheHitRate: day.cacheHitRate, byProvider: day.byProvider, byModel: day.byModel })),
	sessions: workspaces.reduce((sum, workspace) => sum + workspace.sessions, 0),
	refreshing: false,
	partial: false,
	updatedAt: NOW
};

writeFileSync(new URL("./fixture.js", import.meta.url), `window.__FIXTURE__=${JSON.stringify(payload)};`, "utf8");
writeFileSync(new URL("./payload.json", import.meta.url), JSON.stringify(payload, undefined, 2), "utf8");
console.log(`synthetic fixture: ${payload.days.length} days, ${payload.sessions} sessions, ${payload.window.from} → ${payload.window.to}`);
