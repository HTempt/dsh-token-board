/**
 * dsh-token-board — pure token-usage aggregation over durable session event
 * logs, folded into UTC-hour buckets so any viewer timezone can be projected
 * onto calendar days without re-reading a session log.
 *
 * ## Counting rules
 *
 * A **call** is one API request that reported a usage sample: a usage sample
 * rides an `assistant/chunk`
 * (`data.chunk.type === "usage"`), a settling `assistant/message`
 * (`data.usage`), or a `compaction/summary` (`data.usage`). A sample whose
 * buckets are all zero is a warmup request and is not a call, so a day's
 * `calls` always equals the sum of the call counts on the model rows it shows.
 *
 * A repeat for the same `(turn, step)` REPLACES the earlier sample rather than
 * adding to it: the previous contribution is subtracted from the exact hour,
 * model, and provider bucket it was added to.
 *
 * Two facts ride beside `calls`, never
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
 * @module dsh-token-board/usage
 */

import { modelDisplayName } from "./model-names.js";

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
 * Milliseconds of one UTC hour bucket key.
 * @param key - `YYYY-MM-DDTHH` in UTC.
 * @returns epoch milliseconds at the start of that hour.
 */
export function hourKeyToMs(key) {
	const [datePart, hourPart] = key.split("T");
	const [year, month, day] = datePart.split("-").map(Number);
	return Date.UTC(year, month - 1, day, Number(hourPart));
}

/**
 * Minutes to ADD to UTC to reach the wall clock of `timeZone` at `timeMs`
 * (east positive), e.g. UTC+8 at any instant returns 480 and New York returns
 * 300 in winter / 240 in summer.
 *
 * This is the DST-correct replacement for carrying one fixed offset: a single
 * `getTimezoneOffset()` sample describes the viewer's zone AT THE MOMENT the
 * page opened, so it misplaces every hour of history that sits on the other
 * side of a DST switch. Resolving per instant removes that class of bug.
 *
 * @param timeMs - epoch milliseconds to ask about.
 * @param timeZone - IANA zone name (`America/New_York`).
 * @returns offset in minutes, east positive.
 * @throws when the runtime does not know the zone.
 */
export function offsetMinutesAt(timeMs, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	}).formatToParts(new Date(timeMs));
	const field = Object.create(null);
	for (const part of parts) field[part.type] = part.value;
	// `hour` is 24 for midnight under hour12:false in some ICU builds.
	const wallClockAsUtc = Date.UTC(
		Number(field.year),
		Number(field.month) - 1,
		Number(field.day),
		Number(field.hour) % 24,
		Number(field.minute),
		Number(field.second)
	);
	// Drop sub-second noise from `timeMs` before comparing, so the result is a
	// whole number of minutes.
	return Math.round((wallClockAsUtc - Math.floor(timeMs / 1000) * 1000) / 60_000);
}

/**
 * Build a day resolver for one viewer.
 *
 * Returns a function from a UTC hour bucket key to the viewer's calendar day.
 * When an IANA zone is supplied the offset is resolved PER BUCKET, so days on
 * either side of a DST switch stay correct. Without a zone it falls back to the
 * single fixed offset, which is right for zones that never observe DST (China,
 * India, Japan) and is what older callers already pass.
 *
 * @param options - `{ timeZone, tzOffsetMinutes }`.
 * @returns `(hourKey) => YYYY-MM-DD`.
 */
export function dayResolver(options = {}) {
	const { timeZone, tzOffsetMinutes = 0 } = options;
	if (typeof timeZone !== "string" || timeZone === "") {
		// `tzOffsetMinutes` is already in getTimezoneOffset's convention (west
		// positive), which is exactly what dayKey shifts by — so it passes through
		// unnegated. Callers derive it as `-offsetSeconds / 60`, so UTC+8 arrives
		// here as -480.
		return (key) => dayKey(hourKeyToMs(key), tzOffsetMinutes);
	}
	// Memoise per hour: a year of history is ~8760 distinct keys but only two
	// distinct offsets, and formatToParts is the expensive part.
	const cache = new Map();
	return (key) => {
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const at = hourKeyToMs(key);
		// offsetMinutesAt is east positive; dayKey wants west positive.
		const day = dayKey(at, -offsetMinutesAt(at, timeZone));
		cache.set(key, day);
		return day;
	};
}

/**
 * Calendar day of one UTC hour bucket in the viewer's timezone.
 * `tzOffsetMinutes` follows the `Date#getTimezoneOffset` convention (minutes to
 * add to local time to reach UTC), so a bucket lands on the day the viewer
 * actually experienced it.
 *
 * Prefer {@link dayResolver} when a DST-observing viewer may read history: a
 * fixed offset is only exact while the zone's offset never changes.
 *
 * @param key - UTC hour bucket key.
 * @param tzOffsetMinutes - viewer offset; 0 reads UTC.
 */
export function localDayOf(key, tzOffsetMinutes = 0) {
	return dayKey(hourKeyToMs(key), tzOffsetMinutes);
}

/**
 * Build an hour-of-day resolver for one viewer.
 *
 * Returns a function from a UTC hour bucket key to the viewer's wall-clock hour
 * (0–23). Like {@link dayResolver} this resolves the offset PER BUCKET, which is
 * what keeps a 24-slot histogram honest across a DST switch: with one fixed
 * offset, an hour either side of the switch lands in the wrong slot, and the
 * autumn fold would double-count the repeated hour.
 *
 * @param options - `{ timeZone, tzOffsetMinutes }`.
 * @returns `(hourKey) => 0..23`.
 */
export function hourOfDayResolver(options = {}) {
	const { timeZone, tzOffsetMinutes = 0 } = options;
	if (typeof timeZone !== "string" || timeZone === "") {
		return (key) => {
			// `tzOffsetMinutes` is west-positive; the local hour is the UTC hour
			// minus that offset, wrapped into a day.
			const utcHour = Number(key.slice(11, 13));
			return ((utcHour - tzOffsetMinutes / 60) % 24 + 24) % 24;
		};
	}
	const cache = new Map();
	return (key) => {
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const at = hourKeyToMs(key);
		const wallClock = new Date(at - -offsetMinutesAt(at, timeZone) * 60_000);
		const hour = wallClock.getUTCHours();
		cache.set(key, hour);
		return hour;
	};
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
		const row = {
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
		};
		// A channel whose catalog key is a short code (`qodercn/dfmodel`) travels
		// with the readable name beside the route id. The id stays the row's
		// identity — it is what the merge, the sorting and the tooltip key on —
		// while `name` is what the panel prints, so a row always has a label even
		// when the id is meaningless to a reader.
		if (keyName === "model") {
			const slash = key.indexOf("/");
			const name = slash > 0 ? modelDisplayName(key.slice(0, slash), key.slice(slash + 1)) : undefined;
			if (name !== undefined) row.name = name;
		}
		out.push(row);
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
 * `timeZone` takes precedence over `tzOffsetMinutes`: with an IANA zone the day
 * of every hour is resolved against that zone's own rules, so a window that
 * spans a DST switch keeps each hour on the day the viewer actually lived it.
 *
 * @param hours - `UTC hour → { totals, models }`.
 * @param options - `{ timeZone, tzOffsetMinutes, from, to, updatedAt, ledger, mergeLedger }`.
 * @returns `{ days, totals, models, providers, updatedAt }` in the wire shape.
 */
export function renderDays(hours, options = {}) {
	const dayOf = dayResolver({ timeZone: options.timeZone, tzOffsetMinutes: options.tzOffsetMinutes ?? 0 });
	const from = options.from;
	const to = options.to;
	const updatedAt = options.updatedAt ?? Date.now();
	const byDay = new Map();
	for (const key of [...hours.keys()].sort()) {
		const day = dayOf(key);
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

/**
 * Project a folded hour map onto the 24 slots of the viewer's wall clock.
 *
 * This is the "which time of day do I spend most" view: every day in the window
 * collapses onto one 0–23 axis, so the result answers a question the daily
 * series cannot (a 09:00 spike is invisible when a day is one point).
 *
 * The hour is resolved PER BUCKET through {@link hourOfDayResolver}, so a DST
 * switch inside the window neither shifts the later days by an hour nor
 * double-counts the repeated autumn hour.
 *
 * `days` counts how many distinct local days contributed to each slot, which is
 * what turns a raw total into an honest average: a slot used on 30 days and one
 * used on 2 days cannot be compared by total alone.
 *
 * @param hours - `UTC hour → { totals, models }`.
 * @param options - `{ timeZone, tzOffsetMinutes, from, to, updatedAt }`.
 * @returns `{ hours, totals, updatedAt }` in the wire shape.
 */
export function renderHourOfDay(hours, options = {}) {
	const dayOf = dayResolver({ timeZone: options.timeZone, tzOffsetMinutes: options.tzOffsetMinutes ?? 0 });
	const hourOf = hourOfDayResolver({ timeZone: options.timeZone, tzOffsetMinutes: options.tzOffsetMinutes ?? 0 });
	const from = options.from;
	const to = options.to;
	const updatedAt = options.updatedAt ?? Date.now();
	// One bucket per wall-clock hour, each carrying its own totals plus the set
	// of local days that touched it. The set is a Set so an hour that spans two
	// UTC buckets on a DST day still counts as ONE day for the average.
	const slots = Array.from({ length: 24 }, () => ({ totals: zeroBuckets(), days: new Set() }));
	for (const key of [...hours.keys()].sort()) {
		const day = dayOf(key);
		if (from !== undefined && from !== null && day < from) continue;
		if (to !== undefined && to !== null && day > to) continue;
		const entry = hours.get(key);
		const slot = slots[hourOf(key)];
		addInto(slot.totals, entry.totals);
		slot.days.add(day);
	}
	const totals = zeroBuckets();
	const rendered = slots.map((slot, hour) => {
		addInto(totals, slot.totals);
		const activeDays = slot.days.size;
		return {
			hour,
			tokens: totalTokens(slot.totals),
			calls: slot.totals.calls,
			failedCalls: slot.totals.failedCalls,
			retries: slot.totals.retries,
			attempts: totalAttempts(slot.totals),
			successRate: attemptSuccessRate(slot.totals),
			inputTokens: slot.totals.inputTokens,
			outputTokens: slot.totals.outputTokens,
			cacheReadTokens: slot.totals.cacheReadTokens,
			cacheWriteTokens: slot.totals.cacheWriteTokens,
			reasoningTokens: slot.totals.reasoningTokens,
			cacheHitRate: cacheHitRate(slot.totals),
			/** Distinct local days that recorded usage in this slot. */
			activeDays,
			/** Tokens per active day: the comparable figure across slots. */
			tokensPerDay: activeDays > 0 ? Math.round(totalTokens(slot.totals) / activeDays) : 0,
			/** Calls per active day. */
			callsPerDay: activeDays > 0 ? Math.round((slot.totals.calls / activeDays) * 10) / 10 : 0
		};
	});
	return {
		hours: rendered,
		totals: {
			tokens: totalTokens(totals),
			calls: totals.calls,
			failedCalls: totals.failedCalls,
			retries: totals.retries,
			attempts: totalAttempts(totals),
			successRate: attemptSuccessRate(totals),
			cacheHitRate: cacheHitRate(totals)
		},
		updatedAt
	};
}
