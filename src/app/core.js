/* Local PDF Tools: pure helpers (page ranges, ZIP files, sizes). No DOM, so they can be tested in Node. */
(function (root) {
  "use strict";

  // "1-3, 5, 8-" → [[1,3],[5,5],[8,count]] (1-based, inclusive). "last" means the last page; "-4" means 1-4.
  function parseRanges(text, count) {
    const out = [];
    const num = (s) => (s === "last" ? count : Number(s));
    for (const raw of String(text).split(/[,;\n]/)) {
      const part = raw.trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+to\s+/g, "-");
      if (!part) continue;
      let m = part.match(/^(\d+|last)$/);
      let a, b;
      if (m) {
        a = b = num(m[1]);
      } else if ((m = part.match(/^(\d+|last)?\s*-\s*(\d+|last)?$/)) && (m[1] || m[2])) {
        a = m[1] ? num(m[1]) : 1;
        b = m[2] ? num(m[2]) : count;
      } else {
        throw new Error(`"${raw.trim()}" isn't a page or range. Use numbers like 1-3, 5, 8-.`);
      }
      for (const p of [a, b]) {
        if (!Number.isInteger(p) || p < 1 || p > count) throw new Error(`Page ${p} doesn't exist. This file has ${count} page${count === 1 ? "" : "s"}.`);
      }
      out.push([a, b]);
    }
    if (!out.length) throw new Error("Type the pages you want, for example 1-3, 5.");
    return out;
  }

  // [a,b] (1-based) → 0-based indices; a > b gives the pages in reverse order.
  function rangeToIndices([a, b]) {
    const out = [];
    const step = a <= b ? 1 : -1;
    for (let p = a; p !== b + step; p += step) out.push(p - 1);
    return out;
  }

  // 0-based indices → compact text, e.g. [0,1,2,4] → "1-3, 5".
  function indicesToText(indices) {
    const sorted = [...new Set(indices)].sort((x, y) => x - y);
    const parts = [];
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
      i = j;
    }
    return parts.join(", ");
  }

  function chunks(count, size) {
    const out = [];
    for (let s = 1; s <= count; s += size) out.push([s, Math.min(count, s + size - 1)]);
    return out;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // Safe file names: no path separators or control characters.
  function cleanName(name, fallback) {
    const s = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
    return s || fallback;
  }

  function baseName(fileName) {
    return String(fileName).replace(/\.pdf$/i, "");
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // A plain ZIP (stored, no compression: PDFs are already compressed). files: [{name, bytes: Uint8Array}] → Uint8Array
  function makeZip(files, now = new Date()) {
    const enc = new TextEncoder();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.bytes);
      const size = f.bytes.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 file names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, f.bytes);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + size;
    }
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of all) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  // Unique names inside one ZIP: "a.pdf", "a (2).pdf", ...
  function uniqueNames(names) {
    const seen = new Map();
    return names.map((n) => {
      const key = n.toLowerCase();
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      return k === 1 ? n : n.replace(/(\.[^.]+)?$/, ` (${k})$1`);
    });
  }

  root.LPT = { parseRanges, rangeToIndices, indicesToText, chunks, formatBytes, cleanName, baseName, crc32, makeZip, uniqueNames };
})(typeof window !== "undefined" ? window : globalThis);
