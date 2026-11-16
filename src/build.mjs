// Builds release/files/ for Local PDF Tools: node src/build.mjs
// One offline HTML file (pdf-lib + PDF.js inlined), the printable guide's HTML (package.sh prints it to PDF),
// the licences and a README.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.1";
const SRC = dirname(fileURLToPath(import.meta.url));
const KIT = dirname(SRC);
const MODULES = join(KIT, "node_modules");
const OUT = join(KIT, "release", "files");
const read = (p) => readFileSync(p, "utf8");

const pdfLib = read(join(MODULES, "pdf-lib", "dist", "pdf-lib.min.js"));
const pdfjsLib = readFileSync(join(MODULES, "pdfjs-dist", "legacy", "build", "pdf.min.mjs"));
const pdfjsWorker = readFileSync(join(MODULES, "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"));
const pdfjsVersion = JSON.parse(read(join(MODULES, "pdfjs-dist", "package.json"))).version;
const pdfLibVersion = JSON.parse(read(join(MODULES, "pdf-lib", "package.json"))).version;
if (/<\/script/i.test(pdfLib)) throw new Error("pdf-lib contains </script and can't be inlined as is");

const style = read(join(SRC, "app", "style.css"));
const guide = read(join(SRC, "content", "guide.html"));
const fill = (tpl, map) => tpl.replace(/%%([A-Z_]+)%%/g, (m, k) => {
  if (!(k in map)) throw new Error(`No value for ${m}`);
  return map[k];
});

const app = fill(read(join(SRC, "app", "template.html")), {
  STYLE: style,
  GUIDE: guide,
  VERSION,
  PDFLIB: pdfLib,
  PDFJS_LIB: pdfjsLib.toString("base64"),
  PDFJS_WORKER: pdfjsWorker.toString("base64"),
  CORE: read(join(SRC, "app", "core.js")),
  APP: read(join(SRC, "app", "app.js")),
});
const print = fill(read(join(SRC, "guide", "print.html")), { STYLE: style, GUIDE: guide, VERSION });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "licenses"), { recursive: true });
writeFileSync(join(OUT, "Local PDF Tools.html"), app);
writeFileSync(join(KIT, "release", "guide-print.html"), print);
copyFileSync(join(MODULES, "pdf-lib", "LICENSE.md"), join(OUT, "licenses", `pdf-lib ${pdfLibVersion} - MIT licence.txt`));
copyFileSync(join(MODULES, "pdfjs-dist", "LICENSE"), join(OUT, "licenses", `PDF.js ${pdfjsVersion} - Apache 2.0 licence.txt`));
copyFileSync(join(SRC, "LICENSE.txt"), join(OUT, "LICENSE.txt"));
writeFileSync(join(OUT, "README.txt"), fill(read(join(SRC, "README.txt")), { VERSION }));

// Checks: no leftover placeholders, no network addresses the page could call, no local paths.
for (const [name, text] of [["Local PDF Tools.html", app], ["guide-print.html", print]]) {
  const shell = text.replace(/<script type="text\/plain"[^>]*>[^<]*<\/script>/g, "");
  if (/%%[A-Z_]+%%/.test(shell)) throw new Error(`${name}: unreplaced placeholder`);
}
if (!/Content-Security-Policy[^>]*connect-src 'none'/.test(app)) throw new Error("CSP with connect-src 'none' is missing");
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(OUT);
const own = [read(join(SRC, "app", "template.html")), style, guide, read(join(SRC, "app", "app.js")), read(join(SRC, "app", "core.js")), read(join(SRC, "README.txt")), read(join(SRC, "LICENSE.txt")), print];
for (const forbidden of ["/Users/", "/home/", "C:\\Users\\"]) {
  for (const t of own) if (t.includes(forbidden)) throw new Error(`Local path "${forbidden}" found in the source`);
}
console.log(`Built ${files.length} files, Local PDF Tools.html ${(app.length / 1024 / 1024).toFixed(1)} MB (pdf-lib ${pdfLibVersion}, PDF.js ${pdfjsVersion})`);
