// Drive headless Chrome over the DevTools protocol (no extra packages; needs Node 22+ for WebSocket).
//   const page = await openPage(url, { width, height, dark, mobile })
//   await page.eval("1 + 1")            → 2 (awaits promises; returns JSON values)
//   await page.waitFor("document.querySelector('canvas')")
//   await page.screenshot("out.png", { full: true })
//   page.logs                           → console messages and errors seen so far
//   await page.close()
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openPage(url, { width = 1280, height = 900, dark = false, mobile = width < 600 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    chrome.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error("Chrome didn't start")), 15000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled") logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (msg.method === "Runtime.exceptionThrown") logs.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    if (msg.method === "Log.entryAdded") logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Log.enable");
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });

  const page = {
    logs,
    async goto(u) {
      await s("Page.navigate", { url: u });
      await page.waitFor("document.readyState === 'complete'");
    },
    async eval(expression) {
      const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (await page.eval(`(() => { try { return !!(${expression}); } catch { return false; } })()`)) return true;
        await sleep(150);
      }
      return false;
    },
    // full: the whole page; selector: crop to one element (plus `pad` pixels around it).
    async screenshot(out, { full = false, selector = null, pad = 0 } = {}) {
      let clip;
      if (full) clip = { x: 0, y: 0, width, height: await page.eval("document.documentElement.scrollHeight"), scale: 1 };
      if (selector) {
        const r = await page.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
        clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + 2 * pad, height: r.h + 2 * pad, scale: 1 };
      }
      const { data } = await s("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      writeFileSync(out, Buffer.from(data, "base64"));
    },
    async close() {
      ws.close();
      chrome.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    },
  };
  await page.goto(url);
  return page;
}
