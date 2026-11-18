// The showcase's pictures: CC0 notionists avatars, the server's icon and a few illustrated "photos".
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const [depsDir, out] = process.argv.slice(2);
const deps = createRequire(depsDir + "/package.json");
const { createAvatar } = deps("@dicebear/core");
const { notionists } = deps("@dicebear/collection");
const { chromium } = createRequire(new URL("../../package.json", import.meta.url))("playwright-core");

const people = {
  alex: [33, "cfe8ff"], maya: [19, "ffd5dc"], theo: [12, "c7f0d8"], nadia: [2, "e2d4f7"], kai: [0, "ffdfbf"],
  elena: [34, "f5e6b8"], jonas: [46, "d1d4f9"], aiko: [30, "ffc9b9"], leo: [41, "b6e3f4"], sofia: [24, "d8e8c9"], ben: [28, "c0aede"],
  // Telegram's people
  tg_anna: [42, "ffdfbf"], tg_mom: [4, "ffd5dc"], tg_jakub: [45, "cfe8ff"], tg_ola: [16, "c7f0d8"], tg_tomek: [54, "f5e6b8"], tg_kasia: [37, "e2d4f7"],
};

const svgs = {};
for (const [name, [seed, bg]] of Object.entries(people)) {
  svgs[`avatar-${name}`] = [createAvatar(notionists, { seed: `zuna-${seed}`, backgroundColor: [bg], size: 512 }).toString(), 512, 512];
}

const stars = (n, w, h, seed) => {
  let s = seed, out = "";
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) out += `<circle cx="${r() * w}" cy="${r() * h * 0.55}" r="${0.6 + r() * 1.8}" fill="#fff" opacity="${0.35 + r() * 0.65}"/>`;
  return out;
};

// Sunrise over a lake below the peaks.
svgs["photo-sunrise"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
<defs>
 <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4c8c"/><stop offset=".45" stop-color="#e98a7b"/><stop offset=".62" stop-color="#ffc98b"/></linearGradient>
 <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0a98a"/><stop offset=".5" stop-color="#5a5f8f"/><stop offset="1" stop-color="#262a4a"/></linearGradient>
 <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff6d8"/><stop offset=".35" stop-color="#ffe2a0"/><stop offset="1" stop-color="#ffe2a0" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1600" height="760" fill="url(#sky)"/>
<circle cx="980" cy="660" r="330" fill="url(#sun)"/>
<circle cx="980" cy="660" r="70" fill="#fff4d6"/>
<path d="M0 640 L180 470 L300 560 L470 360 L610 520 L760 410 L900 560 L1060 380 L1230 540 L1380 430 L1600 600 L1600 760 L0 760Z" fill="#8a6f9e" opacity=".75"/>
<path d="M0 700 L220 520 L360 640 L560 450 L700 610 L880 500 L1040 650 L1240 480 L1420 620 L1600 540 L1600 760 L0 760Z" fill="#4e4677"/>
<path d="M0 760 L0 690 C200 660 380 720 560 690 C760 655 980 720 1180 690 C1360 665 1480 700 1600 685 L1600 760Z" fill="#2c2b4f"/>
<rect y="760" width="1600" height="440" fill="url(#lake)"/>
<g fill="#fff4d6" opacity=".55">${[0,1,2,3,4,5,6,7].map(i => `<rect x="${930 - i*14}" y="${790 + i*42}" width="${100 + i*28}" height="5" rx="2.5"/>`).join("")}</g>
<path d="M0 1200 L0 1030 C260 1000 480 1050 680 1100 C760 1125 810 1165 840 1200Z" fill="#1c1d36"/>
<path d="M160 1060 l26 -110 l26 110 M120 1070 l30 -150 l30 150" fill="#141529"/>
</svg>`, 1600, 1200];

// A tent glowing under the stars.
svgs["photo-tent"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
<defs>
 <linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070b1f"/><stop offset=".6" stop-color="#1c2550"/><stop offset="1" stop-color="#2d3a6b"/></linearGradient>
 <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".9"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient>
 <linearGradient id="mw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9aa8ff" stop-opacity="0"/><stop offset=".5" stop-color="#c9d1ff" stop-opacity=".22"/><stop offset="1" stop-color="#9aa8ff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="1600" height="1200" fill="url(#n)"/>
<path d="M-100 700 C400 350 900 250 1700 -50 L1700 150 C1000 420 500 520 -100 900Z" fill="url(#mw)"/>
${stars(260, 1600, 1200, 7)}
<path d="M0 860 L260 620 L420 760 L640 560 L860 780 L1080 600 L1300 760 L1600 640 L1600 1200 L0 1200Z" fill="#141a38"/>
<path d="M0 960 C300 920 600 990 900 950 C1150 920 1400 980 1600 950 L1600 1200 L0 1200Z" fill="#0b0f24"/>
<circle cx="800" cy="930" r="300" fill="url(#glow)"/>
<path d="M650 990 L800 780 L950 990Z" fill="#ffb347"/>
<path d="M800 780 L770 990 L830 990Z" fill="#c9711f"/>
<path d="M620 995 L980 995" stroke="#0b0f24" stroke-width="10" stroke-linecap="round"/>
<g fill="#0b0f24"><path d="M300 980 l40 -170 l40 170z"/><path d="M360 990 l30 -120 l30 120z"/><path d="M1180 985 l45 -190 l45 190z"/><path d="M1250 995 l32 -130 l32 130z"/></g>
</svg>`, 1600, 1200];

// The ridge at midday.
svgs["photo-ridge"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">
<defs>
 <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa0e6"/><stop offset="1" stop-color="#bfe0f7"/></linearGradient>
 <linearGradient id="m1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8c9db4"/><stop offset="1" stop-color="#5d6f88"/></linearGradient>
 <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5f9a5a"/><stop offset="1" stop-color="#2f5a35"/></linearGradient>
</defs>
<rect width="1600" height="1200" fill="url(#s)"/>
<g fill="#fff" opacity=".85"><ellipse cx="300" cy="220" rx="150" ry="38"/><ellipse cx="380" cy="200" rx="110" ry="44"/><ellipse cx="1180" cy="300" rx="190" ry="40"/><ellipse cx="1260" cy="280" rx="120" ry="46"/></g>
<path d="M0 760 L240 460 L380 600 L620 300 L820 560 L1000 380 L1220 610 L1400 450 L1600 640 L1600 1200 L0 1200Z" fill="url(#m1)"/>
<path d="M620 300 L560 375 L600 365 L640 400 L690 362 Z M1000 380 L955 435 L990 430 L1030 455 L1050 424Z M240 460 L200 510 L235 505 L270 525Z" fill="#fff"/>
<path d="M0 900 C260 820 520 880 760 820 C1000 760 1260 860 1600 800 L1600 1200 L0 1200Z" fill="url(#g)"/>
<path d="M520 1200 C620 1080 700 1000 820 930 C900 885 960 860 1040 850" stroke="#d9c7a0" stroke-width="22" fill="none" stroke-linecap="round" opacity=".8"/>
<g fill="#244a2a"><path d="M120 1010 l38 -150 l38 150z"/><path d="M190 1030 l30 -110 l30 110z"/><path d="M1340 990 l40 -160 l40 160z"/><path d="M1410 1010 l30 -120 l30 120z"/></g>
</svg>`, 1600, 1200];

// Basecamp's icon: a peak and a tent, white on deep teal.
svgs["icon-basecamp"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6f73"/><stop offset="1" stop-color="#173c48"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#b)"/>
<path d="M96 370 L230 170 L290 260 L330 205 L416 370Z" fill="#fff"/>
<path d="M230 170 L205 208 L232 200 L256 214Z" fill="#173c48"/>
<path d="M208 370 L256 300 L304 370Z" fill="#173c48"/>
</svg>`, 512, 512];

// A second server, for the server list: a controller on violet.
svgs["icon-pixel"] = [`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b4fd8"/><stop offset="1" stop-color="#2b1e6e"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#b)"/>
<rect x="116" y="196" width="280" height="140" rx="70" fill="#fff"/>
<rect x="166" y="248" width="56" height="18" rx="5" fill="#2b1e6e"/><rect x="185" y="229" width="18" height="56" rx="5" fill="#2b1e6e"/>
<circle cx="320" cy="244" r="13" fill="#2b1e6e"/><circle cx="350" cy="272" r="13" fill="#2b1e6e"/>
</svg>`, 512, 512];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, [svg, w, h]] of Object.entries(svgs)) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: w, height: h } });
}
await browser.close();
console.log(Object.keys(svgs).length, "images");
