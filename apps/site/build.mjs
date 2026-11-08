// Builds zuna.chat: the browser's bundle, then each page prerendered into its own HTML file,
// with the latest release's download links baked in. Nothing is fetched by visitors' browsers.

import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { CONTENT_SECURITY_POLICY } from "./policy.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const ssr = join(dist, ".ssr");

const release = await latestRelease();
const define = { __RELEASE__: JSON.stringify(release) };

await build({ root, define, logLevel: "warn" });
await build({ root, define, logLevel: "warn", build: { ssr: "src/render.tsx", outDir: ssr, emptyOutDir: true } });

const { PAGES, SITE, render, head } = await import(pathToFileURL(join(ssr, "render.js")).href);
const template = await readFile(join(dist, "index.html"), "utf8");
// Each page's policy and content go where these markers are, and a page without them would
// go out with neither, which nothing else would notice.
for (const marker of ["<!--csp-->", '<div id="root"><!--app--></div>']) {
  if (!template.includes(marker)) throw new Error(`index.html has lost its ${marker} marker`);
}
for (const page of PAGES) {
  const html = template
    .replace("<!--csp-->", `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`)
    .replace(/<title>.*?<\/title>/, head(page))
    .replace('<div id="root"><!--app--></div>', `<div id="root" data-page="${page.id}">${await render(page)}</div>`);
  const file = join(dist, page.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}
await rm(ssr, { recursive: true, force: true });

const listed = PAGES.filter((page) => page.id !== "missing");
await writeFile(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed
    .map((page) => `  <url><loc>${SITE}${page.path}</loc></url>`)
    .join("\n")}\n</urlset>\n`,
);
await writeFile(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built ${PAGES.length} pages into ${dist}${release ? `, linking to ${release.version}` : ", linking to the releases page"}`);

/** The latest release's files, or null when there's none to see, which leaves downloads on the releases page. */
async function latestRelease() {
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    // A network that takes the request and never answers mustn't hold the build.
    const response = await fetch("https://api.github.com/repos/SocketByte/zuna-chat/releases/latest", { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      console.warn(`No release to link to (GitHub said ${response.status}), so downloads lead to the releases page`);
      return null;
    }
    const body = await response.json();
    return {
      version: body.tag_name.replace(/^v/, ""),
      assets: body.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })),
    };
  } catch (error) {
    console.warn(`Couldn't ask GitHub for the latest release (${error.message}), so downloads lead to the releases page`);
    return null;
  }
}
