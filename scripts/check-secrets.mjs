/**
 * Guard: refuse to commit the author's real usage data.
 *
 * The plugin folds the REAL session store into `preview/payload.json` and
 * `preview/fixture.js` when `preview/make-fixture.mjs` runs, and that output
 * carries the author's workspace paths, provider routes and token totals. Those
 * two files ARE committed (the preview harness needs them), so a careless
 * `make-fixture.mjs` followed by `git commit -a` publishes the real data.
 *
 * It happened once: commit 6180aa7 shipped 18 workspace paths and 556
 * sessions of real usage to a public repository, and clearing it meant
 * rewriting every commit hash.
 *
 * This script is the second line of defence. It scans the CONTENT THAT WOULD
 * BE COMMITTED and fails when it finds anything that looks like the author's
 * own machine: a home directory, a Windows user profile, a drive path outside
 * the synthetic examples, or the session-store markers the real fixture
 * carries.
 *
 * ## What it scans
 *
 * The staged content (`git diff --cached`), not the working tree: a private
 * file that was never `git add`ed must not block an unrelated commit, and a
 * stale working-tree copy must not be able to hide a leak that IS staged.
 *
 * ## What it does NOT flag
 *
 * The synthetic fixture's own paths (`/home/dev/projects/...`) and the
 * generic Windows examples in the docs (`D:\projects\...`). Those are the
 * repository's intended content, and flagging them would make the guard
 * unusable on a clean tree.
 *
 *   node scripts/check-secrets.mjs              # scan the staged content
 *   node scripts/check-secrets.mjs --all        # scan every tracked file
 *   node scripts/check-secrets.mjs --paths a b  # scan specific files
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Patterns that only the author's own machine can produce.
 *
 * Each entry names the kind of leak it catches and a human sentence for the
 * error message, because "your data leaked" needs to say WHICH pattern fired
 * or the reader has to guess what to do about it.
 */
const PATTERNS = [
	{
		id: "windows-user-profile",
		why: "a Windows user profile path (C:\\Users\\<you>\\...)",
		// Any drive letter + Users + a name, so a DIFFERENT machine's profile is
		// caught too, not just this one's.
		pattern: /[A-Za-z]:\\\\+Users\\\\+[A-Za-z0-9._-]+/gi
	},
	{
		id: "posix-home",
		why: "a home directory path (/home/<you>/...)",
		// `/root`, `/home/<name>`, `/Users/<name>` — the three shapes a macOS or
		// Linux home takes. The synthetic fixture's `/home/dev/...` is
		// deliberately excluded below.
		pattern: /(?:\/root\/|(?:\/home\/|\/Users\/)(?!dev\/)[A-Za-z0-9._-]+\/)/gi
	},
	{
		id: "drive-path-outside-examples",
		why: "a Windows drive path outside the synthetic examples",
		// A drive path is the shape that leaked. The synthetic examples the
		// repository uses are listed as allowed prefixes.
		pattern: /\b[A-Za-z]:\\(?!projects\\|WorkSpace\\SideJob\b)[^\s"'`,;)]{4,}/g,
		allowedPrefixes: ["D:\\projects\\"]
	},
	{
		id: "real-route-mix",
		why: "a mix of the author's real provider routes (the real session fold)",
		// A single route id is NOT a leak: the plugin's own model-name table
		// legitimately names `qoder`, `workbuddy` and friends, and the unit
		// tests use them as examples. What identifies the real fixture is the
		// BREADTH — a dozen distinct real channels appearing together, which
		// no hand-written example does.
		//
		// So this counts DISTINCT real routes in one file rather than matching
		// any of them.
		countRoutes: (text) => {
			const routes = new Set();
			for (const match of text.matchAll(/"([a-z0-9-]+)\//g)) routes.add(match[1]);
			const real = [...routes].filter((route) => REAL_ROUTES.has(route));
			return real.length >= 4 ? real : null;
		},
		sample: (routes) => routes.join(", ")
	},
	{
		id: "dsh-home-path",
		why: "the DSH home directory (the session store's own location)",
		pattern: /[A-Za-z]:\\\\+Users\\\\+[A-Za-z0-9._-]+\\\\\.dsh/gi
	}
];

/**
 * The real provider routes this account uses.
 *
 * They are the ones the session fold writes into the fixture. The synthetic
 * fixture invents its own (`example-cloud`, `demo-inference`, ...), so a file
 * carrying four or more of THESE is the real data, while the plugin's own
 * source and tests may mention one or two in passing.
 */
const REAL_ROUTES = new Set([
	"mota", "hejuapi", "trae", "zcode", "bailian", "bailian-tpp",
	"workbuddy-ai", "workbuddy-global", "our-free-model", "zai-coding-cn",
	"xfyun", "qoder", "qodercn", "workbuddy", "deepseek-official"
]);

/** Paths the repository legitimately contains. */
const ALLOWED = [
	// The synthetic fixture's invented workspaces.
	"/home/dev/",
	// The generic examples the docs use.
	"D:\\projects\\",
	// The plugin's own data directory (current name, plus the pre-rename one the
	// migration docs still mention).
	"dsh-token-board",
	"dsh-usage-dashboard"
];

/**
 * Files that are ALLOWED to contain the patterns.
 *
 * The guard names the very shapes it looks for, so it would otherwise flag
 * itself: its own documentation spells out `C:\Users\<you>\...` as an
 * example. A file is exempt only if it is part of the guard, not if it merely
 * mentions a path.
 */
const EXEMPT_FILES = new Set([
	"scripts/check-secrets.mjs",
	"scripts/install-hooks.mjs"
]);

/** Run git and return stdout, or an empty string when git fails. */
function git(...args) {
	const result = spawnSync("git", args, { cwd: packageRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) return "";
	return result.stdout ?? "";
}

/**
 * The paths to scan, and the bytes to scan for each.
 *
 * @returns `{ path, text }[]` — the content to inspect, already decoded.
 */
function collectTargets() {
	const argv = process.argv.slice(2);
	if (argv.includes("--paths")) {
		const start = argv.indexOf("--paths") + 1;
		return argv.slice(start).filter(Boolean).map((path) => ({ path, text: readText(join(packageRoot, path)) }));
	}
	if (argv.includes("--all")) {
		const files = git("ls-files").split("\n").filter(Boolean);
		return files.map((path) => ({ path, text: readText(join(packageRoot, path)) }));
	}
	// Default: the staged content. `--cached` with `--name-only` lists the
	// files, and each one is read from the INDEX rather than the working tree,
	// so an unstaged edit cannot smuggle content past the guard.
	const files = git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean);
	return files.map((path) => ({ path, text: readStaged(path) }));
}

/** Read a file from the working tree, tolerating binary and missing files. */
function readText(path) {
	if (!existsSync(path)) return "";
	const buffer = readFileSync(path);
	if (buffer.includes(0)) return ""; // binary: no text patterns to find
	return buffer.toString("utf8");
}

/**
 * Read a path's content AS IT IS STAGED.
 *
 * `git show :path` prints the index entry. A file that is staged as a
 * deletion prints nothing, and a file that is not staged at all is skipped by
 * the caller.
 */
function readStaged(path) {
	const result = spawnSync("git", ["show", `:${path}`], { cwd: packageRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) return "";
	const buffer = Buffer.from(result.stdout ?? "", "utf8");
	if (buffer.includes(0)) return "";
	return buffer.toString("utf8");
}

/** Every finding, as `{ path, id, why, sample }`. */
function scan(targets) {
	const findings = [];
	for (const { path, text } of targets) {
		if (text === "") continue;
		if (EXEMPT_FILES.has(path)) continue;
		for (const rule of PATTERNS) {
			// A rule that counts rather than matches.
			if (rule.countRoutes !== undefined) {
				const routes = rule.countRoutes(text);
				if (routes !== null) findings.push({ path, id: rule.id, why: rule.why, sample: rule.sample(routes) });
				continue;
			}
			const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
			let match;
			while ((match = regex.exec(text)) !== null) {
				const found = match[0];
				if (ALLOWED.some((allowed) => found.includes(allowed))) continue;
				if (rule.allowedPrefixes !== undefined && rule.allowedPrefixes.some((prefix) => found.startsWith(prefix))) continue;
				findings.push({ path, id: rule.id, why: rule.why, sample: found.slice(0, 80) });
				if (match.index === regex.lastIndex) regex.lastIndex += 1;
			}
		}
	}
	return findings;
}

const targets = collectTargets();
const findings = scan(targets);

if (findings.length === 0) {
	const scope = process.argv.includes("--all") ? "tracked files" : process.argv.includes("--paths") ? "given paths" : "staged content";
	console.log(`check-secrets: ${scope} clean (${targets.length} file(s) scanned)`);
	process.exit(0);
}

console.error("");
console.error("check-secrets: refusing to commit — real usage data detected.");
console.error("");
const seen = new Set();
for (const finding of findings) {
	const key = `${finding.path}|${finding.id}`;
	if (seen.has(key)) continue;
	seen.add(key);
	console.error(`  ${finding.path}`);
	console.error(`    ${finding.id}: ${finding.why}`);
	console.error(`    matched: ${finding.sample}`);
}
console.error("");
console.error("  The plugin folds the REAL session store into preview/payload.json");
console.error("  and preview/fixture.js. Regenerate the synthetic ones:");
console.error("");
console.error("    node preview/make-fixture-sample.mjs");
console.error("");
console.error("  If a path here is meant to be public, say so in scripts/check-secrets.mjs");
console.error("  (the ALLOWED list) instead of deleting the guard.");
console.error("");
process.exit(1);
