/**
 * Resolve the harness packages these scripts import.
 *
 * These scripts live in the plugin's own directory, so a bare
 * `import "@deepseek-ai/cordis"` would resolve against THIS directory and fail:
 * the harness packages are installed elsewhere. The script therefore imports
 * them by absolute file URL, searching the same places the host does, in order:
 *
 *   1. the web profile's `node_modules` (`DSH_WEB_PROFILE`, default
 *      `<DSH_HOME>/profiles/web`),
 *   2. the global `dsh` CLI installation's `node_modules`, which is where a
 *      global install keeps the harness packages.
 *
 * @module dsh-usage-dashboard/scripts/harness
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `<DSH_HOME>`, defaulting to `~/.dsh`. */
export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** The profile whose `node_modules` may hold the harness packages. */
export function profileRoot() {
	return process.env.DSH_WEB_PROFILE ?? join(dshHome(), "profiles", "web");
}

/**
 * The directories that may hold the harness packages, most specific first.
 *
 * A global `npm` install puts the CLI at `<global>/node_modules/@deepseek-ai/dsh`
 * and hoists the harness packages either beside it (`<global>/node_modules`) or
 * inside the CLI's own tree (`<global>/node_modules/@deepseek-ai/dsh/node_modules`)
 * — both are checked, because which one applies depends on how npm resolved the
 * dedupe. The CLI's own location is discovered from the `dsh` launcher on `PATH`
 * rather than guessed, and `DSH_CLI_ROOT` overrides it.
 */
export function moduleRoots() {
	const roots = [join(profileRoot(), "node_modules")];
	const cli = typeof process.env.DSH_CLI_ROOT === "string" && process.env.DSH_CLI_ROOT !== ""
		? process.env.DSH_CLI_ROOT
		: findCliRoot();
	if (cli !== null) {
		roots.push(join(cli, "node_modules"));
		roots.push(join(cli, "node_modules", "@deepseek-ai", "dsh", "node_modules"));
	}
	return roots.filter((root, index) => roots.indexOf(root) === index);
}

/**
 * Locate the globally installed `dsh` CLI from its launcher on `PATH`.
 * @returns the install root (the directory holding `node_modules`), or null.
 */
function findCliRoot() {
	const separator = process.platform === "win32" ? ";" : ":";
	for (const entry of (process.env.PATH ?? "").split(separator)) {
		if (entry === "" || !existsSync(entry)) continue;
		// The launcher is `dsh`, `dsh.cmd`, or `dsh.ps1` depending on the shell.
		const launcher = ["dsh", "dsh.cmd", "dsh.ps1"]
			.map((name) => join(entry, name))
			.find((path) => existsSync(path));
		if (launcher === undefined) continue;
		// A launcher beside a `node_modules` IS the global install root; one inside
		// `<root>/bin` puts the packages one level up.
		for (const root of [entry, join(entry, "..")]) {
			if (existsSync(join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"))) return root;
		}
	}
	return null;
}

/**
 * Import one package from the first root that has it.
 * @param name - package name, e.g. `@deepseek-ai/cordis`.
 * @returns the package's module namespace.
 */
export async function harness(name) {
	for (const root of moduleRoots()) {
		const dir = join(root, name);
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		// Prefer the declared entry point; fall back to the usual module slot.
		const entry = typeof parsed.module === "string"
			? parsed.module
			: (typeof parsed.main === "string" ? parsed.main : "index.js");
		return import(pathToFileURL(join(dir, entry)).href);
	}
	throw new Error(`${name} is not installed in any of: ${moduleRoots().join(", ")}`);
}
