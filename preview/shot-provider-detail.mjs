// One-off screenshot + layout probe for the provider detail (style polish).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=9467", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = await (async () => {
	for (let i = 0; i < 60; i++) {
		try { const r = await fetch("http://127.0.0.1:9467/json/version"); if (r.ok) return r.json(); } catch {}
		await sleep(250);
	}
	throw new Error("no devtools");
})();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const raw = (method, params = {}, sessionId) => new Promise((res, rej) => { seq += 1; const id = seq; ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); pending.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 20000); });
const { sessionId } = await raw("Target.attachToTarget", { targetId: (await raw("Target.createTarget", { url: "about:blank" })).targetId, flatten: true });
const send = (m, p) => raw(m, p, sessionId);
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:4599/preview.html?scene=loaded&locale=zh&tab=dist&theme=light&v=8" });
await sleep(3000);
const CLICK = "document.querySelectorAll('.udw_distSection')[0].querySelector('.udw_wsRow[data-expandable=true] button.udw_wsMain').click()";
await send("Runtime.evaluate", { expression: CLICK });
await sleep(500);
const probe = await send("Runtime.evaluate", {
	returnByValue: true,
	expression: `
(() => {
	const card = document.querySelectorAll('.udw_distSection')[0];
	const row = card.querySelector('.udw_wsRow[data-open=true]');
	const track = row.querySelector('.udw_wsTrack').getBoundingClientRect();
	const rowRect = row.getBoundingClientRect();
	const header = row.querySelector('.udw_wsMain').getBoundingClientRect();
	const grid = row.querySelector('.udw_modelList');
	const name = grid.querySelector('.udw_modelName');
	const detail = grid.querySelector('.udw_modelDetail');
	return {
		trackAtHeaderFoot: Math.abs(track.bottom - header.bottom) < 6,
		trackNotAtRowFoot: rowRect.bottom - track.bottom > 20,
		gridIndent: Math.round(grid.getBoundingClientRect().left - rowRect.left),
		nameFont: getComputedStyle(name).fontSize,
		nameWeight: getComputedStyle(name).fontWeight,
		overflow: detail.getBoundingClientRect().right > rowRect.right - 8
	};
})()`
});
console.log("layout:", JSON.stringify(probe.result.value));
await send("Page.bringToFront", {});
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(new URL("./provider-detail-open.png", import.meta.url), Buffer.from(shot.data, "base64"));
console.log("saved");
chrome.kill();
process.exit(0);
