/**
 * Smoke check for the provider-detail expansion in the distribution tab.
 *
 * Opens the preview with fixture data, clicks the first provider row, and
 * asserts the expanded body lists the provider's models token-descending.
 * Run with the preview server up:
 *   node preview/server.mjs &
 *   node preview/verify-provider-detail.mjs
 */
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9452;
const URL_UNDER_TEST = "http://127.0.0.1:4599/preview.html?scene=loaded&locale=zh&tab=dist&theme=light";

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
try {
	const { sessionId } = await raw("Target.attachToTarget", { targetId: (await raw("Target.createTarget", { url: "about:blank" })).targetId, flatten: true });
	const send = (m, p) => raw(m, p, sessionId);
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url: URL_UNDER_TEST });
	await sleep(3000);

	// 1. Provider rows exist and are marked expandable.
	const probe = await send("Runtime.evaluate", { expression: `(() => {
		const providerSection = document.querySelectorAll('.udw_distSection')[0];
		const rows = [...providerSection.querySelectorAll('.udw_wsRow[data-expandable="true"]')];
		return {
			sections: document.querySelectorAll('.udw_distSection').length,
			providerRows: rows.length,
			firstName: rows[0]?.querySelector('.udw_wsName')?.textContent ?? null,
			hint: providerSection.querySelector('.udw_cardHint')?.textContent ?? null
		};
	})()`, returnByValue: true });
	const p = probe.result.value;
	console.log("sections:", p.sections, "| expandable provider rows:", p.providerRows, "| first:", JSON.stringify(p.firstName));
	console.log("hint:", JSON.stringify(p.hint));
	if (p.providerRows === 0) { console.log("FAIL: no expandable provider rows"); failed = true; }

	// 2. Click the first provider row and check the expansion.
	if (!failed) {
		await send("Runtime.evaluate", { expression: `document.querySelectorAll('.udw_distSection')[0].querySelector('.udw_wsRow[data-expandable="true"] button.udw_wsMain').click()` });
		await sleep(400);
		const open = await send("Runtime.evaluate", { expression: `(() => {
			const providerSection = document.querySelectorAll('.udw_distSection')[0];
			const detail = providerSection.querySelector('.udw_modelList');
			if (detail === null) return { open: false };
			const names = [...detail.querySelectorAll(':scope > .udw_modelName')].map((el) => el.textContent);
			const modelRows = [...detail.querySelectorAll(':scope > .udw_modelDetail')].map((el, i) => {
				const tokens = el.querySelector('.udw_modelTokens')?.textContent ?? "";
				return { name: names[i] ?? "?", tokens };
			});
			return {
				open: true,
				facts: providerSection.querySelectorAll('.udw_wsDetail .udw_wsFact, .udw_wsToolsHead').length,
				modelRows,
				barWidths: [...detail.querySelectorAll('.udw_modelFill')].map((el) => el.style.width)
			};
		})()`, returnByValue: true });
		const o = open.result.value;
		console.log("expanded:", o.open);
		console.log("stray heads/facts:", o.facts);
		console.log("models:", JSON.stringify(o.modelRows));
		console.log("bar widths:", JSON.stringify(o.barWidths));
		if (!o.open) { console.log("FAIL: provider detail did not open"); failed = true; }
		else {
			if (o.facts !== 0) { console.log("FAIL: summary facts or section head still rendered"); failed = true; }
			if (o.modelRows.length === 0) { console.log("FAIL: no model rows in the detail"); failed = true; }
			if (o.barWidths.length >= 2) {
				// The bars encode the token order: widths must be non-increasing.
				const widths = o.barWidths.map((w) => parseFloat(w));
				const descending = widths.every((w, i) => i === 0 || w <= widths[i - 1] + 0.01);
				console.log("token-descending by bar width:", descending);
				if (!descending) { console.log("FAIL: model bars are not token-descending"); failed = true; }
			}
		}

		// 3. Click again to collapse.
		if (!failed) {
			await send("Runtime.evaluate", { expression: `document.querySelectorAll('.udw_distSection')[0].querySelector('.udw_wsRow[data-expandable="true"] button.udw_wsMain').click()` });
			await sleep(300);
			const after = await send("Runtime.evaluate", { expression: `document.querySelectorAll('.udw_distSection')[0].querySelectorAll('.udw_modelList').length`, returnByValue: true });
			console.log("detail bodies after collapse:", after.result.value);
			if (after.result.value !== 0) { console.log("FAIL: detail did not collapse"); failed = true; }
		}
	}

	// Screenshot for the report: reopen the first provider for the picture.
	await send("Runtime.evaluate", { expression: `document.querySelectorAll('.udw_distSection')[0].querySelector('.udw_wsRow[data-expandable="true"] button.udw_wsMain').click()` });
	await sleep(400);
	await send("Page.bringToFront", {});
	const shot = await send("Page.captureScreenshot", { format: "png" });
	if (shot.result?.data) {
		const fs = await import("node:fs");
		fs.writeFileSync(new globalThis.URL("./provider-detail-open.png", import.meta.url), Buffer.from(shot.result.data, "base64"));
		console.log("screenshot: preview/provider-detail-open.png");
	}
	if (consoleErrors.length > 0) { console.log("FAIL: console errors:", consoleErrors.join(" | ")); failed = true; }
} catch (error) {
	console.log("FAIL:", error.message);
	failed = true;
} finally {
	chrome.kill();
}
process.exit(failed ? 1 : 0);
