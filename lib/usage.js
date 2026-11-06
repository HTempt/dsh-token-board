/**
 * dsh-usage-dashboard — pure token-usage aggregation over durable session event
 * logs, folded into UTC-hour buckets so any viewer timezone can be projected
 * onto calendar days without re-reading a session log.
 *
 * ## Counting rules (kept identical to `@ychris12138/dsh-usage-stats`)
 *
 * A **call** is one API request that reported a usage sample, exactly as the
 * reference plugin counts it: a usage sample rides an `assistant/chunk`
 * (`data.chunk.type === "usage"`), a settling `assistant/message`
 * (`data.usage`), or a `compaction/summary` (`data.usage`). A sample whose
 * buckets are all zero is a warmup request and is not a call, so a day's
 * `calls` always equals the sum of the call counts on the model rows it shows.
 *
 * A repeat for the same `(turn, step)` REPLACES the earlier sample rather than
 * adding to it: the previous contribution is subtracted from the exact hour,
 * model, and provider bucket it was added to.
 *
 * Two facts the reference plugin does not surface ride beside `calls`, never
 * inside it, so token/call figures stay comparable:
 *
 *   - `failedCalls` — `assistant/attempt` records: a model stream that settled
 *     without committing a model-visible message (failed, retried, cancelled,
 *     stream error). These cost a request but produced no usage sample, so
 *     they are requests that failed rather than calls the provider billed.
 *   - `retries` — `llm/retry` transitions scheduled after a failed attempt.
 *
 * Their sum with `calls` is the number of *attempts*; the success rate the
 * panel shows is derived from attempts, never from a `calls` figure that would
 * already exclude the failures.
 *
 * ## Attribution
 *
 * Provider and model come from `data.message.source` on a completed message and
 * from the last `request/header` route for a failed attempt, which carries no
 * source of its own. Anything unresolved lands in `unknown/unknown`.
 *
 * @module dsh-usage-dashboard/usage
 */

/** UTC hour bucket key: `YYYY-MM-DDTHH`. */
export function hourKey(timeMs) {
	const date = new Date(timeMs);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hour = String(date.getUTCHours()).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}-${day}T${hour}`;
}

/** Calendar `YYYY-MM-DD` key for a millisecond epoch in the viewer's timezone. */
export function dayKey(timeMs, tzOffsetMinutes = 0) {
	const shifted = new Date(timeMs - tzOffsetMinutes * 60_000);
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Calendar day of one UTC hour bucket in the viewer's timezone.
 * `tzOffsetMinutes` follows the `Date#getTimezoneOffset` convention (minutes to
 * add to local time to reach UTC), so a bucket lands on the day the viewer
 * actually experienced it.
 * @param key - UTC hour bucket key.
 * @param tzOffsetMinutes - viewer offset; 0 reads UTC.
 */
export function localDayOf(key, tzOffsetMinutes = 0) {
	const [datePart, hourPart] = key.split("T");
	const [year, month, day] = datePart.split("-").map(Number);
	const utcMs = Date.UTC(year, month - 1, day, Number(hourPart));
	return dayKey(utcMs, tzOffsetMinutes);
}

/** One empty usage bucket. */
export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		/** Requests that reported a usage sample — the reference plugin's `calls`. */
		calls: 0,
		/** Settled attempts that produced no model message and no usage sample. */
		failedCalls: 0,
		/** Retry transitions scheduled after a failed attempt. */
		retries: 0
	};
}

/** Total tokens across every bucket (input, output, and both cache sides). */
export function totalTokens(buckets) {
	return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/** Billed calls in a bucket — identical to the reference plugin's `calls`. */
export function totalCalls(buckets) {
	return buckets.calls;
}

/** Requests attempted: billed calls plus those that settled without a message. */
export function totalAttempts(buckets) {
	return buckets.calls + buckets.failedCalls;
}

/** Attempt success rate in percent (one decimal), or null when nothing ran. */
export function attemptSuccessRate(buckets) {
	const attempts = totalAttempts(buckets);
	if (attempts <= 0) return null;
	return Math.round((buckets.calls / attempts) * 1000) / 10;
}

/**
 * Prompt-side cache hit rate in percent (one decimal), or null when the request
 * reported no prompt tokens at all.
 */
export function cacheHitRate(buckets) {
	const prompt = buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
	if (prompt <= 0) return null;
	return Math.round((buckets.cacheReadTokens / prompt) * 1000) / 10;
}

/** Provider usage → buckets (cache fields are optional in the wire shape). */
export function bucketsOf(usage) {
	return {
		...zeroBuckets(),
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0
	};
}

/** Add one bucket into another (mutating the target). */
export function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.calls += source.calls;
	target.failedCalls += source.failedCalls;
	target.retries += source.retries;
	return target;
}

/** Subtract one bucket from another (mutating the target). */
export function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	target.reasoningTokens -= source.reasoningTokens;
	target.calls -= source.calls;
	target.failedCalls -= source.failedCalls;
	target.retries -= source.retries;
	return target;
}

/** Fetch or create the bucket for one key in a row map. */
export function rowFor(rows, key) {
	let row = rows.get(key);
	if (row === undefined) {
		row = zeroBuckets();
		rows.set(key, row);
	}
	return row;
}

/** The `provider/model` attribution of one event. */
function routeOf(event) {
	const source = event.data?.message?.source;
	if (source !== undefined && typeof source.model === "string" && source.model !== "") {
		return {
			providerId: typeof source.provider === "string" && source.provider !== "" ? source.provider : "unknown",
			model: source.model
		};
	}
	const config = event.data?.header?.config;
	if (config !== undefined && typeof config.model === "string" && config.model !== "") {
		return {
			providerId: typeof config.provider === "string" && config.provider !== "" ? config.provider : "unknown",
			model: config.model
		};
	}
	return undefined;
}

/** `provider/model` row key. */
export function modelKeyOf(route) {
	return route === undefined ? "unknown/unknown" : `${route.providerId}/${route.model}`;
}

/** Provider portion of a `provider/model` row key. */
export function providerOfModelKey(key) {
	const slash = key.indexOf("/");
	return slash > 0 ? key.slice(0, slash) : key;
}

/** The model portion of a `provider/model` row key. */
export function modelOfModelKey(key) {
	const slash = key.indexOf("/");
	return slash > 0 ? key.slice(slash + 1) : key;
}

/**
 * Provider identity used for cross-source reconciliation.
 *
 * The ledger stores the official DeepSeek account under its display spelling
 * (`DeepSeek`) while the runtime route id is `deepseek-official`; both describe
 * the same account, so they must fold into one family or the merge would keep
 * two halves of one day apart.
 * @param provider - raw provider id or ledger key.
 * @returns the family id used on both sides.
 */
export function providerFamilyOf(provider) {
	if (typeof provider !== "string" || provider === "") return "unknown";
	const lower = provider.toLowerCase();
	if (lower === "deepseek" || lower === "deepseek-official" || lower === "deepseek-account") return "deepseek-official";
	return provider;
}

/**
 * One session's incremental fold state.
 *
 * `hours` holds `UTC hour → { totals, models }`. Provider rows are NOT stored:
 * they are derived from the model rows at render time, so a reconciliation that
 * touches per-model call counts cannot leave the provider rows disagreeing with
 * the models they summarize.
 * @returns a fresh, empty fold state.
 */
/**
 * A fresh activity record.
 *
 * `tools` maps a tool name to `{ calls, failedCalls, totalMs, maxMs }`: the
 * count is what a reader compares across tools, and the durations say whether
 * a tool is slow in general or was slow once.
 * `pending` holds tool callIds waiting for their result, so a duration is the
 * gap between the call and its own result rather than between unrelated events.
 */
export function createActivity() {
	return {
		tools: new Map(),
		pending: new Map(),
		compactions: 0,
		compactionMs: 0,
		llmMs: 0,
		llmCalls: 0,
		stepStartMs: new Map()
	};
}

/** One tool name's counters, created on first use. */
function toolOf(activity, name) {
	let entry = activity.tools.get(name);
	if (entry === undefined) {
		entry = { calls: 0, failedCalls: 0, totalMs: 0, maxMs: 0 };
		activity.tools.set(name, entry);
	}
	return entry;
}

/**
 * Fold one non-usage event into the activity record.
 *
 * Only the event kinds that carry a measurable fact are handled; anything else
 * returns without touching state, so an unknown event can never corrupt a
 * duration.
 * @param activity - the fold's activity record.
 * @param event - the raw session event.
 */
function applyActivity(activity, event) {
	const type = event.type;
	const time = event.time;
	const data = event.data;
	if (type === "tool/call") {
		const name = typeof data?.name === "string" && data.name !== "" ? data.name : "unknown";
		const entry = toolOf(activity, name);
		entry.calls += 1;
		// Remember when this call started, keyed by its own id, so the matching
		// result can close it. A call with no id cannot be paired and is left
		// duration-less rather than credited to some other call's gap.
		if (typeof data?.callId === "string" && Number.isFinite(time)) {
			activity.pending.set(data.callId, { name, startMs: time });
		}
		return;
	}
	if (type === "tool/result") {
		const callId = data?.toolCallId ?? data?.message?.toolCallId;
		if (typeof callId !== "string") return;
		const open = activity.pending.get(callId);
		if (open === undefined) return;
		activity.pending.delete(callId);
		if (!Number.isFinite(time)) return;
		const elapsed = Math.max(0, time - open.startMs);
		const entry = toolOf(activity, open.name);
		entry.totalMs += elapsed;
		if (elapsed > entry.maxMs) entry.maxMs = elapsed;
		// A result whose message reports an error is a failed call. The flag is
		// read from the message the tool returned, which is what the panel would
		// call a failure.
		if (data?.message?.isError === true) entry.failedCalls += 1;
		return;
	}
	if (type === "compaction/start") {
		if (typeof data?.compactionId === "string" && Number.isFinite(time)) {
			activity.stepStartMs.set(`c:${data.compactionId}`, time);
		}
		return;
	}
	if (type === "compaction/end") {
		const startKey = `c:${data?.compactionId}`;
		const startedAt = activity.stepStartMs.get(startKey);
		if (startedAt !== undefined && Number.isFinite(time)) {
			activity.stepStartMs.delete(startKey);
			activity.compactions += 1;
			activity.compactionMs += Math.max(0, time - startedAt);
		}
		return;
	}
	if (type === "step/start") {
		if (Number.isSafeInteger(data?.step) && Number.isFinite(time)) {
			activity.stepStartMs.set(`s:${data.turn}:${data.step}`, time);
		}
		return;
	}
	if (type === "step/end") {
		const key = `s:${data?.turn}:${data?.step}`;
		const startedAt = activity.stepStartMs.get(key);
		if (startedAt !== undefined && Number.isFinite(time)) {
			activity.stepStartMs.delete(key);
			activity.llmCalls += 1;
			activity.llmMs += Math.max(0, time - startedAt);
		}
		return;
	}
}

export function createFold() {
	return {
		hours: new Map(),
		/**
		 * Session activity: what the model did besides spend tokens.
		 *
		 * Kept apart from `hours` on purpose. `hours` is keyed by hour and holds
		 * billable buckets; these are counts and durations for a DIFFERENT question
		 * (how the session worked), and folding them into a bucket would change the
		 * cache format and every existing row's identity.
		 */
		activity: createActivity(),
		lastSample: null,
		/** Compaction summaries key their own replacement slot; see applyEvents. */
		compactionSamples: new Map(),
		currentRoute: undefined,
		/**
		 * Last folded event seq in this log's own sequence space, or -1 before
		 * anything is folded. A tail read starts at or before it (the persistence
		 * read offset is inclusive), so only events above it are applied.
		 */
		consumed: -1,
		/**
		 * Which source this fold currently describes: `live` (the session's
		 * in-memory log) or `persisted` (its stored artifact). The two coordinate
		 * systems are the same seq space only while the log has not been rebuilt,
		 * so a session that switches source is refolded from scratch instead of
		 * continuing a cursor that may no longer describe its log.
		 */
		kind: undefined,
		inheritedEventCount: null,
		title: null,
		revision: null
	};
}

/** Clear every derived field while keeping cache bookkeeping (title, revision). */
export function resetFold(state) {
	state.hours = new Map();
	state.lastSample = null;
	state.compactionSamples = new Map();
	state.currentRoute = undefined;
	state.consumed = -1;
	state.inheritedEventCount = null;
	// A refold must not keep the old tool counts: the events behind them are
	// about to be replayed from zero.
	state.activity = createActivity();
	return state;
}

/** One hour entry for a session fold. */
function hourEntryOf(state, key) {
	let entry = state.hours.get(key);
	if (entry === undefined) {
		entry = { totals: zeroBuckets(), models: new Map() };
		state.hours.set(key, entry);
	}
	return entry;
}

/**
 * Apply one contribution to one hour with a direction, so a replacement can
 * retract exactly what it added.
 */
function applyToHour(state, key, route, buckets, direction) {
	const entry = hourEntryOf(state, key);
	const sign = direction;
	const add = (target) => {
		target.inputTokens += sign * buckets.inputTokens;
		target.outputTokens += sign * buckets.outputTokens;
		target.cacheReadTokens += sign * buckets.cacheReadTokens;
		target.cacheWriteTokens += sign * buckets.cacheWriteTokens;
		target.reasoningTokens += sign * buckets.reasoningTokens;
		target.calls += sign * buckets.calls;
		target.failedCalls += sign * buckets.failedCalls;
		target.retries += sign * buckets.retries;
	};
	add(entry.totals);
	const row = rowFor(entry.models, modelKeyOf(route));
	add(row);
	// Drop an hour whose rows all cancelled back out, so a retracted sample leaves
	// no empty bucket behind for the renderer to filter.
	if (totalTokens(entry.totals) === 0 && totalAttempts(entry.totals) === 0 && entry.totals.retries === 0) {
		state.hours.delete(key);
	}
	// A model row that cancelled out entirely is removed too, so the row list
	// never carries an all-zero row that the renderer then has to filter.
	if (totalTokens(row) === 0 && totalAttempts(row) === 0 && row.retries === 0) {
		entry.models.delete(modelKeyOf(route));
	}
}

/**
 * Fold a slice of events onto an existing session state (mutating).
 *
 * The caller guarantees `events` continue the log this state already folded; a
 * gap or a rewritten log is handled by {@link resetFold} first. Events are
 * processed in seq order and hour keys are UTC, so no timezone is needed here.
 *
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order.
 * @param options - `{ skipBeforeSeq }`: events below this seq are a fork's
 *   inherited prefix, already folded in the session it was copied from. Re-folding
 *   them here would count the same usage twice, so they are skipped.
 */
export function applyEvents(state, events, options = {}) {
	const skipBeforeSeq = Number.isSafeInteger(options.skipBeforeSeq) ? options.skipBeforeSeq : 0;
	// `currentRoute` mirrors the reference plugin's `currentModel`: it is set by
	// `request/header` (the request the sample belongs to), and a sample that
	// carries no route of its own is attributed to it. `assistant/message` also
	// updates it so a compaction or a late chunk cannot be attributed to a stale
	// earlier request when the message names its own source.
	let currentRoute = state.currentRoute;
	for (const event of events) {
		// A forked session replays its parent's events; those tokens are already
		// counted once in the parent's own fold.
		if (Number.isSafeInteger(event.seq) && event.seq < skipBeforeSeq) continue;
		const type = event.type;
		if (type === "request/header" || type === "assistant/message") {
			const route = routeOf(event);
			if (route !== undefined) currentRoute = route;
		}
		if (!Number.isFinite(event.time)) continue;
		const key = hourKey(event.time);
		// Bookkeeping that is not billing: tool calls and their durations, plus
		// compaction and step timings. Folded before the usage branches so a call
		// event is recorded even though it carries no tokens.
		applyActivity(state.activity, event);

		if (type === "llm/retry") {
			// A retry transition, not a request: counts as a retry only.
			hourEntryOf(state, key).totals.retries += 1;
			continue;
		}

		if (type === "assistant/attempt") {
			// Settled without a model message: a failed request, not a billed call.
			applyToHour(state, key, currentRoute, { ...zeroBuckets(), failedCalls: 1 }, 1);
			continue;
		}

		const usage = type === "assistant/chunk"
			? (event.data?.chunk?.type === "usage" ? event.data.chunk.usage : undefined)
			: type === "assistant/message"
				? event.data?.usage
				: type === "compaction/summary"
					? event.data?.usage
					: undefined;
		if (usage === undefined) continue;
		const buckets = bucketsOf(usage);
		// One reported usage sample is one API call. A warmup request reports
		// all-zero buckets and is NOT a call, so a day's count always equals the
		// sum of the model rows the panel shows beside it.
		if (totalTokens(buckets) > 0) buckets.calls = 1;
		const route = routeOf(event) ?? currentRoute;
		// A compaction summary is a call of its own: it has its own identity and
		// may interleave with assistant chunks/messages, so it must never overwrite
		// the assistant replacement cursor (and vice versa). Sharing one cursor
		// loses exactly one call per interleave.
		const compaction = type === "compaction/summary";
		const sampleKey = compaction
			? `compaction:${event.data?.compactionId ?? event.seq}`
			: `${event.data?.turn}:${event.data?.step}`;
		const previous = compaction
			? state.compactionSamples.get(sampleKey) ?? null
			: state.lastSample;
		// Same (turn, step) re-reported: the LATER sample replaces the earlier one
		// instead of adding to it. This holds for a zero-token re-report too — it
		// is still the same request's final answer, so the earlier sample must be
		// retracted or the day would keep a figure the provider no longer reports.
		if (previous !== null && previous.key === sampleKey) {
			applyToHour(state, previous.hour, previous.route, previous.buckets, -1);
		}
		applyToHour(state, key, route, buckets, 1);
		const nextSample = { key: sampleKey, hour: key, route, buckets };
		if (compaction) state.compactionSamples.set(sampleKey, nextSample);
		else state.lastSample = nextSample;
	}
	state.currentRoute = currentRoute;
	return state;
}

/** Merge another session's folded hours into a target hour map (mutating). */
export function mergeHours(target, source) {
	for (const [key, entry] of source) {
		let targetEntry = target.get(key);
		if (targetEntry === undefined) {
			targetEntry = { totals: zeroBuckets(), models: new Map() };
			target.set(key, targetEntry);
		}
		addInto(targetEntry.totals, entry.totals);
		for (const [rowKey, buckets] of entry.models) addInto(rowFor(targetEntry.models, rowKey), buckets);
	}
	return target;
}

/** Render one row map into sorted wire rows (token-descending). */
function renderRows(rows, keyName) {
	const out = [];
	for (const [key, buckets] of rows) {
		const tokens = totalTokens(buckets);
		const attempts = totalAttempts(buckets);
		// Matching the reference plugin: a row with neither tokens nor a call
		// carries nothing to show.
		if (tokens === 0 && attempts === 0) continue;
		out.push({
			[keyName]: key,
			inputTokens: buckets.inputTokens,
			outputTokens: buckets.outputTokens,
			cacheReadTokens: buckets.cacheReadTokens,
			cacheWriteTokens: buckets.cacheWriteTokens,
			reasoningTokens: buckets.reasoningTokens,
			calls: buckets.calls,
			failedCalls: buckets.failedCalls,
			retries: buckets.retries,
			attempts,
			tokens,
			successRate: attemptSuccessRate(buckets),
			cacheHitRate: cacheHitRate(buckets)
		});
	}
	out.sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || (a[keyName] < b[keyName] ? -1 : 1));
	return out;
}

/** Sum one day's model rows into provider rows (derived, never stored). */
function providerRowsOf(models) {
	const rows = new Map();
	for (const [modelKey, buckets] of models) {
		const family = providerFamilyOf(providerOfModelKey(modelKey));
		addInto(rowFor(rows, family), buckets);
	}
	return rows;
}

/** Sum every day's model rows into one model map and one provider map. */
function totalsOfDays(byDay) {
	const models = new Map();
	const providers = new Map();
	for (const entry of byDay.values()) {
		for (const [key, buckets] of entry.models) addInto(rowFor(models, key), buckets);
		for (const [key, buckets] of entry.providers) addInto(rowFor(providers, key), buckets);
	}
	return { models, providers };
}

/**
 * Project a folded hour map onto calendar days in the viewer's timezone, then
 * (optionally) fold the shared ledger in.
 *
 * @param hours - `UTC hour → { totals, models }`.
 * @param options - `{ tzOffsetMinutes, from, to, updatedAt, ledger, mergeLedger }`.
 * @returns `{ days, totals, models, providers, updatedAt }` in the wire shape.
 */
export function renderDays(hours, options = {}) {
	const tzOffsetMinutes = options.tzOffsetMinutes ?? 0;
	const from = options.from;
	const to = options.to;
	const updatedAt = options.updatedAt ?? Date.now();
	const byDay = new Map();
	for (const key of [...hours.keys()].sort()) {
		const day = localDayOf(key, tzOffsetMinutes);
		if (from !== undefined && day < from) continue;
		if (to !== undefined && day > to) continue;
		const entry = hours.get(key);
		let dayEntry = byDay.get(day);
		if (dayEntry === undefined) {
			dayEntry = { totals: zeroBuckets(), models: new Map() };
			byDay.set(day, dayEntry);
		}
		addInto(dayEntry.totals, entry.totals);
		for (const [rowKey, buckets] of entry.models) addInto(rowFor(dayEntry.models, rowKey), buckets);
	}
	if (typeof options.mergeLedger === "function") options.mergeLedger(byDay, from, to);
	// Provider rows are derived after the merge so a ledger replacement or a
	// call-count reconciliation cannot leave them disagreeing with the models.
	for (const entry of byDay.values()) entry.providers = providerRowsOf(entry.models);

	const days = [];
	const totals = zeroBuckets();
	for (const day of [...byDay.keys()].sort()) {
		const entry = byDay.get(day);
		addInto(totals, entry.totals);
		days.push({
			date: day,
			tokens: totalTokens(entry.totals),
			calls: entry.totals.calls,
			failedCalls: entry.totals.failedCalls,
			retries: entry.totals.retries,
			attempts: totalAttempts(entry.totals),
			successRate: attemptSuccessRate(entry.totals),
			inputTokens: entry.totals.inputTokens,
			outputTokens: entry.totals.outputTokens,
			cacheReadTokens: entry.totals.cacheReadTokens,
			cacheWriteTokens: entry.totals.cacheWriteTokens,
			reasoningTokens: entry.totals.reasoningTokens,
			cacheHitRate: cacheHitRate(entry.totals),
			byModel: renderRows(entry.models, "model"),
			byProvider: renderRows(entry.providers, "provider")
		});
	}

	const aggregates = totalsOfDays(byDay);
	// An aggregate row must carry the same counters a day row does, so `calls`
	// here is the sum of the per-day calls the calendar draws.
	const calls = totals.calls;
	return {
		days,
		totals: {
			tokens: totalTokens(totals),
			calls,
			failedCalls: totals.failedCalls,
			retries: totals.retries,
			attempts: totalAttempts(totals),
			successRate: attemptSuccessRate(totals),
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheReadTokens: totals.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens,
			reasoningTokens: totals.reasoningTokens,
			cacheHitRate: cacheHitRate(totals)
		},
		models: renderRows(aggregates.models, "model"),
		providers: renderRows(aggregates.providers, "provider"),
		updatedAt
	};
}
