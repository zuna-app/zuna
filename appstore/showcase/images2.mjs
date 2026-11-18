// Faces and an icon for the two servers added to the showcase.
import { createRequire } from "node:module";
const [depsDir, out] = process.argv.slice(2);
const deps = createRequire(depsDir + "/package.json");
const { createAvatar } = deps("@dicebear/core");
const { notionists } = deps("@dicebear/collection");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("playwright-core");
const people = { rin: [10, "c7f0d8"], marco: [49, "ffdfbf"], zoe: [21, "d1d4f9"], ella: [37, "ffd5dc"], david: [47, "cfe8ff"], rose: [56, "f5e6b8"] };
const svgs = {};
for (const [name, [seed, bg]] of Object.entries(people)) svgs[`avatar-${name}`] = [createAvatar(notionists, { seed: `zuna-${seed}`, backgroundColor: [bg], size: 512 }).toString(), 512, 512];
svgs["icon-family"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2895c"/><stop offset="1" stop-color="#a24a2c"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#b)"/>
<path d="M256 120 L404 246 L370 246 L370 382 L142 382 L142 246 L108 246Z" fill="#fff"/>
<path d="M256 262 c-14 -26 -58 -22 -58 12 c0 30 40 52 58 68 c18 -16 58 -38 58 -68 c0 -34 -44 -38 -58 -12z" fill="#a24a2c"/>
</svg>`, 512, 512];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, [svg, w, h]] of Object.entries(svgs)) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: w, height: h } });
}
await browser.close();
console.log(Object.keys(svgs).join(" "));
