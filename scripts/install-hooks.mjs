/**
 * Install the pre-commit guard into this repository's `.git/hooks/`.
 *
 * The hook is what makes the guard automatic: `scripts/check-secrets.mjs` can
 * only help if it runs before every commit. Git does not version `.git/hooks`,
 * so the hook is installed by this script rather than committed — and
 * `scripts/install-hooks.mjs` is documented in the README so a fresh clone
 * can be protected in one command.
 *
 * The hook is a thin shim: it calls the same script the developer can run by
 * hand, so there is exactly one implementation of the rules.
 *
 *   node scripts/install-hooks.mjs           # install
 *   node scripts/install-hooks.mjs --check   # report whether it is installed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hooksDir = join(packageRoot, ".git", "hooks");
const hookPath = join(hooksDir, "pre-commit");

/**
 * The hook body.
 *
 * It resolves the repository root from the hook's own location rather than
 * the current directory, so it works when git invokes it from a subdirectory.
 * `DSH_SKIP_SECRET_GUARD=1` skips it deliberately — for a one-off commit the
 * developer has inspected and accepted.
 */
const HOOK = `#!/bin/sh
# dsh-token-board: refuse to commit the author's real usage data.
#
# Installed by scripts/install-hooks.mjs. The rules live in
# scripts/check-secrets.mjs; this shim only runs them.
#
# Set DSH_SKIP_SECRET_GUARD=1 to bypass deliberately.
if [ "$DSH_SKIP_SECRET_GUARD" = "1" ]; then
  echo "check-secrets: skipped (DSH_SKIP_SECRET_GUARD=1)"
  exit 0
fi
repo_root=$(git rev-parse --show-toplevel)
exec node "$repo_root/scripts/check-secrets.mjs"
`;

if (process.argv.includes("--check")) {
	if (!existsSync(hookPath)) {
		console.log("pre-commit hook: NOT installed");
		process.exit(1);
	}
	const current = readFileSync(hookPath, "utf8");
	if (current !== HOOK) {
		console.log("pre-commit hook: installed, but its content differs from this repo's version");
		process.exit(1);
	}
	console.log("pre-commit hook: installed and current");
	process.exit(0);
}

if (!existsSync(hooksDir)) {
	console.error(`no .git/hooks directory at ${hooksDir}`);
	console.error("This script installs into a git working tree; it cannot set up a bare clone.");
	process.exit(1);
}

writeFileSync(hookPath, HOOK, "utf8");
// Windows does not honour the executable bit, and git for Windows ships a
// shim that runs hooks through the shell anyway, so the mode is best-effort.
try {
	const { chmodSync } = await import("node:fs");
	chmodSync(hookPath, 0o755);
} catch {
	// A filesystem without POSIX modes (Windows) is fine: git for Windows
	// runs the hook through sh regardless of the mode.
}

console.log(`pre-commit hook installed: ${hookPath}`);
console.log("");
console.log("  It now blocks a commit that would publish real usage data.");
console.log("  Run the same check by hand:  node scripts/check-secrets.mjs");
console.log("  Scan everything tracked:     node scripts/check-secrets.mjs --all");
console.log("  Bypass once, on purpose:     DSH_SKIP_SECRET_GUARD=1 git commit ...");
