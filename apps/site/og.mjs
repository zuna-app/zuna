// Draws public/og.png, the picture a link to zuna.chat shows when it's shared, in the page's own fonts
// and colors. Run it after changing the hero's words: npm run og -w @zuna/site
//
// Needs Playwright's Chromium: npx playwright-core install chromium
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = dirname(fileURLToPath(import.meta.url));
const fonts = join(root, "..", "..", "node_modules", "@fontsource-variable");
const font = (path) => pathToFileURL(join(fonts, path)).href;

const html = `<!doctype html>
<meta charset="utf-8" />
<style>
  @font-face { font-family: Inter; src: url(${font("inter/files/inter-latin-opsz-normal.woff2")}); font-weight: 100 900; }
  @font-face { font-family: Mono; src: url(${font("jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2")}); font-weight: 100 800; }
  html, body { margin: 0; width: 1200px; height: 630px; background: #0f0f11; color: #ececee; font-family: Inter; overflow: hidden; }
  .light { position: absolute; inset: -300px 0 auto; height: 900px; background: radial-gradient(50% 45% at 50% 30%, rgba(255,255,255,0.11), transparent 70%); }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px); background-size: 48px 48px; -webkit-mask-image: radial-gradient(60% 60% at 50% 40%, #000, transparent); }
  main { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 650; letter-spacing: -0.02em; margin-bottom: 44px; }
  h1 { margin: 0; font-size: 88px; font-weight: 650; letter-spacing: -0.045em; line-height: 1; background: linear-gradient(180deg, #fff 35%, rgba(255,255,255,0.6)); -webkit-background-clip: text; color: transparent; }
  p { margin: 30px 0 0; font-size: 30px; color: #a0a0a6; letter-spacing: -0.01em; }
  .url { position: absolute; bottom: 40px; font: 500 22px Mono; color: #6e6e75; }
</style>
<div class="light"></div>
<div class="grid"></div>
<main>
  <div class="brand">
    <svg width="56" height="56" viewBox="0 0 1024 1024"><defs><linearGradient id="glow" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2a2a2a"/><stop offset="0.55" stop-color="#000000"/></linearGradient></defs><rect width="1024" height="1024" rx="160" fill="url(#glow)"/><path d="M248 524V392A144 144 0 0 1 392 248H776L248 776H632A144 144 0 0 0 776 632V500" fill="none" stroke="#ffffff" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Zuna
  </div>
  <h1>The chat app nobody owns.</h1>
  <p>Chat, voice and screen sharing, on servers you run.</p>
  <div class="url">zuna.chat</div>
</main>`;

const scratch = mkdtempSync(join(tmpdir(), "zuna-og-"));
const page = join(scratch, "og.html");
writeFileSync(page, html);
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await tab.goto(pathToFileURL(page).href);
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: join(root, "public", "og.png") });
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
console.log("Drew public/og.png");
