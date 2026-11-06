/**
 * dsh-usage-dashboard — fold the shared usage ledger into the session-folded
 * daily aggregate.
 *
 * The session fold reads event logs, which only reach as far back as the session
 * store itself keeps. A long-lived per-day ledger may also exist at
 * `<DSH_HOME>/dsh-usage/usage-ledger.json`, maintained outside this plugin, and
 * every day imported into that file — plus every day whose session logs no
 * longer exist — is recorded ONLY there. Without this pass, history before the
 * oldest stored session is missing even though it was really paid for.
 *
 * ## Merge rule — take the larger side, per (day, provider, model)
 *
 * The two sources overlap in a way that defeats any single coarse rule. On this
 * profile most models agree within a few percent (the same batch recorded
 * twice), while specific ones differ by whole multiples because another agent
 * spent on the same route:
 *
 *   vendor-alpha/model-x    log 126M   archive 506M   → archive holds 4x
 *   vendor-alpha/model-y   log 101M   archive 109M   → same batch
 *
 * Summing would double the batch rows; trusting the logs alone would drop the
 * external spend; trusting the archive alone would freeze the numbers at the
 * archive's last import. Per (day, provider, model) taking the LARGER side is
 * the only rule that satisfies all three: a doubled batch stays one batch, and
 * genuine extra spend survives.
 *
 * The archive is added as the EXCESS over the log (`archive − log`), never as
 * its whole row, so the part both sides counted is never counted twice. A gap
 * below {@link ARCHIVE_NOISE_RATIO} is treated as recorder noise rather than
 * extra spending.
 *
 * Provider ids differ between the two sources (`DeepSeek` vs
 * `deepseek-official`), so identity is normalized to a family before matching.
 *
 * @module dsh-usage-dashboard/ledger-merge
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addInto, providerFamilyOf, rowFor, totalTokens, zeroBuckets } from "./usage.js";

/** `<DSH_HOME>/dsh-usage/usage-ledger.json`, the location that ledger uses. */
export function ledgerPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-usage", "usage-ledger.json");
}

/** Whether a key is a real calendar day. */
function isDayKey(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const atMs = new Date(`${value}T12:00:00`).getTime();
	if (!Number.isFinite(atMs)) return false;
	const date = new Date(atMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}` === value;
}

/** A non-negative token count from untrusted JSON. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A whole, non-negative call count from untrusted JSON. */
function countOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read one model's totals defensively. A row with no tokens carries nothing to
 * merge, and rows with calls but no tokens are dropped: the day card sums the
 * model rows it shows, and zero-token rows are filtered out of that list.
 */
function bucketsOf(totals) {
	if (totals === null || typeof totals !== "object" || Array.isArray(totals)) return null;
	const buckets = {
		...zeroBuckets(),
		inputTokens: num(totals.inputTokens),
		outputTokens: num(totals.outputTokens),
		cacheReadTokens: num(totals.cacheReadTokens),
		cacheWriteTokens: num(totals.cacheWriteTokens),
		reasoningTokens: num(totals.reasoningTokens),
		calls: countOf(totals.calls)
	};
	return totalTokens(buckets) > 0 ? buckets : null;
}

// The ledger is small but read on every collection, so the parse result is
// memoized against the file's size and mtime.
let memo = null;

/**
 * Parse the ledger once per file revision.
 * @returns `{ signature, days }`, where `days` is
 *   `Map<day, Map<family, Map<bareModel, buckets>>>`, or null when no ledger
 *   exists on this profile.
 */
export function readLedger() {
	const path = ledgerPath();
	let signature;
	try {
		const info = statSync(path);
		signature = `${info.size}:${info.mtimeMs}`;
	} catch {
		// No ledger on this profile: nothing to merge, and a previously memoized
		// document must not survive the file's removal.
		memo = null;
		return null;
	}
	if (memo !== null && memo.signature === signature) return memo;

	const days = new Map();
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A corrupt or mid-write ledger is skipped for this revision rather than
		// failing the whole collection.
		memo = { signature, days };
		return memo;
	}

	const source = raw !== null && typeof raw === "object" && raw.days !== null && typeof raw.days === "object" ? raw.days : null;
	if (source !== null) {
		for (const [day, providers] of Object.entries(source)) {
			if (!isDayKey(day) || providers === null || typeof providers !== "object" || Array.isArray(providers)) continue;
			const families = new Map();
			for (const [provider, models] of Object.entries(providers)) {
				if (models === null || typeof models !== "object" || Array.isArray(models)) continue;
				const family = providerFamilyOf(provider);
				let familyModels = families.get(family);
				if (familyModels === undefined) {
					familyModels = new Map();
					families.set(family, familyModels);
				}
				for (const [model, totals] of Object.entries(models)) {
					const buckets = bucketsOf(totals);
					if (buckets === null) continue;
					// Two spellings of one family can both name the same model; the
					// family block is taken as a unit, so summing here is correct.
					addInto(rowFor(familyModels, model), buckets);
				}
			}
			if (families.size > 0) days.set(day, families);
		}
	}
	memo = { signature, days };
	return memo;
}

/** The ledger revision in effect, so an aggregate knows when it went stale. */
export function ledgerSignature() {
	const ledger = readLedger();
	return ledger === null ? null : ledger.signature;
}

/**
 * Fold the shared ledger into a per-day aggregate in place, keeping the larger
 * side per (day, family) for tokens and reconciling call counts per model
 * whichever side wins.
 *
 * @param byDay - `Map<day, { totals, models: Map<"provider/model", buckets> }>`
 *   as produced by the fold (mutated).
 * @param options - `{ from, to }` local day keys limiting the merge.
 * @returns the number of (day, family) blocks the ledger replaced or contributed.
 */
export function mergeLedgerInto(byDay, options = {}) {
	const ledger = readLedger();
	if (ledger === null) return 0;
	return mergeDaysInto(byDay, ledger.days, options);
}

export function mergeArchivedInto(byDay, archivedDays, options = {}) {
	return mergeDaysInto(byDay, archivedDays, options);
}

/**
 * Fold an ALREADY-PARSED day map into a per-day aggregate in place.
 *
 * Shared by the one-time ledger import and by the archive read on every
 * request, so an imported day and a freshly read one can never be merged by
 * two different rules.
 *
 * ## The merge unit is (day, provider, model)
 *
 * A coarser unit is wrong in both directions, and this store has the data to
 * prove it:
 *
 * - Per PROVIDER loses real money. `vendor-alpha` appears on both sides, yet its
 *   `model-x` row is 506M in the archive and 126M in the logs — the
 *   archive holds more than the logs ever recorded for that model, because
 *   another agent used the same route.
 * - Per DAY is worse: the same day can hold one model that both sides saw and
 *   another that only the archive knows.
 *
 * ## What each archive row contributes
 *
 * Most models land within a few percent on both sides (ratio ≈ 1.00 across
 * this store), which means the archive's row is the SAME calls the logs
 * counted. For those the logs win: they are live and reach today, while the
 * archive stops at its last import.
 *
 * An archive row is therefore added ONLY when it describes spending the logs
 * cannot account for — the log has no row for that model that day, or the
 * archive is materially LARGER than the log. The excess (`archive − log`) is
 * what gets added, never the whole row: the part the logs already counted must
 * not be counted twice. This also covers the `gpt-6.1-sol` days where the log
 * recorded a token amount and the archive recorded hundreds of times more.
 *
 * @param byDay - `Map<day, { totals, models: Map<"provider/model", buckets> }>`
 *   as produced by the fold (mutated).
 * @param days - `Map<day, Map<family, Map<bareModel, buckets>>>`.
 * @param options - `{ from, to }` local day keys limiting the merge.
 * @returns the number of archive rows contributed.
 */
function mergeDaysInto(byDay, days, options = {}) {
	const from = options.from;
	const to = options.to;
	let applied = 0;

	for (const [day, families] of days) {
		if (from !== undefined && day < from) continue;
		if (to !== undefined && day > to) continue;
		let entry = byDay.get(day) ?? null;
		for (const [family, ledgerModels] of families) {
			for (const [model, rawBuckets] of ledgerModels) {
				// The archive stores token fields only, while a fold bucket also carries
				// `failedCalls`/`retries`. `addInto` sums those fields unconditionally,
				// so an archive row must be completed first or every sum becomes NaN
				// (which JSON turns into null, blanking the whole day).
				const ledgerBuckets = completeBuckets(rawBuckets);
				const ledgerTokens = totalTokens(ledgerBuckets);
				if (ledgerTokens <= 0) continue;
				const row = entry === undefined || entry === null
					? undefined
					: findRow(entry.models, family, model);
				const foldTokens = row === undefined ? 0 : totalTokens(row);
				// What the logs already counted for this exact (day, provider, model).
				// Anything at or above the archive's figure means the archive adds
				// nothing new here.
				const excess = ledgerTokens - foldTokens;
				if (excess <= 0) continue;
				// A tiny excess is measurement noise between two recorders of the
				// same call, not extra spending: 3% of a busy day would otherwise
				// inflate every day on the calendar.
				if (foldTokens > 0 && excess <= foldTokens * ARCHIVE_NOISE_RATIO) continue;
				if (entry === null) {
					entry = { totals: zeroBuckets(), models: new Map() };
					byDay.set(day, entry);
				}
				const target = row === undefined ? null : row;
				if (target === null) {
					const key = `${family}/${model}`;
					addInto(rowFor(entry.models, key), ledgerBuckets);
					addInto(entry.totals, ledgerBuckets);
				} else {
					// The log knows this model too: contribute only the excess, so the
					// day ends up with the larger of the two figures rather than their
					// sum. Calls follow the same proportion as tokens so a day's call
					// count stays consistent with its rows.
					const extra = scaleBuckets(ledgerBuckets, excess / ledgerTokens);
					addInto(target, extra);
					addInto(entry.totals, extra);
				}
				applied += 1;
			}
		}
	}
	return applied;
}

/**
 * An archive row must exceed the log's row by more than this fraction of the
 * log's figure before it counts as extra spending. Two recorders of one batch
 * agree within a few percent here; real external usage is off by whole
 * multiples.
 */
const ARCHIVE_NOISE_RATIO = 0.1;

/**
 * Find the fold row for one (family, model) pair on one day.
 *
 * The fold keys rows `provider/model` with the RAW provider id, while families
 * are normalized (`DeepSeek` ↔ `deepseek-official`), so the lookup compares
 * families and model ids rather than whole keys.
 * @param models - that day's `Map<"provider/model", buckets>`.
 * @param family - normalized provider family.
 * @param model - bare model id from the archive.
 * @returns the buckets, or undefined when the fold has no such row.
 */
function findRow(models, family, model) {
	const wanted = model.toLowerCase();
	for (const [key, buckets] of models) {
		const text = String(key);
		const slash = text.indexOf("/");
		const provider = slash < 0 ? text : text.slice(0, slash);
		const bare = slash < 0 ? "" : text.slice(slash + 1);
		if (providerFamilyOf(provider) !== family) continue;
		if (bare.toLowerCase() !== wanted) continue;
		return buckets;
	}
	return undefined;
}

/** Scale every counter of a bucket set by `ratio`, keeping integers. */
function scaleBuckets(buckets, ratio) {
	const out = zeroBuckets();
	for (const field of Object.keys(out)) {
		const value = buckets[field] ?? 0;
		out[field] = Math.round(value * ratio);
	}
	return out;
}

/**
 * Fill a partial bucket set out to the full folded shape.
 *
 * Archive rows and imported samples may omit counters (`failedCalls`,
 * `retries`, or a token field). `addInto` sums every field unconditionally, so
 * a missing one poisons its target with NaN and the day renders as zero.
 * @param buckets - a possibly partial bucket set.
 * @returns a complete one, never sharing the caller's object.
 */
function completeBuckets(buckets) {
	const out = zeroBuckets();
	if (buckets === null || buckets === undefined) return out;
	for (const field of Object.keys(out)) {
		const value = buckets[field];
		out[field] = typeof value === "number" && Number.isFinite(value) ? value : 0;
	}
	return out;
}

//#region own-history archive
/**
 * The import marker stored beside the archive. It records which ledger
 * revision was already absorbed so a re-import is skipped, and lets the
 * archive stay valid after the external ledger disappears.
 */
const IMPORTED_FROM = "usage-ledger.json";

/**
 * Take a one-time snapshot of the external ledger's days.
 *
 * The ledger is the ONLY record of usage older than the oldest stored session
 * log, and its writer is a separate plugin that may be disabled or removed at
 * any time. Copying its days into this plugin's own cache at first sight means
 * that history keeps showing after the writer is gone, and lets this plugin
 * drop its runtime dependency on that file entirely.
 *
 * The snapshot is merged by the SAME rule the live read used, so importing it
 * reproduces the figures the panel already showed instead of shifting them.
 * @returns `{ days, signature }`, or null when there is no readable ledger.
 */
export function importLedgerDays() {
	const ledger = readLedger();
	if (ledger === null) return null;
	if (ledger.days.size === 0) return { days: [], signature: ledger.signature };
	// Flatten to the serializable shape: [[day, [[family, [[model, buckets]]]]]]
	// Empty days are dropped, so the archive never carries a zero row.
	const days = [];
	for (const [day, families] of [...ledger.days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const familyRows = [];
		for (const [family, models] of families) {
			const modelRows = [];
			for (const [model, buckets] of models) {
				if (totalTokens(buckets) > 0) modelRows.push([model, buckets]);
			}
			if (modelRows.length > 0) familyRows.push([family, modelRows]);
		}
		if (familyRows.length > 0) days.push([day, familyRows]);
	}
	return { days, signature: ledger.signature };
}

/**
 * Restore a serialized archive into the same day map the live ledger would
 * have produced, so {@link mergeDaysInto} cannot tell the two apart.
 * @param raw - the archived `[[day, [[family, [[model, buckets]]]]]]` array.
 * @returns `Map<day, Map<family, Map<bareModel, buckets>>>`, possibly empty.
 */
export function restoreArchivedDays(raw) {
	const days = new Map();
	if (!Array.isArray(raw)) return days;
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length !== 2) continue;
		const [day, familyRows] = entry;
		if (!isDayKey(day) || !Array.isArray(familyRows)) continue;
		const families = new Map();
		for (const familyEntry of familyRows) {
			if (!Array.isArray(familyEntry) || familyEntry.length !== 2) continue;
			const [family, modelRows] = familyEntry;
			if (typeof family !== "string" || !Array.isArray(modelRows)) continue;
			const models = new Map();
			for (const modelEntry of modelRows) {
				if (!Array.isArray(modelEntry) || modelEntry.length !== 2) continue;
				const [model, totals] = modelEntry;
				if (typeof model !== "string") continue;
				const buckets = bucketsOf(totals);
				if (buckets === null) continue;
				models.set(model, buckets);
			}
			if (models.size > 0) families.set(family, models);
		}
		if (families.size > 0) days.set(day, families);
	}
	return days;
}

/** Name of the ledger this archive was imported from, for diagnostics. */
export const IMPORT_SOURCE = IMPORTED_FROM;
//#endregion
