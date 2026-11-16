// Screenshot a page with headless Chrome once it has finished drawing (workers, canvases, lazy content):
//   node lib/shot.mjs <url> <out.png> [width] [height] [--dark] [--full] [--wait "<js expression that becomes true>"]
import { openPage } from "./cdp.mjs";

const args = process.argv.slice(2);
const wait = args.includes("--wait") ? args[args.indexOf("--wait") + 1] : null;
const [url, out, w = "1280", h = "900"] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--wait");
const page = await openPage(url, { width: Number(w), height: Number(h), dark: args.includes("--dark") });
try {
  if (wait && !(await page.waitFor(wait))) console.warn(`Warning: "${wait}" never became true`);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot(out, { full: args.includes("--full") });
  console.log(`Saved ${out}`);
} finally {
  await page.close();
}
