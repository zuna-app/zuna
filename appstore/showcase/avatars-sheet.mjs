// A contact sheet of CC0 DiceBear styles on Zuna-like backgrounds, to pick one.
import { createRequire } from "node:module";
const deps = createRequire(process.argv[2] + "/package.json");
const { createAvatar } = deps("@dicebear/core");
const collection = deps("@dicebear/collection");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("playwright-core");
const seeds = ["Maya Lindqvist", "Theo Park", "Nadia Haddad", "Kai Okafor", "Elena Rossi", "Jonas Weber", "Aiko Tanaka", "Leo Martins"];
const bgs = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "c7f0d8", "f5e6b8", "e0e0e6"];
let html = `<body style="margin:0;background:#0f0f11;color:#ccc;font:14px -apple-system">`;
for (const style of ["notionists", "lorelei", "openPeeps"]) {
  html += `<div style="padding:10px">${style}</div><div style="display:flex;gap:12px;padding:0 10px 10px">`;
  seeds.forEach((seed, i) => {
    const svg = createAvatar(collection[style], { seed, backgroundColor: [bgs[i]], radius: 50, size: 128 }).toString();
    html += `<div style="width:128px;height:128px">${svg}</div>`;
  });
  html += `</div>`;
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1150, height: 520 } });
await page.setContent(html);
await page.screenshot({ path: process.argv[3] });
await browser.close();
