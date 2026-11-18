// A numbered sheet of notionists faces, to pick one per person.
import { createRequire } from "node:module";
const deps = createRequire(process.argv[2] + "/package.json");
const { createAvatar } = deps("@dicebear/core");
const { notionists } = deps("@dicebear/collection");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("playwright-core");
let html = `<body style="margin:0;background:#0f0f11;color:#aaa;font:13px -apple-system;display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:1200px">`;
for (let i = 0; i < 60; i++) {
  const svg = createAvatar(notionists, { seed: `zuna-${i}`, backgroundColor: ["e0e0e6"], size: 132 }).toString();
  html += `<div style="text-align:center"><div style="width:132px;height:132px;border-radius:50%;overflow:hidden">${svg}</div>${i}</div>`;
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1216, height: 1000 } });
await page.setContent(html);
await page.screenshot({ path: process.argv[3], fullPage: true });
await browser.close();
