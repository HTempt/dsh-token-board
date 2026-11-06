/**
 * dsh-token-board — host half.
 *
 * Aggregates token usage from the durable session event logs (the same source
 * the harness's own token meter folds) into per-day, per-provider, per-model
 * figures, and serves them to the browser half over loopback-only exact routes.
 *
 * ## Where the numbers come from
 *
 * `ctx.sessionPersistence` is the authority for stored logs: `list()` returns
 * one snapshot per stored session with an opaque revision, and `open(id,
 * "read")` returns a handle whose `read(0)` yields a validated event slice. A
 * session already folded at its current revision costs no read at all, which
 * keeps this plugin cheap on a large store: a full scan decodes every log once,
 * then only changed logs are read again.
 *
 * ## Incremental fold
 *
 * Each session keeps one {@link createFold} state plus the opaque revision it
 * folded at. Session events are append-only and never rewritten, so a revision
 * change means "read the log again": the whole log is re-folded from scratch
 * rather than trusting a cursor across a possible compaction. Only sessions
 * whose revision moved are opened at all.
 *
 * ## Write scope — this plugin's own file only
 *
 * Statistics are a read-only view of other people's data. The plugin NEVER
 * writes the session store, the shared usage ledger, the sibling usage-stats
 * cache, or any harness file. Its only write is its own cache,
 * `<DSH_HOME>/storages/usage-dashboard-cache.json` (atomic temp + rename), so a
 * restart does not re-decode hundreds of megabytes of logs. The cache carries
 * its own schema version, so a fold change invalidates it instead of serving
 * numbers computed with other semantics. Deleting that one file loses nothing
 * but speed: the session logs are always the authority.
 *
 * @module dsh-usage-dashboard
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEvents, createActivity, createFold, mergeHours, renderDays, resetFold, zeroBuckets } from "./usage.js";
import { importLedgerDays, restoreArchivedDays, mergeArchivedInto, IMPORT_SOURCE } from "./ledger-merge.js";

/**
 * Stable Cordis plugin name — NOT the npm package name.
 *
 * This is the row identity inside the Cordis tree (the profile patch inserts
 * `- id: usage-dashboard`), so it is deliberately independent of the package
 * name and must not be renamed with it. The package name lives in
 * `package.json`, and the browser bundle repeats it in
 * `__ModuleLoader__.load({ id })`; those two must match each other.
 */
const name = "usage-dashboard";

/**
 * Services this plugin needs. `sessionPersistence` is the stored-log authority;
 * `webServer` carries the exact routes.
 */
const inject = ["webServer", "sessionPersistence", "sessions"];

/** Data route: the whole dashboard payload (`?days=<n|all>`). */
const SUMMARY_PATH = "/api/usage-dashboard/summary";
/** Data route: one local day's detail rows (`?date=YYYY-MM-DD`). */
const DAY_PATH = "/api/usage-dashboard/day";

/**
 * This plugin's own on-disk state, split by whether it can be rebuilt.
 *
 * Two files, because they are two different kinds of data:
 *
 * - `DATA_FILE` — the plugin's STATISTICS. Absorbed history that predates the
 *   oldest stored session log. Nothing else on the machine holds these days
 *   once the external ledger is gone, so this is a source of truth, not a
 *   cache: deleting it loses usage that was really paid for.
 * - `CACHE_FILE` — a derived fold cache. Every byte of it can be recomputed
 *   from the session logs, so deleting it costs one rescan and nothing else.
 *
 * They live in different places for that reason: the statistics sit in this
 * plugin's own data directory beside other plugins' state, while the cache
 * sits in the shared `storages` directory the harness treats as disposable.
 */
/**
 * On-disk directory holding this plugin's statistics, under `<DSH_HOME>`.
 *
 * FROZEN — do not rename with the package. The directory already exists on
 * installed machines and holds absorbed history that predates the oldest stored
 * session log, which nothing else can rebuild. Renaming it would silently start
 * from an empty archive.
 */
const DATA_DIR = "dsh-usage-dashboard";
const DATA_FILE = "statistics.json";
/** Private integrity ledger: per-day digests, kept OUT of the user-facing statistics file. */
const DIGEST_FILE = "usage-dashboard-digests.json";

/**
 * The statistics backup: ONE file, `.bak`, beside the live statistics file.
 *
 * This file is the ONE thing here that cannot be rebuilt, so it gets the only
 * backup in the plugin. Everything else (the fold cache, the day rows) can be
 * recomputed from the session logs.
 *
 * Exactly one generation is kept on purpose. Rotating a history of copies grows
 * without bound and answers nothing the reader asked for: the failure worth
 * surviving is "the live file got damaged", and the copy taken before the last
 * write is enough to survive it.
 */
const BACKUP_SUFFIX = ".bak";

/** The single backup's absolute path. */
function backupPath() {
	return `${dataPath()}${BACKUP_SUFFIX}`;
}

/**
 * Replace the backup with a copy of the current statistics file.
 *
 * Copied, not renamed: a crash between the copy and the new write must leave
 * the live file in place. The current content is parsed first — rotating a
 * DAMAGED live file into the backup slot would destroy the last good copy,
 * which is the one failure this mechanism exists to prevent.
 * @param source - the live statistics file.
 * @returns whether a backup copy now exists.
 */
async function refreshStatisticsBackup(source) {
	try {
		const current = await readFile(source, "utf8");
		JSON.parse(current);
		await writeFile(backupPath(), current, "utf8");
		return true;
	} catch (error) {
		// Nothing to back up yet (first run), or an unreadable live file: either
		// way the existing backup is left untouched.
		if (error?.code !== "ENOENT") throw error;
		return false;
	}
}

/**
 * Read the backup, if it parses and carries the current schema.
 *
 * The parse is the validation: a backup that cannot be read is not trusted,
 * and the reader is left to report "no history" rather than serve a corrupt
 * block.
 * @param logger - for the note that recovery happened.
 * @returns the parsed document, or null.
 */
async function readStatisticsBackup(logger) {
	try {
		const parsed = JSON.parse(await readFile(backupPath(), "utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.version !== STATISTICS_VERSION) return null;
		logger.warn(`usage-dashboard: statistics restored from backup`);
		return parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") logger.warn(`usage-dashboard: statistics backup is unreadable: ${String(error)}`);
		return null;
	}
}
const CACHE_FILE = "usage-dashboard-cache.json";

/**
 * Statistics-file schema. Its own version, independent of CACHE_VERSION: the
 * absorbed history is data that must survive a fold-format change, so bumping
 * the cache schema must never invalidate it.
 */
const STATISTICS_VERSION = 1;
/** Display name of the row that carries history with no known workspace. */
const UNATTRIBUTED_NAME = "（未归属）";


/**
 * Cache schema. Bump on any change to the fold or to the wire shape: the cache
 * holds folded token buckets, so stale semantics would silently survive a
 * code change.
 *
 * 4 — one fold per session with a live/persisted `kind` and a last-seq `consumed`
 * (`3` stored a per-event count plus a separate merged aggregate, which could
 * disagree after a partial scan and re-read a boundary event).
 */
const CACHE_VERSION = 4;

/**
 * The one older schema that is MIGRATED rather than discarded. A v3 fold holds
 * real folded buckets, and the log it was built from may since have been
 * compacted, so the cache can be the only surviving record of that usage.
 */
const LEGACY_CACHE_VERSION = 3;




/**
 * How often the store is enumerated for NEW or CHANGED sessions.
 *
 * `list()` stats every session directory, so it is the expensive probe here.
 * History never changes and only a session still being written gains usage, so
 * one pass every few minutes is enough; between passes the persisted fold is
 * served untouched.
 */
const ENUMERATE_EVERY_MS = 3 * 60_000;

/**
 * How many stored logs are decoded at once.
 *
 * DSH 0.1.7 decodes and verifies a whole artifact on the first open (~0.5 s
 * per session), so a strictly sequential pass over a large store takes minutes
 * while the panel waits for its first complete generation. Bounded concurrency
 * keeps that pass short without starving the host of workers.
 */
const PERSISTED_READ_CONCURRENCY = 6;

/**
 * How many stored logs one incremental pass may re-read.
 *
 * A cache written before a new fold field (workspace, activity) makes every
 * stored session stale at once. Re-reading all of them in one pass takes
 * ~55s for 464 logs, far longer than a panel wait, so the pass is chunked:
 * each chunk is folded, SAVED, and published, and the next scan continues
 * from where this one stopped. The cache is therefore always making progress
 * instead of restarting a long pass that never lands.
 */
const BACKFILL_BATCH = 48;

/** Upper bound on the window `?days=` may request. */
const MAX_WINDOW_DAYS = 370;

/** Default window when the client names none: three months, per the design. */
const DEFAULT_WINDOW_DAYS = 92;

/** This plugin's own data directory: its statistics live here. */
function dataDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, DATA_DIR);
}

/** The statistics file: absorbed history that cannot be rebuilt. */
/** This plugin's PRIVATE digest ledger: integrity evidence, not user data. */
function digestsPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", DIGEST_FILE);
}

function dataPath() {
	return join(dataDir(), DATA_FILE);
}

/** This plugin's private cache path: a derived fold cache. */
function cachePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", CACHE_FILE);
}

//#region wire helpers
/** Write one JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}

/**
 * Loopback fence, decided on the PEER SOCKET address rather than the
 * client-controllable Host header, with the Host header as an additional
 * check. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const value = address.toLowerCase();
	if (value === "::1") return true;
	const ipv4 = value.startsWith("::ffff:") ? value.slice(7) : value;
	const octets = ipv4.split(".");
	return octets.length === 4
		&& octets[0] === "127"
		&& octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const host = hostNameOf(req.headers.host);
	return host === "localhost" || isLoopbackAddress(host);
}

/** Refuse non-loopback callers and non-GET methods before any work starts. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		json(res, 405, { ok: false, error: "method-not-allowed" });
		return true;
	}
	if (isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/**
 * Viewer timezone offset in seconds, EAST POSITIVE (UTC+8 → `28800`), which is
 * what the browser half sends: `-new Date().getTimezoneOffset() * 60`.
 *
 * This is deliberately NOT `getTimezoneOffset`'s own sign (that one is negative
 * east of UTC). Mixing the two put the window's end a day in the past for every
 * viewer east of Greenwich, so today's row fell outside the window and the
 * "today" card read 0.
 */
function tzOffsetOf(req) {
	const raw = req.headers["x-dsh-usage-dashboard-tz-offset"];
	const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : 0;
	if (!Number.isFinite(value) || Math.abs(value) > 14 * 60 * 60) return 0;
	return value;
}

/**
 * Local `YYYY-MM-DD` key for the current instant in the viewer's timezone.
 * @param tzOffsetSeconds - offset EAST POSITIVE in seconds (UTC+8 -> 28800),
 *   so the shift SUBTRACTS to reach UTC.
 */
function localToday(tzOffsetSeconds) {
	// EAST POSITIVE: UTC+8 arrives as 28800, so the shift is ADDED to reach the
	// viewer's local wall clock. Subtracting put every viewer east of UTC a day
	// in the past — today's row then fell outside the window and read 0.
	const shifted = new Date(Date.now() + tzOffsetSeconds * 1000);
	const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const day = String(shifted.getUTCDate()).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** Shift a local `YYYY-MM-DD` key by a number of days. */
function shiftDay(day, days) {
	const [year, month, date] = day.split("-").map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, date + days));
	const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
	const d = String(shifted.getUTCDate()).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${m}-${d}`;
}

/**
 * The calendar month containing a local day key, as `{ from, to }`.
 *
 * Derived by shifting to the first of the month and to the day before the
 * NEXT month's first, so month length and leap years need no table.
 * @param day - a `YYYY-MM-DD` key.
 * @returns the month's first and last day.
 */
function monthRangeOf(day) {
	const [year, month] = day.split("-").map(Number);
	const first = `${year}-${String(month).padStart(2, "0")}-01`;
	const nextMonthFirst = month === 12
		? `${year + 1}-01-01`
		: `${year}-${String(month + 1).padStart(2, "0")}-01`;
	return { from: first, to: shiftDay(nextMonthFirst, -1) };
}

/** Whether a string is a real `YYYY-MM-DD` calendar date. */
function isDayKey(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const atMs = new Date(`${value}T12:00:00`).getTime();
	if (!Number.isFinite(atMs)) return false;
	const date = new Date(atMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}` === value;
}

/**
 * Resolve the requested window from `?days=` or an explicit `?from=&to=` range.
 *
 * An explicit range is what the dashboard's own date picker sends. It is
 * clamped to {@link MAX_WINDOW_DAYS} (one year) so a hand-picked span can
 * never ask the fold to cover more history than the control offers.
 * @returns `{ days }` for a trailing window, or `{ from, to, days }` for a range.
 */
function windowOf(req) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const from = url.searchParams.get("from");
	const to = url.searchParams.get("to");
	if (isDayKey(from) && isDayKey(to)) {
		const lo = from <= to ? from : to;
		const hi = from <= to ? to : from;
		const span = Math.round((new Date(hi + "T12:00:00") - new Date(lo + "T12:00:00")) / 86400000) + 1;
		const clamped = Math.min(span, MAX_WINDOW_DAYS);
		// Keep the END fixed and pull the start forward when the span is too long.
		const start = clamped === span ? lo : shiftDay(hi, -(clamped - 1));
		return { from: start, to: hi, days: clamped };
	}
	const raw = url.searchParams.get("days");
	if (raw === "all") return { days: "all" };
	const value = Number(raw ?? DEFAULT_WINDOW_DAYS);
	if (!Number.isFinite(value) || value <= 0) return { days: DEFAULT_WINDOW_DAYS };
	return { days: Math.min(Math.floor(value), MAX_WINDOW_DAYS) };
}

/** Whether a request asked for a forced re-check of stored revisions. */
function forceOf(req) {
	const url = new URL(req.url ?? "/", "http://localhost");
	return url.searchParams.get("refresh") === "1";
}
//#endregion

//#region session log access
/**
 * Exact fork-inherited prefix length carried beside a stored header or a read
 * handle. Absent metadata reads as 0 (an unseeded log), never as "unknown":
 * `0` is the only value that lets a fold skip nothing and stay correct.
 */
function inheritedCutOf(source) {
	const count = source?.inheritedEventCount;
	return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * Whether a stored-log read failure is a deterministic refusal of this log's
 * CONTENT by this runtime, rather than a transient backend or I/O error.
 *
 * Only these are worth remembering: retrying costs a full decode and cannot
 * succeed until the log changes. A transient failure must be retried on the
 * next scan, or a single bad read would freeze that session forever.
 */
function isStoredLogRefusal(error) {
	const name = error instanceof Error ? error.name : null;
	return name === "SessionFormatUnsupportedError" || name === "SessionPersistenceCorruptionError";
}

/**
 * Enumerate every stored session as `{ id, revision }`, newest first.
 *
 * Recency ordering matters during a first fold: sessions are folded in list
 * order, so the most recent activity lands in the published generation first.
 * The backend promises no order, so recency is derived from the header's
 * `createdAt` (an id-only artifact would otherwise fold arbitrarily).
 *
 * `revision` is kept only when the backend supplies a string: an opaque token
 * that cannot be compared is `null`, which makes the caller fold that session
 * every scan instead of pretending it is unchanged.
 * @returns the entries, or null when the backend cannot enumerate (the caller
 *   then keeps its previous fold rather than dropping every folded day).
 */
async function listStoredSessions(persistence, logger) {
	try {
		// Current backends list snapshots; older ones expose `listSnapshots()`.
		const snapshots = typeof persistence.list === "function"
			? await persistence.list()
			: await persistence.listSnapshots();
		return snapshots
			.map((snapshot) => {
				const header = snapshot?.header ?? snapshot;
				return {
					id: typeof header?.id === "string" ? header.id : "",
					revision: typeof snapshot?.revision === "string" ? snapshot.revision : null,
					// The artifact byte size is the cheap content test: a revision moves
					// when the file is touched, but an unchanged size means unchanged
					// content, so the log need not be decoded again.
					sizeBytes: Number.isFinite(snapshot?.sizeBytes) ? snapshot.sizeBytes : null,
					// A seeded session (a fork) always has a non-trivial log, so an
					// empty read for one is a storer failure rather than an empty log.
					seeded: header?.isSeeded === true,
					createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : 0,
					// The session's project directory: the ONLY per-workspace identity the
					// store exposes, and the same string the shell shows for a workspace.
					// Absent stays null rather than inventing a bucket.
					workspace: typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : null
				};
			})
			.filter((entry) => entry.id !== "")
			.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
	} catch (error) {
		logger.warn(`usage-dashboard: listing stored sessions failed: ${String(error)}`);
		return null;
	}
}

/**
 * Read a slice of one stored session's log, through a read handle when the
 * backend has one and through the older `readFrom()` seam otherwise.
 *
 * The handle also carries the fork's exact inherited prefix length: a forked
 * session replays its parent's events, and those tokens are already counted in
 * the parent's own fold, so the fold must skip them or the same usage lands on
 * the calendar twice.
 * @param fromSeq - first logical event seq to include; the slice is inclusive.
 * @returns `{ events, inheritedEventCount }`.
 */
async function readStoredLog(persistence, id, fromSeq = 0) {
	if (typeof persistence.open === "function") {
		const handle = await persistence.open(id, "read");
		let events;
		try {
			events = (await handle.read(fromSeq)).events;
		} catch (error) {
			// Release the handle before surfacing the read failure: a handle owns
			// local resources, and a failing read must not leak one per scan.
			try {
				await handle.close();
			} catch {
				/* The read failure is the actionable cause. */
			}
			throw error;
		}
		try {
			await handle.close();
		} catch {
			/* The read outcome is the actionable fact; a close failure on the same
			   handle changes no folded value. */
		}
		return { events, inheritedEventCount: inheritedCutOf(handle) };
	}
	const result = await persistence.readFrom(id, fromSeq);
	return { events: result.events, inheritedEventCount: inheritedCutOf(result) };
}

/**
 * Fold one stored session's log onto its existing fold state, refolding the
 * whole log when the read tail no longer continues the folded cursor.
 *
 * `consumed` is the LAST folded event seq (the backend's read offset is
 * inclusive), so a fresh slice always starts at or before it and the fold keeps
 * only events above it. That is what makes a repeated read of an unchanged log
 * free of double counting instead of re-folding its boundary event every time.
 *
 * A tail whose first event is not `cursor + 1` is a gap, and a log that no
 * longer contains the cursor was truncated: both refold from seq 0.
 *
 * An EMPTY read is not an empty log. A fold that already holds usage and now
 * reads nothing is a storer failure, so the fold is kept and the revision is
 * left unrecorded for the next scan to retry — otherwise real history would be
 * replaced by zero.
 *
 * @param persistence - the stored-log authority.
 * @param entry - `{ id, revision, seeded }` of the session to fold.
 * @param state - the session's fold state, mutated in place.
 * @returns whether the folded state changed.
 */
async function foldStoredSession(persistence, entry, state) {
	const wasPersisted = state.kind === "persisted";
	const cursor = wasPersisted && state.consumed >= 0 ? state.consumed : 0;
	let read = await readStoredLog(persistence, entry.id, cursor);
	const events = read.events;
	const fresh = wasPersisted && state.consumed >= 0
		? events.filter((event) => Number.isSafeInteger(event.seq) && event.seq > cursor)
		: events;
	// A tail that continues the cursor is an append. An EMPTY tail that still
	// contains the cursor event is an unchanged log (the read offset is
	// inclusive), so nothing was appended and nothing needs re-folding.
	const contiguous = fresh.length === 0
		? wasPersisted && state.consumed >= 0 && events.some((event) => event.seq === cursor)
		: fresh[0].seq === cursor + 1;
	// A gap, a truncated log, or a fold whose source was the LIVE store: the
	// cursor no longer describes this log, so the whole log is folded from zero.
	// Reset is required when the fold came from another source, because its
	// hours already contain that source's copy of the same events and folding
	// the stored log on top would count them twice. When the read above already
	// started at 0 (a first fold, or a live-built fold), that read IS the whole
	// log and no second read is needed.
	const refold = !wasPersisted || (state.consumed >= 0 && !contiguous);
	let slice = fresh;
	if (refold && (!wasPersisted || cursor === 0)) {
		slice = events;
	} else if (refold) {
		read = await readStoredLog(persistence, entry.id, 0);
		slice = read.events;
	}
	// An empty read is not an empty log: a fold that already holds usage (or a
	// seeded session, which always has a non-trivial log) reading nothing means
	// the storer failed. Keep the fold and leave the revision unrecorded so the
	// next scan retries instead of replacing real history with zero.
	const failedRead = slice.length === 0
		&& (entry.seeded === true || state.consumed >= 0 || state.hours.size > 0);
	if (failedRead) return false;

	let changed = false;
	if (refold) {
		resetFold(state);
		changed = true;
	}
	const cut = read.inheritedEventCount;
	if (cut !== state.inheritedEventCount) {
		state.inheritedEventCount = cut;
		changed = true;
	}
	// A rewrite that folds back to nothing is still a real empty log, so an
	// emptied fold must land at zero rather than keep the pre-rewrite hours.
	if (slice.length > 0) {
		applyEvents(state, slice, { skipBeforeSeq: cut });
		const last = slice[slice.length - 1];
		state.consumed = Number.isSafeInteger(last.seq) ? last.seq : state.consumed + slice.length;
		changed = true;
	} else if (refold) {
		state.consumed = -1;
	}
	if (state.kind !== "persisted") {
		state.kind = "persisted";
		changed = true;
	}
	// Record the owning workspace even when the log itself contributed nothing:
	// the identity comes from the enumerated header, not from the events, so a
	// session with an unchanged log still has to learn (or refresh) it.
	if (entry.workspace !== null && state.workspace !== entry.workspace) {
		state.workspace = entry.workspace;
		changed = true;
	}
	// The log has just been folded, so its activity is now collected. Clearing
	// the flag here is what stops the next scan from re-reading this log again.
	if (state.activityStale === true) {
		state.activityStale = false;
		changed = true;
	}
	if (entry.revision !== null && state.revision !== entry.revision) {
		state.revision = entry.revision;
		changed = true;
	}
	return changed;
}

//#endregion


/**
 * Stored logs this runtime already refused at a given revision, keyed by
 * session id. Folding one costs a full decode and cannot start succeeding
 * until the artifact changes, so retrying it on every enumeration only burns
 * CPU and keeps the panel stuck in its refreshing state. A TRANSIENT failure is
 * never remembered: it is retried on the next scan.
 */
const refusedStoredReads = new Map();

/**
 * The events a LIVE session holds in memory, and its cue into that sequence.
 *
 * A live session's in-memory log is the SAME seq space its own appends use
 * (`seq = log.length`), so a persisted fold's cursor is meaningless against it
 * only when the session was rebuilt from storage between scans. The cue is
 * therefore tracked per session, and a shrunken log re-folds from 0.
 * @param session - live Session object from `ctx.sessions.list()`.
 * @returns `{ count, tail }` or null when the session exposes no snapshot API.
 */
function liveAdapterOf(session) {
	if (typeof session.snapshotEvents === "function" && Number.isSafeInteger(session.seq)) {
		return {
			count: () => session.seq,
			tail: (fromIndex) => session.snapshotEvents(fromIndex)
		};
	}
	const events = session.events;
	if (!Array.isArray(events)) return null;
	return {
		count: () => events.length,
		tail: (fromIndex) => events.slice(fromIndex)
	};
}

//#region plugin-private cache
/** Serialize one fold state for this plugin's own cache file. */
/**
 * Serialize an activity record for the cache.
 *
 * The pending-call table is intentionally absent: it holds in-flight tool calls,
 * and a restart cannot close them, so persisting it would only carry dead ids.
 * @param activity - the fold's activity record, or undefined for an old fold.
 * @returns a JSON-safe object.
 */
function activityToJson(activity) {
	if (activity === undefined || activity === null) return null;
	const tools = {};
	for (const [name, entry] of activity.tools) {
		tools[name] = {
			calls: entry.calls,
			failedCalls: entry.failedCalls,
			totalMs: entry.totalMs,
			maxMs: entry.maxMs
		};
	}
	return {
		tools,
		compactions: activity.compactions,
		compactionMs: activity.compactionMs,
		llmMs: activity.llmMs,
		llmCalls: activity.llmCalls
	};
}

/**
 * Restore an activity record from the cache.
 *
 * Every field is validated: a corrupt or older payload must degrade to an
 * empty record, never to NaN counters that would poison the aggregate.
 * @param raw - the cached value, possibly absent.
 * @returns a fresh activity record.
 */
function activityFromJson(raw) {
	const activity = createActivity();
	if (raw === null || typeof raw !== "object") return activity;
	const num = (value) => (Number.isFinite(value) ? value : 0);
	for (const [name, entry] of Object.entries(raw.tools ?? {})) {
		if (entry === null || typeof entry !== "object") continue;
		activity.tools.set(name, {
			calls: num(entry.calls),
			failedCalls: num(entry.failedCalls),
			totalMs: num(entry.totalMs),
			maxMs: num(entry.maxMs)
		});
	}
	activity.compactions = num(raw.compactions);
	activity.compactionMs = num(raw.compactionMs);
	activity.llmMs = num(raw.llmMs);
	activity.llmCalls = num(raw.llmCalls);
	return activity;
}

/**
 * Sum one activity record into another.
 * @param target - accumulator.
 * @param source - record to add.
 * @returns the accumulator.
 */
function mergeActivity(target, source) {
	for (const [name, entry] of source.tools) {
		let into = target.tools.get(name);
		if (into === undefined) {
			into = { calls: 0, failedCalls: 0, totalMs: 0, maxMs: 0 };
			target.tools.set(name, into);
		}
		into.calls += entry.calls;
		into.failedCalls += entry.failedCalls;
		into.totalMs += entry.totalMs;
		if (entry.maxMs > into.maxMs) into.maxMs = entry.maxMs;
	}
	target.compactions += source.compactions;
	target.compactionMs += source.compactionMs;
	target.llmMs += source.llmMs;
	target.llmCalls += source.llmCalls;
	return target;
}

function serializeFold(state) {
	const hours = {};
	for (const [key, entry] of state.hours) {
		hours[key] = { totals: entry.totals, models: [...entry.models] };
	}
	return {
		kind: state.kind ?? null,
		hours,
		lastSample: state.lastSample,
		compactionSamples: [...(state.compactionSamples ?? new Map())],
		currentRoute: state.currentRoute ?? null,
		consumed: state.consumed,
		inheritedEventCount: state.inheritedEventCount,
		revision: state.revision ?? null,
		sizeBytes: state.sizeBytes ?? null,
		// The session's project directory, kept so a cached fold still knows which
		// workspace it belongs to after a restart.
		workspace: state.workspace ?? null,
		// Tool and timing counters. Serialized as plain objects because a Map does
		// not survive JSON, and the pending-call table is dropped: a call whose
		// result never arrived in the folded range cannot be paired later anyway.
		activity: activityToJson(state.activity),
		// The flag is WRITTEN, not dropped: a backfill may be chunked, and a fold
		// still waiting its turn must stay marked or it would never be read. Only
		// a fold that has actually been re-read clears it.
		activityStale: state.activityStale === true
	};
}

/** Restore one replacement cursor sample from the cache. */
function restoreSample(raw) {
	if (raw === null || typeof raw !== "object") return null;
	if (typeof raw.key !== "string" || typeof raw.hour !== "string") return null;
	const buckets = { ...zeroBuckets(), ...(raw.buckets ?? {}) };
	if (!Number.isFinite(buckets.inputTokens)) return null;
	return { key: raw.key, hour: raw.hour, route: raw.route ?? undefined, buckets };
}

/** Restore one bucket map (`[key, buckets]` pairs) from the cache. */
function restoreRows(pairs) {
	const rows = new Map();
	if (!Array.isArray(pairs)) return rows;
	for (const pair of pairs) {
		if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
		if (pair[1] === null || typeof pair[1] !== "object") continue;
		rows.set(pair[0], { ...zeroBuckets(), ...pair[1] });
	}
	return rows;
}

/**
 * Restore one fold state from the cache, skipping anything malformed.
 *
 * Two shapes are accepted:
 *
 *   - **4** — `{ kind, consumed(last seq), hours, ... }`, this schema.
 *   - **3** — `{ consumed(event COUNT), hours, revision, sizeBytes }`. Its hours
 *     are the only surviving record of usage whose log may since have been
 *     compacted away, so they are MIGRATED rather than dropped: `seq = count - 1`
 *     (the log's seq is its length), and the source is inferred from the stored
 *     revision (a string means it was folded from the artifact).
 *
 *     A v3 fold that was re-scanned after an append re-applied its boundary
 *     event (it compared an inclusive read offset as an exclusive one). Token
 *     buckets are unaffected — a repeated usage sample replaces its predecessor
 *     rather than adding to it — but `failedCalls`/`retries` may be a few counts
 *     high for those sessions. Deleting the cache file rebuilds them exactly.
 */
function deserializeFold(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const state = createFold();
	if (raw.hours !== null && typeof raw.hours === "object") {
		for (const [key, entry] of Object.entries(raw.hours)) {
			if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) continue;
			if (entry === null || typeof entry !== "object") continue;
			const totals = { ...zeroBuckets(), ...(entry.totals ?? {}) };
			if (!Number.isFinite(totals.inputTokens)) continue;
			state.hours.set(key, { totals, models: restoreRows(entry.models) });
		}
	}
	state.lastSample = restoreSample(raw.lastSample);
	state.compactionSamples = new Map();
	for (const pair of Array.isArray(raw.compactionSamples) ? raw.compactionSamples : []) {
		if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
		const restored = restoreSample(pair[1]);
		if (restored !== null) state.compactionSamples.set(pair[0], restored);
	}
	state.currentRoute = raw.currentRoute ?? undefined;
	const hasKind = raw.kind === "live" || raw.kind === "persisted";
	if (hasKind) {
		state.kind = raw.kind;
		state.consumed = Number.isSafeInteger(raw.consumed) && raw.consumed >= 0 ? raw.consumed : -1;
	} else {
		// v3: `consumed` counted events, so the last folded seq is one below it.
		const count = Number.isSafeInteger(raw.consumed) && raw.consumed >= 0 ? raw.consumed : 0;
		state.consumed = count > 0 ? count - 1 : -1;
		state.kind = typeof raw.revision === "string" && raw.revision !== "" ? "persisted" : undefined;
		state.migrated = true;
	}
	state.inheritedEventCount = Number.isSafeInteger(raw.inheritedEventCount) ? raw.inheritedEventCount : null;
	state.revision = typeof raw.revision === "string" ? raw.revision : null;
	state.sizeBytes = Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null;
	state.workspace = typeof raw.workspace === "string" && raw.workspace !== "" ? raw.workspace : null;
	// A cache written before activity existed simply has none; treat that as an
	// empty record rather than dropping the fold.
	state.activity = activityFromJson(raw.activity)
	// Stale means "this fold's activity has never been collected from its log".
	//
	// Two sources, in order: an explicit flag written by a chunked backfill that
	// has not reached this session yet, and a cache written before the activity
	// record existed at all. Reading only the second would silently drop the
	// queue between passes, because a not-yet-read fold persists an empty record.
	state.activityStale = raw.activityStale === true
		|| raw.activity === undefined
		|| raw.activity === null
	return state;
}

/**
 * Read this plugin's own cache.
 *
 * Anything absent, corrupt, or written under an unknown schema is ignored: the
 * fold then rebuilds from the session logs, which remain the authority. A
 * PREVIOUS known schema is migrated instead of dropped — after a log is
 * compacted, the cached fold is the only surviving record of that usage, so
 * discarding it would silently lose history.
 */
async function loadCache(logger) {
	try {
		const parsed = JSON.parse(await readFile(cachePath(), "utf8"));
		if (parsed === null || typeof parsed !== "object") return null;
		if (parsed.version !== CACHE_VERSION && parsed.version !== LEGACY_CACHE_VERSION) return null;
		const sessions = new Map();
		for (const [id, raw] of Object.entries(parsed.sessions ?? {})) {
			const state = deserializeFold(raw);
			if (state !== null) sessions.set(id, state);
		}
		return {
			sessions,
			enumeratedAt: Number.isFinite(parsed.enumeratedAt) ? parsed.enumeratedAt : 0,
			migrated: parsed.version !== CACHE_VERSION
		};
	} catch (error) {
		if (error?.code !== "ENOENT") logger.warn(`usage-dashboard: reading the usage cache failed: ${String(error)}`);
		return null;
	}
}

/**
 * A stable digest of one day's archived content.
 *
 * ## What this protects
 *
 * Days whose session logs still exist are verified against those logs on every
 * read (see `absorbLogDays`). Days whose logs were compacted away have no
 * external evidence left, so a hand edit of the file cannot be detected by
 * comparison. This digest is the evidence: it was written by this plugin when
 * the figure was still correct, so a later edit no longer matches it.
 *
 * ## Why a digest and not the raw value
 *
 * The file already holds the value. A digest adds a second, independently
 * derived copy that a careless edit of the numbers will not update — it catches
 * the realistic case (someone opening the JSON and changing a figure), not a
 * determined forger who recomputes the hash.
 *
 * ## Canonical form
 *
 * The digest covers the day's providers, models and every counter, sorted, with
 * fixed integer formatting. Two runs on the same data must produce the same
 * string, or a legitimate reload would read as tampering.
 *
 * @param families - `Map<provider, Map<model, buckets>>` for one day.
 * @returns a short hex digest.
 */
function dayDigest(families) {
	const parts = [];
	for (const family of [...families.keys()].sort()) {
		const models = families.get(family);
		for (const model of [...models.keys()].sort()) {
			const b = models.get(model);
			// Integers only, in a fixed order: a value that is missing must read as
			// zero here exactly as it does in the aggregator, or a sparse archive
			// would hash differently from a complete one holding the same numbers.
			const counters = [
				b.inputTokens, b.outputTokens, b.cacheReadTokens,
				b.cacheWriteTokens, b.reasoningTokens, b.calls,
				b.failedCalls, b.retries
			].map((n) => (Number.isFinite(n) ? n : 0));
			parts.push(`${family}\u0001${model}\u0001${counters.join("\u0001")}`);
		}
	}
	return createHash("sha256").update(parts.join("\u0002")).digest("hex").slice(0, 16);
}

/**
 * Compare stored digests with the archive's current content.
 *
 * @param days - the archive's day map.
 * @param stored - `{ day: digest }` as written to the file, possibly absent.
 * @returns `{ missing, mismatched }`: days with no digest at all, and days whose
 *   digest no longer matches.
 */
function verifyDigests(days, stored) {
	const missing = [];
	const mismatched = [];
	if (stored === null || typeof stored !== "object") {
		return { missing: [], mismatched: [] };
	}
	for (const [day, families] of days) {
		const expected = stored[day];
		if (typeof expected !== "string") {
			missing.push(day);
			continue;
		}
		if (dayDigest(families) !== expected) mismatched.push(day);
	}
	return { missing, mismatched };
}

	/**
	 * Validate an archived-history block.
	 *
	 * Accepted only in the exact serialized shape the writer emits; anything else
	 * reads as "no history yet", which makes the next sync import it again rather
	 * than serving numbers from a corrupt block.
	 * @param raw - the stored history field, of unknown shape.
	 * @returns `{ days, signature, importedFrom }`, or null when unusable.
	 */
	function normalizeArchive(raw) {
		if (raw === null || typeof raw !== "object") return null;
		const days = restoreArchivedDays(raw.days);
		// An empty result is still "no history": the caller must not treat it as a
		// valid archive, or the next sync would skip the import.
		if (days.size === 0) return null;
		return {
			days,
			signature: typeof raw.signature === "string" ? raw.signature : null,
			importedFrom: typeof raw.importedFrom === "string" ? raw.importedFrom : null
		};
	}

	/**
	 * Serialize the in-memory archive for the statistics file.
	 *
	 * Written in the same wire shape `normalizeArchive` accepts, so a file this
	 * process writes is always a file it can read back.
	 * @returns the `{ days, signature, importedFrom }` block, or null when empty.
	 */
	function archiveOf(state) {
		const archive = state.archive;
		if (archive === null || archive === undefined || archive.days.size === 0) return null;
		const days = [];
		for (const [day, families] of [...archive.days].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
			const familyRows = [];
			for (const [family, models] of families) {
				const modelRows = [];
				for (const [model, buckets] of models) modelRows.push([model, buckets]);
				if (modelRows.length > 0) familyRows.push([family, modelRows]);
			}
			if (familyRows.length > 0) days.push([day, familyRows]);
		}
		return days.length === 0 ? null : { days, signature: archive.signature, importedFrom: archive.importedFrom };
	}

	/**
	 * Persist the absorbed history atomically, keeping ONE backup.
	 *
	 * Written only when the archive actually changed, so a restart that imports
	 * nothing performs no write at all.
	 * @param archive - the in-memory archive, or null when there is none yet.
	 * @returns whether anything was written.
	 */
	async function saveStatistics(archive, logger) {
		if (archive === null || archive.days.size === 0) return false;
		try {
			const serialized = archiveOf({ archive });
			if (serialized === null) return false;
			const path = dataPath();
			await mkdir(dirname(path), { recursive: true });
			// Rotate BEFORE writing: this is the last moment the previous good file is
			// still on disk, and it is the only copy of history whose logs are gone.
			// A rotation failure is not fatal — the write still proceeds, because
			// refusing to save because a backup could not be made would be worse.
			try {
				await refreshStatisticsBackup(path);
			} catch (error) {
				logger.warn(`usage-dashboard: statistics backup failed: ${String(error)}`);
			}
			const tmp = `${path}.tmp`;
			// One digest per day, written WITH the data it describes. This is the only
			// evidence that survives a compacted log: the figures alone cannot prove
			// they were not edited, but a digest computed at write time can.
			const digests = {};
			for (const [day, families] of archive.days) digests[day] = dayDigest(families);
			// The user-facing file carries ONLY the daily data. The digests live in a
			// separate private ledger under storages/: a reader of statistics.json sees
			// plain figures, while the evidence that they were not edited stays where
			// a casual edit will not find (or think to update) it.
			const tmpD = `${digestsPath()}.tmp`;
			await mkdir(dirname(tmpD), { recursive: true });
			await writeFile(tmpD, JSON.stringify({ version: STATISTICS_VERSION, digests }, null, "\t"), "utf8");
			await rename(tmpD, digestsPath());
			await writeFile(tmp, JSON.stringify({
				version: STATISTICS_VERSION,
				history: serialized
			}, null, "\t"), "utf8");
			await rename(tmp, path);
			return true;
		} catch (error) {
			logger.warn(`usage-dashboard: saving the statistics file failed: ${String(error)}`);
			return false;
		}
	}

/**
 * Read this plugin's STATISTICS file: the absorbed history.
 *
 * This is a source of truth, not a cache. It carries the days whose session
 * logs no longer exist, which nothing else on the machine can reproduce, so a
 * read failure is reported as a warning and treated as "no absorbed history"
 * rather than silently ignored.
 * @returns `{ days, signature, importedFrom }` or null when none is stored.
 */
	/** Read the private digest ledger; null when absent or unreadable. */
	async function readDigests() {
		try {
			const parsed = JSON.parse(await readFile(digestsPath(), "utf8"));
			return parsed && typeof parsed === "object" ? parsed.digests ?? null : null;
		} catch {
			return null;
		}
	}

	async function loadStatistics(logger) {
		const path = dataPath();
		let primary = null;
		try {
			primary = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			// A missing file is normal (first run). Anything else means the file exists
			// but cannot be trusted, which is exactly when the backup matters.
			if (error?.code !== "ENOENT") {
				logger.warn(`usage-dashboard: statistics file is damaged: ${String(error)}`);
				primary = null;
			}
		}
		if (primary !== null && typeof primary === "object" && primary.version === STATISTICS_VERSION) {
			const restored = normalizeArchive(primary.history);
			if (restored !== null && restored.days.size > 0) {
				// Verify the digests BEFORE trusting the file. A day whose content no
				// longer matches its stored digest was edited outside this plugin.
				//
				// The edit cannot be undone from the digest alone — it proves only that
				// the file changed. So the damaged copy is reported, and the backup is
				// tried: it was written before the edit, so its digests still match.
				const check = verifyDigests(restored.days, await readDigests());
				if (check.mismatched.length > 0) {
					const head = check.mismatched.slice(0, 3).join(", ");
					logger.warn(`usage-dashboard: statistics was edited outside the plugin (${check.mismatched.length} day(s), first: ${head}); trying the backup`);
				} else {
					if (check.missing.length > 0) {
						// Freshly absorbed days have no digest yet: not tampering, just a
						// step behind. The next save writes theirs.
						logger.info && logger.info(`usage-dashboard: ${check.missing.length} archived day(s) have no digest yet`);
					}
					return restored;
				}
			}
		}
		// Fall through to the backup. This is the self-recovery path: a damaged or
		// edited file must not silently reset the archive, nor serve a figure no
		// evidence supports.
		const backup = await readStatisticsBackup(logger);
		if (backup !== null) {
			const restored = normalizeArchive(backup.history);
			if (restored !== null && restored.days.size > 0) {
				const check = verifyDigests(restored.days, await readDigests());
				if (check.mismatched.length > 0) {
					logger.warn(`usage-dashboard: the backup was edited too (${check.mismatched.length} day(s)); restoring anyway, the session logs will correct any day they still cover`);
				}
				logger.warn(`usage-dashboard: recovered ${restored.days.size} archived days from backup`);
				return restored;
			}
		}
		return null;
	}

/**
 * The day with the most tokens in a rendered window, or null when empty.
 * @param days - rendered day rows.
 * @returns `{ date, tokens }` or null.
 */
function peakDayOf(days) {
	let best = null;
	for (const day of days) {
		if (best === null || day.tokens > best.tokens) best = { date: day.date, tokens: day.tokens };
	}
	return best;
}

function renderWorkspaces(workspaceHours, options) {
	const rows = [];
	if (workspaceHours === undefined || workspaceHours === null) return rows;
	for (const [cwd, bucket] of workspaceHours) {
		const rendered = renderDays(bucket.hours, options);
		const tokens = rendered.totals.tokens;
		const calls = rendered.totals.calls;
		if (tokens === 0 && calls === 0) continue;
		rows.push({
			cwd,
			name: workspaceNameOf(cwd),
			sessions: bucket.sessions,
			tokens,
			calls,
			attempts: rendered.totals.attempts,
			successRate: rendered.totals.successRate,
			// Days in the window with any usage: a workspace that worked on three
			// days is a different story from one that ran on thirty.
			activeDays: rendered.days.length,
			// The busiest day, so a spike inside the window is visible without opening
			// the workspace.
			peakDay: peakDayOf(rendered.days),
			// The dominant model family for this workspace: a project usually runs one,
			// and it explains the cache hit rate next to it.
			providers: rendered.providers.map((row) => row.provider),
			// How the workspace worked, beside what it spent. `tools` is a plain
			// object (JSON-safe) sorted by call count, and the timings are the
			// sums the fold kept.
			activity: workspaceActivityOf(bucket.activity),
			failedCalls: rendered.totals.failedCalls,
			inputTokens: rendered.totals.inputTokens,
			outputTokens: rendered.totals.outputTokens,
			cacheReadTokens: rendered.totals.cacheReadTokens,
			cacheWriteTokens: rendered.totals.cacheWriteTokens,
			reasoningTokens: rendered.totals.reasoningTokens,
			cacheHitRate: rendered.totals.cacheHitRate
		});
	}
	// Descending by consumption. A tie falls back to the name so the order is
	// stable across reads rather than dependent on Map insertion.
	return rows.sort((a, b) => b.tokens - a.tokens || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
}

/**
 * Mirror the live log aggregate into the archive, EVERY time it is published.
 *
 * ## Why real time, not a grace window
 *
 * DSH compacts session logs. Once a log is compacted its usage exists nowhere
 * else, so the archive is the only copy that survives. Waiting even a day risks
 * losing that day to a compaction; waiting a week is indefensible.
 *
 * So every published generation is written into `statistics.json`, and the
 * window the logs cover stops being a window at all: the file always holds the
 * complete history up to the last publish.
 *
 * ## Why replace rather than add
 *
 * The archived figure and the log figure for the same day describe the SAME
 * calls. Summing them would double count, so a day the logs still cover is
 * overwritten with the log's figure whenever that figure is larger — the same
 * "larger side wins" rule the render path applies, fixed once at write time. A
 * day the logs no longer cover keeps its archived copy untouched.
 *
 * @param hours - the merged hour aggregate of every fold.
 * @param archive - the current archive, or null.
 * @param tzOffsetMinutes - viewer offset, so day keys match the panel.
 * @returns the new archive, or null when nothing changed.
 */
function absorbLogDays(hours, archive, tzOffsetMinutes, logger) {
	const rendered = renderDays(hours, { tzOffsetMinutes, updatedAt: Date.now() });
	if (rendered.days.length === 0) return null;
	const days = archive === null ? new Map() : restoreArchivedDays(archiveDaysOf(archive));
	// Days whose archived figure disagrees with the log. Collected here and
	// reported once, so a hand-edited file is visible instead of silently
	// corrected — the correction matters, but so does knowing it happened.
	const tamperedDays = [];
	let changed = false;
	for (const day of rendered.days) {
		// Rebuild this day's provider -> model map in the archive's own shape.
		const families = new Map();
		for (const row of day.byModel) {
			const slash = row.model.indexOf("/");
			const provider = slash < 0 ? row.model : row.model.slice(0, slash);
			let models = families.get(provider);
			if (models === undefined) {
				models = new Map();
				families.set(provider, models);
			}
			models.set(slash < 0 ? row.model : row.model.slice(slash + 1), {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheReadTokens: row.cacheReadTokens,
				cacheWriteTokens: row.cacheWriteTokens,
				reasoningTokens: row.reasoningTokens,
				calls: row.calls,
				failedCalls: row.failedCalls,
				retries: row.retries
			});
		}
		if (families.size === 0) continue;
		const existing = days.get(day.date);
		// The LOG is authoritative for any day it still covers, so its figure
		// replaces the archived copy unconditionally — not "when larger".
		//
		// "Larger wins" was wrong for two reasons. It kept a hand-edited figure
		// (raising a number made the edit permanent), and it kept a stale figure
		// after the host corrected a double count DOWNWARD. A log is the record of
		// what actually ran; the archive is only this plugin's memory of it. So the
		// archive is overwritten whenever the two disagree, and the disagreement is
		// reported, because it means someone edited the file or a figure drifted.
		if (existing !== undefined) {
			const archivedTokens = totalOfFamilies(existing);
			if (archivedTokens !== day.tokens) {
				tamperedDays.push({ date: day.date, archived: archivedTokens, live: day.tokens });
			}
		}
		days.set(day.date, families);
		changed = true;
	}
	if (!changed) return null;
	if (tamperedDays.length > 0) {
		// One line for the log, one per day would flood it on a wholesale edit.
		const summary = tamperedDays.slice(0, 3).map((d) => `${d.date} archived=${(d.archived / 1e8).toFixed(2)}亿 live=${(d.live / 1e8).toFixed(2)}亿`).join(", ");
		logger.warn(`usage-dashboard: statistics disagreed with the session logs for ${tamperedDays.length} day(s) and was restored from them (${summary}${tamperedDays.length > 3 ? ", ..." : ""})`);
	}
	return {
		days,
		tamperedDays,
		// The signature describes the EXTERNAL ledger, not this archive's content, so
		// mirroring log days must not rewrite it: a later ledger with the same content
		// would otherwise be re-imported as if it were new.
			signature: archive === null ? null : archive.signature,
			importedFrom: archive === null ? null : archive.importedFrom
	};
}

/** Sum every bucket of a day's provider -> model map into a token count. */
function totalOfFamilies(families) {
	let tokens = 0;
	for (const [, models] of families) {
		for (const [, buckets] of models) {
			tokens += buckets.inputTokens + buckets.outputTokens
				+ buckets.cacheReadTokens + buckets.cacheWriteTokens
				+ buckets.reasoningTokens;
		}
	}
	return tokens;
}

/**
 * Absorb the external usage ledger into this plugin's own archive, once.
 *
 * The ledger predates the session logs, so its days are history that nothing
 * else on this machine can reproduce. Absorbing it into `statistics.json` is
 * what lets this plugin stop depending on that external file at render time.
 *
 * The import is idempotent: a signature match means the archive already holds
 * this ledger's content, so nothing is re-imported and nothing is written.
 * @returns whether the archive changed and therefore needs saving.
 */
async function absorbLedger(archive) {
	const imported = importLedgerDays();
	if (imported === null || imported.days.length === 0) return null;
	// Already absorbed at this exact ledger content: nothing new to take.
	if (archive !== null && archive.signature === imported.signature) return null;
	const days = restoreArchivedDays(imported.days);
	if (days.size === 0) return null;
	// Merged into the existing archive rather than replacing it: the archive may
	// already hold days this ledger does not cover, and dropping those would
	// erase history the logs cannot rebuild.
	const merged = restoreArchivedDays(archive === null ? [] : archiveDaysOf(archive));
	for (const [day, families] of days) {
		const into = merged.get(day) ?? new Map();
		for (const [family, models] of families) {
			const familyMap = into.get(family) ?? new Map();
			for (const [model, buckets] of models) {
				// The ledger's own figure wins: it is the source being absorbed.
				familyMap.set(model, buckets);
			}
			into.set(family, familyMap);
		}
		merged.set(day, into);
	}
	return { days: merged, signature: imported.signature, importedFrom: IMPORT_SOURCE };
}

/**
 * Serialize an archive's day map back to the wire array.
 *
 * `archiveOf` reads from a state object; the merge above needs the raw array
 * to re-validate through `restoreArchivedDays`.
 * @param archive - `{ days }`.
 * @returns `[[day, [[family, [[model, buckets]]]]]]`.
 */
function archiveDaysOf(archive) {
	const out = [];
	for (const [day, families] of [...archive.days].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
		const familyRows = [];
		for (const [family, models] of families) {
			const modelRows = [];
			for (const [model, buckets] of models) modelRows.push([model, buckets]);
			if (modelRows.length > 0) familyRows.push([family, modelRows]);
		}
		if (familyRows.length > 0) out.push([day, familyRows]);
	}
	return out;
}

/**
 * Project a workspace's activity record into the wire shape.
 *
 * Durations travel in milliseconds and the panel formats them, so a Host that
 * renders "1.2s" or "45m" differently still gets the same number. Tool rows
 * are sorted by call count: the busiest tool is the one worth naming first.
 * @param activity - a workspace's accumulated activity record.
 * @returns JSON-safe counters and a sorted tool list.
 */
function workspaceActivityOf(activity) {
	const tools = [];
	for (const [name, entry] of activity.tools) {
		if (entry.calls === 0) continue;
		tools.push({
			name,
			calls: entry.calls,
			failedCalls: entry.failedCalls,
			totalMs: entry.totalMs,
			// A call with no paired result has no duration; the average divides by
			// the calls that WERE measured, not by all of them.
			avgMs: entry.calls === 0 ? 0 : Math.round(entry.totalMs / entry.calls),
			maxMs: entry.maxMs
		});
	}
	tools.sort((a, b) => b.calls - a.calls || b.totalMs - a.totalMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return {
		toolCalls: tools.reduce((sum, row) => sum + row.calls, 0),
		tools,
		compactions: activity.compactions,
		compactionMs: activity.compactionMs,
		llmMs: activity.llmMs,
		llmCalls: activity.llmCalls
	};
}

/**
 * The display name of a workspace: its directory's last segment.
 *
 * Separators of both kinds are accepted, because a Host may report either and
 * a trailing separator must not produce an empty name.
 * @param cwd - absolute project directory.
 * @returns the last path segment, or the whole string when it has none.
 */
function workspaceNameOf(cwd) {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	// A root path has no leaf segment; strip to nothing and the row would be
	// nameless, so the original string is the name instead.
	const leaf = cut < 0 ? trimmed : trimmed.slice(cut + 1);
	return leaf === "" ? cwd : leaf;
}

async function summaryPayload(aggregator, options) {
	const generation = await aggregator.generation(options.force, -options.tzOffsetSeconds / 60);
	// An explicit range wins; otherwise the window is the trailing day count
	// ending today in the viewer's own timezone.
	const explicit = options.from !== undefined && options.to !== undefined;
	const to = explicit ? options.to : localToday(options.tzOffsetSeconds);
	const from = explicit
		? options.from
		: (options.days === "all" ? null : shiftDay(to, -(options.days - 1)));
	const tzOffsetMinutes = -options.tzOffsetSeconds / 60;
	// Day rows are windowed to the selected range; the rankings stay all-time,
	// so a provider that was only active months ago still shows in the
	// distribution, and the cumulative card reports its true total.
	// Per-workspace ranking, over the SAME window as the calendar so the two
	// agree, sorted by consumption: the reader wants to know which project
	// costs the most, so the order is by tokens and never by name.
	// A session with no recorded directory cannot be attributed, and inventing
	// a bucket for it would overstate an unnamed project, so those are dropped.
	const workspaces = renderWorkspaces(generation.workspaceHours, {
		tzOffsetMinutes,
		...(from === null ? {} : { from }),
		to,
		updatedAt: generation.foldedAt
	});
	// History with no known workspace: the external ledger this archive absorbed
	// carried no cwd, and those session folders are long gone. The spend is real,
	// so it is reported as ONE explicit row at the FOOT of the workspace list —
	// separate, unmoved by sorting, because it is not a workspace.
	const windowed = renderDays(generation.hours, {
		tzOffsetMinutes,
		...(from === null ? {} : { from }),
		to,
		updatedAt: generation.foldedAt,
		mergeLedger: (byDay, dayFrom, dayTo) =>
			mergeArchivedInto(byDay, aggregator.archiveDays, { from: dayFrom, to: dayTo })
	});
	// History with no known workspace: the value merged into windowTotals but
	// owned by no directory. Derived from the SAME merged totals the metric
	// cards show, so the ranking closes the gap instead of leaving a silent
	// remainder. A sibling row of the workspace list, not a workspace.
	const unattributed = (() => {
		const attributed = workspaces.reduce((sum, row) => sum + row.tokens, 0);
		const attributedCalls = workspaces.reduce((sum, row) => sum + row.calls, 0);
		const gapTokens = windowed.totals.tokens - attributed;
		const gapCalls = windowed.totals.calls - attributedCalls;
		if (gapTokens <= 1000000) return null;
		return { name: UNATTRIBUTED_NAME, tokens: gapTokens, calls: Math.max(0, gapCalls) };
	})();
	const allTime = renderDays(generation.hours, {
		tzOffsetMinutes,
		updatedAt: generation.foldedAt,
		mergeLedger: (byDay) => mergeArchivedInto(byDay, aggregator.archiveDays)
	});
	// The current calendar month, independent of the selected window: the card
	// reports "this month" whoever the range happens to cover, so it stays
	// comparable across tabs and after changing the range.
	const month = monthRangeOf(to);
	const monthTotals = renderDays(generation.hours, {
		tzOffsetMinutes,
		from: month.from,
		to: month.to,
		updatedAt: generation.foldedAt,
		mergeLedger: (byDay, dayFrom, dayTo) =>
			mergeArchivedInto(byDay, aggregator.archiveDays, { from: dayFrom, to: dayTo })
	});
	return {
		ok: true,
		window: { from, to, days: explicit ? options.days : options.days, explicit: explicit === true },
		days: windowed.days,
		windowTotals: windowed.totals,
		month: { from: month.from, to: month.to, days: monthTotals.days, totals: monthTotals.totals },
		allTime: {
			totals: allTime.totals,
			models: allTime.models,
			providers: allTime.providers,
		},
		// The per-workspace ranking, over the selected window. TOP LEVEL, not
		// nested under `allTime`: it is windowed like the calendar, and the client
		// reads `payload.workspaces`.
		workspaces,
		// History with no known workspace, pinned to the foot of the workspace list.
		unattributed,
		sessions: generation.sessions,
		refreshing: aggregator.refreshing,
		partial: generation.partial === true,
		updatedAt: generation.foldedAt
	};
}

/** Build one day's payload from the published generation. */
async function dayPayload(aggregator, date, tzOffsetSeconds, force) {
	const generation = await aggregator.generation(force, -tzOffsetSeconds / 60);
	const tzOffsetMinutes = -tzOffsetSeconds / 60;
	const allTime = renderDays(generation.hours, {
		tzOffsetMinutes,
		updatedAt: generation.foldedAt,
		mergeLedger: (byDay) => mergeArchivedInto(byDay, aggregator.archiveDays)
	});
	const day = allTime.days.find((entry) => entry.date === date);
	return {
		ok: true,
		date,
		day: day ?? null,
		refreshing: aggregator.refreshing,
		partial: generation.partial === true,
		updatedAt: generation.foldedAt
	};
}

/** An error carrying the HTTP status it answers with. */
function httpError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

/**
 * Register the two data routes. Both are read-only and loopback-only: they
 * expose aggregate token counts, never prompts or credentials, but an exact
 * route bypasses the RPC trust fence, so the peer check is stated here.
 */
function registerRoutes(ctx, aggregator) {
	const handler = (build) => async (req, res) => {
		if (rejectForeignCaller(req, res)) return;
		try {
			json(res, 200, await build(req, tzOffsetOf(req)));
		} catch (error) {
			ctx.logger.warn(`usage-dashboard: request failed: ${String(error)}`);
			json(res, error?.status ?? 500, {
				ok: false,
				error: error?.code ?? "aggregation-failed",
				message: error instanceof Error ? error.message : String(error)
			});
		}
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SUMMARY_PATH,
		handler: handler((req, tzOffsetSeconds) => summaryPayload(aggregator, {
			...windowOf(req),
			tzOffsetSeconds,
			force: forceOf(req)
		}))
	}), "usage-dashboard: summary route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: DAY_PATH,
		handler: handler(async (req, tzOffsetSeconds) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const date = url.searchParams.get("date") ?? "";
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				throw httpError(400, "invalid-date", "date must be a YYYY-MM-DD local key");
			}
			return dayPayload(aggregator, date, tzOffsetSeconds, forceOf(req));
		})
	}), "usage-dashboard: day route");
}
//#endregion

/**
 * The aggregator: owns per-session folds, the published generation, and the
 * single-flight scan that keeps both current.
 *
 * A read never waits for a scan: it serves the last published generation and
 * starts a scan if one is due, so the panel is responsive even while a cold
 * fold runs.
 * @param ctx - plugin context carrying sessionPersistence and sessions.
 */
function createAggregator(ctx, logger) {
	const state = {
		sessions: new Map(),
		published: null,
		foldedAt: 0,
		inflight: null,
		loaded: false,
		/**
		 * Whether this process has completed a store walk over every stored fold.
		 *
		 * Until it has, a published generation is missing stored history, so it
		 * must be reported as partial even when a cache restored cleanly.
		 */
		scanned: false,
		enumeratedAt: 0,
		settled: new Set(),
		archive: null,
		attached: new Set(),
		/** Stale folds left for a later pass by the backfill budget. */
		pendingStale: 0
	};

	/** Sum every folded session into the hour map and the per-workspace split. */
	function aggregateOf(sessions) {
		const hours = new Map();
		// Workspace totals are summed in the SAME pass, keyed by the session's
		// project directory. They are kept BESIDE `hours` rather than folded into
		// it because a workspace belongs to the session, not to an hour: encoding
		// it into the hour/model key would change every existing row's identity.
		const workspaceHours = new Map();
		for (const fold of sessions.values()) {
			mergeHours(hours, fold.hours);
			if (fold.workspace === null || fold.workspace === undefined) continue;
			let bucket = workspaceHours.get(fold.workspace);
			if (bucket === undefined) {
				bucket = { hours: new Map(), sessions: 0, activity: createActivity() };
				workspaceHours.set(fold.workspace, bucket);
			}
			mergeHours(bucket.hours, fold.hours);
			bucket.sessions += 1;
			// Tool and timing counters ride along: they answer "how did this
			// workspace work", which the row shows alongside its spend.
			mergeActivity(bucket.activity, fold.activity ?? createActivity());
		}
		return { hours, workspaceHours };
	}

	/** Publish a generation. `partial` marks a cold fold still in progress. */
	// Coalescing mirror-writes: the last publish inside one second wins.
	let mirrorTimer = null;
	let mirrorTz = 0;
	function scheduleMirror(tzOffsetMinutes) {
		mirrorTz = tzOffsetMinutes;
		if (mirrorTimer !== null) return;
		// A short delay both coalesces bursts (sidebar + page poll together) and
		// lets the current call stack finish before any disk work starts.
		mirrorTimer = setTimeout(() => {
			mirrorTimer = null;
			void mirrorArchive(mirrorTz).catch((error) => logger.warn(`usage-dashboard: mirror failed: ${String(error)}`));
		}, 1_000);
	}
	function publish(partial, tzOfViewer) {
		state.foldedAt = Date.now();
		// One aggregate per publish: the hour map and the per-workspace split must
		// come from the same pass, or a reader could see them disagree.
		const aggregated = aggregateOf(state.sessions);
		state.published = {
			hours: aggregated.hours,
			workspaceHours: aggregated.workspaceHours,
			sessions: state.sessions.size,
			foldedAt: state.foldedAt,
			partial: partial === true
		};
		// The statistics file is THE data file — history and today both live in it.
		// Every publish that could have changed the aggregate schedules one write;
		// reads do not await it (a JSON dump must never sit in the response path),
		// and writes inside the same second coalesce into the last one.
		scheduleMirror(tzOfViewer ?? 0);
		return state.published;
	}

	/**
	 * Restore both halves of the on-disk state.
	 *
	 * The STATISTICS are read first and unconditionally: they are this plugin's
	 * own data and survive a missing or invalid cache.
	 * @returns whether a usable fold cache was restored.
	 */
	async function restore() {
		state.archive = await loadStatistics(logger);
		const cached = await loadCache(logger);
		state.loaded = true;
		if (cached === null) return false;
		state.sessions = cached.sessions;
		state.enumeratedAt = cached.enumeratedAt;
		return true;
	}

	/** Fold the in-memory tail of every LIVE session. */
	function foldLiveSessions() {
		const liveStore = ctx.get("sessions");
		if (liveStore === undefined || typeof liveStore.list !== "function") return false;
		let touched = false;
		const attached = new Set();
		for (const session of liveStore.list()) {
			const adapter = liveAdapterOf(session);
			if (adapter === null) continue;
			attached.add(session.id);
			const count = adapter.count();
			let fold = state.sessions.get(session.id);
			let changed = false;
			if (fold === undefined) {
				fold = createFold();
				state.sessions.set(session.id, fold);
				// The live session object carries its own header, cwd included. Recording
				// it HERE is what makes the workspace ranking include LIVE sessions: the
				// aggregate skips folds with no workspace, and a brand-new session is
				// live-only until its first store walk, so without this its spend lands
				// in the totals but never in any workspace row.
				fold.workspace = typeof session.header?.cwd === "string" && session.header.cwd !== "" ? session.header.cwd : fold.workspace ?? null;
				changed = true;
			}
			// A live/persisted transition, or a fold that predates the activity
			// record: the whole in-memory log is folded again.
			if ((fold.kind !== "live" || fold.activityStale === true) && count > 0) {
				resetFold(fold);
				changed = true;
			}
		 const cut = inheritedCutOf(session);
			if (cut !== fold.inheritedEventCount) {
				fold.inheritedEventCount = cut;
				changed = true;
			}
			if (count > (fold.consumed ?? -1) + 1) {
				const from = (fold.consumed ?? -1) + 1;
				applyEvents(fold, adapter.tail(from), { skipBeforeSeq: cut });
				fold.consumed = count - 1;
				// The live log was just replayed, so its activity is collected now.
				fold.activityStale = false;
				changed = true;
			}
			if (fold.kind !== "live") {
				fold.kind = "live";
				changed = true;
			}
			if (changed) touched = true;
		}
		state.attached = attached;
		return touched;
	}

	/** Serialize the fold map for the cache. */
	async function saveCache(sessions, enumeratedAt, logger2) {
		try {
			const path = cachePath();
			await mkdir(dirname(path), { recursive: true });
			const store = {};
			for (const [id, fold] of sessions) store[id] = serializeFold(fold);
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify({
				version: CACHE_VERSION,
				enumeratedAt,
				sessions: store
			}), "utf8");
			await rename(tmp, path);
		} catch (error) {
			logger2.warn(`usage-dashboard: saving the usage cache failed: ${String(error)}`);
		}
	}

	/**
	 * Fold a batch of stored sessions with bounded concurrency.
	 * @param enumerated - whether this batch came from a full store enumeration.
	 */
	async function drain(persistence, pending, pruned, enumerated, backfilled = 0) {
		if (pending.length === 0) return { folded: pruned, enumerated, retry: [], remainingStale: state.pendingStale };
		const failures = [];
		const retry = [];
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= pending.length) return;
				const { entry, fold, settled: wasSettled } = pending[index];
				try {
					if (await foldStoredSession(persistence, entry, fold)) refusedStoredReads.delete(entry.id);
					fold.sizeBytes = entry.sizeBytes;
				} catch (error) {
					const refused = isStoredLogRefusal(error);
					if (refused && entry.revision !== null) refusedStoredReads.set(entry.id, entry.revision);
					failures.push({ id: entry.id, error, refused });
					if (wasSettled === true) retry.push(entry.id);
				}
			}
		};
		const workers = Math.min(PERSISTED_READ_CONCURRENCY, pending.length);
		await Promise.all(Array.from({ length: workers }, worker));
		if (failures.length > 0) {
			const transient = failures.filter((failure) => !failure.refused).length;
			const parts = [
				`${failures.length} failed`,
				transient > 0 ? `${transient} transient and retried on the next scan` : "",
				failures.length - transient > 0 ? `${failures.length - transient} refused permanently` : ""
			].filter((part) => part !== "");
			logger.warn(`usage-dashboard: ${failures.length} stored session(s) could not be read (${parts.join("; ")}) (first: "${failures[0].id}": ${String(failures[0].error)})`);
		}
		return { folded: pending.length + pruned + backfilled, enumerated, retry, remainingStale: state.pendingStale };
	}

	/**
	 * Enumerate stored sessions and fold what the cache does not cover.
	 * @param force - enumerate now even if the reuse window has not elapsed.
	 */
	async function walkStore(force) {
		const persistence = ctx.get("sessionPersistence");
		if (persistence === undefined) throw new Error("session persistence is unavailable");
		const sinceEnumeration = Date.now() - state.enumeratedAt;
		// A session that settled out of the live store is read by id NOW: its usage
		// exists only in storage, and waiting for the next walk would hide it.
		const settledNow = [...state.settled].filter((id) => !state.attached.has(id));
		if (!force && settledNow.length === 0 && sinceEnumeration < ENUMERATE_EVERY_MS) {
			const toFold = [];
			for (const id of settledNow) {
				if (state.attached.has(id)) continue;
				const fold = state.sessions.get(id) ?? createFold();
				state.sessions.set(id, fold);
				toFold.push({ entry: { id, revision: null, sizeBytes: null, seeded: true, workspace: null }, fold, settled: true });
			}
			if (toFold.length === 0) return { folded: 0, enumerated: false, retry: [], remainingStale: 0 };
			const result = await drain(persistence, toFold, 0, false);
			for (const id of result.retry) state.settled.add(id);
			return result;
		}
	 const listed = await listStoredSessions(persistence, logger);
		// An unenumerable store keeps the previous folds: they are still the best
		// evidence available, and dropping them would blank the panel.
		if (listed === null) return { folded: 0, enumerated: false, retry: [], remainingStale: 0 };
		state.enumeratedAt = Date.now();
		// Reset the backlog count for this enumeration; it is raised below when
		// the batch budget runs out with folds still waiting.
		state.pendingStale = 0;

		const attached = state.attached ?? new Set();
		const persistedIds = new Set();
		let pruned = 0;
		let backfilled = 0;
		// Budget for this pass. A cache missing a fold field marks EVERY stored
		// session stale at once; re-reading them all in one pass takes ~55s and
		// never lands. Re-reading at most this many per pass lets each pass
		// finish, save, and hand the remainder to the next scan.
		let staleBudget = BACKFILL_BATCH;
		const toFold = [];
		for (const entry of listed) {
			persistedIds.add(entry.id);
			// A session that is still live is owned by the live path; its stored log
			// is not a second source to fold.
			if (attached.has(entry.id)) continue;
			const existing = state.sessions.get(entry.id);
			// Backfill the owning workspace BEFORE any skip below. A session whose
			// log is unchanged never reaches `foldStoredSession`, so the first scan
			// after this field was introduced would leave every cached fold without
			// a workspace and the ranking empty.
			if (existing !== undefined && entry.workspace !== null && existing.workspace !== entry.workspace) {
				existing.workspace = entry.workspace;
				backfilled += 1;
			}
			// A fold restored before the activity record existed must be re-read ONCE
			// even though its log is unchanged: the tool counts live in the log, not
			// in the cached fold, and nothing else will ever put them there.
			const needsActivity = existing !== undefined && existing.activityStale === true && staleBudget > 0;
			// Left for a later pass: count it so the caller knows to continue.
			if (!needsActivity && existing !== undefined && existing.activityStale === true) state.pendingStale += 1;
			if (needsActivity) staleBudget -= 1;
			if (!needsActivity && existing !== undefined && existing.kind === "persisted" && entry.revision !== null && existing.revision === entry.revision) continue;
			if (!needsActivity && existing !== undefined && existing.kind === "persisted" && entry.sizeBytes !== null && existing.sizeBytes === entry.sizeBytes) {
				existing.revision = entry.revision;
				existing.sizeBytes = entry.sizeBytes;
				continue;
			}
			// A log already refused at this exact revision is skipped without another
			// decode: the artifact has not changed, so the outcome cannot differ.
			if (refusedStoredReads.get(entry.id) === entry.revision) continue;
			const fold = existing ?? createFold();
			state.sessions.set(entry.id, fold);
			toFold.push({ entry, fold });
		}
		// An EMPTY enumeration is not evidence that sessions were deleted: a store
		// that has not finished starting up, or a backend whose listing failed
		// softly, both look exactly like this. Pruning on it would erase every
		// restore from the cache — which is precisely how a full reset happened.
		// Deletion is only believable when the store DID list something AND the
		// cache was restored (so the rows being removed were ours to begin with).
		const allowPruning = listed.length > 0;
		// A session deleted from the store must leave the fold map, or it keeps
		// contributing usage that no longer exists.
		for (const id of [...state.sessions.keys()]) {
			if (!allowPruning) break;
			if (attached.has(id) || persistedIds.has(id)) continue;
			if (state.sessions.get(id)?.migrated === true) continue;
			state.sessions.delete(id);
			refusedStoredReads.delete(id);
			pruned += 1;
		}
		const result = await drain(persistence, toFold, pruned, true, backfilled);
		for (const id of result.retry) state.settled.add(id);
		return { folded: result.folded, enumerated: true, retry: result.retry, remainingStale: state.pendingStale };
	}

	/**
	 * Run the store walk, publishing before and after it.
	 *
	 * The pre-walk publish is what makes the CURRENT day visible immediately:
	 * a cold fold can take a minute, and an empty calendar during that time
	 * reads as broken.
	 * @param force - pass through to the walk.
	 */
	function startSync(force, tzOffsetMinutes = 0) {
		if (state.inflight !== null) return;
		const run = (async () => {
			const liveTouched = foldLiveSessions();
			if (liveTouched) await saveCache(state.sessions, state.enumeratedAt, logger);
			publish(state.scanned === false, tzOffsetMinutes);
			try {
				const walked = await walkStore(force);
				// `scanned` means "every stored fold has been read at least once". A
				// chunked backfill is still reading, so completeness waits for that:
				// claiming readiness while folds remain unread is what made the panel
				// show figures that then grew.
				if (walked.enumerated && (walked.remainingStale ?? 0) === 0) state.scanned = true;
				if (walked.folded > 0) await saveCache(state.sessions, state.enumeratedAt, logger);
				// Continue the backfill on the next tick rather than waiting a full
				// enumeration interval: the budget is a time guard, not a pace.
				if ((walked.remainingStale ?? 0) > 0) setTimeout(() => startSync(false), 250);
			} catch (error) {
				logger.warn(`usage-dashboard: background sync failed: ${String(error)}`);
			}
			publish(state.scanned === false, tzOffsetMinutes);
		})();
		state.inflight = run.finally(() => {
			state.inflight = null;
		});
		run.catch(() => {});
	}

	/**
	 * The generation to serve one read, starting a scan when one is due.
	 * @param force - force a store walk now.
	 */
	const generation = async (force, tzOffsetMinutes = 0) => {
		if (!state.loaded) {
			await restore();
			// Absorb the EXTERNAL ledger once, then persist it: the archive is the only
			// surviving record of the days whose logs are already compacted away.
			const absorbed = await absorbLedger(state.archive);
			if (absorbed !== null) {
				state.archive = absorbed;
				await saveStatistics(state.archive, logger);
			}
			foldLiveSessions();
			// ALWAYS partial here, even with a restored cache: `foldLiveSessions()`
			// covers only the sessions this process holds live, and the stored folds
			// are not in `state.sessions` until the first walk lands them.
			publish(true, tzOffsetMinutes);
			startSync(true, tzOffsetMinutes);
			return state.published ?? publish(true, tzOffsetMinutes);
		}
		const liveTouched = foldLiveSessions();
		if (force || Date.now() - state.enumeratedAt >= ENUMERATE_EVERY_MS) startSync(force, tzOffsetMinutes);
		else if (liveTouched) publish(state.scanned === false, tzOffsetMinutes);
		return state.published ?? publish(true, tzOffsetMinutes);
	};
	/**
	 * Write the live aggregate into the archive, once per publish that changed it.
	 *
	 * Runs on the READ path rather than on a timer: a read is exactly the moment
	 * the aggregate is known to be current, and it costs one JSON write of a file
	 * that already exists. Skipped while a cold fold is still in progress, because
	 * a partial aggregate would freeze an incomplete day into the file.
	 *
	 * @param tzOffsetMinutes - viewer offset, so the day keys match the panel.
	 */
	async function mirrorArchive(tzOffsetMinutes) {
		if (state.scanned !== true) return;
		const snapshot = state.published;
		if (snapshot === null) return;
		// `hours` is the merged aggregate this publish was built from.
		const next = absorbLogDays(snapshot.hours, state.archive, tzOffsetMinutes, logger);
		if (next === null) return;
		state.archive = next;
		// Persisted immediately: the point of this is that the file, not the log,
		// is the record — a figure held only in memory would vanish with the
		// process, which is the very loss this mechanism exists to prevent.
		await saveStatistics(state.archive, logger);
	}


	return {
		generation,
		/** The archived pre-log history, as Maps ready to merge. */
		get archiveDays() {
			return state.archive?.days ?? EMPTY_DAYS;
		},
		/** Whether a sync is running right now (reported to the client). */
		get refreshing() {
			return state.inflight !== null;
		}
	};
}

/** Shared empty archive, so a profile without one allocates nothing. */
const EMPTY_DAYS = new Map();

/**
 * Plugin body: build the aggregator and register the data routes. No fold runs
 * at activation — the host is serving boot traffic then, and the fold starts on
 * the first dashboard read instead.
 * @param ctx - plugin context carrying webServer and sessionPersistence.
 */
function apply(ctx) {
	const aggregator = createAggregator(ctx, ctx.logger);
	registerRoutes(ctx, aggregator);
	// No fold on activation: the host is busy serving boot traffic (including the
	// user's first new-session request), and a cold fold would compete with it.
	// The first dashboard read starts the fold instead.
}

export { apply, inject, name, SUMMARY_PATH, DAY_PATH };
