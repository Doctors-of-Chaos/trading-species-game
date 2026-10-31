// 自动试玩并截图：node tools/playtest.mjs <html> <outdir> <width> <height> <prefix> <story|blind>
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const [FILE, OUT, Ws, Hs, PRE, MODE] = process.argv.slice(2);
const W = Number(Ws), H = Number(Hs);
const PICKS = (process.env.PICKS || "0,1,0,3,0,3").split(",").map(Number); // 新手模式每关选第几张卡（0-3）
mkdirSync(OUT, { recursive: true });
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 300);
const chrome = spawn(CH, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--disable-gpu",
  `--user-data-dir=/tmp/tsp_shots_prof_${PORT}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
await send("Page.navigate", { url: "file://" + FILE });
await sleep(1600);

let n = 0; const hs = [];
const shot = async (name, full) => {
  if (await ev("document.documentElement.scrollWidth > window.innerWidth + 1")) hs.push(name);
  const p = { format: "jpeg", quality: 72 };
  if (full) { const h = await ev("document.documentElement.scrollHeight"); Object.assign(p, { clip: { x: 0, y: 0, width: W, height: Math.min(h, 3200), scale: 1 }, captureBeyondViewport: true }); }
  const r = await send("Page.captureScreenshot", p);
  n += 1; writeFileSync(`${OUT}/${PRE}_${String(n).padStart(2, "0")}_${name}.jpg`, Buffer.from(r.result.data, "base64"));
};
async function click(sel) {
  const pt = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  if (!pt) throw new Error("missing " + sel);
  await sleep(200);
  const p2 = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p2.x, y: p2.y, button: "left", clickCount: 1 });
  await sleep(150);
}
const top = async () => { await ev("window.scrollTo(0,0)"); await sleep(250); };

try {
  await shot("首页");
  if (MODE === "story") {
    await click("#start-story");
    for (let r = 0; r < 6; r++) {
      await sleep(1100); await top();
      if (r === 0 || r === 2 || r === 5) await shot(`第${r + 1}关_场景`);
      await click(`.cards .card:nth-child(${PICKS[r] + 1})`);
      if (r === 0) { await sleep(400); await shot("第1关_选中"); }
      await click(".side .confirm .btn");
      if (r === 0) { await sleep(1000); await shot("第1关_倒带中"); }
      await sleep(r === 0 ? 2900 : 3900);
      if (r === 0 || r === 2) await shot(`第${r + 1}关_揭晓`);
      await click(".rv .nextrow .btn");
    }
    await sleep(1500); await top();
    await shot("结算页_整页", true);
    console.log(PRE, "result:", await ev(`JSON.stringify({ species: document.querySelector(".tc h2")?.textContent, axes: document.querySelector(".tc .eyebrow")?.textContent, rarity: document.querySelector(".rar")?.textContent, ending: document.querySelector(".ending")?.textContent, bag: document.querySelector(".bagline b")?.textContent, conf: [...document.querySelectorAll(".confrow")].map(r => r.innerText.replace(/\\s+/g, " ")), followUp: !!document.querySelector(".follow .btn"), why: document.querySelector("#recpack .why")?.textContent, recs: [...document.querySelectorAll("#recpack .rcard b")].map(b => b.textContent) })`));
  } else {
    await click("#start-blind");
    await sleep(900); await top();
    await click(".meters .meter:nth-child(3)"); await click(".metas .mc:nth-child(3)");
    await sleep(300); await top(); await shot("盲盒_作答");
    await click(".q3 .confirm .btn");
    await sleep(4300); await top(); await shot("盲盒_揭晓");
  }
} catch (e) { console.log("FAIL", e.message); }
console.log(PRE, "shots:", n, "| h-scroll:", hs.length ? hs : "none", "| errors:", errors.length ? errors : "none");
ws.close(); chrome.kill(); process.exit(0);
