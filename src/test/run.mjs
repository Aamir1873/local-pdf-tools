// End-to-end tests for Local PDF Tools: npm test
// Opens the built file from disk in headless Chrome (the way people use it), drives every tool,
// and checks each downloaded file with pdf-lib and unzip. Writes TEST-REPORT.md next to this file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import { openPage } from "../../lib/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..", "..");
const PRODUCTS = KIT;
const require = createRequire(join(PRODUCTS, "package.json"));
const { PDFDocument, StandardFonts } = require("pdf-lib");
const APP = join(KIT, "release", "files", "Local PDF Tools.html");
const URL_ = "file://" + APP.split("/").map(encodeURIComponent).join("/");
const tmp = mkdtempSync(join(tmpdir(), "lpt-test-"));

// ---------- Fixtures
async function pdf(widths, label = "") {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => d.addPage([w, 500]).drawText(`${label}${i + 1}`, { x: 20, y: 250, size: 40, font: f }));
  return Buffer.from(await d.save()).toString("base64");
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const FX = {
  A: await pdf([301, 302, 303], "A"),
  B: await pdf([401, 402], "B"),
  SEVEN: await pdf(range(101, 107), "P"),
  BIG: await pdf(Array(150).fill(300), "Big"),
  REAL1: readFileSync(join(HERE, "fixtures", "real-guide.pdf")).toString("base64"),
  REAL2: readFileSync(join(HERE, "fixtures", "real-app.pdf")).toString("base64"),
  SECRET: readFileSync(join(HERE, "fixtures", "password-protected.pdf")).toString("base64"),
  DAMAGED: Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\nthis is not a real pdf\n").toString("base64"),
  TEXT: Buffer.from("just some notes").toString("base64"),
};
const realPages = async (b64) => (await PDFDocument.load(Buffer.from(b64, "base64"))).getPageCount();

// ---------- Page helpers
const HELPERS = `(() => {
  window.__T = { dl: [] };
  const blobs = new Map();
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = create(b); blobs.set(u, b); return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) { __T.dl.push({ name: this.download, blob: blobs.get(this.href) }); return; }
    return click.call(this);
  };
  __T.file = (b64, name, type = "application/pdf") => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name, { type }); };
  __T.load = (kind, files) => { const inp = document.querySelector('[data-input="' + kind + '"]'); const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); inp.files = dt.files; inp.dispatchEvent(new Event("change")); return true; };
  __T.last = async () => { const d = __T.dl[__T.dl.length - 1]; const b = new Uint8Array(await d.blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return { name: d.name, type: d.blob.type, b64: btoa(s) }; };
  __T.status = () => document.querySelector("#status").textContent;
  __T.image = async (type, w, h, color, exifOrientation) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = "#000"; x.fillRect(0, 0, w / 4, h / 4);
    let bytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, type, 0.9))).arrayBuffer());
    if (exifOrientation) {
      const tiff = [0x4d,0x4d,0,0x2a,0,0,0,8, 0,1, 0x01,0x12, 0,3, 0,0,0,1, 0,exifOrientation,0,0, 0,0,0,0];
      const payload = [0x45,0x78,0x69,0x66,0,0, ...tiff];
      const len = payload.length + 2;
      const app1 = [0xff, 0xe1, len >> 8, len & 255, ...payload];
      bytes = new Uint8Array([...bytes.subarray(0, 2), ...app1, ...bytes.subarray(2)]);
    }
    return new File([bytes], "photo-" + w + "x" + h + "." + type.split("/")[1], { type });
  };
  return true;
})()`;

const page = await openPage(URL_, { width: 1280, height: 900 });
async function reset() {
  await page.goto(URL_);
  await page.eval(HELPERS);
}
const ev = (js) => page.eval(js);
const until = async (js, msg, timeout) => assert.ok(await page.waitFor(js, timeout), `Timed out waiting for: ${msg || js}`);
async function clickDownload(js) {
  const before = await ev("__T.dl.length");
  await ev(js);
  return nextDownload(before);
}
async function nextDownload(before) {
  await until(`__T.dl.length > ${before}`, "a download");
  const d = await ev("__T.last()");
  return { ...d, bytes: Buffer.from(d.b64, "base64") };
}
const pages = async (bytes) => PDFDocument.load(bytes, { updateMetadata: false });
const widths = async (bytes) => (await pages(bytes)).getPages().map((p) => Math.round(p.getWidth()));
const idle = () => until(`!document.body.hasAttribute("aria-busy") && !/^(Reading|Merging|Splitting|Making|Adding|Saving)/.test(__T.status())`, "the tool to finish");

const results = [];
async function test(group, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ group, name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${group}: ${name}`);
  } catch (e) {
    results.push({ group, name, ok: false, ms: Date.now() - t0, error: e.message.split("\n")[0] });
    console.log(`  ✗ ${group}: ${name}\n      ${e.message.split("\n")[0]}`);
  }
}

// ---------- Core helpers (Node, no browser)
const sandbox = { TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer };
vm.runInNewContext(readFileSync(join(KIT, "src", "app", "core.js"), "utf8"), sandbox);
const L = sandbox.LPT;
await test("Core", "page ranges: 1-3, 5, 8-", () => assert.deepEqual(JSON.parse(JSON.stringify(L.parseRanges("1-3, 5, 8-", 10))), [[1, 3], [5, 5], [8, 10]]));
await test("Core", "page ranges: -2, last, 3 to 1, en dash", () => assert.deepEqual(JSON.parse(JSON.stringify(L.parseRanges("-2; last, 3 to 1, 2–3", 4))), [[1, 2], [4, 4], [3, 1], [2, 3]]));
await test("Core", "page ranges: clear errors for 0, too high, text, empty", () => {
  assert.throws(() => L.parseRanges("0", 4), /Page 0 doesn't exist/);
  assert.throws(() => L.parseRanges("9", 4), /This file has 4 pages/);
  assert.throws(() => L.parseRanges("abc", 4), /isn't a page or range/);
  assert.throws(() => L.parseRanges(" , ", 4), /Type the pages/);
});
await test("Core", "pages to text: [0,1,2,4,6,7] → 1-3, 5, 7-8", () => assert.equal(L.indicesToText([0, 1, 2, 4, 6, 7]), "1-3, 5, 7-8"));
await test("Core", "CRC-32 matches the standard check value", () => assert.equal(L.crc32(new TextEncoder().encode("123456789")).toString(16), "cbf43926"));
await test("Core", "file names can't contain path characters", () => assert.equal(L.cleanName("../a/b:c?.pdf", "x"), ".. a b c .pdf"));
await test("Core", "ZIP files open with unzip", () => {
  const zip = L.makeZip([{ name: "one.pdf", bytes: new Uint8Array([1, 2, 3]) }, { name: "two.pdf", bytes: new Uint8Array(5000).fill(9) }]);
  writeFileSync(join(tmp, "core.zip"), zip);
  const out = execFileSync("unzip", ["-t", join(tmp, "core.zip")]).toString();
  assert.match(out, /No errors detected/);
});

// ---------- Page basics
await reset();
await test("Page", "opens from a file with no errors", async () => {
  assert.equal(await ev("document.title"), "Local PDF Tools");
  const errors = page.logs.filter((l) => /^(error|exception)/.test(l) && !/favicon/.test(l));
  assert.deepEqual(errors, []);
});
await test("Page", "blocks every network request (Content Security Policy)", async () => {
  const r = await ev(`fetch("https://example.com/upload", { method: "POST", body: "x" }).then(() => "sent", () => "blocked")`);
  assert.equal(r, "blocked");
  const img = await ev(`new Promise((res) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => res("blocked"); i.src = "https://example.com/pixel.png"; })`);
  assert.equal(img, "blocked");
});
await test("Page", "tabs switch with clicks and arrow keys", async () => {
  await ev(`document.querySelector("#tab-split").click()`);
  assert.equal(await ev(`document.querySelector("#panel-split").hidden`), false);
  await ev(`document.querySelector("#tab-split").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))`);
  assert.equal(await ev(`document.activeElement.id`), "tab-pages");
  assert.equal(await ev(`document.querySelector("#panel-pages").hidden`), false);
  assert.equal(await ev(`document.querySelector("#panel-split").hidden`), true);
});
await test("Page", "every button has a name and every image has alt text", async () => {
  const unnamed = await ev(`[...document.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.textContent.trim())).length`);
  assert.equal(unnamed, 0);
  assert.equal(await ev(`[...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length`), 0);
});

// ---------- Merge
await reset();
await test("Merge", "two PDFs, reordered, merged in the chosen order", async () => {
  await ev(`__T.load("merge", [__T.file("${FX.A}", "A.pdf"), __T.file("${FX.B}", "B.pdf")])`);
  await until(`document.querySelectorAll("#merge-list .file").length === 2`);
  await ev(`document.querySelectorAll("#merge-list .file")[1].querySelector(".ctl button").click()`);
  assert.deepEqual(await ev(`[...document.querySelectorAll("#merge-list .file b")].map((b) => b.textContent)`), ["B.pdf", "A.pdf"]);
  const d = await clickDownload(`document.querySelector("#merge-name").value = "Combined"; document.querySelector("#merge-go").click()`);
  assert.equal(d.name, "Combined.pdf");
  assert.deepEqual(await widths(d.bytes), [401, 402, 301, 302, 303]);
  assert.equal((await pages(d.bytes)).getProducer(), "Local PDF Tools");
  await idle();
  assert.match(await ev("__T.status()"), /^Done: Combined.pdf \(5 pages/);
});
await test("Merge", "real documents with embedded fonts", async () => {
  await ev(`document.querySelector("#merge-clear").click()`);
  await ev(`__T.load("merge", [__T.file("${FX.REAL1}", "checklist.pdf"), __T.file("${FX.REAL2}", "ai.pdf"), __T.file("${FX.A}", "A.pdf")])`);
  await until(`document.querySelectorAll("#merge-list .file").length === 3`);
  const d = await clickDownload(`document.querySelector("#merge-go").click()`);
  assert.equal((await pages(d.bytes)).getPageCount(), (await realPages(FX.REAL1)) + (await realPages(FX.REAL2)) + 3);
  writeFileSync(join(tmp, "real-merged.pdf"), d.bytes);
  execFileSync("pdftoppm", ["-png", "-r", "20", "-f", "1", "-l", "1", join(tmp, "real-merged.pdf"), join(tmp, "real-merged")]);
});
await test("Merge", "remove a file, then Merge needs two files", async () => {
  await ev(`document.querySelectorAll("#merge-list .file")[2].querySelector(".del").click()`);
  await ev(`document.querySelectorAll("#merge-list .file")[1].querySelector(".del").click()`);
  assert.equal(await ev(`document.querySelectorAll("#merge-list .file").length`), 1);
  assert.equal(await ev(`document.querySelector("#merge-go").disabled`), true);
  assert.match(await ev("__T.status()"), /at least one more PDF/);
});
await test("Merge", "refuses a non-PDF file with a clear message", async () => {
  await ev(`__T.load("merge", [__T.file("${FX.TEXT}", "notes.txt", "text/plain")])`);
  await until(`/notes.txt isn't a PDF/.test(__T.status())`, "the not-a-PDF message");
  assert.equal(await ev(`document.querySelectorAll("#merge-list .file").length`), 1);
});
await test("Merge", "refuses a damaged PDF with a clear message", async () => {
  await ev(`__T.load("merge", [__T.file("${FX.DAMAGED}", "broken.pdf")])`);
  await until(`/broken.pdf couldn't be read/.test(__T.status())`, "the damaged-file message");
});
await test("Merge", "refuses a password-protected PDF and says why", async () => {
  await ev(`__T.load("merge", [__T.file("${FX.SECRET}", "locked.pdf")])`);
  await until(`/locked.pdf is password-protected/.test(__T.status())`, "the password message");
  assert.equal(await ev(`document.querySelectorAll("#merge-list .file").length`), 1);
});
await test("Merge", "unsafe output names are cleaned", async () => {
  await ev(`__T.load("merge", [__T.file("${FX.B}", "B.pdf")])`);
  await until(`document.querySelectorAll("#merge-list .file").length === 2`);
  const d = await clickDownload(`document.querySelector("#merge-name").value = "../../evil:name"; document.querySelector("#merge-go").click()`);
  assert.ok(!/[\\/:]/.test(d.name), d.name);
  assert.match(d.name, /\.pdf$/);
});
await test("Merge", "150-page file merges in under 10 seconds", async () => {
  await ev(`document.querySelector("#merge-clear").click()`);
  await ev(`__T.load("merge", [__T.file("${FX.BIG}", "big.pdf"), __T.file("${FX.BIG}", "big2.pdf")])`);
  await until(`document.querySelectorAll("#merge-list .file").length === 2`);
  const n = await ev("__T.dl.length");
  const t0 = Date.now();
  const d = await clickDownload(`document.querySelector("#merge-go").click()`);
  assert.equal((await pages(d.bytes)).getPageCount(), 300);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
});

// ---------- Split
await reset();
const openSplit = async (b64, name) => {
  await ev(`document.querySelector("#tab-split").click(); __T.load("split", [__T.file("${b64}", "${name}")])`);
  await until(`!document.querySelector("#split-work").hidden && document.querySelectorAll("#split-thumbs .thumb").length > 0`, "the split file to open");
};
const setMode = (m) => ev(`(() => { const r = document.querySelector('input[name="split-mode"][value="${m}"]'); r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const setRanges = (t) => ev(`(() => { const i = document.querySelector("#split-ranges"); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input")); })()`);
await test("Split", "keep pages typed as 2-3, 6", async () => {
  await openSplit(FX.SEVEN, "Seven.pdf");
  await setRanges("2-3, 6");
  assert.equal(await ev(`document.querySelector("#split-summary").textContent`), "New PDF with 3 pages.");
  const d = await clickDownload(`document.querySelector("#split-go").click()`);
  assert.equal(d.name, "Seven (pages 2-3,6).pdf");
  assert.deepEqual(await widths(d.bytes), [102, 103, 106]);
});
await test("Split", "keep pages picked by clicking previews", async () => {
  await setRanges("");
  await ev(`[0, 4, 6].forEach((i) => document.querySelectorAll("#split-thumbs .thumb")[i].click())`);
  assert.equal(await ev(`document.querySelector("#split-ranges").value`), "1, 5, 7");
  assert.equal(await ev(`document.querySelectorAll('#split-thumbs [aria-pressed="true"]').length`), 3);
  const d = await clickDownload(`document.querySelector("#split-go").click()`);
  assert.deepEqual(await widths(d.bytes), [101, 105, 107]);
});
await test("Split", "a backwards range reverses the pages", async () => {
  await setRanges("5-3");
  const d = await clickDownload(`document.querySelector("#split-go").click()`);
  assert.deepEqual(await widths(d.bytes), [105, 104, 103]);
});
await test("Split", "a page that doesn't exist disables the button and explains", async () => {
  await setRanges("2, 9");
  assert.equal(await ev(`document.querySelector("#split-go").disabled`), true);
  assert.match(await ev(`document.querySelector("#split-summary").textContent`), /Page 9 doesn't exist. This file has 7 pages/);
});
const zipEntries = async (d) => {
  const file = join(tmp, d.name);
  writeFileSync(file, d.bytes);
  assert.match(execFileSync("unzip", ["-t", file]).toString(), /No errors detected/);
  const names = execFileSync("unzip", ["-Z1", file]).toString().trim().split("\n");
  const out = [];
  for (const n of names) out.push({ name: n, widths: await widths(execFileSync("unzip", ["-p", file, n], { maxBuffer: 1e8 })) });
  return out;
};
await test("Split", "every page separately → ZIP with 7 one-page PDFs", async () => {
  await setMode("each");
  assert.equal(await ev(`document.querySelector("#split-summary").textContent`), "7 files: pages 1 · 2 · 3 · 4 · 5 · 6 · 7.");
  const d = await clickDownload(`document.querySelector("#split-go").click()`);
  assert.equal(d.name, "Seven (split).zip");
  const e = await zipEntries(d);
  assert.equal(e.length, 7);
  assert.equal(e[0].name, "Seven - page 1.pdf");
  assert.deepEqual(e.map((x) => x.widths[0]), range(101, 107));
});
await test("Split", "every 3 pages → 1-3, 4-6, 7", async () => {
  await setMode("every");
  await ev(`(() => { const n = document.querySelector("#split-n"); n.value = "3"; n.dispatchEvent(new Event("input")); })()`);
  const e = await zipEntries(await clickDownload(`document.querySelector("#split-go").click()`));
  assert.deepEqual(e.map((x) => x.widths), [[101, 102, 103], [104, 105, 106], [107]]);
  assert.deepEqual(e.map((x) => x.name), ["Seven - pages 1-3.pdf", "Seven - pages 4-6.pdf", "Seven - page 7.pdf"]);
});
await test("Split", "my own parts: 1-2, 3-7", async () => {
  await setMode("groups");
  await setRanges("1-2, 3-7");
  const e = await zipEntries(await clickDownload(`document.querySelector("#split-go").click()`));
  assert.deepEqual(e.map((x) => x.widths.length), [2, 5]);
});
await test("Split", "one part only gives a PDF, not a ZIP", async () => {
  await setMode("every");
  await ev(`(() => { const n = document.querySelector("#split-n"); n.value = "10"; n.dispatchEvent(new Event("input")); })()`);
  const d = await clickDownload(`document.querySelector("#split-go").click()`);
  assert.match(d.name, /\.pdf$/);
  assert.equal((await pages(d.bytes)).getPageCount(), 7);
});
await test("Split", "page previews are drawn (opened from a file)", async () => {
  await ev(`document.querySelector("#split-thumbs").scrollIntoView()`);
  await until(`document.querySelectorAll("#split-thumbs canvas").length === 7`, "7 previews", 15000);
});
await test("Split", "choose another file resets the tool", async () => {
  await ev(`document.querySelector("#split-clear").click()`);
  assert.equal(await ev(`document.querySelector("#split-work").hidden`), true);
  assert.equal(await ev(`document.querySelector('[data-drop="split"]').hidden`), false);
  await openSplit(FX.A, "A.pdf");
  assert.equal(await ev(`document.querySelectorAll("#split-thumbs .thumb").length`), 3);
});

// ---------- Pages
await reset();
await test("Pages", "move, rotate and delete, then download", async () => {
  await ev(`document.querySelector("#tab-pages").click(); __T.load("pages", [__T.file("${FX.SEVEN}", "Scan.pdf")])`);
  await until(`document.querySelectorAll("#pages-thumbs .thumb").length === 7`);
  const tile = (i) => `document.querySelectorAll("#pages-thumbs .thumb")[${i}]`;
  await ev(`${tile(1)}.querySelector('[data-act="rot"]').click()`);
  await ev(`${tile(2)}.querySelector('[data-act="del"]').click()`);
  await ev(`${tile(6)}.querySelector('[data-act="left"]').click()`);
  await ev(`${tile(0)}.querySelector('[data-act="right"]').click()`);
  assert.equal(await ev("__T.status()"), "New PDF will have 6 pages.");
  const d = await clickDownload(`document.querySelector("#pages-go").click()`);
  assert.equal(d.name, "Scan (edited).pdf");
  const doc = await pages(d.bytes);
  assert.deepEqual(doc.getPages().map((p) => Math.round(p.getWidth())), [102, 101, 104, 105, 107, 106]);
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [90, 0, 0, 0, 0, 0]);
});
await test("Pages", "rotating four times returns to upright", async () => {
  for (let k = 0; k < 3; k++) await ev(`document.querySelectorAll("#pages-thumbs .thumb")[0].querySelector('[data-act="rot"]').click()`);
  assert.doesNotMatch(await ev(`document.querySelectorAll("#pages-thumbs .thumb")[0].getAttribute("aria-label")`), /rotated/);
});
await test("Pages", "a deleted page can be kept again", async () => {
  await ev(`document.querySelectorAll("#pages-thumbs .thumb")[3].querySelector('[data-act="del"]').click()`);
  assert.match(await ev(`document.querySelectorAll("#pages-thumbs .thumb")[3].getAttribute("aria-label")`), /Page 4 \\(was 3\\), will be removed|will be removed/);
  await ev(`document.querySelectorAll("#pages-thumbs .thumb")[3].querySelector('[data-act="del"]').click()`);
  assert.doesNotMatch(await ev(`document.querySelectorAll("#pages-thumbs .thumb")[3].getAttribute("aria-label")`), /removed/);
});
await test("Pages", "Undo all changes restores the original order", async () => {
  await ev(`document.querySelector("#pages-reset").click()`);
  assert.deepEqual(await ev(`[...document.querySelectorAll("#pages-thumbs .lbl")].map((l) => l.textContent)`), range(1, 7).map((n) => `Page ${n}`));
});
await test("Pages", "removing every page disables download", async () => {
  for (let i = 0; i < 7; i++) await ev(`document.querySelectorAll("#pages-thumbs .thumb")[${i}].querySelector('[data-act="del"]').click()`);
  assert.equal(await ev(`document.querySelector("#pages-go").disabled`), true);
  assert.match(await ev("__T.status()"), /Keep at least one page/);
});
await test("Pages", "keyboard: focus stays on the moved page's button", async () => {
  await ev(`document.querySelector("#pages-reset").click()`);
  await ev(`document.querySelectorAll("#pages-thumbs .thumb")[2].querySelector('[data-act="right"]').click()`);
  assert.equal(await ev(`document.activeElement.getAttribute("aria-label")`), "Move page 4 later");
});

// ---------- Images to PDF
await reset();
await test("Images", "PNG, JPEG and WebP become one A4 PDF, one image per page", async () => {
  await ev(`(async () => { document.querySelector("#tab-images").click(); __T.load("images", [await __T.image("image/png", 800, 600, "#fc0"), await __T.image("image/jpeg", 600, 900, "#0cf"), await __T.image("image/webp", 500, 500, "#f6c")]); return true; })()`);
  await until(`document.querySelectorAll("#images-list .file").length === 3`);
  const d = await clickDownload(`document.querySelector("#img-go").click()`);
  const doc = await pages(d.bytes);
  assert.deepEqual(doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]), [[842, 595], [595, 842], [595, 842]]);
});
await test("Images", "phone photo with a rotation tag comes out the right way up", async () => {
  await ev(`document.querySelector("#img-clear").click()`);
  await ev(`(async () => { __T.load("images", [await __T.image("image/jpeg", 600, 400, "#0c6", 6)]); return true; })()`);
  await until(`document.querySelectorAll("#images-list .file").length === 1`);
  const d = await clickDownload(`document.querySelector("#img-size").value = "fit"; document.querySelector("#img-go").click()`);
  const p = (await pages(d.bytes)).getPages()[0];
  assert.ok(p.getHeight() > p.getWidth(), `page is ${p.getWidth()}×${p.getHeight()}, expected portrait`);
});
await test("Images", "US Letter with a large margin", async () => {
  const d = await clickDownload(`document.querySelector("#img-size").value = "letter"; document.querySelector("#img-margin").value = "48"; document.querySelector("#img-go").click()`);
  const p = (await pages(d.bytes)).getPages()[0];
  assert.deepEqual([Math.round(p.getWidth()), Math.round(p.getHeight())], [612, 792]);
});
await test("Images", "refuses files that aren't images", async () => {
  await ev(`__T.load("images", [__T.file("${FX.TEXT}", "notes.txt", "text/plain")])`);
  assert.match(await ev("__T.status()"), /Not an image: notes.txt/);
});

// ---------- Phone layout
await page.close();
const phone = await openPage(URL_, { width: 375, height: 800 });
await test("Layout", "no sideways scrolling on a 375px phone", async () => {
  assert.equal(await phone.eval("document.documentElement.scrollWidth"), 375);
});
await phone.close();
const dark = await openPage(URL_, { width: 1280, height: 900, dark: true });
await test("Layout", "dark mode uses dark colours", async () => {
  const bg = await dark.eval(`getComputedStyle(document.body).backgroundColor`);
  assert.equal(bg, "rgb(18, 18, 17)");
});
await dark.close();

// ---------- Report
const failed = results.filter((r) => !r.ok);
const rows = results.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? "Pass" : "**Fail**: " + r.error.replace(/\|/g, "\\|")} |`).join("\n");
writeFileSync(join(HERE, "TEST-REPORT.md"), `# Local PDF Tools: test report\n\n${new Date().toISOString().slice(0, 10)} · ${results.length - failed.length} of ${results.length} passed · run with \`npm test\`\n\nThe built file was opened from disk in headless Chrome, the way people open it. Every download was checked with pdf-lib (page count, order, size, rotation) and every ZIP with \`unzip -t\`.\n\n| Area | Test | Result |\n|---|---|---|\n${rows}\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
