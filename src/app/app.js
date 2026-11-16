/* Local PDF Tools: the page. Everything runs in this browser tab; nothing is sent anywhere
   (the Content Security Policy in <head> blocks all network connections). */
(() => {
  "use strict";
  const { PDFDocument, degrees } = window.PDFLib;
  const L = window.LPT;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  let nextId = 1;
  const uid = () => nextId++;

  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    n.append(...kids.filter((k) => k != null));
    return n;
  }

  // ---------- Status, network badge, tabs
  const statusEl = $("#status");
  function say(msg, kind = "") {
    statusEl.textContent = msg;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }
  function updateNet() {
    const off = !navigator.onLine;
    $("#net").classList.toggle("is-off", off);
    $("#net-text").textContent = off ? "You're offline. It still works." : "Offline. Nothing is uploaded.";
  }
  addEventListener("online", updateNet);
  addEventListener("offline", updateNet);
  updateNet();

  const tabs = $$('[role="tab"]');
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $("#" + t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    say("");
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      const map = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (e.key in map) {
        e.preventDefault();
        selectTab(tabs[map[e.key]], true);
      }
    });
  });

  // ---------- Files in and out
  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const readBytes = async (f) => new Uint8Array(await f.arrayBuffer());

  async function loadPdf(bytes) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (!head.includes("%PDF")) throw new Error("isn't a PDF file");
    let doc;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if (/encrypt/i.test(String(e && e.message))) throw new Error("is password-protected. Remove the password first, then try again");
      throw new Error("couldn't be read. It may be damaged");
    }
    // A file can parse but still be broken (no page list), so check that its pages can be read.
    let count = 0;
    try {
      count = doc.getPageCount();
      doc.getPages();
    } catch {
      count = 0;
    }
    if (!count) throw new Error("couldn't be read. It may be damaged or have no pages");
    return doc;
  }

  async function savePdf(doc) {
    doc.setProducer("Local PDF Tools");
    doc.setCreator("Local PDF Tools");
    return doc.save();
  }

  function download(bytes, name, type = "application/pdf") {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function pagesFrom(src, indices) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    return out;
  }

  function busy(button, on, label) {
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = label || "Working…";
      button.disabled = true;
      document.body.setAttribute("aria-busy", "true");
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
      document.body.removeAttribute("aria-busy");
    }
  }

  const pageWord = (n) => `${n} page${n === 1 ? "" : "s"}`;
  const pad = (n, count) => String(n).padStart(String(count).length, "0");

  // ---------- Motion: only to show what changed (respects "reduce motion")
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EASE = "cubic-bezier(.22,.9,.3,1)";
  const FX_COLORS = ["var(--fx-a)", "var(--fx-b)", "var(--fx-c)", "var(--fx-d)"];

  // Remember where keyed items were, redraw, then slide each one from its old place (FLIP).
  function flip(container, draw) {
    const before = new Map();
    if (!calm()) for (const el of container.children) if (el.dataset.key) before.set(el.dataset.key, el.getBoundingClientRect());
    draw();
    if (calm()) return;
    for (const el of container.children) {
      const was = before.get(el.dataset.key);
      if (!el.dataset.key) continue;
      if (!was) {
        if (before.size || container.children.length === 1) el.animate([{ opacity: 0, transform: "translateY(10px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 340, easing: EASE });
    }
  }

  // A short scene in the tool's panel that shows the result: files joining, a file splitting, pages reordering.
  function sheet(color, extra = "", label = "") {
    const el = h("div", { class: "fx-sheet " + extra, style: `--c:${color}` }, h("i"), h("i"), h("i"));
    if (label) el.append(h("b", { text: label }));
    return el;
  }
  function stage(panel) {
    let fx = panel.querySelector(".fx");
    if (fx) fx.remove();
    fx = h("div", { class: "fx", "aria-hidden": "true" });
    panel.querySelector(".actions")?.after(fx) ?? panel.append(fx);
    return fx;
  }
  function doneLine(fx, text, delay) {
    const d = h("div", { class: "fx-done" }, h("span", { text: "✓ " }), text);
    fx.append(d);
    d.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay, easing: EASE, fill: "both" });
  }
  const spread = (i, n, gap) => (i - (n - 1) / 2) * gap;
  function showMerge(panel, count, pages) {
    if (calm()) return;
    const fx = stage(panel), n = Math.min(count, 5);
    const parts = Array.from({ length: n }, (_, i) => fx.appendChild(sheet(FX_COLORS[i % 4])));
    const out = fx.appendChild(sheet("var(--fx-b)", "", pageWord(pages)));
    parts.forEach((el, i) => {
      const x = spread(i, n, 74), r = (i - (n - 1) / 2) * 5;
      el.animate([{ transform: `translate(${x}px,-12px) rotate(${r}deg)` }, { transform: `translate(${x}px,-12px) rotate(${r}deg)`, offset: .25 }, { transform: "translate(0,-12px)", opacity: 1, offset: .75 }, { transform: "translate(0,-12px)", opacity: 0 }], { duration: 1300, easing: EASE, fill: "forwards" });
    });
    out.animate([{ opacity: 0, transform: "translate(0,-12px) scale(.9)" }, { opacity: 1, transform: "translate(0,-12px) scale(1.06)", offset: .7 }, { opacity: 1, transform: "translate(0,-12px)" }], { duration: 520, delay: 950, easing: EASE, fill: "both" });
    doneLine(fx, "Joined into one PDF and saved to Downloads", 1300);
  }
  function showSplit(panel, parts, label) {
    if (calm()) return;
    const fx = stage(panel), n = Math.min(parts, 6);
    const src = fx.appendChild(sheet("var(--fx-a)"));
    src.animate([{ transform: "translate(0,-12px)", opacity: 1 }, { transform: "translate(0,-12px) scale(1.04)", opacity: 1, offset: .5 }, { transform: "translate(0,-12px)", opacity: 0 }], { duration: 650, easing: EASE, fill: "forwards" });
    for (let i = 0; i < n; i++) {
      const el = fx.appendChild(sheet(FX_COLORS[i % 4], "small"));
      const x = spread(i, n, 56);
      el.animate([{ opacity: 0, transform: "translate(0,-12px) rotate(0)" }, { opacity: 1, transform: `translate(${x}px,-12px) rotate(${(i - (n - 1) / 2) * 4}deg)` }], { duration: 650, delay: 450 + i * 60, easing: EASE, fill: "both" });
    }
    doneLine(fx, label, 900 + n * 60);
  }
  function showPages(panel, order) {
    if (calm()) return;
    const fx = stage(panel), list = order.slice(0, 10), kept = list.filter((o) => !o.del);
    const gap = 60, before = [...list].sort((a, b) => a.src - b.src);
    before.forEach((o, i) => {
      const el = fx.appendChild(sheet(FX_COLORS[o.src % 4], "small", String(o.src + 1)));
      const from = `translate(${spread(i, before.length, gap)}px,-12px)`;
      if (o.del) {
        el.animate([{ transform: from, opacity: 1 }, { transform: from + " translateY(36px) rotate(14deg)", opacity: 0 }], { duration: 650, delay: 250, easing: "ease-in", fill: "both" });
      } else {
        const j = kept.indexOf(o);
        const to = `translate(${spread(j, kept.length, gap)}px,-12px) rotate(${o.rot || 0}deg)`;
        el.animate([{ transform: from }, { transform: to }], { duration: 750, delay: 500, easing: EASE, fill: "both" });
      }
    });
    doneLine(fx, `New PDF with ${pageWord(order.filter((o) => !o.del).length)} saved to Downloads`, 1300);
  }
  function showImages(panel, count) {
    if (calm()) return;
    const fx = stage(panel), n = Math.min(count, 5);
    for (let i = 0; i < n; i++) {
      const el = fx.appendChild(sheet(FX_COLORS[i % 4], "photo"));
      const x = spread(i, n, 70);
      el.animate([{ transform: `translate(${x}px,-12px) scale(1.15,.85)`, borderRadius: "10px" }, { transform: `translate(${x}px,-12px)`, borderRadius: "5px", offset: .45 }, { transform: `translate(${(n - 1 - i) * 3}px,${-12 - (n - 1 - i) * 3}px)` }], { duration: 1200, delay: i * 50, easing: EASE, fill: "both" });
    }
    doneLine(fx, `${pageWord(count)} in one PDF, saved to Downloads`, 1250);
  }

  // A file dropped anywhere else must not make the browser open it in place of this page.
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  for (const ev of ["dragover", "drop"]) addEventListener(ev, (e) => { if (hasFiles(e)) e.preventDefault(); });

  // Files can be chosen with the button, or dropped anywhere on the tool's panel.
  function wireDrop(name, handler) {
    const zone = $(`[data-drop="${name}"]`);
    const input = $(`[data-input="${name}"]`);
    const area = zone.closest(".panel");
    input.addEventListener("change", () => {
      if (input.files.length) handler([...input.files]);
      input.value = "";
    });
    area.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); zone.classList.add("over"); } });
    area.addEventListener("dragleave", (e) => { if (!area.contains(e.relatedTarget)) zone.classList.remove("over"); });
    area.addEventListener("drop", (e) => {
      zone.classList.remove("over");
      if (!hasFiles(e)) return;
      e.preventDefault();
      handler([...e.dataTransfer.files]);
    });
    return zone;
  }

  // ---------- Page previews with PDF.js (optional: the tools work without them)
  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  let pdfjsPromise = null;
  function getPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = (async () => {
        const lib = $("#pdfjs-lib").textContent.trim();
        const worker = $("#pdfjs-worker").textContent.trim();
        if (!lib || lib.startsWith("%%")) return null;
        const libUrl = URL.createObjectURL(new Blob([b64ToBytes(lib)], { type: "text/javascript" }));
        const workerUrl = URL.createObjectURL(new Blob([b64ToBytes(worker)], { type: "text/javascript" }));
        const pdfjs = await import(libUrl);
        if (location.protocol === "file:") {
          // Browsers don't allow background workers in a page opened from a file, so PDF.js runs on the page itself.
          globalThis.pdfjsWorker = await import(workerUrl);
        } else {
          pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });
        }
        return pdfjs;
      })().catch((e) => {
        console.warn("Page previews are off:", e);
        return null;
      });
    }
    return pdfjsPromise;
  }
  async function openPreview(bytes) {
    const pdfjs = await getPdfjs();
    if (!pdfjs) return null;
    try {
      const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, enableXfa: false, stopAtErrors: false });
      const doc = await task.promise;
      doc.task = task;
      return doc;
    } catch (e) {
      console.warn("Preview failed:", e);
      return null;
    }
  }
  // Renders page canvases lazily (when a tile scrolls into view), one at a time.
  function previewer(doc) {
    const cache = new Map();
    const queue = [];
    let running = false;
    let stopped = false;
    const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); queue.push(en.target); }
      pump();
    }, { rootMargin: "300px" }) : null;
    async function draw(index) {
      if (cache.has(index)) return cache.get(index);
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(200 / base.width, 260 / base.height) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale });
      const canvas = h("canvas", { "aria-hidden": "true" });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      cache.set(index, canvas);
      return canvas;
    }
    async function pump() {
      if (running) return;
      running = true;
      while (queue.length && !stopped) {
        const tile = queue.shift();
        const index = Number(tile.dataset.src);
        try {
          const canvas = await draw(index);
          if (!stopped && tile.isConnected) tile.querySelector(".pg").replaceChildren(canvas);
          tile.dispatchEvent(new Event("drawn"));
        } catch (e) {
          console.warn("Page", index + 1, "preview failed:", e);
        }
      }
      running = false;
    }
    return {
      observe(tile) {
        const index = Number(tile.dataset.src);
        if (cache.has(index)) { tile.querySelector(".pg").replaceChildren(cache.get(index)); return; }
        if (io) io.observe(tile); else { queue.push(tile); pump(); }
      },
      stop() { stopped = true; if (io) io.disconnect(); queue.length = 0; doc.task.destroy().catch(() => {}); },
    };
  }
  const placeholder = (n) => h("span", { class: "ph", "aria-hidden": "true", text: String(n) });

  // ---------- Sortable lists (merge files, images)
  function renderList(ol, items, describe, onChange) {
    flip(ol, () => renderItems(ol, items, describe, onChange));
  }
  function renderItems(ol, items, describe, onChange) {
    ol.replaceChildren();
    items.forEach((it, i) => {
      const li = h("li", { class: "file", draggable: "true", "data-i": i, "data-key": it.id },
        h("span", { class: "n", "aria-hidden": "true", text: String(i + 1) }),
        h("span", { class: "meta" }, ...describe(it)),
        h("span", { class: "ctl" },
          h("button", { class: "icon-btn", type: "button", "aria-label": `Move ${it.name} up`, disabled: i === 0, text: "↑", onclick: () => { move(items, i, i - 1); onChange(i - 1, "up"); } }),
          h("button", { class: "icon-btn", type: "button", "aria-label": `Move ${it.name} down`, disabled: i === items.length - 1, text: "↓", onclick: () => { move(items, i, i + 1); onChange(i + 1, "down"); } }),
          h("button", { class: "icon-btn del", type: "button", "aria-label": `Remove ${it.name}`, text: "✕", onclick: () => { const [gone] = items.splice(i, 1); if (gone.url) URL.revokeObjectURL(gone.url); onChange(Math.min(i, items.length - 1), "remove"); } })));
      ol.append(li);
    });
    dragSort(ol, ".file", (from, to) => { move(items, from, to); onChange(to, "drag"); });
  }
  function move(arr, from, to) {
    if (to < 0 || to >= arr.length || from === to) return;
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
  }
  // Mouse drag-and-drop reordering. Buttons do the same for keyboards and touch screens.
  function dragSort(container, selector, onMove) {
    let from = null;
    container.ondragstart = (e) => {
      const item = e.target.closest(selector);
      if (!item) return;
      from = $$(selector, container).indexOf(item);
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(from));
    };
    container.ondragend = () => { from = null; $$(selector, container).forEach((x) => x.classList.remove("dragging", "drop-before")); };
    container.ondragover = (e) => {
      if (from === null) return;
      e.preventDefault();
      const item = e.target.closest(selector);
      $$(selector, container).forEach((x) => x.classList.toggle("drop-before", x === item));
    };
    container.ondrop = (e) => {
      if (from === null) return;
      e.preventDefault();
      const item = e.target.closest(selector);
      const all = $$(selector, container);
      let to = item ? all.indexOf(item) : all.length - 1;
      if (to > from) to -= 1;
      const f = from;
      from = null;
      if (to !== f && to >= 0) onMove(f, to);
      all.forEach((x) => x.classList.remove("dragging", "drop-before"));
    };
  }
  function refocus(ol, index, kind) {
    const li = ol.children[index];
    if (!li) return;
    const btn = kind === "up" ? li.querySelector(".ctl button:nth-child(1)") : kind === "down" ? li.querySelector(".ctl button:nth-child(2)") : li.querySelector(".ctl button:nth-child(3)");
    (btn && !btn.disabled ? btn : li.querySelector(".ctl button:not(:disabled)"))?.focus();
  }

  // ---------- Merge
  const merge = { items: [] };
  const mergeList = $("#merge-list");
  const mergeGo = $("#merge-go");
  function drawMerge(focusIndex, kind) {
    renderList(mergeList, merge.items, (it) => [h("b", { text: it.name }), h("small", { text: `${pageWord(it.pages)} · ${L.formatBytes(it.size)}` })], (i, k) => drawMerge(i, k));
    mergeGo.disabled = merge.items.length < 2;
    $("#merge-clear").hidden = !merge.items.length;
    const total = merge.items.reduce((s, it) => s + it.pages, 0);
    if (merge.items.length === 1) say("Add at least one more PDF to merge.");
    else if (merge.items.length > 1 && kind) say(`${merge.items.length} files, ${pageWord(total)} in total.`);
    if (kind && kind !== "add") refocus(mergeList, focusIndex, kind);
  }
  async function addMerge(files) {
    const problems = [];
    let added = 0;
    for (const f of files) {
      if (!isPdf(f)) { problems.push(`${f.name} isn't a PDF`); continue; }
      say(`Reading ${f.name}…`);
      try {
        const bytes = await readBytes(f);
        const doc = await loadPdf(bytes);
        merge.items.push({ id: uid(), name: f.name, size: f.size, bytes, pages: doc.getPageCount() });
        added++;
      } catch (e) {
        problems.push(`${f.name} ${e.message}`);
      }
    }
    drawMerge(merge.items.length - 1, "add");
    if (problems.length) say(problems.join(". ") + ".", "err");
    else if (merge.items.length >= 2) say(`${added} added. ${merge.items.length} files ready. Put them in order, then merge.`);
  }
  wireDrop("merge", addMerge);
  $("#merge-clear").onclick = () => { merge.items = []; drawMerge(); say(""); };
  mergeGo.onclick = async () => {
    if (merge.items.length < 2) return;
    busy(mergeGo, true, "Merging…");
    say("Merging…");
    try {
      const out = await PDFDocument.create();
      for (const it of merge.items) {
        const src = await PDFDocument.load(it.bytes, { updateMetadata: false });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
      }
      const bytes = await savePdf(out);
      const name = L.cleanName($("#merge-name").value.replace(/\.pdf$/i, ""), "merged") + ".pdf";
      download(bytes, name);
      say(`Done: ${name} (${pageWord(out.getPageCount())}, ${L.formatBytes(bytes.length)}). Check your downloads.`, "ok");
      showMerge($("#panel-merge"), merge.items.length, out.getPageCount());
    } catch (e) {
      console.error(e);
      say(`Merging didn't work: ${e.message}`, "err");
    } finally {
      busy(mergeGo, false);
    }
  };

  // ---------- Split
  const split = { name: "", bytes: null, count: 0, selected: new Set(), view: null };
  const splitZone = $('[data-drop="split"]');
  const splitThumbs = $("#split-thumbs");
  const splitGo = $("#split-go");
  const rangesInput = $("#split-ranges");
  const mode = () => $('input[name="split-mode"]:checked').value;

  function splitPlan() {
    const m = mode();
    if (m === "extract") {
      const pairs = L.parseRanges(rangesInput.value, split.count);
      const indices = pairs.flatMap(L.rangeToIndices);
      return { kind: "one", indices, text: `New PDF with ${pageWord(indices.length)}.` };
    }
    let pairs;
    if (m === "each") pairs = L.chunks(split.count, 1);
    else if (m === "every") {
      const n = Number($("#split-n").value);
      if (!Number.isInteger(n) || n < 1) throw new Error("Pages per file must be a whole number, 1 or more.");
      pairs = L.chunks(split.count, n);
    } else pairs = L.parseRanges(rangesInput.value, split.count);
    const label = pairs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
    const shown = label.length > 8 ? label.slice(0, 8).join(" · ") + ` · and ${label.length - 8} more` : label.join(" · ");
    return { kind: pairs.length === 1 ? "one" : "zip", pairs, indices: pairs.length === 1 ? L.rangeToIndices(pairs[0]) : null, text: `${pairs.length} file${pairs.length === 1 ? "" : "s"}: pages ${shown}.` };
  }
  function updateSplit() {
    if (!split.bytes) return;
    const m = mode();
    for (const o of $$("#split-work .opt")) o.hidden = !o.dataset.for.split(" ").includes(m);
    $("#split-ranges-label").textContent = m === "groups" ? "Parts (each range becomes a file)" : "Pages to keep";
    rangesInput.placeholder = m === "groups" ? `for example 1-3, 4-7, 8-${split.count}` : "for example 1-3, 5, 8-";
    splitThumbs.classList.toggle("selectable", m === "extract");
    for (const t of $$(".thumb", splitThumbs)) {
      if (m === "extract") {
        t.setAttribute("role", "button");
        t.setAttribute("aria-pressed", String(split.selected.has(Number(t.dataset.src))));
        t.tabIndex = 0;
      } else {
        t.setAttribute("role", "img");
        t.removeAttribute("aria-pressed");
        t.tabIndex = -1;
      }
    }
    const sum = $("#split-summary");
    try {
      if ((m === "extract" || m === "groups") && !rangesInput.value.trim()) {
        sum.textContent = m === "extract" ? "Type pages, or click the pages you want to keep." : "Type the parts, for example 1-3, 4-7.";
        sum.className = "summary";
        splitGo.disabled = true;
        return;
      }
      sum.textContent = splitPlan().text;
      sum.className = "summary";
      splitGo.disabled = false;
    } catch (e) {
      sum.textContent = e.message;
      sum.className = "summary err";
      splitGo.disabled = true;
    }
  }
  function syncSelectionFromText() {
    if (mode() !== "extract") return;
    if (!rangesInput.value.trim()) {
      split.selected = new Set();
      return;
    }
    try {
      split.selected = new Set(L.parseRanges(rangesInput.value, split.count).flatMap(L.rangeToIndices));
    } catch {
      /* keep the last valid selection while typing */
    }
  }
  function toggleSplitPage(index) {
    if (mode() !== "extract") return;
    split.selected.has(index) ? split.selected.delete(index) : split.selected.add(index);
    rangesInput.value = L.indicesToText([...split.selected]);
    updateSplit();
  }
  async function openSplit(files) {
    const f = files.find(isPdf);
    if (!f) return say("Choose a PDF file.", "err");
    say(`Reading ${f.name}…`);
    try {
      const bytes = await readBytes(f);
      const doc = await loadPdf(bytes);
      closeSplit();
      Object.assign(split, { name: f.name, bytes, count: doc.getPageCount(), selected: new Set() });
      $("#split-file").textContent = `${f.name} · ${pageWord(split.count)} · ${L.formatBytes(f.size)}`;
      splitZone.hidden = true;
      $("#split-work").hidden = false;
      rangesInput.value = "";
      splitThumbs.replaceChildren(...Array.from({ length: split.count }, (_, i) => h("div", {
        class: "thumb", role: "button", tabindex: "0", "data-src": i, "aria-label": `Page ${i + 1}`,
        onclick: () => toggleSplitPage(i),
        onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSplitPage(i); } },
      }, h("span", { class: "pg" }, placeholder(i + 1)), h("span", { class: "lbl", text: `Page ${i + 1}` }))));
      updateSplit();
      say(`${f.name} is ready.`);
      openPreview(bytes).then((preview) => {
        if (!preview) return;
        if (split.bytes !== bytes) return preview.task.destroy();
        split.view = previewer(preview);
        $$(".thumb", splitThumbs).forEach((t) => split.view.observe(t));
      });
    } catch (e) {
      say(`${f.name} ${e.message}.`, "err");
    }
  }
  function closeSplit() {
    if (split.view) split.view.stop();
    Object.assign(split, { name: "", bytes: null, count: 0, selected: new Set(), view: null });
    splitThumbs.replaceChildren();
  }
  wireDrop("split", openSplit);
  $("#split-clear").onclick = () => { closeSplit(); $("#split-work").hidden = true; splitZone.hidden = false; say(""); splitZone.querySelector("input").focus(); };
  $$('input[name="split-mode"]').forEach((r) => r.addEventListener("change", () => { if (mode() === "extract") syncSelectionFromText(); updateSplit(); }));
  rangesInput.addEventListener("input", () => { syncSelectionFromText(); updateSplit(); });
  $("#split-n").addEventListener("input", updateSplit);
  splitGo.onclick = async () => {
    let plan;
    try { plan = splitPlan(); } catch (e) { return say(e.message, "err"); }
    busy(splitGo, true, "Splitting…");
    say("Splitting…");
    try {
      const src = await PDFDocument.load(split.bytes, { updateMetadata: false });
      const base = L.cleanName(L.baseName(split.name), "document");
      if (plan.kind === "one") {
        const bytes = await savePdf(await pagesFrom(src, plan.indices));
        const label = L.indicesToText(plan.indices).replace(/, /g, ",");
        const name = `${base} (${label.length <= 40 ? `pages ${label}` : "selected pages"}).pdf`;
        download(bytes, name);
        say(`Done: ${name} (${pageWord(plan.indices.length)}). Check your downloads.`, "ok");
        showSplit($("#panel-split"), 1, `${pageWord(plan.indices.length)} taken out into a new PDF`);
      } else {
        const files = [];
        for (const [a, b] of plan.pairs) {
          say(`Making part ${files.length + 1} of ${plan.pairs.length}…`);
          const bytes = await savePdf(await pagesFrom(src, L.rangeToIndices([a, b])));
          files.push({ name: a === b ? `${base} - page ${pad(a, split.count)}.pdf` : `${base} - pages ${pad(a, split.count)}-${pad(b, split.count)}.pdf`, bytes });
        }
        const names = L.uniqueNames(files.map((f) => f.name));
        const zip = L.makeZip(files.map((f, i) => ({ name: names[i], bytes: f.bytes })));
        download(zip, `${base} (split).zip`, "application/zip");
        say(`Done: ${files.length} PDFs in "${base} (split).zip". Check your downloads, then open the ZIP.`, "ok");
        showSplit($("#panel-split"), files.length, `Cut into ${files.length} PDFs, saved to Downloads as one ZIP`);
      }
    } catch (e) {
      console.error(e);
      say(`Splitting didn't work: ${e.message}`, "err");
    } finally {
      busy(splitGo, false);
      updateSplit();
    }
  };

  // ---------- Pages: reorder, rotate, delete
  const pages = { name: "", bytes: null, count: 0, order: [], view: null };
  const pagesZone = $('[data-drop="pages"]');
  const pagesThumbs = $("#pages-thumbs");
  const pagesGo = $("#pages-go");
  function drawPages(focus) {
    flip(pagesThumbs, () => drawThumbs());
    afterThumbs(focus);
  }
  function drawThumbs() {
    pagesThumbs.replaceChildren();
    const n = pages.order.length;
    pages.order.forEach((o, i) => {
      const label = `Page ${i + 1}${o.src !== i ? ` (was ${o.src + 1})` : ""}`;
      const tile = h("div", { class: "thumb" + (o.del ? " deleted" : ""), draggable: "true", "data-src": o.src, "data-key": "p" + o.src, role: "group", "aria-label": label + (o.del ? ", will be removed" : "") + (o.rot ? `, rotated ${o.rot}°` : "") },
        h("span", { class: "frame" },
          h("span", { class: "pg" }, placeholder(o.src + 1)),
          o.del ? h("span", { class: "gone", "aria-hidden": "true", text: "Removed" }) : null,
          h("span", { class: "tools-row" },
            h("button", { class: "icon-btn", type: "button", "data-act": "left", "aria-label": `Move page ${i + 1} earlier`, title: "Move earlier", disabled: i === 0, text: "←", onclick: () => { move(pages.order, i, i - 1); drawPages({ i: i - 1, act: "left" }); } }),
            h("button", { class: "icon-btn", type: "button", "data-act": "rot", "aria-label": `Rotate page ${i + 1} clockwise`, title: "Turn", text: "↻", onclick: () => { o.rot = (o.rot + 90) % 360; drawPages({ i, act: "rot" }); } }),
            h("button", { class: "icon-btn del", type: "button", "data-act": "del", "aria-label": o.del ? `Keep page ${i + 1}` : `Remove page ${i + 1}`, title: o.del ? "Keep" : "Remove", text: o.del ? "↺" : "✕", onclick: () => { o.del = !o.del; drawPages({ i, act: "del" }); } }),
            h("button", { class: "icon-btn", type: "button", "data-act": "right", "aria-label": `Move page ${i + 1} later`, title: "Move later", disabled: i === n - 1, text: "→", onclick: () => { move(pages.order, i, i + 1); drawPages({ i: i + 1, act: "right" }); } }))),
        h("span", { class: "cap" },
          h("span", { class: "lbl", text: `Page ${i + 1}` }),
          o.src !== i ? h("span", { class: "was", "aria-hidden": "true", text: `was ${o.src + 1}` }) : null,
          o.rot ? h("span", { class: "was", "aria-hidden": "true", text: `${o.rot}°` }) : null));
      // Rotate the preview; when it turns sideways, shrink it so it still fits the tile.
      const fit = () => {
        const c = tile.querySelector("canvas");
        if (!c) return;
        const box = tile.querySelector(".pg");
        const s = o.rot % 180 && c.clientWidth ? Math.min(1, box.clientWidth / c.clientHeight, box.clientHeight / c.clientWidth) : 1;
        c.style.transform = o.rot ? `rotate(${o.rot}deg) scale(${s.toFixed(3)})` : "";
      };
      tile.addEventListener("drawn", fit);
      pagesThumbs.append(tile);
      if (pages.view) pages.view.observe(tile);
      fit();
    });
  }
  function afterThumbs(focus) {
    dragSort(pagesThumbs, ".thumb", (from, to) => { move(pages.order, from, to); drawPages(); });
    const kept = pages.order.filter((o) => !o.del).length;
    pagesGo.disabled = kept === 0;
    const changed = pages.order.some((o, i) => o.src !== i || o.rot || o.del);
    say(kept === 0 ? "Every page is marked for removal. Keep at least one page." : changed ? `New PDF will have ${pageWord(kept)}.` : "");
    if (focus) {
      const tile = pagesThumbs.children[focus.i];
      const btn = tile && tile.querySelector(`[data-act="${focus.act}"]`);
      (btn && !btn.disabled ? btn : tile && tile.querySelector("button:not(:disabled)"))?.focus();
    }
  }
  async function openPages(files) {
    const f = files.find(isPdf);
    if (!f) return say("Choose a PDF file.", "err");
    say(`Reading ${f.name}…`);
    try {
      const bytes = await readBytes(f);
      const doc = await loadPdf(bytes);
      closePages();
      Object.assign(pages, { name: f.name, bytes, count: doc.getPageCount() });
      pages.order = Array.from({ length: pages.count }, (_, i) => ({ src: i, rot: 0, del: false }));
      $("#pages-file").textContent = `${f.name} · ${pageWord(pages.count)}`;
      $("#pages-name").value = `${L.cleanName(L.baseName(f.name), "document")} (edited)`;
      pagesZone.hidden = true;
      $("#pages-work").hidden = false;
      drawPages();
      say(`${f.name} is ready. Move, rotate or remove pages, then download.`);
      openPreview(bytes).then((preview) => {
        if (!preview) return;
        if (pages.bytes !== bytes) return preview.task.destroy();
        pages.view = previewer(preview);
        $$(".thumb", pagesThumbs).forEach((t) => pages.view.observe(t));
      });
    } catch (e) {
      say(`${f.name} ${e.message}.`, "err");
    }
  }
  function closePages() {
    if (pages.view) pages.view.stop();
    Object.assign(pages, { name: "", bytes: null, count: 0, order: [], view: null });
    pagesThumbs.replaceChildren();
  }
  wireDrop("pages", openPages);
  $("#pages-clear").onclick = () => { closePages(); $("#pages-work").hidden = true; pagesZone.hidden = false; say(""); pagesZone.querySelector("input").focus(); };
  $("#pages-reset").onclick = () => { pages.order = Array.from({ length: pages.count }, (_, i) => ({ src: i, rot: 0, del: false })); drawPages(); say("All changes undone."); };
  pagesGo.onclick = async () => {
    const keep = pages.order.filter((o) => !o.del);
    if (!keep.length) return;
    busy(pagesGo, true, "Saving…");
    try {
      const src = await PDFDocument.load(pages.bytes, { updateMetadata: false });
      const out = await pagesFrom(src, keep.map((o) => o.src));
      out.getPages().forEach((p, i) => { if (keep[i].rot) p.setRotation(degrees((p.getRotation().angle + keep[i].rot) % 360)); });
      const bytes = await savePdf(out);
      const name = L.cleanName($("#pages-name").value.replace(/\.pdf$/i, ""), "edited") + ".pdf";
      download(bytes, name);
      say(`Done: ${name} (${pageWord(keep.length)}). Check your downloads.`, "ok");
      showPages($("#panel-pages"), pages.order);
    } catch (e) {
      console.error(e);
      say(`Saving didn't work: ${e.message}`, "err");
    } finally {
      busy(pagesGo, false);
    }
  };

  // ---------- Images to PDF
  const imgs = { items: [] };
  const imgList = $("#images-list");
  const imgGo = $("#img-go");
  function drawImgs(focusIndex, kind) {
    renderList(imgList, imgs.items, (it) => [h("b", { text: it.name }), h("small", { text: L.formatBytes(it.size) })], (i, k) => drawImgs(i, k));
    $$(".file", imgList).forEach((li, i) => li.querySelector(".n").replaceWith(h("img", { src: imgs.items[i].url, alt: "", width: 32, height: 32 })));
    imgGo.disabled = !imgs.items.length;
    $("#img-clear").hidden = !imgs.items.length;
    if (kind && kind !== "add") refocus(imgList, focusIndex, kind);
  }
  function addImgs(files) {
    const bad = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) { bad.push(f.name); continue; }
      imgs.items.push({ id: uid(), name: f.name, size: f.size, file: f, url: URL.createObjectURL(f) });
    }
    drawImgs(imgs.items.length - 1, "add");
    say(bad.length ? `Not an image: ${bad.join(", ")}.` : `${imgs.items.length} image${imgs.items.length === 1 ? "" : "s"} ready. Put them in order, then make the PDF.`, bad.length ? "err" : "");
  }
  wireDrop("images", addImgs);
  $("#img-clear").onclick = () => { imgs.items.forEach((it) => URL.revokeObjectURL(it.url)); imgs.items = []; drawImgs(); say(""); };

  // JPEG EXIF orientation (1 = upright). Phones often save photos sideways with an orientation tag.
  function jpegOrientation(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) return 1;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif") {
        const t = i + 10;
        const le = b[t] === 0x49;
        const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
        const u32 = (o) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
        const ifd = u32(4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda) return 1;
      i += 2 + len;
    }
    return 1;
  }
  // Draw any image the browser can open onto a canvas (this applies EXIF rotation) and return JPEG bytes.
  async function viaCanvas(file) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    try {
      await img.decode();
      const c = h("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  imgGo.onclick = async () => {
    if (!imgs.items.length) return;
    busy(imgGo, true, "Making PDF…");
    try {
      const out = await PDFDocument.create();
      const size = $("#img-size").value;
      const margin = Number($("#img-margin").value);
      for (const [n, it] of imgs.items.entries()) {
        say(`Adding image ${n + 1} of ${imgs.items.length}…`);
        let bytes = await readBytes(it.file);
        let image;
        const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        try {
          if (isJpeg && jpegOrientation(bytes) === 1) image = await out.embedJpg(bytes);
          else if (isPng) image = await out.embedPng(bytes);
          else image = await out.embedJpg(await viaCanvas(it.file));
        } catch {
          try { image = await out.embedJpg(await viaCanvas(it.file)); } catch { throw new Error(`${it.name} can't be opened in this browser`); }
        }
        const landscape = image.width > image.height;
        let [W, H] = size === "fit" ? (landscape ? [841.89, (841.89 * image.height) / image.width] : [(841.89 * image.width) / image.height, 841.89]) : SIZES[size];
        if (size !== "fit" && landscape) [W, H] = [H, W];
        const m = size === "fit" ? Math.min(margin, W / 8, H / 8) : margin;
        const scale = Math.min((W - 2 * m) / image.width, (H - 2 * m) / image.height);
        const w = image.width * scale;
        const hgt = image.height * scale;
        const page = out.addPage([W, H]);
        page.drawImage(image, { x: (W - w) / 2, y: (H - hgt) / 2, width: w, height: hgt });
      }
      const bytes = await savePdf(out);
      const name = L.cleanName($("#img-name").value.replace(/\.pdf$/i, ""), "images") + ".pdf";
      download(bytes, name);
      say(`Done: ${name} (${pageWord(imgs.items.length)}, ${L.formatBytes(bytes.length)}). Check your downloads.`, "ok");
      showImages($("#panel-images"), imgs.items.length);
    } catch (e) {
      console.error(e);
      say(`Making the PDF didn't work: ${e.message}.`, "err");
    } finally {
      busy(imgGo, false);
    }
  };

  // Start loading PDF.js in the background so previews are ready when a file is opened.
  setTimeout(getPdfjs, 300);

  // "#sample" opens a made-up 8-page PDF in the Pages tool (used for screenshots and quick tries).
  if (location.hash === "#sample") {
    (async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont("Helvetica-Bold");
      const body = await doc.embedFont("Helvetica");
      const colors = [[0.11, 0.29, 0.79], [0.04, 0.42, 0.22], [0.70, 0.08, 0.04], [0.85, 0.65, 0.0]];
      const titles = ["Contract", "Schedule A", "Schedule B", "Invoice", "Receipt", "Notes", "Signed page", "Appendix"];
      titles.forEach((t, i) => {
        const p = doc.addPage([420, 595]);
        const [r, g, b] = colors[i % colors.length];
        p.drawRectangle({ x: 0, y: 515, width: 420, height: 80, color: window.PDFLib.rgb(r, g, b) });
        p.drawText(t, { x: 32, y: 545, size: 30, font, color: window.PDFLib.rgb(1, 1, 1) });
        for (let k = 0; k < 14; k++) p.drawRectangle({ x: 32, y: 470 - k * 26, width: 356 - ((k * 37) % 120), height: 9, color: window.PDFLib.rgb(0.82, 0.82, 0.8) });
        p.drawText(`Page ${i + 1}`, { x: 32, y: 40, size: 14, font: body, color: window.PDFLib.rgb(0.4, 0.4, 0.4) });
      });
      selectTab($("#tab-pages"));
      await openPages([new File([await doc.save()], "Sample contract.pdf", { type: "application/pdf" })]);
      pages.order[3].rot = 90;
      pages.order[5].del = true;
      move(pages.order, 6, 2);
      drawPages();
    })();
  }
})();
