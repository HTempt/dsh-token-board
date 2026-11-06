/**
 * Smoke check for the single-source preview: load preview.html from the local
 * harness and assert the page actually rendered from ../lib/client.js.
 * Fails loudly if the bundle failed to load, if the preview entry is missing,
 * or if no dashboard root was mounted. Run with the harness up:
 *   node preview/server.mjs &
 *   node preview/verify-single-source.mjs
 */
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9451;
const URL_UNDER_TEST = "http://127.0.0.1:4599/preview.html?scene=loaded&locale=zh&tab=overview&theme=light";

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version() {
	for (let i = 0; i < 80; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (r.ok) return r.json();
		} catch {}
		await sleep(250);
	}
	throw new Error("no devtools");
}

const info = await version();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (e) => {
	const m = JSON.parse(e.data);
	if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.text ?? "exception");
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
		consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
	}
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function raw(method, params, sessionId) {
	seq += 1;
	const id = seq;
	ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	return new Promise((res, rej) => {
		pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
		setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
	});
}

let failed = false;
let browser;
try {
	const { sessionId } = await raw("Target.attachToTarget", { targetId: (await raw("Target.createTarget", { url: "about:blank" })).targetId, flatten: true });
	const send = (m, p) => raw(m, p, sessionId);
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });

	// Track which script URL actually carried the bundle.
	await send("Network.enable");
	const scriptUrls = [];
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.method === "Network.responseReceived" && m.params.type === "Script") scriptUrls.push(m.params.response.url);
	});

	await send("Page.navigate", { url: URL_UNDER_TEST });
	await sleep(3000);
	const state = await send("Runtime.evaluate", { expression: `(() => ({
		ready: window.__PREVIEW_READY__ === true,
		mountText: (document.getElementById('mount')?.textContent ?? '').slice(0, 120),
		hasRoot: document.querySelector('[data-dsh-token-board-view]') !== null,
		hasPage: document.querySelector('.udw_page') !== null,
		cells: document.querySelectorAll('.udw_cell').length
	}))()`, returnByValue: true });
	const v = state.result.value;

	console.log("bundle script loaded:", scriptUrls.filter((u) => u.endsWith("client.js")).join(", ") || "(none)");
	console.log("ready:", v.ready, "| root:", v.hasRoot, "| page:", v.hasPage, "| heat cells:", v.cells);
	console.log("mount text:", JSON.stringify(v.mountText));

	if (!v.ready) { console.log("FAIL: preview never reported ready"); failed = true; }
	else if (!v.hasRoot || !v.hasPage) { console.log("FAIL: dashboard did not mount"); failed = true; }
	else if (v.cells === 0) { console.log("FAIL: heat calendar rendered no cells"); failed = true; }
	else if (consoleErrors.length > 0) { console.log("FAIL: console errors:", consoleErrors.join(" | ")); failed = true; }
	else console.log("PASS: preview renders from the real bundle with no console errors");

	// Prove the served bundle is the repo's one source, not a leftover copy.
	const res = await fetch("http://127.0.0.1:4599/lib/client.js");
	const served = await res.text();
	const fs = await import("node:fs");
	const { createHash } = await import("node:crypto");
	const h = (s) => createHash("sha256").update(s).digest("hex");
	const onDisk = fs.readFileSync(new globalThis.URL("../lib/client.js", import.meta.url));
	console.log("served bundle sha256 === lib/client.js:", h(served) === h(onDisk));
	if (h(served) !== h(onDisk)) failed = true;
} catch (error) {
	console.log("FAIL:", error.message);
	failed = true;
} finally {
	browser = undefined;
	chrome.kill();
}

process.exit(failed ? 1 : 0);
